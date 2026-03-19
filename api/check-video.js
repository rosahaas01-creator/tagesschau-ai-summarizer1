import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("Starte Überprüfung auf 'Tagesschau in 100 Sekunden' (Audio Edition)...");
        
        // 1. Suche nach der neuesten AUDIO-Folge (Viel kleiner als Video, perfekt für Groq)
        // Wir nutzen den Podcast-RSS-Feed, da er stabil die MP3-Links liefert
        const rssUrl = "https://www.tagesschau.de/infoservices/podcast/tagesschau_100_sekunden/index~podcast.xml";
        const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const rssXml = await rssRes.text();
        
        // Extrahiere den ersten MP3-Link und die ID (meistens im <guid> oder <link>)
        const mp3Match = rssXml.match(/<enclosure url="(https?:[^"]+\.mp3)"/);
        const guidMatch = rssXml.match(/<guid[^>]*>(https?:[^<]+)<\/guid>/) || rssXml.match(/<link>(https?:[^<]+)<\/link>/);
        
        if (!mp3Match) throw new Error("Keine MP3 im RSS-Feed gefunden.");
        
        const directMp3Url = mp3Match[1];
        // Wir extrahieren eine ID aus der URL oder dem GUID
        const videoId = directMp3Url.split('/').pop().replace('.mp3', '').substring(0, 20);

        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) return res.status(200).json({ message: 'Schon erledigt.', videoId });

        // 2. Download MP3 (Nur ca. 1-2 MB)
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp3`);
        const mp3Res = await fetch(directMp3Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!mp3Res.ok) throw new Error("Download fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp3Res.body), fileStream);
        console.log(`Download von ${directMp3Url} abgeschlossen.`);

        // 3. Transcription via Groq Whisper
        console.log("Transkription via Groq Whisper...");
        const formData = new FormData();
        formData.append('file', new Blob([fs.readFileSync(tmpPath)]), `${videoId}.mp3`);
        formData.append('model', 'whisper-large-v3');
        formData.append('language', 'de');
        formData.append('response_format', 'text');

        const transRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
            body: formData
        });

        if (!transRes.ok) {
            const err = await transRes.text();
            throw new Error(`Groq Transcription Error: ${err}`);
        }
        const transcript = await transRes.text();
        console.log("Transkription erfolgreich.");

        // 4. Summarization via Groq Llama-3
        console.log("Zusammenfassung via Groq Llama-3...");
        const chatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "Du bist ein Nachrichten-Assistent. Fasse die Nachrichtensendung kurz zusammen. Antworte NUR im JSON-Format: { \"summary\": \"...\", \"details\": \"...\" }" },
                    { role: "user", content: `Hier ist das Transkript: ${transcript}` }
                ],
                response_format: { type: "json_object" }
            })
        });

        if (!chatRes.ok) {
            const err = await chatRes.text();
            throw new Error(`Groq Chat Error: ${err}`);
        }
        const chatData = await chatRes.json();
        const jsonResponse = JSON.parse(chatData.choices[0].message.content);

        // 5. Datensatz speichern
        const dbEntry = {
            id: videoId,
            title: `Tagesschau in 100 Sekunden (Audio)`,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.details, 
            processedAt: new Date().toISOString()
        };

        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        // E-Mail senden
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Tagesschau kompakt - ${new Date().toLocaleDateString('de-DE')}`,
            html: `<h3>Zusammenfassung</h3><p>${jsonResponse.summary}</p><h3>Hintergrund</h3><p>${jsonResponse.details}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return res.status(200).json({ success: true, videoId, method: 'Groq/Whisper-Audio' });

    } catch (error) {
        console.error("FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

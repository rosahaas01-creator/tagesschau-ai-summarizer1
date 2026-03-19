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
        
        // 1. Suche nach der neuesten AUDIO-Folge via stabilem RSS-Feed
        const rssUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_in_100_sekunden/podcast-ts100-audio-100~podcast.xml";
        const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!rssRes.ok) throw new Error(`RSS-Feed konnte nicht geladen werden (${rssRes.status})`);
        
        const rssXml = await rssRes.text();
        
        // Robusterer Regex für die MP3-URL
        const enclosureMatch = rssXml.match(/<enclosure[^>]+url="([^"]+\.mp3)"/i);
        if (!enclosureMatch) throw new Error("Keine MP3-URL im RSS-Feed gefunden.");
        
        const directMp3Url = enclosureMatch[1];
        
        // ID Extraktion für die Datenbank (um Doppelverarbeitung zu vermeiden)
        const videoIdMatch = directMp3Url.match(/AU-(\d+-\d+-\d+)/) || [null, directMp3Url.split('/').pop()];
        const videoId = videoIdMatch[1] || videoIdMatch[0].replace('.mp3', '');

        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) return res.status(200).json({ message: 'Schon erledigt.', videoId });

        // 2. Download MP3 (Klein und effizient für Groq/Whisper)
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp3`);
        const mp3Res = await fetch(directMp3Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!mp3Res.ok) throw new Error(`MP3 Download fehlgeschlagen (${mp3Res.status})`);
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp3Res.body), fileStream);

        // 3. Transkription via Groq Whisper
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

        // 4. KI-Zusammenfassung via Groq Llama-3
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
                    { role: "system", content: "Du bist ein Nachrichten-Assistent. Fasse die Sendung prägnant zusammen (Bullet Points). Antworte NUR im JSON-Format: { \"summary\": \"...\", \"details\": \"...\" }" },
                    { role: "user", content: `Analysiere dieses Transkript: ${transcript}` }
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

        // 5. Daten in Vercel KV speichern
        const dbEntry = {
            id: videoId,
            title: `Tagesschau Kompakt (${new Date().toLocaleDateString('de-DE')})`,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.details, 
            processedAt: new Date().toISOString()
        };

        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        // Benachrichtigung senden
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Newsletter: Tagesschau kompakte Zusammenfassung`,
            html: `<h2>🗞️ Aktuelle News</h2><p>${jsonResponse.summary.replace(/\n/g, '<br>')}</p><h3>💡 Details</h3><p>${jsonResponse.details.replace(/\n/g, '<br>')}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

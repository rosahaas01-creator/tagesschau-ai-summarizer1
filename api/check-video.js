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
        console.log("Starte Überprüfung auf 'Tagesschau in 100 Sekunden' (Groq Edition)...");
        
        // 1. Suche nach Video
        const baseUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_in_100_sekunden/";
        const indexRes = await fetch(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const indexHtml = await indexRes.text();
        
        const videoLinkMatch = indexHtml.match(/\/tagesschau_in_100_sekunden\/(video-|ts-)([0-9]+)\.html/);
        if (!videoLinkMatch) throw new Error("Kein Video-Link gefunden.");
        
        const videoPageUrl = `https://www.tagesschau.de${videoLinkMatch[0]}`;
        const videoId = videoLinkMatch[2];

        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) return res.status(200).json({ message: 'Schon erledigt.', videoId });

        const detailRes = await fetch(videoPageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const detailHtml = await detailRes.text();
        
        const mp4Regex = /https?:\/\/[^"'>\s&]+?\.mp4(?:[^"'>\s&]*)/g;
        let mp4Matches = (detailHtml.match(mp4Regex) || []).map(url => url.replace(/\\/g, '').split('&')[0]);
        if (mp4Matches.length === 0) throw new Error("Kein MP4 gefunden.");
        
        const directMp4Url = mp4Matches.find(m => m.includes('webxl')) || mp4Matches[0];

        // 2. Download (Groq Whisper kann MP4 direkt verarbeiten bis 25MB)
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!mp4Res.ok) throw new Error("Download fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);

        // 3. Transcription via Groq Whisper
        console.log("Transkription via Groq Whisper...");
        const formData = new FormData();
        formData.append('file', new Blob([fs.readFileSync(tmpPath)]), `${videoId}.mp4`);
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
                    { role: "system", content: "Du bist ein Nachrichten-Assistent. Fasse den Text kurz und prägnant zusammen. Antworte NUR im JSON-Format: { \"summary\": \"...\", \"details\": \"...\" }" },
                    { role: "user", content: `Fasse diese Tagesschau-Sendung zusammen: ${transcript}` }
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
            title: `Tagesschau in 100 Sekunden (${videoId})`,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.details, // Wir mappen "details" auf "visuals" fürs Frontend
            processedAt: new Date().toISOString()
        };

        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        // E-Mail senden
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Tagesschau Kompakt (via Groq) - ${videoId}`,
            html: `<h3>Zusammenfassung</h3><p>${jsonResponse.summary}</p><h3>Details</h3><p>${jsonResponse.details}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return res.status(200).json({ success: true, videoId, method: 'Groq/Whisper' });

    } catch (error) {
        console.error("FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

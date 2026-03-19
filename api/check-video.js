import { kv } from '@vercel/kv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { Resend } from 'resend';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("Starte Überprüfung auf 'Tagesschau in 100 Sekunden'...");
        
        // 1. Suche nach der neuesten Folge auf der Webseite
        const baseUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_in_100_sekunden/";
        const indexRes = await fetch(baseUrl);
        const indexHtml = await indexRes.text();
        
        // Suche nach Links wie /tagesschau_in_100_sekunden/video-1566498.html
        const videoLinkMatch = indexHtml.match(/\/tagesschau_in_100_sekunden\/(video-|ts-)([0-9]+)\.html/);
        
        if (!videoLinkMatch) {
            throw new Error("Konnte keinen Video-Link auf der Übersichtsseite finden.");
        }
        
        const videoPageUrl = `https://www.tagesschau.de${videoLinkMatch[0]}`;
        const videoId = videoLinkMatch[2];
        console.log(`Neueste Folge: ${videoPageUrl} (ID: ${videoId})`);

        // 2. Prüfen, ob bereits verarbeitet
        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) {
            return res.status(200).json({ message: 'Folge bereits verarbeitet.', videoId });
        }

        // 3. MP4 URL aus der Video-Seite extrahieren
        const videoPageRes = await fetch(videoPageUrl);
        const videoPageHtml = await videoPageRes.text();
        
        // Suche nach MP4 Links (meistens in einem JSON-Block für den Player)
        // Wir nehmen den ersten .mp4 Link, der nach einer hohen Qualität aussieht (z.B. webxl)
        const mp4Matches = videoPageHtml.match(/https?:\/\/[^"']+\.mp4/g);
        if (!mp4Matches) {
            throw new Error("Konnte keine MP4-URL im Quelltext finden.");
        }
        
        // Filter nach "webxl" oder "webl" für gute Qualität, sonst nimm den ersten
        const directMp4Url = mp4Matches.find(m => m.includes('webxl')) || 
                             mp4Matches.find(m => m.includes('webl')) || 
                             mp4Matches[0];
        
        console.log(`Extrahiere MP4: ${directMp4Url}`);

        // 4. Download (nur im /tmp Verzeichnis erlaubt auf Vercel)
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url);
        if (!mp4Res.ok) throw new Error("Video-Download fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);

        // 5. Gemini Upload & Analyse
        console.log("Upload zu Gemini...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `TS 100s ${videoId}`
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === 'FAILED') throw new Error("Gemini Video-Processing fehlgeschlagen.");

        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analysiere diese Ausgabe der "Tagesschau in 100 Sekunden". 
Erstelle eine inhaltliche Zusammenfassung und eine visuelle Beschreibung der wichtigsten Bilder.
Antworte ausschließlich im JSON Format:
{
  "summary": "Text...",
  "visuals": "Text..."
}`;

        const result = await model.generateContent([
            { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
            { text: prompt },
        ]);
        
        const responseText = result.response.text();
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);

        // 6. Speichern
        const dbEntry = {
            id: videoId,
            title: `Tagesschau in 100 Sekunden (${videoId})`,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.visuals,
            processedAt: new Date().toISOString()
        };
        
        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        // 7. E-Mail
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Newsletter: Tagesschau kompakt (${videoId})`,
            html: `<h2>Highlights</h2><p>${jsonResponse.summary}</p><h2>Bilder des Tages</h2><p>${jsonResponse.visuals}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

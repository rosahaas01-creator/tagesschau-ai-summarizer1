import { kv } from '@vercel/kv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { Resend } from 'resend';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';

// Initialisiere die APIs
const resend = new Resend(process.env.RESEND_API_KEY);
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("Starte Überprüfung auf 'Tagesschau in 100 Sekunden'...");
        
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY fehlt.");
        }

        // 1. Neueste MP4-URL aus dem 100-Sekunden RSS-Feed extrahieren
        const rssUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_in_100_sekunden/podcast-ts100-video-100.xml";
        const rssRes = await fetch(rssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const rssText = await rssRes.text();
        
        // Suche nach der ersten Enclosure mit .mp4 (das ist die aktuellste Folge)
        const enclosureMatch = rssText.match(/<enclosure url="([^"]+\.mp4)"/i);
        if (!enclosureMatch) {
            throw new Error("Konnte keine MP4-Datei im Podcast-Feed finden.");
        }
        
        const directMp4Url = enclosureMatch[1];
        // Erzeuge eine eindeutige ID aus dem Dateinamen oder Pfad
        const videoIdMatch = directMp4Url.match(/TV-([0-9-]+-[0-9]+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : `ts100-${Date.now()}`;
        
        console.log(`Aktuellste Folge gefunden: ${videoId} (${directMp4Url})`);

        // 2. Prüfen, ob bereits verarbeitet
        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) {
            return res.status(200).json({ message: 'Folge bereits verarbeitet.', videoId });
        }

        // 3. Download (schnell, da nur wenige MB)
        console.log("Download läuft...");
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url);
        if (!mp4Res.ok) throw new Error("Download fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);

        // 4. Gemini Upload & Analyse
        console.log("Lade zu Gemini hoch...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `TS 100s ${videoId}`
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === 'FAILED') throw new Error("Gemini Processing fehlgeschlagen.");

        console.log("Analysiere mit Gemini 1.5 Flash...");
        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analysiere diese Ausgabe der "Tagesschau in 100 Sekunden". 
Erstelle eine strukturierte Zusammenfassung und eine visuelle Beschreibung.
Antworte ausschließlich im JSON Format:
{
  "summary": "Inhaltliche Zusammenfassung...",
  "visuals": "Visuelle Details..."
}`;

        const result = await model.generateContent([
            { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
            { text: prompt },
        ]);
        
        const responseText = result.response.text();
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);

        // 5. In KV speichern
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

        // 6. Resend E-Mail abschicken
        console.log("Sende E-Mail...");
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `TS 100s Update: ${videoId}`,
            html: `<h3>Zusammenfassung</h3><p>${jsonResponse.summary}</p><h3>Visuelle Details</h3><p>${jsonResponse.visuals}</p>`
        });

        // 7. Lokal aufräumen
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        
        console.log("Erfolgreich abgeschlossen!");
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("KRITISCHER FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

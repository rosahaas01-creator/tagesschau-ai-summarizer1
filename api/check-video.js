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
        console.log("Starte Überprüfung auf neue Tagesschau-Sendung auf tagesschau.de...");
        
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY fehlt.");
        }

        // 1. Neueste Sendungs-URL finden
        const indexUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_20_uhr/";
        const indexRes = await fetch(indexUrl);
        const indexHtml = await indexRes.text();
        
        // Suche nach Links vom Typ /tagesschau_20_uhr/video-1565932.html
        const videoLinkMatch = indexHtml.match(/\/tagesschau_20_uhr\/video-([0-9]+)\.html/);
        if (!videoLinkMatch) {
            throw new Error("Konnte keinen Link zur aktuellen 20-Uhr-Sendung finden.");
        }
        
        const videoId = videoLinkMatch[1];
        const videoUrl = `https://www.tagesschau.de${videoLinkMatch[0]}`;
        console.log(`Neueste Sendung gefunden: ${videoUrl} (ID: ${videoId})`);

        // 2. Prüfen, ob Video bereits verarbeitet wurde
        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) {
            return res.status(200).json({ message: 'Sendung wurde bereits verarbeitet.', videoId });
        }

        // 3. MP4 URL aus der Video-Seite extrahieren
        console.log("Extrahiere MP4-Link...");
        const videoPageRes = await fetch(videoUrl);
        const videoPageHtml = await videoPageRes.text();
        
        // Die Video-Links liegen oft in einem JSON Block namens mediaCollection
        const mediaCollectionMatch = videoPageHtml.match(/mediaCollection\s*:\s*(\{.*?\})\s*,/s) || 
                                     videoPageHtml.match(/var\s+mediaCollection\s*=\s*(\{.*?\});/s);
        
        if (!mediaCollectionMatch) {
            throw new Error("Konnte mediaCollection im Quelltext nicht finden.");
        }
        
        const mediaCollection = JSON.parse(mediaCollectionMatch[1]);
        const streams = mediaCollection._mediaArray[0]._mediaStreamArray;
        
        // Finde den besten MP4 Stream (meistens am Ende oder nach Qualität sortiert)
        const mp4Stream = streams.filter(s => s._stream && s._stream.endsWith('.mp4'))
                                 .sort((a, b) => (b._quality || 0) - (a._quality || 0))[0];
        
        if (!mp4Stream || !mp4Stream._stream) {
            throw new Error("Keine MP4-Stream URL gefunden.");
        }
        
        const directMp4Url = mp4Stream._stream;
        console.log(`Direkter MP4-Link extrahiert: ${directMp4Url}`);

        // 4. Video herunterladen
        console.log("Lade Video von tagesschau.de herunter...");
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url);
        if (!mp4Res.ok) throw new Error("Download der MP4 fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);
        console.log("Video erfolgreich in /tmp gespeichert.");

        // 5. Video an Gemini File API hochladen
        console.log("Lade Video zu Gemini hoch...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `Tagesschau 20 Uhr ${videoId}`
        });
        
        console.log(`Video bei Gemini hochgeladen: ${uploadResult.file.uri}`);

        // Warte auf Processing
        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === 'FAILED') {
            throw new Error("Gemini Video-Processing fehlgeschlagen.");
        }

        // 6. Analyse generieren
        console.log("Starte Gemini Analyse...");
        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analysiere diese Ausgabe der "Tagesschau 20 Uhr". 
Erstelle eine strukturierte Zusammenfassung und eine visuelle Beschreibung.
Antworte ausschließlich im JSON Format:
{
  "summary": "Inhaltliche Zusammenfassung...",
  "visuals": "Visuelle Details..."
}`;

        const result = await model.generateContent([
            {
                fileData: {
                    mimeType: file.mimeType,
                    fileUri: file.uri
                }
            },
            { text: prompt },
        ]);
        
        const responseText = result.response.text();
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);

        // 7. Speichern in KV
        console.log("Speichere in Datenbank...");
        const videoTitle = `Tagesschau 20 Uhr (${videoId})`;
        const dbEntry = {
            id: videoId,
            title: videoTitle,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.visuals,
            processedAt: new Date().toISOString()
        };
        
        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        // 8. E-Mail senden
        console.log("Sende E-Mail...");
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Tagesschau Zusammenfassung: ${videoId}`,
            html: `<h2>Zusammenfassung</h2><p>${jsonResponse.summary}</p><h2>Visuelle Details</h2><p>${jsonResponse.visuals}</p>`
        });

        // 9. Aufräumen
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        
        console.log("Erfolgreich abgeschlossen!");
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("KRITISCHER FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

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
        console.log("Starte Überprüfung auf neue Tagesschau-Sendung...");
        
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY fehlt.");
        }

        // 1. MP4-URL finden via RSS-Feed (zuverlässigste Quelle)
        const rssUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_20_uhr/podcast-ts2000-video-100.xml";
        console.log(`Rufe RSS-Feed ab: ${rssUrl}`);
        
        const rssRes = await fetch(rssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Vercel Serverless)' }
        });
        const rssContent = await rssRes.text();
        
        // Suche nach <enclosure url="...mp4" .../>
        const enclosureMatch = rssContent.match(/<enclosure url="([^"]+\.mp4)"/i);
        
        let directMp4Url = null;
        let videoId = null;

        if (enclosureMatch) {
            directMp4Url = enclosureMatch[1];
            // Extrahiere eine Pseudo-ID aus der URL für das KV-Tracking (z.B. Datums-Part)
            const idMatch = directMp4Url.match(/TV-([0-9-]+-[0-9]+)/);
            videoId = idMatch ? idMatch[1] : `ts-${Date.now()}`;
            console.log(`MP4 via RSS gefunden: ${directMp4Url}`);
        } else {
            console.log("RSS-Feed (enclosure) nicht gefunden, versuche HTML-Scraping...");
            
            // Fallback: Website durchsuchen
            const indexUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_20_uhr/";
            const indexRes = await fetch(indexUrl);
            const indexHtml = await indexRes.text();
            
            // Suche nach Video-Links im HTML
            const pageLinkMatch = indexHtml.match(/\/tagesschau_20_uhr\/(video-|ts-)([0-9a-zA-Z]+)\.html/);
            if (!pageLinkMatch) {
                throw new Error("Konnte keinen aktuellen Sendungs-Link finden.");
            }
            
            const detailUrl = `https://www.tagesschau.de${pageLinkMatch[0]}`;
            videoId = pageLinkMatch[2];
            console.log(`Detail-Seite gefunden: ${detailUrl}`);
            
            const detailRes = await fetch(detailUrl);
            const detailHtml = await detailRes.text();
            
            // Suche nach MP4 in der Seite (verschärfter Regex)
            const mp4Match = detailHtml.match(/https?:\/\/[^"]+\.mp4/);
            if (mp4Match) {
                directMp4Url = mp4Match[0];
                console.log(`MP4 via HTML gefunden: ${directMp4Url}`);
            } else {
                throw new Error("Konnte keine direkte MP4-URL im Quelltext finden.");
            }
        }

        // 2. Prüfen, ob Video bereits verarbeitet wurde
        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) {
            return res.status(200).json({ message: 'Sendung bereits verarbeitet.', videoId });
        }

        // 3. Video herunterladen
        console.log(`Download läuft von: ${directMp4Url}`);
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url);
        if (!mp4Res.ok) throw new Error("Download der Video-Datei fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);
        console.log("Download abgeschlossen.");

        // 4. Gemini Upload & Analyse
        console.log("Upload zu Gemini...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `Tagesschau ${videoId}`
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === 'FAILED') throw new Error("Gemini Processing fehlgeschlagen.");

        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analysiere diese Ausgabe der "Tagesschau 20 Uhr". 
Erstelle eine inhaltliche Zusammenfassung und eine visuelle Beschreibung des Studios/der Grafiken.
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

        // 5. Speichern und Benachrichtigen
        const dbEntry = {
            id: videoId,
            title: `Tagesschau 20 Uhr (${videoId})`,
            date: new Date().toISOString(),
            summary: jsonResponse.summary,
            visuals: jsonResponse.visuals,
            processedAt: new Date().toISOString()
        };
        
        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Tagesschau News: ${videoId}`,
            html: `<h3>Zusammenfassung</h3><p>${jsonResponse.summary}</p><h3>Visuelle Details</h3><p>${jsonResponse.visuals}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("Fehler:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

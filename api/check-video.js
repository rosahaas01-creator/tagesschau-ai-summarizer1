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
        
        const baseUrl = "https://www.tagesschau.de/multimedia/sendung/tagesschau_in_100_sekunden/";
        const indexRes = await fetch(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const indexHtml = await indexRes.text();
        
        const videoLinkMatch = indexHtml.match(/\/tagesschau_in_100_sekunden\/(video-|ts-)([0-9]+)\.html/);
        if (!videoLinkMatch) throw new Error("Kein Video-Link auf Übersichtsseite gefunden.");
        
        const videoPageUrl = `https://www.tagesschau.de${videoLinkMatch[0]}`;
        const videoId = videoLinkMatch[2];
        console.log(`Folge: ${videoPageUrl}`);

        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) return res.status(200).json({ message: 'Bereits verarbeitet.', videoId });

        const detailRes = await fetch(videoPageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const detailHtml = await detailRes.text();
        
        // Stark verbesserter Regex: Sucht nach URLs die auf .mp4 enden, aber stoppt VOR Quoten, Tags oder HTML-Entities
        const mp4Regex = /https?:\/\/[^"'>\s&]+?\.mp4(?:[^"'>\s&]*)/g;
        let mp4Matches = (detailHtml.match(mp4Regex) || []).map(url => {
            // Bereinige Slashes und eventuelle Reste von HTML-Entities
            return url.replace(/\\/g, '').split('&')[0]; 
        });
        
        if (mp4Matches.length === 0) throw new Error("Kein MP4-Link im Quelltext gefunden.");
        
        // Priorisiere hohe Qualität (webxl > webl > webs)
        const directMp4Url = mp4Matches.find(m => m.includes('webxl')) || 
                             mp4Matches.find(m => m.includes('webl')) || 
                             mp4Matches[0];
        
        console.log(`Lade MP4: ${directMp4Url}`);

        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        
        if (!mp4Res.ok) {
            throw new Error(`Download-Fehler: ${mp4Res.status} für URL: ${directMp4Url}`);
        }
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);

        console.log("Analyse mit Gemini...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `TS 100s ${videoId}`
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent([
            { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
            { text: "Fasse diese Tagesschau in 100 Sekunden kurz zusammen und beschreibe die wichtigsten gezeigten Bilder. Antworte als JSON: { \"summary\": \"...\", \"visuals\": \"...\" }" },
        ]);
        
        const responseText = result.response.text();
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);

        await kv.hset(`video:${videoId}`, jsonResponse);
        await kv.lpush('feed', jsonResponse);
        await kv.sadd('processed_videos', videoId);

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Newsletter: Tagesschau kompakt (${videoId})`,
            html: `<b>Summary:</b> ${jsonResponse.summary}<br><br><b>Visuals:</b> ${jsonResponse.visuals}`
        });

        fs.unlinkSync(tmpPath);
        return res.status(200).json({ success: true, videoId });

    } catch (error) {
        console.error("DEBUG:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

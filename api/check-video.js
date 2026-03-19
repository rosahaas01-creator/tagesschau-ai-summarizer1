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

// Wir behalten den SDK-Manager für den Upload (der funktioniert)
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("Starte Überprüfung auf 'Tagesschau in 100 Sekunden'...");
        
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

        // 2. Download
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const mp4Res = await fetch(directMp4Url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!mp4Res.ok) throw new Error("Download fehlgeschlagen.");
        
        const fileStream = fs.createWriteStream(tmpPath);
        await pipeline(Readable.fromWeb(mp4Res.body), fileStream);

        // 3. Gemini Upload via SDK
        console.log("Upload zu Google...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: `TS100s_${videoId}`
        });

        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        // 4. Modell-Auto-Discovery (REST v1)
        console.log("Suche verfügbares Modell...");
        const modelList = await modelListDiscovery(process.env.GEMINI_API_KEY);
        let targetModel = modelList.find(m => m.includes('gemini-1.5-flash')) || 
                           modelList.find(m => m.includes('gemini-1.5-pro')) || 
                           "gemini-1.5-flash"; 
        
        console.log(`Nutze Modell: ${targetModel}`);

        // 5. Analyse via REST API v1 (WICHTIG: Snake Case verwenden für REST)
        console.log("Analyse via REST gestartet...");
        const generateUrl = `https://generativelanguage.googleapis.com/v1/models/${targetModel}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const generateRes = await fetch(generateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { 
                            file_data: { 
                                mime_type: file.mimeType, 
                                file_uri: file.uri 
                            } 
                        },
                        { text: "Fasse diese Tagesschau in 100 Sekunden kurz zusammen und beschreibe die Bilder. Antworte als JSON: { \"summary\": \"...\", \"visuals\": \"...\" }" }
                    ]
                }]
            })
        });

        if (!generateRes.ok) {
            const errBody = await generateRes.text();
            throw new Error(`Gemini API Error (${generateRes.status}): ${errBody}`);
        }

        const genData = await generateRes.json();
        if (!genData.candidates || !genData.candidates[0].content) {
            throw new Error("Keine Antwort von Gemini erhalten (Blockiert oder Fehler).");
        }

        const responseText = genData.candidates[0].content.parts[0].text;
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);

        // 6. Datensatz speichern
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

        // E-Mail senden
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: process.env.USER_EMAIL || 'onboarding@resend.dev',
            subject: `Newsletter: Tagesschau kompakt (${videoId})`,
            html: `<b>Zusammenfassung:</b><p>${jsonResponse.summary}</p><br><b>Bilder des Tages:</b><p>${jsonResponse.visuals}</p>`
        });

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return res.status(200).json({ success: true, videoId, modelUsed: targetModel });

    } catch (error) {
        console.error("FEHLER:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

async function modelListDiscovery(apiKey) {
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) {
            return data.models.map(m => m.name.replace('models/', ''));
        }
    } catch (e) {
        console.error("Discovery failed", e);
    }
    return [];
}

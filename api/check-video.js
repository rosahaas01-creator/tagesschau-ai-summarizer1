import { kv } from '@vercel/kv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { Resend } from 'resend';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import { pipeline } from 'stream/promises';
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
        console.log("Starte Überprüfung auf neues Tagesschau-Video...");
        
        // Check API Keys
        if (!process.env.GEMINI_API_KEY || !process.env.YOUTUBE_API_KEY) {
            throw new Error("API Keys fehlen in den Environment Variables.");
        }

        // 1. YouTube Playlist abrufen
        const PLAYLIST_ID = 'PL4A2F331EE86DCC22';
        const ytUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${PLAYLIST_ID}&maxResults=3&key=${process.env.YOUTUBE_API_KEY}`;
        
        const ytRes = await fetch(ytUrl);
        if (!ytRes.ok) {
            const errorText = await ytRes.text();
            throw new Error(`YouTube API Fehler (${ytRes.status}): ${errorText}`);
        }
        
        const ytData = await ytRes.json();
        
        if (!ytData.items || ytData.items.length === 0) {
            return res.status(200).json({ message: 'Keine Videos in der Playlist gefunden.' });
        }
        
        const latestVideo = ytData.items[0];
        const videoId = latestVideo.snippet.resourceId.videoId;
        const videoTitle = latestVideo.snippet.title;
        const videoDate = latestVideo.snippet.publishedAt;
        
        console.log(`Neuestes Video: ${videoTitle} (${videoId})`);
        
        // 2. Prüfen, ob Video bereits verarbeitet wurde
        const alreadyProcessed = await kv.sismember('processed_videos', videoId);
        if (alreadyProcessed) {
            return res.status(200).json({ message: 'Video wurde bereits verarbeitet.', videoId });
        }
        
        // 3. Video via ytdl-core in /tmp herunterladen
        console.log("Lade Video herunter...");
        const tmpPath = path.join(os.tmpdir(), `${videoId}.mp4`);
        const videoStream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { 
            filter: 'audioandvideo',
            quality: 'lowest' 
        });
        
        await pipeline(videoStream, fs.createWriteStream(tmpPath));
        console.log("Video lokal in vercel temporärem Verzeichnis gespeichert.");
        
        // 4. Video an Gemini File API hochladen
        console.log("Lade Video zu Gemini hoch...");
        const uploadResult = await fileManager.uploadFile(tmpPath, {
           mimeType: 'video/mp4',
           displayName: videoTitle
        });
        
        console.log(`Video hochgeladen: ${uploadResult.file.uri}`);

        // Warte auf Processing
        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === 'PROCESSING') {
            process.stdout.write(".");
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === 'FAILED') {
            throw new Error("Video processing failed.");
        }
        
        // 5. Inhalte via Gemini generieren
        console.log("Analysiere Video mit gemini-1.5-flash...");
        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Du bist ein professioneller Nachrichten-Analyst. 
Analysiere diese Ausgabe der "Tagesschau 20 Uhr".
Erstelle mir eine Ausgabe im JSON Format mit folgendem Schema:
{
  "summary": "Detaillierte, inhaltliche Zusammenfassung der wichtigsten Themen der Sendung.",
  "visuals": "Detaillierte visuelle Beschreibung (Szenen, Grafiken im Hintergrund, Auffälligkeiten im Studio)."
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
        // Bereinige den Text von Markdown-Code-Blöcken falls vorhanden
        const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanedJson);
        
        // 6. In Vercel KV Datenbank speichern
        console.log("Speichere in Datenbank...");
        const dbEntry = {
            id: videoId,
            title: videoTitle,
            date: videoDate,
            summary: jsonResponse.summary,
            visuals: jsonResponse.visuals,
            processedAt: new Date().toISOString()
        };
        
        // Speichere das einzelne Video als Hash und füge die ID der Feed-Liste hinzu
        await kv.hset(`video:${videoId}`, dbEntry);
        await kv.lpush('feed', dbEntry);
        await kv.sadd('processed_videos', videoId);
        
        // 7. E-Mail Senden
        console.log("Sende E-Mail via Resend...");
        const emailTo = process.env.USER_EMAIL && process.env.USER_EMAIL !== "" 
                        ? process.env.USER_EMAIL 
                        : "onboarding@resend.dev";
                        
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: emailTo,
            subject: `Tagesschau Zusammenfassung: ${videoTitle}`,
            html: `<h2>Zusammenfassung</h2><p>${jsonResponse.summary.replace(/\n/g, '<br>')}</p><h2>Visuelle Details</h2><p>${jsonResponse.visuals.replace(/\n/g, '<br>')}</p>`
        });
        
        // 8. Aufräumen (Lokale Datei löschen, Vercel löscht /tmp eh irgendwann, aber sicher ist sicher)
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        // Hinweis: Die Datei bei Google AI Studio bleibt dort, falls man sie später braucht, 
        // oder man könnte sie mit fileManager.deleteFile(file.name) löschen.
        
        console.log("Erfolgreich abgeschlossen!");
        return res.status(200).json({ success: true, dbEntry });
        
    } catch (error) {
        console.error("Fehler bei der Video-Analyse:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

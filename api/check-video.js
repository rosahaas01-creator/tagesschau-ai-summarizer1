import { kv } from '@vercel/kv';
import { GoogleGenAI } from '@google/genai';
import { Resend } from 'resend';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import os from 'os';
import path from 'path';

// Initialisiere die APIs
const resend = new Resend(process.env.RESEND_API_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("Starte Überprüfung auf neues Tagesschau-Video...");
        
        // 1. YouTube Playlist abrufen
        const PLAYLIST_ID = 'PL4A2F331EE86DCC22';
        const ytUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${PLAYLIST_ID}&maxResults=3&key=${process.env.YOUTUBE_API_KEY}`;
        const ytRes = await fetch(ytUrl);
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
        const uploadResult = await ai.files.upload({
           file: tmpPath,
           mimeType: 'video/mp4'
        });
        
        console.log("Warte auf Gemini Video-Processing...");
        let fileInfo = await ai.files.get({name: uploadResult.name});
        while (fileInfo.state === 'PROCESSING') {
            await new Promise(r => setTimeout(r, 5000));
            fileInfo = await ai.files.get({name: uploadResult.name});
        }
        
        if (fileInfo.state === 'FAILED') {
            throw new Error("Gemini Video-Processing ist fehlgeschlagen.");
        }
        
        // 5. Inhalte via Gemini generieren
        console.log("Analysiere Video mit gemini-3.1-flash-lite-preview...");
        const prompt = `Du bist ein professioneller Nachrichten-Analyst. 
Analysiere diese Ausgabe der "Tagesschau 20 Uhr".
Erstelle mir eine Ausgabe im JSON Format mit folgendem Schema:
{
  "summary": "Detaillierte, inhaltliche Zusammenfassung der wichtigsten Themen der Sendung.",
  "visuals": "Detaillierte visuelle Beschreibung (Szenen, Grafiken im Hintergrund, Auffälligkeiten im Studio)."
}`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [
                uploadResult,
                { text: prompt }
            ],
            config: {
                responseMimeType: "application/json"
            }
        });
        
        const jsonResponse = JSON.parse(response.text);
        
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
        
        // 8. Aufräumen (Lokale Datei und Gemini File löschen um Platz zu sparen)
        fs.unlinkSync(tmpPath);
        await ai.files.delete({name: uploadResult.name});
        
        console.log("Erfolgreich abgeschlossen!");
        return res.status(200).json({ success: true, dbEntry });
        
    } catch (error) {
        console.error("Fehler bei der Video-Analyse:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: String(error) });
    }
}

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    try {
        await kv.flushall();
        console.log("Datenbank erfolgreich geleert.");
        return res.status(200).json({ 
            success: true, 
            message: "Datenbank komplett geleert! Der Weg ist frei für einen sauberen Neustart." 
        });
    } catch (error) {
        console.error("Reset Fehler:", error);
        return res.status(500).json({ error: String(error) });
    }
}

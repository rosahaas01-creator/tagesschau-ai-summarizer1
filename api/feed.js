import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Lade die neuesten 10 Zusammenfassungen aus der Vercel KV Datenbank
        const feedItems = await kv.lrange('feed', 0, 9);
        
        if (!feedItems || feedItems.length === 0) {
            return res.status(200).json([]);
        }
        
        return res.status(200).json(feedItems);
    } catch (error) {
        console.error("Error fetching feed:", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

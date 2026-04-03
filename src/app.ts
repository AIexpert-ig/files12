import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const TEST_IDS = process.env.IG_TEST_USER_IDS?.split(',') || [];

// 0. COMPLIANCE ROUTES (Required by Meta)
app.get('/privacy', (req: Request, res: Response) => {
    res.send(`
        <h1>Privacy Policy</h1>
        <p>This Instagram Bot provides concierge services for Marriott luxury stays.</p>
        <p>Data is only used to facilitate real-time guest communication.</p>
    `);
});

app.get('/deauth', (req: Request, res: Response) => res.status(200).send('Deauthorized'));
app.get('/delete-data', (req: Request, res: Response) => res.status(200).send('Data deletion requested'));

// 1. WEBHOOK VERIFICATION (The "Handshake")
app.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. MESSAGE HANDLER (The "Ear")
app.post('/webhook', async (req: Request, res: Response) => {
    const body = req.body;

    if (body.object === 'instagram') {
        body.entry.forEach(async (entry: any) => {
            if (!entry.messaging) return;
            const messagingEvent = entry.messaging[0];
            const senderId = messagingEvent.sender.id;
            const messageText = messagingEvent.message?.text;

            if (!messageText) return;

            // SandboxGuard: Only respond to authorized testers
            if (process.env.IG_SANDBOX_MODE === 'true' && !TEST_IDS.includes(senderId)) {
                console.log(`Blocked message from unauthorized ID: ${senderId}`);
                return;
            }

            console.log(`Message from ${senderId}: ${messageText}`);

            // SEND RESPONSE (The "Voice")
            await sendBotResponse(senderId, `Marriott Luxury Assistant: I received "${messageText}". How can I elevate your stay?`);
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

async function sendBotResponse(recipientId: string, text: string) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: recipientId },
            message: { text: text }
        });
    } catch (error) {
        console.error('Error sending message:', error?.response?.data || error.message);
    }
}

app.listen(PORT, () => console.log(`Concierge Engine Live on port ${PORT}`));
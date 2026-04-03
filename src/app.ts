import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import axios, { AxiosError } from 'axios';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const TEST_IDS = process.env.IG_TEST_USER_IDS?.split(',') || [];

// 0. COMPLIANCE ROUTES (Mandatory for Meta App Review)
app.get('/privacy', (req: Request, res: Response) => {
    res.send(`
        <h1>Privacy Policy</h1>
        <p>This Instagram Bot provides concierge services for Marriott luxury stays.</p>
        <p>Data is only used to facilitate real-time guest communication and service fulfillment.</p>
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
        console.log('--- WEBHOOK_VERIFIED ---');
        res.status(200).send(challenge);
    } else {
        console.error('Verification Failed: Token Mismatch');
        res.sendStatus(403);
    }
});

// 2. MESSAGE HANDLER (The "Ear")
app.post('/webhook', async (req: Request, res: Response) => {
    const body = req.body;

    if (body.object === 'instagram') {
        // Logic: Use Promise.all to ensure all messages are processed before responding to Meta
        await Promise.all(body.entry.map(async (entry: any) => {
            if (!entry.messaging) return;

            const messagingEvent = entry.messaging[0];
            const senderId = messagingEvent.sender.id;
            const messageText = messagingEvent.message?.text;

            if (!messageText) return;

            // SandboxGuard: Logic to prevent unauthorized access during development
            if (process.env.IG_SANDBOX_MODE === 'true' && !TEST_IDS.includes(senderId)) {
                console.log(`[SECURITY] Blocked unauthorized sender: ${senderId}`);
                return;
            }

            console.log(`[INCOMING] From ${senderId}: ${messageText}`);

            // TRIGGER RESPONSE
            const responseText = `Marriott Luxury Assistant: I received your request for "${messageText}". How can I further elevate your experience today?`;
            await sendBotResponse(senderId, responseText);
        }));

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// 3. API TRANSMISSION (The "Voice")
async function sendBotResponse(recipientId: string, text: string) {
    try {
        // Logic: Updated to v21.0 and direct instagram.com endpoint for 2026 standards
        await axios.post(`https://graph.instagram.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: recipientId },
            message: { text: text }
        });
        console.log(`[OUTGOING] To ${recipientId}: Success`);
    } catch (error: unknown) {
        // Type Guard: Ensuring logical error handling for TypeScript strict mode
        if (axios.isAxiosError(error)) {
            console.error('[META API ERROR]:', error.response?.data || error.message);
        } else {
            console.error('[INTERNAL ERROR]:', error);
        }
    }
}

app.listen(PORT, () => console.log(`Concierge Engine Live on port ${PORT}`));
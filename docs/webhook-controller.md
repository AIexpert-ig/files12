# Task: webhook-controller

## Goal
HTTP layer that receives Meta webhook events, verifies the hub challenge, and hands off to `MessageProcessor`.

## Dependencies
- `webhook-idempotency` (must be COMPLETED — MessageProcessor exists)
- `sandbox-config` (must be COMPLETED)

---

## TDD Steps

### Step 1 — Write Failing Tests First

**File**: `src/__tests__/webhook-controller.test.ts`

```typescript
import request from 'supertest';
import { buildApp } from '../app';
import { buildWebhookPayload } from './fixtures/webhook-payload';

const VERIFY_TOKEN = 'test_verify_token';

describe('WebhookController', () => {
  const app = buildApp({ verifyToken: VERIFY_TOKEN });

  describe('GET /webhook (hub challenge)', () => {
    it('responds with hub.challenge when token matches', async () => {
      const res = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'CHALLENGE_CODE_123',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('CHALLENGE_CODE_123');
    });

    it('returns 403 when verify token does not match', async () => {
      const res = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong_token',
          'hub.challenge': 'CHALLENGE_CODE_123',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /webhook (message events)', () => {
    it('returns 200 for a valid messaging payload', async () => {
      const payload = buildWebhookPayload({ mid: 'mid.test001', recipientId: 'recip_001' });
      const res = await request(app).post('/webhook').send(payload);
      expect(res.status).toBe(200);
    });

    it('returns 200 even for an unrecognized object type', async () => {
      const res = await request(app)
        .post('/webhook')
        .send({ object: 'unknown_type', entry: [] });
      expect(res.status).toBe(200);
    });
  });
});
```

**Run tests — expect RED.**

---

### Step 2 — Implement

**File**: `src/app.ts`

```typescript
import express from 'express';
import { IdempotencyStore } from './idempotency-store';
import { MessageProcessor } from './message-processor';
import { SandboxGuard } from './sandbox-guard';

interface AppConfig {
  verifyToken: string;
}

export function buildApp(config: AppConfig) {
  const app = express();
  app.use(express.json());

  const idempotencyStore = new IdempotencyStore();
  const sandboxGuard = SandboxGuard.fromEnv();

  // Injected stubs replaceable in integration tests
  const processor = new MessageProcessor({
    idempotencyStore,
    insertMessage: async (data) => { /* DB call */ },
    generateLLMResponse: async (text) => { /* LLM call */ return ''; },
    updateConversationState: async (data) => { /* state update */ },
  });

  // Hub challenge verification
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.verifyToken) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // Incoming message events
  app.post('/webhook', async (req, res) => {
    // Always acknowledge receipt immediately — Meta requires this
    res.sendStatus(200);

    try {
      await processor.handle(req.body);
    } catch (err) {
      // Log but never re-throw — webhook must always return 200
      console.error('[webhook] Processing error:', err);
    }
  });

  return app;
}
```

**Run tests — expect GREEN.**

---

### Step 3 — Verify
- [ ] All 4 tests green
- [ ] `res.sendStatus(200)` fires BEFORE async processing (fire-and-forget pattern — Meta timeout is 20s)
- [ ] Processing errors are caught and logged, never surfaced as 5xx to Meta

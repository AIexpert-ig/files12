# Task: webhook-idempotency

## Goal
Implement idempotency for incoming `messaging` webhook events, keyed on `mid`. The idempotency test MUST be written before the handler is implemented.

## Webhook Idempotency Rule (Meta Graph API Extension §3)
> Before writing the webhook handler, the sub-agent MUST write a test that sends two identical `messaging` webhook payloads with the same `mid` and `recipient.id` and asserts the second does NOT insert a duplicate DB row, trigger a duplicate LLM call, or update conversation state twice.

**This task's structure enforces that rule by construction: tests come before implementation.**

---

## TDD Steps

### Step 1 — Write the Idempotency Tests FIRST (Blocking Requirement)

**File**: `src/__tests__/webhook.idempotency.test.ts`

```typescript
import { IdempotencyStore } from '../idempotency-store';
import { MessageProcessor } from '../message-processor';
import { buildWebhookPayload } from './fixtures/webhook-payload';

describe('Webhook Idempotency — mid-keyed deduplication', () => {
  let store: IdempotencyStore;
  let dbInsertSpy: jest.Mock;
  let llmCallSpy: jest.Mock;
  let stateUpdateSpy: jest.Mock;
  let processor: MessageProcessor;

  const MID = 'mid.$abc123xyz456';
  const RECIPIENT_ID = 'recipient_789';

  beforeEach(() => {
    store = new IdempotencyStore(); // in-memory for tests
    dbInsertSpy = jest.fn().mockResolvedValue({ id: 1 });
    llmCallSpy = jest.fn().mockResolvedValue('Hello!');
    stateUpdateSpy = jest.fn().mockResolvedValue(undefined);

    processor = new MessageProcessor({
      idempotencyStore: store,
      insertMessage: dbInsertSpy,
      generateLLMResponse: llmCallSpy,
      updateConversationState: stateUpdateSpy,
    });
  });

  it('processes the first payload normally', async () => {
    const payload = buildWebhookPayload({ mid: MID, recipientId: RECIPIENT_ID });
    await processor.handle(payload);

    expect(dbInsertSpy).toHaveBeenCalledTimes(1);
    expect(llmCallSpy).toHaveBeenCalledTimes(1);
    expect(stateUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it('silently discards a duplicate payload with the same mid', async () => {
    const payload = buildWebhookPayload({ mid: MID, recipientId: RECIPIENT_ID });

    await processor.handle(payload);
    await processor.handle(payload); // identical replay

    // All downstream effects must have fired exactly once
    expect(dbInsertSpy).toHaveBeenCalledTimes(1);
    expect(llmCallSpy).toHaveBeenCalledTimes(1);
    expect(stateUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it('processes a different mid even with the same recipient', async () => {
    const payload1 = buildWebhookPayload({ mid: MID, recipientId: RECIPIENT_ID });
    const payload2 = buildWebhookPayload({ mid: 'mid.$different999', recipientId: RECIPIENT_ID });

    await processor.handle(payload1);
    await processor.handle(payload2);

    expect(dbInsertSpy).toHaveBeenCalledTimes(2);
    expect(llmCallSpy).toHaveBeenCalledTimes(2);
    expect(stateUpdateSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 200 OK on duplicate without throwing', async () => {
    const payload = buildWebhookPayload({ mid: MID, recipientId: RECIPIENT_ID });
    await processor.handle(payload); // first — fine

    // Second must not throw — Meta requires 200 on all webhook receipts
    await expect(processor.handle(payload)).resolves.not.toThrow();
  });
});
```

**File**: `src/__tests__/fixtures/webhook-payload.ts`

```typescript
export function buildWebhookPayload(opts: { mid: string; recipientId: string }) {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'page_123',
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'sender_456' },
            recipient: { id: opts.recipientId },
            timestamp: Date.now(),
            message: {
              mid: opts.mid,
              text: 'Hello, bot!',
            },
          },
        ],
      },
    ],
  };
}
```

**Run tests — expect RED (IdempotencyStore and MessageProcessor don't exist yet).**

---

### Step 2 — Implement IdempotencyStore

**File**: `src/idempotency-store.ts`

```typescript
/**
 * In-memory idempotency store.
 * In production, replace the Map with Redis: SET mid NX EX 86400
 */
export class IdempotencyStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 86_400_000 /* 24h */) {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if this mid has been seen before (duplicate).
   * Returns false and marks as seen if it's new.
   */
  checkAndMark(mid: string): boolean {
    const now = Date.now();
    const existing = this.seen.get(mid);

    if (existing !== undefined) {
      if (now - existing < this.ttlMs) {
        return true; // duplicate
      }
      // TTL expired — treat as new
    }

    this.seen.set(mid, now);
    return false; // new message
  }
}
```

---

### Step 3 — Implement MessageProcessor

**File**: `src/message-processor.ts`

```typescript
import { IdempotencyStore } from './idempotency-store';

interface MessageProcessorDeps {
  idempotencyStore: IdempotencyStore;
  insertMessage: (data: unknown) => Promise<unknown>;
  generateLLMResponse: (text: string) => Promise<string>;
  updateConversationState: (data: unknown) => Promise<void>;
}

export class MessageProcessor {
  private readonly deps: MessageProcessorDeps;

  constructor(deps: MessageProcessorDeps) {
    this.deps = deps;
  }

  async handle(payload: unknown): Promise<void> {
    const messaging = this.extractMessagingEvent(payload);
    if (!messaging) return;

    const mid: string = messaging.message?.mid;
    if (!mid) return;

    // Idempotency gate — keyed on mid
    const isDuplicate = this.deps.idempotencyStore.checkAndMark(mid);
    if (isDuplicate) {
      // Silently discard — return 200 to Meta
      return;
    }

    // Process exactly once
    await this.deps.insertMessage(messaging);
    const reply = await this.deps.generateLLMResponse(messaging.message.text ?? '');
    await this.deps.updateConversationState({ mid, reply });
  }

  private extractMessagingEvent(payload: unknown): Record<string, unknown> | null {
    try {
      const p = payload as Record<string, unknown>;
      const entry = (p.entry as unknown[])[0] as Record<string, unknown>;
      const messaging = (entry.messaging as unknown[])[0] as Record<string, unknown>;
      return messaging;
    } catch {
      return null;
    }
  }
}
```

**Run tests — expect GREEN.**

---

### Step 4 — Verify
- [ ] All 4 idempotency tests green
- [ ] `dbInsertSpy` never called more than once per unique `mid`
- [ ] `llmCallSpy` never called more than once per unique `mid`
- [ ] `stateUpdateSpy` never called more than once per unique `mid`
- [ ] Duplicate payload returns without throwing (200 contract upheld)

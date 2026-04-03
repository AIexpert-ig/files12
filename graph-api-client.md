# Task: graph-api-client

## Goal
Build the outbound HTTP client for Meta Graph API. Integrates `SandboxGuard` (pre-flight) and `RateLimitManager` (D15). Every call is intercepted — no bypass path exists.

## Dependencies
- `sandbox-config` (must be COMPLETED)
- `rate-limit-manager` (must be COMPLETED)

---

## TDD Steps

### Step 1 — Write Failing Tests First

**File**: `src/__tests__/graph-api-client.test.ts`

```typescript
import nock from 'nock';
import { GraphApiClient } from '../graph-api-client';
import { SandboxGuard } from '../sandbox-guard';
import { RateLimitManager } from '../rate-limit-manager';

const GRAPH_BASE = 'https://graph.facebook.com';
const ACCESS_TOKEN = 'test_token_abc';
const RECIPIENT_ID = 'test_user_123';

describe('GraphApiClient', () => {
  let client: GraphApiClient;

  beforeEach(() => {
    process.env.IG_SANDBOX_MODE = 'true';
    const guard = new SandboxGuard([]);
    const rateLimiter = new RateLimitManager();
    client = new GraphApiClient({ accessToken: ACCESS_TOKEN, sandboxGuard: guard, rateLimitManager: rateLimiter });
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.IG_SANDBOX_MODE;
  });

  it('sends a message successfully', async () => {
    nock(GRAPH_BASE)
      .post('/v18.0/me/messages')
      .reply(200, { recipient_id: RECIPIENT_ID, message_id: 'mid.001' }, {
        'X-App-Usage': '{"call_count":10,"total_cputime":5,"total_time":5}',
      });

    const result = await client.sendMessage({
      recipientId: RECIPIENT_ID,
      text: 'Hello!',
    });

    expect(result.message_id).toBe('mid.001');
  });

  it('blocks production call when sandbox guard rejects', async () => {
    process.env.IG_SANDBOX_MODE = 'false';
    const strictGuard = new SandboxGuard([]); // no test users
    const strictClient = new GraphApiClient({
      accessToken: ACCESS_TOKEN,
      sandboxGuard: strictGuard,
      rateLimitManager: new RateLimitManager(),
    });

    await expect(
      strictClient.sendMessage({ recipientId: 'prod_account', text: 'Hi' })
    ).rejects.toThrow('Production API calls blocked – missing sandbox configuration');
  });

  it('triggers backoff when X-App-Usage exceeds threshold', async () => {
    const backoffSpy = jest.spyOn(client as unknown as { scheduleBackoff: () => void }, 'scheduleBackoff');

    nock(GRAPH_BASE)
      .post('/v18.0/me/messages')
      .reply(200, { recipient_id: RECIPIENT_ID, message_id: 'mid.002' }, {
        'X-App-Usage': '{"call_count":85,"total_cputime":10,"total_time":10}',
      });

    await client.sendMessage({ recipientId: RECIPIENT_ID, text: 'Hi' });

    expect(backoffSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 using Retry-After header', async () => {
    nock(GRAPH_BASE)
      .post('/v18.0/me/messages')
      .reply(429, {}, { 'Retry-After': '1' }) // 1 second for test speed
      .post('/v18.0/me/messages')
      .reply(200, { recipient_id: RECIPIENT_ID, message_id: 'mid.003' });

    const result = await client.sendMessage({
      recipientId: RECIPIENT_ID,
      text: 'Retry me',
    });

    expect(result.message_id).toBe('mid.003');
  }, 10_000);
});
```

**Run tests — expect RED.**

---

### Step 2 — Implement

**File**: `src/graph-api-client.ts`

```typescript
import { SandboxGuard } from './sandbox-guard';
import { RateLimitManager } from './rate-limit-manager';

interface SendMessageInput {
  recipientId: string;
  text: string;
}

interface GraphApiClientConfig {
  accessToken: string;
  sandboxGuard: SandboxGuard;
  rateLimitManager: RateLimitManager;
  maxRetries?: number;
}

export class GraphApiClient {
  private readonly config: Required<GraphApiClientConfig>;
  private backoffScheduled = false;

  constructor(config: GraphApiClientConfig) {
    this.config = { maxRetries: 3, ...config };
  }

  async sendMessage(input: SendMessageInput): Promise<{ recipient_id: string; message_id: string }> {
    // Pre-flight sandbox guard — fail-closed
    this.config.sandboxGuard.assertCallPermitted(input.recipientId);

    return this.executeWithRetry(input, 0);
  }

  private async executeWithRetry(
    input: SendMessageInput,
    attempt: number
  ): Promise<{ recipient_id: string; message_id: string }> {
    const response = await fetch('https://graph.facebook.com/v18.0/me/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: input.recipientId },
        message: { text: input.text },
      }),
    });

    const usageHeader = response.headers.get('X-App-Usage');
    const usage = this.config.rateLimitManager.parseUsageHeader(usageHeader);

    if (usage && this.config.rateLimitManager.isThrottleWarning(usage)) {
      this.scheduleBackoff();
    }

    if (response.status === 429) {
      if (attempt >= this.config.maxRetries) {
        throw new Error(`Graph API rate limited after ${attempt} retries`);
      }

      const retryAfterRaw = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterRaw ? parseFloat(retryAfterRaw) : null;

      const delayMs = this.config.rateLimitManager.getBackoffMs({
        statusCode: 429,
        retryAfterSeconds,
        attempt,
      });

      await this.sleep(delayMs);
      return this.executeWithRetry(input, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Graph API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<{ recipient_id: string; message_id: string }>;
  }

  private scheduleBackoff(): void {
    this.backoffScheduled = true;
    // In production: signal the queue to pause dispatch
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Run tests — expect GREEN.**

---

### Step 3 — Verify
- [ ] All 4 tests green
- [ ] No hardcoded sleep values in `sleep()` calls — all values come from `RateLimitManager`
- [ ] `SandboxGuard.assertCallPermitted` called before EVERY outbound fetch
- [ ] D15 checklist fully satisfied (review sub-agent will verify)

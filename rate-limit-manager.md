# Task: rate-limit-manager

## Goal
Implement D15 — Graph API Resilience. Parse `X-App-Usage`, schedule exponential backoff with full jitter, respect `Retry-After`. Zero hardcoded retry intervals.

## D15 Quality Dimension (Meta Graph API Extension §2)
This task is the direct implementation target of D15. The review sub-agent MUST validate this task against D15 before merge.

| Check | Implementation target |
|-------|-----------------------|
| Parses `X-App-Usage` | `RateLimitManager.parseUsageHeader()` |
| Exponential backoff on `429` or usage warning | `RateLimitManager.getBackoffMs()` |
| Respects `Retry-After` | Priority override in `getBackoffMs()` |
| No hardcoded retry intervals | Lint rule + test assertion |

---

## TDD Steps

### Step 1 — Write Failing Tests First

**File**: `src/__tests__/rate-limit-manager.test.ts`

```typescript
import { RateLimitManager, AppUsage } from '../rate-limit-manager';

describe('RateLimitManager', () => {

  describe('parseUsageHeader', () => {
    it('parses a valid X-App-Usage header', () => {
      const mgr = new RateLimitManager();
      const usage = mgr.parseUsageHeader(
        '{"call_count":72,"total_cputime":45,"total_time":50}'
      );
      expect(usage).toEqual({ call_count: 72, total_cputime: 45, total_time: 50 });
    });

    it('returns null for missing or malformed header', () => {
      const mgr = new RateLimitManager();
      expect(mgr.parseUsageHeader(null)).toBeNull();
      expect(mgr.parseUsageHeader('NOT_JSON')).toBeNull();
    });
  });

  describe('isThrottleWarning', () => {
    it('returns true when any axis exceeds the warning threshold (80%)', () => {
      const mgr = new RateLimitManager({ warningThreshold: 80 });
      expect(mgr.isThrottleWarning({ call_count: 85, total_cputime: 20, total_time: 20 })).toBe(true);
      expect(mgr.isThrottleWarning({ call_count: 20, total_cputime: 81, total_time: 20 })).toBe(true);
    });

    it('returns false when all axes are below threshold', () => {
      const mgr = new RateLimitManager({ warningThreshold: 80 });
      expect(mgr.isThrottleWarning({ call_count: 70, total_cputime: 70, total_time: 70 })).toBe(false);
    });
  });

  describe('getBackoffMs', () => {
    it('returns Retry-After ms when header is present on 429', () => {
      const mgr = new RateLimitManager();
      // Retry-After: 30 seconds
      const ms = mgr.getBackoffMs({ statusCode: 429, retryAfterSeconds: 30, attempt: 1 });
      expect(ms).toBe(30_000);
    });

    it('uses exponential backoff with jitter when Retry-After is absent', () => {
      const mgr = new RateLimitManager({ baseDelayMs: 1000, capMs: 32_000 });
      // Run 100 times to validate jitter range for attempt=3
      const results = Array.from({ length: 100 }, () =>
        mgr.getBackoffMs({ statusCode: 429, retryAfterSeconds: null, attempt: 3 })
      );
      const max = Math.max(...results);
      const min = Math.min(...results);
      // Full jitter: [0, min(cap, base * 2^attempt)] = [0, min(32000, 8000)]
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(8_000);
      // Jitter must actually vary — not a constant
      expect(max).toBeGreaterThan(min);
    });

    it('caps backoff at configured maximum', () => {
      const mgr = new RateLimitManager({ baseDelayMs: 1000, capMs: 5_000 });
      for (let attempt = 10; attempt <= 20; attempt++) {
        const ms = mgr.getBackoffMs({ statusCode: 429, retryAfterSeconds: null, attempt });
        expect(ms).toBeLessThanOrEqual(5_000);
      }
    });

    it('MUST NOT return a hardcoded constant across attempts', () => {
      const mgr = new RateLimitManager({ baseDelayMs: 1000, capMs: 64_000 });
      const results = new Set(
        [1, 2, 3, 4, 5].map(attempt =>
          // Seed-free, so run multiple times and check spread
          mgr.getBackoffMs({ statusCode: 429, retryAfterSeconds: null, attempt })
        )
      );
      // Should not always produce the same value for different attempts
      // (probabilistic — we allow very small chance of collision on low attempts)
      expect(results.size).toBeGreaterThan(1);
    });
  });
});
```

**Run tests — expect RED.**

---

### Step 2 — Implement

**File**: `src/rate-limit-manager.ts`

```typescript
export interface AppUsage {
  call_count: number;
  total_cputime: number;
  total_time: number;
}

interface RateLimitConfig {
  warningThreshold?: number; // default 80
  baseDelayMs?: number;      // default 1000
  capMs?: number;            // default 32_000
}

interface BackoffInput {
  statusCode: number;
  retryAfterSeconds: number | null;
  attempt: number;
}

export class RateLimitManager {
  private readonly warningThreshold: number;
  private readonly baseDelayMs: number;
  private readonly capMs: number;

  constructor(config: RateLimitConfig = {}) {
    this.warningThreshold = config.warningThreshold ?? 80;
    this.baseDelayMs = config.baseDelayMs ?? 1_000;
    this.capMs = config.capMs ?? 32_000;
  }

  parseUsageHeader(header: string | null | undefined): AppUsage | null {
    if (!header) return null;
    try {
      const parsed = JSON.parse(header);
      if (
        typeof parsed.call_count === 'number' &&
        typeof parsed.total_cputime === 'number' &&
        typeof parsed.total_time === 'number'
      ) {
        return parsed as AppUsage;
      }
      return null;
    } catch {
      return null;
    }
  }

  isThrottleWarning(usage: AppUsage): boolean {
    return (
      usage.call_count >= this.warningThreshold ||
      usage.total_cputime >= this.warningThreshold ||
      usage.total_time >= this.warningThreshold
    );
  }

  getBackoffMs(input: BackoffInput): number {
    // Retry-After takes absolute priority
    if (input.retryAfterSeconds !== null) {
      return input.retryAfterSeconds * 1_000;
    }

    // Full jitter exponential backoff: random(0, min(cap, base * 2^attempt))
    const ceiling = Math.min(this.capMs, this.baseDelayMs * Math.pow(2, input.attempt));
    return Math.floor(Math.random() * ceiling);
  }
}
```

**Run tests — expect GREEN.**

---

### Step 3 — Verify & Refactor
- Grep the entire codebase for magic numbers like `sleep(5000)`, `setTimeout.*[0-9]{4,}` — must be zero
- `getBackoffMs` must never return a hardcoded constant
- Export `AppUsage` interface for use in `GraphApiClient`

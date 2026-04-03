# Meta Graph API Integration — Architecture Plan

---

## Architecture Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        INBOUND LAYER                            │
│                                                                 │
│   Meta Platform ──► POST /webhook ──► WebhookController        │
│                          │                                      │
│                          ▼                                      │
│                 [ IdempotencyGuard ]                            │
│                   (keyed on `mid`)                              │
│                          │                                      │
│                    dup? ─┤─► 200 OK (silently discard)         │
│                    new?  ▼                                      │
│                 [ MessageQueue ]                                │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PROCESSING LAYER                            │
│                                                                 │
│              MessageProcessor                                   │
│                  │         │                                    │
│                  ▼         ▼                                    │
│           ConvStore    LLMService                               │
│         (persist msg)  (generate reply)                        │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OUTBOUND LAYER                             │
│                                                                 │
│              GraphApiClient                                     │
│       ┌──────────┴───────────┐                                  │
│       ▼                      ▼                                  │
│  SandboxGuard          RateLimitManager                        │
│  (pre-flight)          (X-App-Usage parser,                    │
│                         backoff scheduler,                     │
│                         Retry-After respector)                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dependency Graph

```
sandbox-config
    └── graph-api-client
            ├── rate-limit-manager
            └── sandbox-guard

idempotency-store
    └── webhook-controller
            └── message-processor
                    ├── conversation-store
                    └── llm-service
                            └── graph-api-client
```

**Build order enforced by execution_order in state.json.**

---

## Key Design Decisions

### 1. Idempotency via `mid` (not timestamp, not sender)
The `mid` field from Meta's payload is globally unique per message. Using it as the idempotency key means:
- Redis `SET mid NX EX 86400` — atomic check-and-set, 24h TTL
- If the key already exists → 200 and exit. No processing.
- If not → SET key, proceed.

This handles both network retries from Meta AND malicious/accidental replay.

### 2. Sandbox Guard — Fail-Closed
The guard is not a flag you can "forget." It wraps `fetch`/`axios` at the HTTP client level, not at the business logic level. Any outbound call to `graph.facebook.com` goes through it unconditionally.

```typescript
// Pseudo-structure
class SandboxGuard {
  assertCallPermitted(accountId: string): void {
    if (process.env.IG_SANDBOX_MODE !== 'true') {
      if (!this.testUsers.has(accountId)) {
        throw new Error(
          'Production API calls blocked – missing sandbox configuration'
        );
      }
    }
  }
}
```

### 3. Rate Limit Manager — Dynamic, Not Hardcoded
```
X-App-Usage: {"call_count":72,"total_cputime":45,"total_time":50}
```
- At ≥80% on any axis → preemptive backoff before the next call
- On `429` → read `Retry-After`; if absent, use exponential backoff with full jitter: `min(cap, random(0, base * 2^attempt))`
- No `sleep(5000)` anywhere in the codebase — CI lint rule enforced

---

## Acceptance Criteria (Testable)

| # | Criterion | Test file |
|---|-----------|-----------|
| AC1 | Duplicate `mid` payload → single DB row | `webhook.idempotency.test.ts` |
| AC2 | Duplicate `mid` payload → single LLM call | `webhook.idempotency.test.ts` |
| AC3 | `IG_SANDBOX_MODE=false` + unknown account → throws | `sandbox-guard.test.ts` |
| AC4 | `X-App-Usage` at 85% → backoff triggered | `rate-limit-manager.test.ts` |
| AC5 | `429` + `Retry-After: 30` → waits 30s (mocked) | `rate-limit-manager.test.ts` |
| AC6 | All tests pass with `IG_SANDBOX_MODE=true` | CI pipeline |

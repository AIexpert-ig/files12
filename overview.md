# Meta Graph API Integration — Feature Overview

## Feature Name
`meta-graph-api` — Instagram Messaging via Meta Graph API

## Scope
Full-stack integration with Meta's Graph API to handle Instagram Direct Messages:
- Webhook ingestion (receive incoming messages)
- LLM response generation pipeline
- Outbound message dispatch via Graph API
- Rate-limit awareness + exponential backoff (D15)
- Webhook idempotency via `mid` deduplication
- Strict sandbox enforcement before any production call

## Tech Stack Assumptions
- **Runtime**: Node.js (TypeScript)
- **Framework**: Express (webhook receiver) or equivalent
- **Queue**: In-memory or Redis-backed idempotency store
- **Testing**: Jest + Supertest
- **Env management**: `dotenv`

## Mandatory Overrides Applied
| Override | Source | Status |
|----------|--------|--------|
| Sandbox pre-flight on every API call | Meta Graph API Extension §1 | ✅ Enforced in every task |
| D15 Graph API Resilience dimension | Meta Graph API Extension §2 | ✅ Added to review matrix |
| Webhook idempotency test before handler impl | Meta Graph API Extension §3 | ✅ TDD step injected |
| `meta_api_requirements` block in state.json | Meta Graph API Extension §4 | ✅ In state.json |

## Acceptance Criteria
1. Webhook receives `messaging` events and parses them correctly.
2. Identical payloads with the same `mid` are deduplicated — no duplicate DB writes, no duplicate LLM calls.
3. Every outbound Graph API call validates sandbox mode before execution.
4. Rate-limit headers (`X-App-Usage`) are parsed; `429` responses trigger exponential backoff with jitter.
5. `Retry-After` header is respected when present; no hardcoded retry intervals exist.
6. All tests pass with `IG_SANDBOX_MODE=true`; tests that hit real endpoints without `sandbox: true` fixture are rejected at CI.

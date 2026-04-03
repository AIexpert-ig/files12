# Task: sandbox-config

## Goal
Establish the sandbox enforcement layer. This is the foundation every other task builds on. No Graph API call can bypass it.

## Sandbox Pre-flight Override (Meta Graph API Extension §1)
This task IS the pre-flight. It must be completed and reviewed before any task that makes outbound API calls.

---

## TDD Steps

### Step 1 — Write Failing Tests First

**File**: `src/__tests__/sandbox-guard.test.ts`

```typescript
import { SandboxGuard } from '../sandbox-guard';

describe('SandboxGuard', () => {
  const TEST_USER_ID = 'test_user_123';

  beforeEach(() => {
    delete process.env.IG_SANDBOX_MODE;
  });

  it('permits call when IG_SANDBOX_MODE=true regardless of account', () => {
    process.env.IG_SANDBOX_MODE = 'true';
    const guard = new SandboxGuard([]);
    expect(() => guard.assertCallPermitted('any_account_id')).not.toThrow();
  });

  it('permits call when account is a registered test user', () => {
    process.env.IG_SANDBOX_MODE = 'false';
    const guard = new SandboxGuard([TEST_USER_ID]);
    expect(() => guard.assertCallPermitted(TEST_USER_ID)).not.toThrow();
  });

  it('blocks call when IG_SANDBOX_MODE is not true AND account is unknown', () => {
    process.env.IG_SANDBOX_MODE = 'false';
    const guard = new SandboxGuard([TEST_USER_ID]);
    expect(() => guard.assertCallPermitted('unknown_prod_account')).toThrow(
      'Production API calls blocked – missing sandbox configuration'
    );
  });

  it('blocks call when IG_SANDBOX_MODE is absent AND account is unknown', () => {
    const guard = new SandboxGuard([]);
    expect(() => guard.assertCallPermitted('any_account')).toThrow(
      'Production API calls blocked – missing sandbox configuration'
    );
  });

  it('loads test users from IG_TEST_USER_IDS env var', () => {
    process.env.IG_SANDBOX_MODE = 'false';
    process.env.IG_TEST_USER_IDS = `${TEST_USER_ID},other_user`;
    const guard = SandboxGuard.fromEnv();
    expect(() => guard.assertCallPermitted(TEST_USER_ID)).not.toThrow();
    expect(() => guard.assertCallPermitted('other_user')).not.toThrow();
    expect(() => guard.assertCallPermitted('stranger')).toThrow();
    delete process.env.IG_TEST_USER_IDS;
  });
});
```

**Run tests — expect RED.**

---

### Step 2 — Implement

**File**: `src/sandbox-guard.ts`

```typescript
export class SandboxGuard {
  private readonly testUserSet: ReadonlySet<string>;

  constructor(testUserIds: string[]) {
    this.testUserSet = new Set(testUserIds);
  }

  static fromEnv(): SandboxGuard {
    const raw = process.env.IG_TEST_USER_IDS ?? '';
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    return new SandboxGuard(ids);
  }

  assertCallPermitted(accountId: string): void {
    const isSandboxMode = process.env.IG_SANDBOX_MODE === 'true';
    if (isSandboxMode) return;

    if (!this.testUserSet.has(accountId)) {
      throw new Error(
        'Production API calls blocked – missing sandbox configuration'
      );
    }
  }
}
```

**Run tests — expect GREEN.**

---

### Step 3 — Verify & Refactor
- Ensure error message is byte-for-byte: `'Production API calls blocked – missing sandbox configuration'`
- No `console.log` statements
- Export is named, not default (downstream tasks import by name)

---

## Acceptance Check
- [ ] All 5 tests green
- [ ] Error string matches spec exactly
- [ ] `SandboxGuard.fromEnv()` factory exists for DI in GraphApiClient

# Deep Analysis Remediation — Consolidated Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remediate all actionable open findings from the 4 remaining deep analysis reports (2026-03-09).

**Architecture:** Fixes are grouped by file/module for efficient batching. Each phase is ordered by severity (correctness > security > operations > quality). TDD where applicable — write failing test first, then implement.

**Tech Stack:** TypeScript, Node.js, Jest, Hardhat, ioredis, SharedArrayBuffer

---

## Source Reports & Status Summary

| Report | Total | Remediated | Open | Deferred |
|--------|-------|------------|------|----------|
| DEEP_ANALYSIS_SHARED_CORE_2026-03-09 | 29 | 4 | 25 | 0 |
| EXTENDED_DEEP_ANALYSIS_CONTRACTS_CONFIG_2026-03-09 | 31 | 27 | 0 | 4 |
| EXTENDED_DEEP_ANALYSIS_SHARED_CONFIG_2026-03-09 | 23 | 4 | 18 | 1 |
| DEEP_ANALYSIS_CONTRACTS_TEST_2026-03-09 | 24 | 14 | 10 | 0 |
| **Totals** | **107** | **49** | **53** | **5** |

Open breakdown: **2 HIGH**, **23 MEDIUM**, **28 LOW** = 53 actionable findings across 4 phases.

---

## Phase 1: Correctness & Security Fixes (12 findings)

These affect runtime behavior, data integrity, or security.

### Task 1: Distributed Lock — Race Condition + Weak Token (SC-M-012, SC-L-011)

**Findings:**
- SC-M-012: Lock timeout race — QueuedWaiter can settle twice (timeout fires after notifyNextWaiter)
- SC-L-011: `Math.random()` for lock token values — predictable, should use `crypto.randomBytes`

**Files:**
- Modify: `shared/core/src/redis/distributed-lock.ts:93-97,622-624,651-677`
- Test: `shared/core/__tests__/unit/redis/distributed-lock.test.ts`

**Step 1: Write failing test for race condition**

```typescript
it('should not resolve waiter twice when timeout fires after notifyNextWaiter', async () => {
  // Acquire lock so next caller queues
  const handle1 = await lock.acquireLock('race-test');

  // Queue a waiter with short timeout
  const waiterPromise = lock.acquireWithQueue('race-test', { queueTimeoutMs: 50 });

  // Release after timeout fires — should not cause double-resolve
  await new Promise(resolve => setTimeout(resolve, 100));
  await handle1.release();

  // Waiter should have timed out cleanly
  const result = await waiterPromise;
  expect(result.acquired).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest shared/core/__tests__/unit/redis/distributed-lock.test.ts -t "should not resolve waiter twice" --no-coverage`
Expected: Potential unhandled promise rejection or wrong result

**Step 3: Implement fix**

In `distributed-lock.ts`:
```typescript
// Line 93: Add settled flag to QueuedWaiter
interface QueuedWaiter {
  resolve: (handle: LockHandle) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  settled: boolean;  // SC-M-012 FIX: prevent double-settle
}

// Line 624: Replace Math.random with crypto.randomBytes
import { randomBytes } from 'node:crypto';

private generateLockValue(): string {
  return `${this.instanceId}:${Date.now()}:${randomBytes(6).toString('hex')}`;
}

// Line 657-677: Guard notifyNextWaiter against already-settled waiters
private notifyNextWaiter(key: string): void {
  const queue = this.waitQueues.get(key);
  if (!queue || queue.length === 0) return;

  const waiter = queue.shift()!;
  clearTimeout(waiter.timeoutId);

  if (waiter.settled) {
    // SC-M-012 FIX: timeout already settled this waiter, skip
    if (queue.length === 0) this.waitQueues.delete(key);
    this.updateQueueStats();
    this.notifyNextWaiter(key); // try next waiter
    return;
  }
  waiter.settled = true;

  if (queue.length === 0) this.waitQueues.delete(key);
  this.updateQueueStats();

  const resourceId = key.startsWith(this.config.keyPrefix)
    ? key.slice(this.config.keyPrefix.length)
    : key;

  this.logger.debug('Waking queued waiter', { key, remainingInQueue: queue.length });
  this.acquireLock(resourceId).then(
    (handle) => waiter.resolve(handle),
    (error) => waiter.reject(error)
  );
}
```

Also guard the timeout callback (wherever waiters are created) to set `settled = true` before calling reject.

**Step 4: Run tests**

Run: `npx jest shared/core/__tests__/unit/redis/distributed-lock.test.ts --no-coverage`
Expected: All PASS

**Step 5: Commit**

```bash
git add shared/core/src/redis/distributed-lock.ts shared/core/__tests__/unit/redis/distributed-lock.test.ts
git commit -m "fix(core): distributed lock race condition + crypto-random tokens (SC-M-012, SC-L-011)"
```

---

### Task 2: DLQ — Unbounded retryInFlight + || to ?? (SC-M-007, SC-L-006)

**Findings:**
- SC-M-007: `retryInFlight` Set has no upper bound — memory leak under high retry load
- SC-L-006: `limit || this.config.batchSize` should use `??` (limit=0 is meaningful)

**Files:**
- Modify: `shared/core/src/resilience/dead-letter-queue.ts:249,415`
- Test: `shared/core/__tests__/unit/resilience/dead-letter-queue.test.ts`

**Step 1: Write failing test**

```typescript
it('should use limit=0 as-is, not fall back to batchSize', async () => {
  const result = await dlq.processDeadLetters(0);
  expect(result.processed).toBe(0);
});

it('should reject retry when retryInFlight exceeds max', async () => {
  // Fill up retryInFlight to max (e.g., 1000)
  for (let i = 0; i < 1000; i++) {
    (dlq as any).retryInFlight.add(`op-${i}`);
  }
  const result = await dlq.retryOperation('new-op');
  expect(result).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest shared/core/__tests__/unit/resilience/dead-letter-queue.test.ts -t "limit=0|retryInFlight exceeds" --no-coverage`

**Step 3: Implement fix**

```typescript
// Line 249: || → ??
const batchSize = limit ?? this.config.batchSize;

// Line 415: Add max size constant + guard
private static readonly MAX_RETRY_IN_FLIGHT = 1000;
private retryInFlight = new Set<string>();

// In retryOperation(), after the existing idempotency guard:
if (this.retryInFlight.size >= DeadLetterQueue.MAX_RETRY_IN_FLIGHT) {
  this.logger.warn('retryInFlight at capacity, rejecting retry', {
    operationId, size: this.retryInFlight.size
  });
  return false;
}
```

**Step 4: Run tests**

Run: `npx jest shared/core/__tests__/unit/resilience/dead-letter-queue.test.ts --no-coverage`

**Step 5: Commit**

```bash
git add shared/core/src/resilience/dead-letter-queue.ts shared/core/__tests__/unit/resilience/dead-letter-queue.test.ts
git commit -m "fix(core): DLQ unbounded retryInFlight + nullish coalescing (SC-M-007, SC-L-006)"
```

---

### Task 3: Health Server — Body Size Limit (SC-M-010)

**Findings:**
- SC-M-010: PUT /log-level body accumulation has no size limit — DoS defense-in-depth

**Files:**
- Modify: `shared/core/src/partition/health-server.ts:226-231`
- Test: `shared/core/__tests__/unit/partition/health-server.test.ts`

**Step 1: Write failing test**

```typescript
it('should reject request body exceeding 1KB', async () => {
  const largeBody = JSON.stringify({ level: 'debug', padding: 'x'.repeat(2000) });
  const response = await fetch(`http://localhost:${port}/log-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: largeBody,
  });
  expect(response.status).toBe(413);
});
```

**Step 2: Implement fix**

```typescript
// Line 227-228: Add size guard
const body = await new Promise<string>((resolve, reject) => {
  let data = '';
  req.on('data', (chunk: Buffer) => {
    data += chunk.toString();
    if (data.length > 1024) {
      req.destroy();
      reject(new Error('Body too large'));
    }
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});
```

Add a catch for the "Body too large" error to return 413:
```typescript
} catch (bodyError) {
  if ((bodyError as Error).message === 'Body too large') {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large' }));
    return;
  }
  throw bodyError;
}
```

**Step 3: Run tests**

Run: `npx jest shared/core/__tests__/unit/partition/health-server.test.ts --no-coverage`

**Step 4: Commit**

```bash
git add shared/core/src/partition/health-server.ts shared/core/__tests__/unit/partition/health-server.test.ts
git commit -m "fix(core): health server body size limit 1KB (SC-M-010)"
```

---

### Task 4: PriceMatrix — setBatch Stats Overcount (SC-M-009)

**Findings:**
- SC-M-009: `stats.writes += resolvedCount` includes entries skipped by monotonic timestamp check

**Files:**
- Modify: `shared/core/src/caching/price-matrix.ts:945`
- Test: `shared/core/__tests__/unit/caching/price-matrix.test.ts`

**Step 1: Write failing test**

```typescript
it('should count only actual writes in setBatch stats, not skipped entries', () => {
  // Set initial values with timestamp=100
  matrix.setBatch([
    { key: 'ETH/USDC', price: 2000, timestamp: 100 },
    { key: 'BTC/USDC', price: 50000, timestamp: 100 }
  ]);
  const writesBefore = matrix.getStats().writes;

  // Set again with older timestamp — should be skipped by monotonic check
  matrix.setBatch([
    { key: 'ETH/USDC', price: 2001, timestamp: 50 },  // older, skipped
    { key: 'BTC/USDC', price: 50001, timestamp: 200 }  // newer, written
  ]);
  const writesAfter = matrix.getStats().writes;

  expect(writesAfter - writesBefore).toBe(1); // only BTC was actually written
});
```

**Step 2: Implement fix**

In the write loop (phase 2), add an `actualWrites` counter that only increments when the monotonic check passes:

```typescript
let actualWrites = 0;
// ... in the write loop ...
if (currentTs > relativeTs) continue; // skipped
// ... write happens ...
actualWrites++;

// Line 945: Use actualWrites instead of resolvedCount
this.stats.writes += actualWrites;
```

**Step 3: Run tests**

Run: `npx jest shared/core/__tests__/unit/caching/price-matrix.test.ts --no-coverage`

**Step 4: Commit**

```bash
git add shared/core/src/caching/price-matrix.ts shared/core/__tests__/unit/caching/price-matrix.test.ts
git commit -m "fix(core): price-matrix setBatch stats count actual writes only (SC-M-009)"
```

---

### Task 5: Config Data Fixes — DAI, MNT, Stale Deferred Items (CFG-M-001, CFG-L-005, CFG-M-010, CFG-L-004)

**Findings:**
- CFG-M-001: DAI missing from `TOKEN_METADATA.ethereum.stablecoins`
- CFG-L-005: MNT (WMNT) listed in `STABLECOINS.mantle` — it's the native token, not a stablecoin
- CFG-M-010: D5 and D9 deferred items still `status: 'stub'` despite resolved blockers
- CFG-L-004: Stale "stub chain — no DEX factories" comment in thresholds.ts

**Files:**
- Modify: `shared/config/src/tokens/index.ts:548-551`
- Modify: `shared/config/src/addresses.ts:526`
- Modify: `shared/config/src/deferred-items.ts:69-88`
- Modify: `shared/config/src/thresholds.ts:224`
- Test: `shared/config/__tests__/unit/config-modules.test.ts`

**Step 1: Write failing tests**

```typescript
it('should include DAI in ethereum TOKEN_METADATA stablecoins', () => {
  const ethStables = TOKEN_METADATA.ethereum.stablecoins;
  expect(ethStables.some(s => s.symbol === 'DAI')).toBe(true);
});

it('should not include MNT/WMNT in mantle STABLECOINS', () => {
  expect(STABLECOINS.mantle).not.toHaveProperty('MNT');
  expect(STABLECOINS.mantle).not.toHaveProperty('WMNT');
});
```

**Step 2: Implement fixes**

```typescript
// tokens/index.ts line 548-551: Add DAI to ethereum stablecoins
ethereum: {
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  nativeWrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  stablecoins: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 }
  ]
},

// addresses.ts line 526: Remove MNT from mantle STABLECOINS
// (MNT is the native token, not a stablecoin — WMNT is available via nativeWrapper)

// deferred-items.ts: Update D5 and D9 status
// D5 (line 71): status: 'resolved', blocker: 'DEX factories RPC-validated 2026-03-08'
// D9 (line 85): status: 'resolved', blocker: 'Added to PARTITIONS 2026-03-10'

// thresholds.ts line 224: Remove stale comment
// Delete: "NOTE: mantle/mode have thresholds defined but are currently stubs (no DEX factories)."
// Replace with: "NOTE: mantle/mode DEX factories RPC-validated 2026-03-08, added to partitions 2026-03-10."
```

**Step 3: Run tests**

Run: `npx jest shared/config/__tests__/unit --no-coverage`

**Step 4: Commit**

```bash
git add shared/config/src/tokens/index.ts shared/config/src/addresses.ts shared/config/src/deferred-items.ts shared/config/src/thresholds.ts shared/config/__tests__/unit/config-modules.test.ts
git commit -m "fix(config): add ETH DAI, remove MNT from stablecoins, resolve deferred items (CFG-M-001, CFG-L-005, CFG-M-010, CFG-L-004)"
```

---

### Task 6: Cross-Package Relative Path (SC-M-011)

**Findings:**
- SC-M-011: `price-calculator.ts` re-exports from `'../../../config/src/thresholds'` — violates `@arbitrage/*` convention

**Files:**
- Modify: `shared/core/src/components/price-calculator.ts:480,483`

**Step 1: Implement fix**

```typescript
// Replace lines 480, 483:
export { getMinProfitThreshold } from '@arbitrage/config';
export { getConfidenceMaxAgeMs } from '@arbitrage/config';
```

**Step 2: Build and verify**

Run: `npm run build:deps && npm run typecheck`
Expected: Clean build

**Step 3: Commit**

```bash
git add shared/core/src/components/price-calculator.ts
git commit -m "fix(core): use @arbitrage/config import instead of relative path (SC-M-011)"
```

---

## Phase 2: Operational Robustness (11 findings)

These improve observability, validation strictness, and graceful behavior.

### Task 7: Config Validation Strictness (CFG-M-002, CFG-M-005, CFG-M-009, CFG-L-007)

**Findings:**
- CFG-M-002: Flash loan provider Zod validation only warns, never throws in production
- CFG-M-005: `process.exit(1)` in feature-flags.ts bypasses graceful shutdown
- CFG-M-009: Invalid `EXECUTION_CHAIN_GROUP` logs warn, not error
- CFG-L-007: Stack trace lost on feature flag validation error

**Files:**
- Modify: `shared/config/src/service-config.ts:503-511`
- Modify: `shared/config/src/feature-flags.ts:829,835`
- Modify: `shared/config/src/execution-chain-groups.ts:129`

**Step 1: Write failing tests**

```typescript
// service-config test
it('should throw on invalid flash loan provider addresses in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.FLASH_LOAN_PROVIDERS = '{"aave_v3": "not-an-address"}';
  expect(() => parseFlashLoanProviders()).toThrow();
});
```

**Step 2: Implement fixes**

```typescript
// service-config.ts:506-510 — Throw in production when Zod validation fails
const result = FlashLoanProvidersSchema.safeParse(parsed);
if (!result.success) {
  const msg = `Invalid flash loan provider config: ${result.error.message}`;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(msg);
  }
  console.warn(`[WARN] ${msg} — using defaults`);
}

// feature-flags.ts:835 — Replace process.exit with throw
throw new Error(`Configuration error in production mode: ${errorMessage}`);

// feature-flags.ts:829 — Include full error object
console.error('CRITICAL CONFIGURATION ERROR:', error);

// execution-chain-groups.ts:129 — warn → error
console.error(
  `[ERROR] EXECUTION_CHAIN_GROUP="${process.env.EXECUTION_CHAIN_GROUP}" is not a valid group ...`
);
```

**Step 3: Run tests**

Run: `npx jest shared/config/__tests__/unit --no-coverage`

**Step 4: Commit**

```bash
git add shared/config/src/service-config.ts shared/config/src/feature-flags.ts shared/config/src/execution-chain-groups.ts
git commit -m "fix(config): stricter validation — throw in production, log full errors (CFG-M-002, CFG-M-005, CFG-M-009, CFG-L-007)"
```

---

### Task 8: Stream Health Monitor — Consumer Count + Message Age (SC-M-004, SC-L-003)

**Findings:**
- SC-M-004: `consumerCount: 0` hardcoded — XINFO GROUPS not called
- SC-L-003: `oldestMessageAge: 0` — never calculated from message IDs

**Files:**
- Modify: `shared/core/src/monitoring/stream-health-monitor.ts:538-539`
- Test: `shared/core/__tests__/unit/monitoring/stream-health-monitor.test.ts`

**Step 1: Write failing test**

```typescript
it('should report actual consumer count from XINFO GROUPS', async () => {
  // Mock redis.xinfo to return group data with consumers
  mockRedis.xinfo.mockResolvedValue([
    ['name', 'group1', 'consumers', 3, 'pending', 0, 'last-delivered-id', '0-0']
  ]);

  const health = await monitor.checkStreamHealth('test-stream');
  expect(health.consumerCount).toBe(3);
});
```

**Step 2: Implement fix**

Add XINFO GROUPS call inside the health check:

```typescript
// Replace hardcoded consumerCount: 0
let consumerCount = 0;
try {
  const groups = await this.redis.xinfo('GROUPS', streamName) as unknown[][];
  for (const group of groups) {
    const consumersIdx = (group as string[]).indexOf('consumers');
    if (consumersIdx !== -1) {
      consumerCount += Number(group[consumersIdx + 1]) || 0;
    }
  }
} catch { /* stream may not have groups yet */ }

// Replace hardcoded oldestMessageAge: 0
let oldestMessageAge = 0;
if (firstEntryId) {
  const tsMs = parseInt(firstEntryId.split('-')[0], 10);
  if (!isNaN(tsMs)) {
    oldestMessageAge = Date.now() - tsMs;
  }
}
```

**Step 3: Run tests**

Run: `npx jest shared/core/__tests__/unit/monitoring/stream-health-monitor.test.ts --no-coverage`

**Step 4: Commit**

```bash
git add shared/core/src/monitoring/stream-health-monitor.ts shared/core/__tests__/unit/monitoring/stream-health-monitor.test.ts
git commit -m "fix(core): stream health monitor real consumer count + message age (SC-M-004, SC-L-003)"
```

---

### Task 9: Config Convention Fixes (CFG-M-003, CFG-M-004, CFG-L-003)

**Findings:**
- CFG-M-003: `validateRiskConfig()` catches errors in dev and only logs
- CFG-M-004: FL aggregator weight sum != 1.0 only warns in dev
- CFG-L-003: `|| ''` instead of `?? ''` in service-config.ts:101

**Files:**
- Modify: `shared/config/src/risk-config.ts:432-442`
- Modify: `shared/config/src/feature-flags.ts:515-518`
- Modify: `shared/config/src/service-config.ts:101`

**Step 1: Implement fixes**

```typescript
// risk-config.ts: Throw in development too (not just production)
// Change the catch block to re-throw in all non-test environments
} catch (error) {
  if (process.env.NODE_ENV === 'test') {
    return; // Skip validation in test env
  }
  throw error; // Fail fast in production AND development
}

// feature-flags.ts:515-518: Throw in all environments when weights don't sum to 1.0
// Remove the if/else for production vs dev — always throw
throw new Error(`Flash loan aggregator weights must sum to 1.0, got ${weightSum}`);

// service-config.ts:101: || → ??
endpoints: (process.env.MONITORING_ENDPOINTS ?? '').split(',').filter(Boolean),
```

**Step 2: Run tests**

Run: `npx jest shared/config/__tests__/unit --no-coverage`

**Step 3: Commit**

```bash
git add shared/config/src/risk-config.ts shared/config/src/feature-flags.ts shared/config/src/service-config.ts
git commit -m "fix(config): fail-fast validation in all envs + nullish coalescing (CFG-M-003, CFG-M-004, CFG-L-003)"
```

---

### Task 10: Worker Pool — Unhandled .then() (SC-L-005)

**Findings:**
- SC-L-005: `worker.terminate().then(...)` without `.catch()` in worker-pool.ts (lines 406, 1221)

**Files:**
- Modify: `shared/core/src/async/worker-pool.ts:406,1221`

**Step 1: Implement fix**

```typescript
// Add .catch() to both terminate calls:
worker.terminate().then(
  () => { /* cleanup */ },
).catch((err) => {
  this.logger.warn('Worker terminate failed', { error: (err as Error).message });
});
```

**Step 2: Run tests**

Run: `npx jest shared/core/__tests__/unit/async/worker-pool.test.ts --no-coverage`

**Step 3: Commit**

```bash
git add shared/core/src/async/worker-pool.ts
git commit -m "fix(core): add .catch() to worker.terminate() calls (SC-L-005)"
```

---

## Phase 3: Type Safety & Code Quality (8 findings)

### Task 11: Typed Redis Stream Commands (SC-H-001, SC-L-002)

**Findings:**
- SC-H-001: 5 `as any` casts on ioredis stream commands (xread, xreadgroup, xclaim, xpending, xtrim)
- SC-L-002: 5 `eslint-disable-next-line` comments for the above

**Files:**
- Modify: `shared/core/src/redis/streams.ts:831-832,928-929,1329-1330,1413-1414,1457-1458`

**Step 1: Create typed ioredis extension**

Add a type declaration file or typed wrapper at the top of streams.ts:

```typescript
// SC-H-001 FIX: Typed ioredis stream command declarations
// ioredis doesn't export types for XREAD/XREADGROUP/etc with the full overloads.
// We extend the Redis interface to avoid `as any` casts.
interface TypedStreamRedis {
  xread(...args: (string | number)[]): Promise<[string, [string, string[]][]][] | null>;
  xreadgroup(...args: (string | number)[]): Promise<[string, [string, string[]][]][] | null>;
  xclaim(...args: (string | number)[]): Promise<[string, string[]][]>;
  xpending(key: string, group: string, ...args: (string | number)[]): Promise<unknown[]>;
  xtrim(key: string, strategy: string, ...args: (string | number)[]): Promise<number>;
}
```

Then replace the 5 `(this.client as any).xread(...)` calls with `(this.client as TypedStreamRedis).xread(...)`.

Remove the 5 `eslint-disable-next-line` comments.

**Step 2: Build and verify**

Run: `npm run typecheck`
Expected: Clean

**Step 3: Run tests**

Run: `npx jest shared/core/__tests__/unit/redis/ --no-coverage`

**Step 4: Commit**

```bash
git add shared/core/src/redis/streams.ts
git commit -m "fix(core): typed ioredis stream commands, remove 5 as-any casts (SC-H-001)"
```

---

### Task 12: Config Type Safety — Bridge Routes + FL Availability (CFG-M-007, CFG-M-008)

**Findings:**
- CFG-M-007: `BridgeRoute` uses `src: string` / `dst: string` — typos compile
- CFG-M-008: `FLASH_LOAN_AVAILABILITY` outer key is `Record<string, ...>` — typos compile

**Files:**
- Modify: `shared/config/src/bridge-config.ts:46-53`
- Modify: `shared/config/src/flash-loan-availability.ts:38-39`
- Modify: `shared/types/src/index.ts` (if ChainId type exists)

**Step 1: Check if a ChainId union type exists**

Look for an existing `ChainId` or `SupportedChain` type in `@arbitrage/types`. If none exists, add runtime validation at the point of map construction rather than creating a new type (simpler, no breaking change).

**Step 2: Add runtime validation**

```typescript
// bridge-config.ts: Validate at module load
import { CHAINS } from './chains';
const validChains = new Set(Object.keys(CHAINS));
for (const route of BRIDGE_ROUTES) {
  if (!validChains.has(route.src)) throw new Error(`Invalid bridge src chain: ${route.src}`);
  if (!validChains.has(route.dst)) throw new Error(`Invalid bridge dst chain: ${route.dst}`);
}

// flash-loan-availability.ts: Validate at module load
for (const chain of Object.keys(FLASH_LOAN_AVAILABILITY)) {
  if (!validChains.has(chain)) throw new Error(`Invalid FL availability chain: ${chain}`);
}
```

**Step 3: Run tests**

Run: `npx jest shared/config/__tests__/unit --no-coverage`

**Step 4: Commit**

```bash
git add shared/config/src/bridge-config.ts shared/config/src/flash-loan-availability.ts
git commit -m "fix(config): runtime chain ID validation for bridge routes + FL availability (CFG-M-007, CFG-M-008)"
```

---

### Task 13: Misc Config LOWs Batch (CFG-L-001, CFG-L-002, CFG-L-008)

**Findings:**
- CFG-L-001: Chain RPC URL `||` pattern — theoretical but matches convention enforcement
- CFG-L-002: Feature flag `setTimeout` validation window — documented, low risk
- CFG-L-008: Mixed emoji in feature flag logging

**Assessment:** CFG-L-001 uses `||` for RPC URLs where empty string fallback to drpc is actually beneficial. **No action needed** — document as accepted. CFG-L-002 is by design. CFG-L-008 is cosmetic.

**Action:** Skip. Mark these 3 as ACCEPTED in the tracking table.

---

## Phase 4: Test Quality & Refactoring (10 findings)

### Task 14: Contract Test DRY Extraction (CT-M-08, CT-M-09)

**Findings:**
- CT-M-08: Protocol deployment tests repeat ~75 LOC across 5 files
- CT-M-09: Flash loan fixture factory ~60 LOC repeated in 3 files

**Files:**
- Create: `contracts/test/helpers/shared-deployment-tests.ts`
- Create: `contracts/test/helpers/shared-flash-loan-fixture.ts`
- Modify: 5 protocol test files (deployment), 3 test files (fixtures)

**Step 1: Extract shared deployment test helper**

Read all 5 protocol test files, identify the common deployment test pattern, and extract to `shared-deployment-tests.ts`:

```typescript
export function testProtocolDeployment(
  deployFixture: () => Promise<DeployResult>,
  protocolName: string
) {
  describe(`${protocolName} Deployment`, () => {
    it('should set correct owner', async () => { /* ... */ });
    it('should set correct minimum profit', async () => { /* ... */ });
    // ... common tests
  });
}
```

**Step 2: Extract shared flash loan fixture factory**

```typescript
export function createFlashLoanFixture(protocol: 'aave' | 'balancer' | 'syncswap' | ...) {
  return async function deployFixture() {
    // Common deployment logic
    // Protocol-specific overrides
  };
}
```

**Step 3: Update 5 protocol test files to use the shared helper**

**Step 4: Run contract tests**

Run: `cd contracts && npx hardhat test`

**Step 5: Commit**

```bash
git add contracts/test/helpers/shared-deployment-tests.ts contracts/test/helpers/shared-flash-loan-fixture.ts contracts/test/*.test.ts
git commit -m "refactor(contracts): extract shared deployment + fixture helpers (CT-M-08, CT-M-09)"
```

---

### Task 15: Skipped Tests — Enable or Document (SC-M-002, SC-M-003)

**Findings:**
- SC-M-002: `describe.skip` on Worker Pool Real Integration tests
- SC-M-003: `it.skip` on SharedArrayBuffer buffer size test

**Files:**
- Modify: `shared/core/__tests__/unit/async/worker-pool-load.test.ts:276`
- Modify: `shared/core/__tests__/unit/worker-sharedbuffer.test.ts:321`

**Step 1: Investigate why each test is skipped**

Read the test code and determine if the skip reason still applies.

**Step 2: Either enable the test or add a TODO with issue link**

```typescript
// If still valid to skip:
describe.skip('Worker Pool Real Worker Integration — requires real worker files', () => {
  // TODO(#NNN): Enable when test worker fixture is available
```

**Step 3: Commit**

```bash
git add shared/core/__tests__/unit/async/worker-pool-load.test.ts shared/core/__tests__/unit/worker-sharedbuffer.test.ts
git commit -m "chore(core): document skipped test reasons (SC-M-002, SC-M-003)"
```

---

## Deferred Findings (Will Not Fix Now)

These are design decisions, feature gaps, or structural items deferred to future work:

| ID | Report | Severity | Title | Reason |
|----|--------|----------|-------|--------|
| CC-M-004 | Contracts/Config | MEDIUM | CommitReveal self-service recovery | Design decision — owner recovery is appropriate for bot operators |
| CC-M-006 | Contracts/Config | MEDIUM | No V2 price pools for Blast/Scroll/Mode | Deferred until TVL grows — ETH fallback is accurate |
| CC-M-008 | Contracts/Config | MEDIUM | validateFeatureFlags setTimeout | By design — fallback safety net, production still fails fast |
| CC-M-009 | Contracts/Config | MEDIUM | Solana zero flash loan protocols | Feature gap — requires Solend/Mango integration |
| SC-M-001 | Shared/Core | MEDIUM | LEGACY_HMAC_COMPAT shim | Deferred to v3.0 breaking change |
| SC-M-005 | Shared/Core | MEDIUM | Barrel export 2038 lines | Structural — no runtime impact |
| SC-M-006 | Shared/Core | MEDIUM | Static operationHandlers Map | Document in DLQ tests — no practical issue |
| SC-M-008 | Shared/Core | MEDIUM | CorrelationAnalyzer return unused | Remove TODO comment — return value unused by design |
| SC-H-002 | Shared/Core | HIGH | SharedKeyRegistry O(n) scan | OPT-004 — only affects worker cold-start, acceptable at ~1000 keys. Future: FNV-1a hash table in SAB |
| CT-M-04 | Contracts/Test | MEDIUM | MockQuoterV2 linear pricing | Would require new mock contract — low ROI |
| CT-L-01 | Contracts/Test | LOW | CommitReveal 3-file overlap | Refactoring — no correctness impact |
| CT-L-02 | Contracts/Test | LOW | Long it() blocks (>50 lines) | Cosmetic |
| CT-L-03..L-12 | Contracts/Test | LOW | Various test coverage gaps | Defense-in-depth, EVM guarantees correctness |
| SC-L-001..L-004 | Shared/Core | LOW | TODOs, eslint-disable (tied to H-001), hardcoded monitor values | Addressed by Phase 3 Task 11 (as any) or Phase 2 Task 8 (monitor) |
| SC-L-007..L-010 | Shared/Core | LOW | Decorator syntax, cast patterns, DLQ pipeline, double cast | Low-impact type/style issues |
| CFG-L-001 | Shared/Config | LOW | RPC URL `\|\|` pattern | Empty string fallback to drpc is beneficial |
| CFG-L-002 | Shared/Config | LOW | Feature flag setTimeout window | By design |
| CFG-L-006 | Shared/Config | LOW | checkFallbackPriceStaleness return | ETH fallback mitigates |
| CFG-L-008..L-010 | Shared/Config | LOW | Emoji logging, startup summary, toLowerCase | Cosmetic / negligible |

---

## Execution Summary

| Phase | Tasks | Findings | Estimated Commits |
|-------|-------|----------|-------------------|
| 1: Correctness & Security | 6 | 12 | 6 |
| 2: Operational Robustness | 4 | 11 | 4 |
| 3: Type Safety & Quality | 2 | 5 | 2 |
| 4: Test Quality & Refactoring | 2 | 3 | 2 |
| **Total actionable** | **14** | **31** | **14** |
| Deferred | — | 22 | — |

**Verification after all phases:**
```bash
npm run typecheck         # Must pass clean
npm run test:unit         # All unit tests pass
cd contracts && npx hardhat test  # All contract tests pass
```

# P0 Fix Impact Analysis

## Per-Fix Blast Radius

### Fix 1: REWRITE `s1.1-redis-streams.integration.test.ts` with real Redis

**Target file:** `tests/integration/s1.1-redis-streams.integration.test.ts` (920 lines)

**Current dependencies:**
- Imports from `@jest/globals` (jest, describe, it, expect, etc.)
- Imports from `@arbitrage/core`: `RedisStreamsClient`, `StreamBatcher`, `getRedisStreamsClient`, `resetRedisStreamsInstance`, `StreamHealthMonitor`, `getStreamHealthMonitor`, `resetStreamHealthMonitor`
- Imports from `../../shared/test-utils/src`: `delay`, `createMockPriceUpdate`, `createMockSwapEvent`
- Has 180+ lines of custom ioredis mock (lines 26-190) with inline `jest.mock('ioredis', () => {...})` factory
- Uses `globalThis.__mockRedisInstance` for cross-scope mock access

**External references:** Only referenced in `.agent-reports/` analysis docs, not imported by any code or other test files.

**Jest discovery:** Matched by root `jest.config.js` under the `integration` project (`**/tests/integration/**/*.test.ts`).

**Blast radius:**
- **HIGH** - Complete rewrite from mocked to real Redis. The test exercises `RedisStreamsClient`, `StreamBatcher`, and `StreamHealthMonitor` from `@arbitrage/core`. These are singleton-managed classes with `getRedisStreamsClient()` / `resetRedisStreamsInstance()` patterns.
- The rewrite must replace ALL mock interactions with real Redis Streams commands
- The `StreamBatcher` tests use timing (`delay()`) which becomes more sensitive with real Redis latency
- Performance benchmark tests (lines 859-919) measure timing against mocks -- will need adjusted thresholds with real Redis
- **Risk:** `getRedisStreamsClient()` is a singleton that internally creates an ioredis connection. With the mock removed, it will try to connect to the real Redis from `jest.globalSetup.ts` (redis-memory-server). This should work since `globalSetup` writes the URL to `.redis-test-config.json` and `@arbitrage/test-utils/src/index.ts` loads it at import time.

**Source modules tested:**
- `shared/core/src/redis-streams-client.ts`
- `shared/core/src/stream-batcher.ts`
- `shared/core/src/stream-health-monitor.ts`

**Hot-path proximity:** StreamBatcher is used in the price-update pipeline. Changes here are testing infrastructure only, not modifying hot-path source code.

---

### Fix 2: UPGRADE `coordinator.integration.test.ts` to real Redis

**Target file:** `services/coordinator/src/__tests__/coordinator.integration.test.ts` (904 lines)

**Current dependencies:**
- Imports from `@jest/globals` and `jest-mock`
- Imports from `../coordinator`: `CoordinatorService`, `CoordinatorDependencies`
- Imports from `@arbitrage/core`: `RedisStreamsClient`, `RedisClient`, `ServiceStateManager`
- Uses 6 local mock factory functions: `createMockRedisClient()`, `createMockStreamsClient()`, `createMockLogger()`, `createMockPerfLogger()`, `createMockStateManager()`, `createMockStreamHealthMonitor()`, `createMockStreamConsumerClass()`
- Uses Constructor DI pattern via `CoordinatorDependencies` interface

**External references:** Referenced in `api.routes.test.ts` (same directory) only as a comment. Referenced in docs/ADR-026.

**Jest discovery:** Matched by `services/coordinator/jest.config.js` (`**/__tests__/**/*.test.ts` under `<rootDir>/src`).

**Blast radius:**
- **MEDIUM** - The coordinator test uses Constructor DI with a `CoordinatorDependencies` interface. Upgrading to real Redis means replacing `createMockRedisClient()` and `createMockStreamsClient()` with real Redis connections while keeping other mocks (logger, state manager, stream consumer).
- The test starts an HTTP server on port 0 (random port) and makes `fetch()` calls -- this is real HTTP, not mocked
- Leader election tests (lines 262-318) use `mockRedisClient.setNx` -- these need real Redis `SET NX`
- The test already has good cleanup via `afterEach` with `coordinator.stop()`
- **Risk:** The coordinator creates consumer groups for 6 streams. With real Redis, `createConsumerGroup` failures will be real (BUSYGROUP) rather than mocked. The test at line 519 expects `createConsumerGroup` to fail -- need to verify this still tests the right error path.
- **Risk:** The coordinator's internal `RedisClient` has methods like `renewLockIfOwned` and `releaseLockIfOwned` that are Lua script wrappers. These need a real Redis that supports EVAL.

**Source modules tested:**
- `services/coordinator/src/coordinator.ts`

**Hot-path proximity:** Coordinator is not on the hot path (it's an orchestration service).

---

### Fix 3: UPGRADE `s4.1.5-failover-scenarios.integration.test.ts` to real Redis

**Target file:** `tests/integration/s4.1.5-failover-scenarios.integration.test.ts` (981 lines)

**Current dependencies:**
- Imports from `@jest/globals`
- Sets `process.env.NODE_ENV = 'test'` and `process.env.REDIS_URL = 'redis://localhost:6379'`
- Uses local mock factories: `createMockLogger()`, `createMockRedisClient()`, `createMockStreamsClient()`, `createMockLockManager()`
- **Does NOT import any source modules under test** -- tests are 100% self-contained logic assertions

**External references:** Only referenced in `.agent-reports/` docs and implementation plan docs.

**Jest discovery:** Matched by root `jest.config.js` under the `integration` project (`**/tests/integration/**/*.test.ts`).

**Blast radius:**
- **LOW-MEDIUM** - This test is fundamentally different from Fixes 1-2. It does NOT test any real source code. All tests are inline logic: boolean checks, timing arithmetic, local variable manipulation, mock event emission. There are no class instantiations from the codebase.
- Examples: "should detect stale health data after 3x health check interval" (lines 86-98) just does `const isStale = healthAge > staleThreshold; expect(isStale).toBe(true)` -- pure arithmetic.
- "should complete failover within 60 seconds" (lines 142-158) just checks `30000 + 10000 + 20000 <= 60000`.
- The "Leader Election" section (lines 280-328) uses `mockLockManager.acquireLock` but never connects to any real service.
- **Risk:** Upgrading this to real Redis requires deciding WHAT to test with real Redis. The current tests validate failover concepts, not actual failover behavior. A true real-Redis upgrade would need to instantiate `CoordinatorService` (like Fix 2) and test actual leader election timing, which is a much larger effort.
- **Risk:** Setting `process.env.REDIS_URL = 'redis://localhost:6379'` at the top of the file (line 15) could conflict with the `redis-memory-server` URL from `jest.globalSetup.ts`. This needs to be removed.

**Source modules tested:** None directly. This is a concept/design validation test.

**Hot-path proximity:** None.

---

### Fix 4: CONVERT `helius-provider.test.ts` from vitest to Jest

**Target file:** `services/execution-engine/src/services/simulation/helius-provider.test.ts` (409 lines)

**Current dependencies:**
- Imports from `vitest`: `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`
- Imports from `./helius-provider`: `HeliusSimulationProvider`, `createHeliusProvider`
- Imports from `./helius-provider` (types): `SolanaSimulationRequest`, `HeliusProviderConfig`
- Uses `vi.fn()` (13 instances), `vi.clearAllMocks()` (2 instances), `vi.mock` (none - only `vi.fn`)
- Mocks global `fetch` via `vi.fn()`
- **Source file exists:** `helius-provider.ts` confirmed at same path
- **Only vitest file in entire codebase** (confirmed by grep)

**External references:** Referenced in `.agent-reports/` docs and `ADR-016-transaction-simulation.md`.

**Jest discovery:** Matched by `services/execution-engine/jest.config.js` which has `testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts']` with `roots: ['<rootDir>/src']`. The file is at `src/services/simulation/helius-provider.test.ts`, so it IS discovered by Jest's glob pattern `**/?(*.)+(spec|test).ts`.

**However:** Since the file imports from `vitest`, Jest will fail to resolve the `vitest` module. This means:
- **Currently FAILING silently or with import error** -- Jest would error on `import { ... } from 'vitest'` since vitest is not installed
- The test is effectively dead code in CI

**Vitest APIs used and Jest equivalents:**
| Vitest | Jest |
|--------|------|
| `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'` | `import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'` |
| `vi.fn()` | `jest.fn()` |
| `vi.clearAllMocks()` | `jest.clearAllMocks()` |
| `vi.mock()` | `jest.mock()` |
| `mockFetch.mockReset()` | `mockFetch.mockReset()` (same API) |
| `mockFetch.mockResolvedValueOnce()` | `mockFetch.mockResolvedValueOnce()` (same API) |
| `mockFetch.mockRejectedValueOnce()` | `mockFetch.mockRejectedValueOnce()` (same API) |

**Blast radius:**
- **LOW** - Pure API conversion. No logic changes needed. All mock patterns (`mockResolvedValueOnce`, `mockRejectedValueOnce`, etc.) are identical between vitest and Jest.
- The `global.fetch = mockFetch` pattern works in both frameworks.
- `vi.fn()` -> `jest.fn()` and `vi.clearAllMocks()` -> `jest.clearAllMocks()` are 1:1 replacements.
- **Risk:** The execution-engine's `setupTests.ts` (line 13-15) calls `jest.clearAllMocks()` in `beforeEach` and `jest.resetAllMocks()` in `afterEach`. After conversion, the helius test's own `beforeEach`/`afterEach` must be compatible with this global setup. Since the test already calls `vi.clearAllMocks()` in both hooks, this maps cleanly.
- **Risk:** The execution-engine's `setupTests.ts` mocks `performance.now` (line 21-23). The helius test does not use `performance`, so no conflict.

**Source modules tested:**
- `services/execution-engine/src/services/simulation/helius-provider.ts`

**Hot-path proximity:** Simulation is off the hot path (pre-execution validation).

---

### Fix 5: MERGE duplicate `event-processor.test.ts`, delete old copy

**File A (KEEP):** `shared/core/__tests__/unit/detector/event-processor.test.ts` (422 lines)
**File B (DELETE):** `shared/core/src/detector/__tests__/event-processor.test.ts` (314 lines)

**File A dependencies:**
- Imports from `ethers`
- Imports from `../../../src/detector/event-processor`: 7 functions + 3 types
- Imports from `../../../../types/src`: `Pair` type
- Uses `ethers.AbiCoder.defaultAbiCoder().encode()` for realistic test data

**File B dependencies:**
- Imports from `../event-processor`: same 7 functions
- Imports from `@arbitrage/types`: `Pair` type
- Uses raw hex strings for test data (less readable but equally valid)

**Unique test in File B not in File A:**
```typescript
// File B, line 307-312
it('should be case-sensitive', () => {
  const key1 = generatePairKey('uniswap_v2', '0xAAA', '0xBBB');
  const key2 = generatePairKey('uniswap_v2', '0xaaa', '0xbbb');
  expect(key1).not.toBe(key2);
});
```
File A has similar `generatePairKey` tests but lacks the case-sensitivity test.

**External references:** `detector-integration.test.ts` references `event-processor.test.ts` in comments (lines 15, 397, 418) but does NOT import it.

**Jest discovery:**
- **File A:** Matched by `shared/core/jest.config.js` (`roots: ['<rootDir>/src', '<rootDir>/__tests__']`, `testMatch: ['**/*.test.ts']`). Also matched by root `jest.config.js` under the `unit` project.
- **File B:** Also matched by `shared/core/jest.config.js` (`roots: ['<rootDir>/src']`, `testMatch: ['**/*.test.ts']`). Both files are currently being run.

**Blast radius:**
- **VERY LOW** - Add 1 test case to File A, delete File B entirely. No imports or dependencies will break.
- Import path for merged test: File A uses `../../../src/detector/event-processor` which is correct from `__tests__/unit/detector/`.
- The `Pair` type import differs: File A uses `../../../../types/src`, File B uses `@arbitrage/types`. File A's path works.
- **Risk:** Near zero. The only consideration is making sure the case-sensitivity test from File B uses File A's test data style (ethers encoding vs raw hex). Since `generatePairKey` is a pure string function, no encoding is needed -- just string inputs.

**Source modules tested:**
- `shared/core/src/detector/event-processor.ts`

**Hot-path proximity:** `event-processor.ts` functions are called in the detection pipeline but tests don't modify source.

---

## Cross-Fix Interactions

### Shared utilities
- **Fixes 1, 2, 3** all need real Redis. They will all benefit from `createTestRedisClient()` from `@arbitrage/test-utils/src/integration/redis-helpers.ts` and the global setup in `jest.globalSetup.ts` (redis-memory-server).
- Fix 1 already imports from `@arbitrage/test-utils` (delay, createMockPriceUpdate, createMockSwapEvent).
- Fix 2 does not currently import from `@arbitrage/test-utils` -- will need new imports.
- Fix 3 does not currently import from `@arbitrage/test-utils` -- will need new imports.

### No file overlap
- All 5 fixes target different files. No two fixes modify the same file.
- No fix modifies any source code (only test files).

### Shared source dependencies
- Fix 1 tests `RedisStreamsClient` from `@arbitrage/core`
- Fix 2 tests `CoordinatorService` which internally uses `RedisStreamsClient`
- Both may exercise similar Redis Streams code paths, but since they run in separate test files with separate Redis state, no conflict.

### Mock factory patterns
- Fixes 1 and 3 both have inline mock factories that will be removed
- Fix 2 has mock factories that will be partially retained (logger, perf logger, state manager, stream consumer) but Redis mocks will be replaced
- No shared mock factory files are modified

### Fix 3 depends on Fix 2 conceptually
- Fix 3 (failover) currently tests no real code. To meaningfully upgrade it, one might use `CoordinatorService` with real Redis -- similar to what Fix 2 does. Fix 2 establishes the pattern that Fix 3 could follow.

---

## Test Utility Patterns

### `createTestRedisClient()` (redis-helpers.ts)
- Creates a new `ioredis` Redis client with `lazyConnect: true`, `maxRetriesPerRequest: 3`
- Reads URL from `.redis-test-config.json` (written by `jest.globalSetup.ts`) or falls back to `REDIS_URL` env var or `redis://localhost:6379`
- Returns a connected `Redis` instance
- Caller is responsible for calling `redis.disconnect()` or `redis.quit()` in cleanup

### `IntegrationTestHarness` (harness.ts)
- Higher-level abstraction for managing multiple components
- Has `getRedis()`, `registerComponent()`, `startAll()`, `cleanup()` lifecycle
- Uses `getRedisUrl()` from `redis-test-setup.ts`

### `RedisTestPool` / `IsolatedRedisClient` (redis-pool.ts)
- Connection pooling with keyspace prefixing for test isolation
- `getRedisPool().getIsolatedConnection(testId)` returns an `IsolatedRedisClient`
- Has `cleanup()` method that SCAN-deletes prefixed keys
- Max 10 connections, with idle eviction

### `createIsolatedContext()` / `withIsolation()` (test-isolation.ts)
- Creates isolated test contexts with unique key prefixes
- Returns `{ redis: IsolatedRedisClient, testId, cleanup }`

### Stream utilities (stream-utils.ts)
- `waitForMessages()` - polls stream with exponential backoff
- `publishBatch()` - pipeline-batched publishing
- `StreamCollector` - consumer group-based message collector
- `assertStreamContains()` - assertion helper for stream content

### Redis test server lifecycle
- `jest.globalSetup.ts` starts `redis-memory-server`, writes URL to `.redis-test-config.json`
- `jest.globalTeardown.ts` stops the server and deletes config file
- Test workers read config from the file at import time (via `shared/test-utils/src/index.ts`)

### Timeout configuration
- Root `jest.config.js`: `testTimeout: 700000` (covers all test types including performance)
- Integration project uses `maxWorkers: 2` in CI
- Individual service jest configs: `testTimeout: 10000` (execution-engine, coordinator)
- `shared/core/jest.config.js`: `testTimeout: 30000`

### Exemplary real-Redis test pattern (price-detection.integration.test.ts)
```typescript
import { createTestRedisClient } from '@arbitrage/test-utils';

let redis: Redis;

beforeAll(async () => {
  redis = await createTestRedisClient();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushall();
});
```

---

## Recommended Fix Ordering

### Order: Fix 5 -> Fix 4 -> Fix 1 -> Fix 2 -> Fix 3

**1. Fix 5 (MERGE event-processor tests) -- FIRST**
- **Rationale:** Lowest risk, zero dependencies, no infrastructure changes. Add 1 test, delete 1 file. Can be verified instantly with `npm test -- --testPathPattern event-processor`. Builds confidence before larger changes.
- **Effort:** Minimal

**2. Fix 4 (CONVERT helius-provider vitest to Jest) -- SECOND**
- **Rationale:** Low risk, self-contained file change, no infrastructure. Pure API translation (vi.fn -> jest.fn). Fixes a currently-broken test file. No interaction with other fixes.
- **Effort:** Minimal

**3. Fix 1 (REWRITE s1.1 Redis Streams test with real Redis) -- THIRD**
- **Rationale:** This is the most impactful rewrite but has no dependency on other fixes. Tests foundational Redis Streams infrastructure that Fixes 2 and 3 also rely on. Doing this first among the Redis fixes validates the test utility patterns before applying them to coordinator and failover tests.
- **Effort:** High (180+ lines of mock infrastructure to remove, 45+ test cases to adapt)

**4. Fix 2 (UPGRADE coordinator test to real Redis) -- FOURTH**
- **Rationale:** Depends on Fix 1 succeeding (validates real Redis test patterns). More complex than Fix 1 because it must selectively replace some mocks (Redis) while keeping others (logger, state manager, stream consumer). The HTTP endpoint tests already use real HTTP.
- **Effort:** Medium-High

**5. Fix 3 (UPGRADE failover test to real Redis) -- LAST**
- **Rationale:** Depends on Fix 2 conceptually (may reuse coordinator patterns). Current tests are logic-only with no source code interaction -- the scope of "upgrading to real Redis" needs careful scoping. May end up being a partial upgrade where only the leader election sections use real Redis.
- **Effort:** Variable (depends on scope decision)

---

## Risk Assessment

### Fix 1: HIGH risk
- **Mock removal complexity:** 180+ lines of custom ioredis mock with intricate `jest.mock()` factory. Removing this changes how `RedisStreamsClient` obtains its Redis connection.
- **Singleton behavior:** `getRedisStreamsClient()` is a singleton. With real Redis, it will cache the connection across tests. Must call `resetRedisStreamsInstance()` in `beforeEach` AND ensure the singleton reconnects to the test Redis.
- **Timing sensitivity:** `StreamBatcher` tests use `delay()` with specific timing assumptions. Real Redis adds ~1-5ms latency per operation which may cause flaky tests if timeouts are too tight.
- **Performance benchmarks:** Lines 859-919 measure throughput against mocks. These will be significantly slower with real Redis and thresholds need adjustment.
- **Mitigation:** Follow the established pattern from `component-flows/price-detection.integration.test.ts`. Use `flushall()` between tests. Increase timing tolerances.

### Fix 2: MEDIUM risk
- **Partial mock replacement:** Must keep mocks for logger, perf logger, state manager, and stream consumer while replacing Redis mocks. The `CoordinatorDependencies` DI interface supports this pattern well.
- **Leader election testing:** Real Redis leader election uses Lua scripts (`renewLockIfOwned`, `releaseLockIfOwned`). redis-memory-server supports `EVAL`, but edge cases in lock timing may surface.
- **HTTP server lifecycle:** The test starts a real HTTP server per test. With real Redis adding startup time, test duration will increase.
- **Mitigation:** The DI pattern makes selective mock replacement clean. Only replace `getRedisClient` and `getRedisStreamsClient` factories.

### Fix 3: LOW risk (if scoped correctly)
- **Scope ambiguity:** The current tests don't test real failover code. "Upgrading to real Redis" could mean anything from adding one leader-election test with real Redis to rewriting the entire file.
- **Recommended scope:** Remove the hardcoded `REDIS_URL`, add 2-3 tests that actually acquire/release Redis locks, keep the existing concept-validation tests as-is.
- **Mitigation:** Keep scope small. Don't try to test actual failover timing with real Redis (that's an E2E concern).

### Fix 4: VERY LOW risk
- **Pure API translation:** Every vitest API used has a direct Jest equivalent.
- **Global fetch mock:** `global.fetch = mockFetch` works identically in both frameworks.
- **Only concern:** The execution-engine `setupTests.ts` calls `jest.resetAllMocks()` in `afterEach`. This will reset the global fetch mock between tests. The helius test already re-creates the mock in `beforeEach`, so this is compatible.

### Fix 5: NEGLIGIBLE risk
- **One test addition, one file deletion.** The added test is pure function input/output with no dependencies.
- **Import paths verified:** File A's import `../../../src/detector/event-processor` resolves correctly from `shared/core/__tests__/unit/detector/`.
- **No consumers of File B:** No code imports or depends on File B.

---

## Quality Gate Checklist

- [x] All 5 target files read fully
- [x] Grep for any imports/references to each file (all only referenced in agent-reports and docs, not code)
- [x] Test utility patterns understood (createTestRedisClient, IntegrationTestHarness, RedisTestPool, test-isolation, stream-utils)
- [x] Fix ordering determined with reasoning (5 -> 4 -> 1 -> 2 -> 3)
- [x] Jest config checked for test discovery patterns (root + per-service configs analyzed)
- [x] Vitest APIs mapped to Jest equivalents
- [x] Redis test server lifecycle understood (redis-memory-server via globalSetup/globalTeardown)
- [x] Cross-fix interactions analyzed (no file overlaps, shared Redis utility dependency)
- [x] Source file existence verified for helius-provider.ts
- [x] Duplicate event-processor tests compared, unique test identified

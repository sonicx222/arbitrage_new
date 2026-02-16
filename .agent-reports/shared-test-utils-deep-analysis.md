# Deep Analysis Report: shared/test-utils

**Date:** 2026-02-16
**Target:** `shared/test-utils/` (56 files, ~12,266 lines)
**Team:** 6 specialized agents (architecture, bugs, security, test quality, mock fidelity, performance)
**Consumers:** 69 files across the monorepo import from `@arbitrage/test-utils`

---

## Executive Summary

- **Total findings:** 43 (deduplicated from 48 raw findings across 6 agents)
- **By severity:** 1 Critical, 5 High, 17 Medium, 20 Low
- **Top 3 highest-impact issues:**
  1. **PriceUpdate factory creates wrong-shaped objects** — field names and required fields diverge from `@arbitrage/types`, causing tests to validate against a non-conforming shape (Mock Fidelity)
  2. **Legacy `RedisMock.publish()` callback argument mismatch** — `waitForOpportunity()` always resolves with `null` instead of the published message (Bug Hunter)
  3. **Mock logger missing `child()`, `fatal()`, `trace()`** — any production code calling `logger.child({})` throws TypeError when using the mock (Mock Fidelity)
- **Overall health grade: B-**
- **Agent agreement map:** 6 findings flagged by 2+ agents independently (exists() type, ping() type, generateRandomAddress, `||` vs `??`, waitForCondition duplication, PriceUpdate type drift)

### Grade Justification (B-)
**Strengths:** Sound architecture with no layer violations, correct dependency direction, good modular organization, no security vulnerabilities or credential exposure, excellent partition-service mocks.
**Weaknesses:** Critical PriceUpdate factory type mismatch, very low self-test coverage (~4% of source files), significant dead code (~400 lines in index.ts + 3 unused modules), 30 convention violations (`||` vs `??`), two competing RedisMock implementations, mixed Redis client libraries.

---

## Critical Findings (P0 — Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Mock Fidelity | `factories/price-update.factory.ts:8-21` | Factory defines its OWN `PriceUpdate` type with different field names (`pair` vs `pairKey`, `price0`/`price1` vs `price`) and missing required fields (`latency`, `reserve0`, `reserve1`). Tests validate against wrong shape. `SimulatedPriceGenerator` extends this, propagating the mismatch. | Mock Fidelity, Performance | HIGH | Import `PriceUpdate` from `@arbitrage/types`; align all field names. | 3.8 |

---

## High Findings (P1 — Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 2 | Mock Fidelity | `factories/bridge-quote.factory.ts:34-63` | Factory uses `targetChain` vs real `destChain`, `bridgeProtocol` vs `protocol`, `sourceToken`/`targetToken` vs `token`. Missing `gasFee`, `totalFee`, `valid`, `recipient`. | Mock Fidelity, Performance | HIGH | Import `BridgeQuote` from `@arbitrage/core` and align. | 3.4 |
| 3 | Bug | `index.ts:207-209, 695` | Legacy `RedisMock.publish()` calls `callback(null, serializedMessage)` but subscribers expect `(message) =>`. First arg `null` is received as `message`, so `JSON.parse(null) === null`. `waitForOpportunity()` always resolves with `null`. | Bug Hunter | HIGH | Change to `callback(serializedMessage)` or fix subscriber to `(err, msg)`. | 4.0 |
| 4 | Inconsistency | `index.ts:199` vs `redis.mock.ts:95` | Legacy `RedisMock.exists()` returns `boolean`, newer returns `number` (0/1). Real Redis returns number. Tests using legacy mock pass with truthy checks but fail with `=== 1`. | Security, Bug Hunter, Mock Fidelity | HIGH | Change legacy `exists()` to return `number`. | 3.6 |
| 5 | Mock Fidelity | `mocks/partition-service.mock.ts:27-44` | `createMockLogger()` returns `{ info, error, warn, debug }` but `ILogger` requires `fatal()`, `child()`, and optionally `trace()`. Code calling `logger.child({})` throws TypeError. | Mock Fidelity | HIGH | Add `fatal: jest.fn()`, `child: jest.fn().mockReturnValue(mockLogger)`, `trace: jest.fn()`. | 4.0 |
| 6 | Coverage | Multiple (15+ consumers) | Mock factories (`createMockPerfLogger`, `createMockExecutionStateManager`, `MockRedisClient`) consumed by 15+ test files but have ZERO own tests. Shape drift from real interfaces causes silent false passes. | Test Quality | HIGH | Write unit tests verifying mock shapes match real interfaces. | 3.4 |

---

## Medium Findings (P2 — Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 7 | Convention | Multiple (30 instances) | `\|\| 0` used instead of `?? 0` for numeric fallbacks in `cache-state.builder.ts` (10), `cache-fixtures.ts` (9), `performance-fixtures.ts` (8), `chaos-testing.ts` (2), `worker-test.harness.ts` (1). | Architecture, Bug Hunter, Performance | HIGH | Replace all with `?? 0`. | 4.4 |
| 8 | Bug | `index.ts:557-561` | `generateRandomAddress()` produces ~14 hex chars, not 40. `Math.random().toString(16)` has insufficient entropy. Same for `generateRandomHash()`. | Security, Bug Hunter | HIGH | Use `crypto.randomBytes(20).toString('hex')` for addresses, `randomBytes(32)` for hashes. | 3.6 |
| 9 | Bug | `redis-test-helper.ts:87-111` | Database wraparound at 16 suites: `nextDatabase` wraps to 1, causing silent DB sharing. `flushDb()` on connect wipes earlier suite's data. Non-deterministic failures. | Bug Hunter | HIGH | Throw error on exhaustion, or use keyspace prefixing instead of DB numbers. | 3.4 |
| 10 | Bug | `helpers/timer-helpers.ts:415-450` | `waitForCondition` with `advanceTimers: false` + fake timers = infinite loop. `Date.now()` is faked, timeout check never triggers. | Bug Hunter | HIGH | Use `performance.now()` for timeout check (not faked by default), or document constraint. | 3.3 |
| 11 | Config | `tsconfig.json:38-41` | Missing `{ "path": "../core" }` in references. 6+ files import `@arbitrage/core` but incremental builds won't detect core changes. | Architecture | HIGH | Add `../core` to references array. | 3.6 |
| 12 | Docs | Multiple (9 files) | 6 files reference `docs/TEST_ARCHITECTURE.md` (real path: `docs/architecture/TEST_ARCHITECTURE.md`). 3 other `@see` docs don't exist at all. | Architecture | HIGH | Fix paths; remove stale references. | 3.2 |
| 13 | Architecture | `setup/env-setup.ts:17-78` | `TestEnvironment` missing 4 of 11 chains: Fantom, zkSync, Linea, Solana. | Architecture | HIGH | Add missing chain URLs to interface and defaults. | 3.0 |
| 14 | Architecture | `setup/performance-mock.ts:16-18` | Replaces entire `global.performance` with `{ now: jest.fn() }`, removing `mark()`, `measure()`, `getEntries()`, etc. | Architecture | HIGH | Use `jest.spyOn(performance, 'now')` instead. | 3.4 |
| 15 | Mock Fidelity | `mocks/redis.mock.ts:38-604` | Missing sorted sets (`zadd`, `zrange`, etc.), `multi/exec`, `scan`, `mget`, `incr`, `eval`. Used by rate limiter, metrics, health aggregation, locking. | Mock Fidelity | HIGH | Add missing Redis operations. | 3.0 |
| 16 | Mock Fidelity | `mocks/redis.mock.ts:757-758` | `RedisMockState.createMockRedis()` has `xread`/`xreadgroup` hardcoded to return `null`. Shared state has stream data but simpler mock can't read it. | Mock Fidelity | HIGH | Implement stateful xread/xreadgroup from `state.streams`. | 3.0 |
| 17 | Mock Fidelity | `mocks/redis.mock.ts:80, 130` | `setex()` and `setNx()` store data but never expire it. TTL not simulated. Lock auto-release and cache invalidation untestable. | Security | MEDIUM | Add `setTimeout`-based TTL simulation. | 2.8 |
| 18 | Bug | `factories/swap-event.factory.ts:290-297` | `createEthereumSwap(overrides?)` and `createBscSwap(overrides?)` accept `overrides` param but silently ignore it. | Bug Hunter, Performance | HIGH | Apply overrides or remove parameter. | 3.2 |
| 19 | Docs | `integration-patterns.ts:232, 319-325` | Level 2/3 setup has TODO stubs for service init and Anvil forks. Config fields accepted but silently ignored. ADR-026 status is "Accepted". | Architecture | HIGH | Implement features or mark as `@experimental`. | 2.8 |
| 20 | Race Condition | `helpers/chaos-testing.ts:41` | `chaosStates` module-level Map has no reset function, not registered with singleton reset. Leaks state between tests. | Bug Hunter | HIGH | Export `resetChaosStates()` and register with `registerSingletonReset`. | 3.2 |
| 21 | Structural | 3 files + 2 Redis libs | Three Redis helper files (`redis-test-setup.ts`, `redis-test-helper.ts`, `integration/redis-helpers.ts`) with overlapping purposes and two different Redis client libraries (`redis` v4 vs `ioredis`). | Performance | HIGH | Consolidate to 1-2 files, standardize on ioredis. | 3.1 |
| 22 | Coverage | `integration/*.ts` (7 files) | `RedisTestPool`, `StreamCollector`, `createIsolatedContext` used by 10+ integration tests but have zero own tests. | Test Quality | HIGH | Write unit tests for integration utilities. | 3.0 |
| 23 | Performance | `integration/redis-pool.ts:300-306` | `flushall()` uses `redis.keys('*')` — explicitly forbidden by CLAUDE.md. `cleanupTest()` correctly uses SCAN, but `flushall()` bypasses it. | Performance | HIGH | Replace with SCAN-based iteration or FLUSHDB. | 3.4 |

---

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 24 | Inconsistency | `index.ts:289` vs `redis.mock.ts:490` | Legacy `ping()` returns `true` instead of `'PONG'`. | Security, Bug Hunter | HIGH | 3.2 |
| 25 | Mock Fidelity | `mocks/mock-factories.ts:82` | `createMockRedisClient().setNx` returns `number` (1), real returns `boolean` (true). | Mock Fidelity | HIGH | 3.0 |
| 26 | Mock Fidelity | `builders/pair-snapshot.builder.ts:23` | Uses deprecated `fee` field instead of `feeDecimal`. | Mock Fidelity | HIGH | 2.8 |
| 27 | Mock Fidelity | `mocks/provider.mock.ts:60-71` | Missing `on`/`off`/`removeAllListeners` for event subscription. | Mock Fidelity | MEDIUM | 2.6 |
| 28 | Mock Fidelity | `generators/simulated-price.generator.ts:164-169` | `seed` parameter stored but never used; all randomness from `Math.random()`. Non-reproducible test data. | Mock Fidelity | HIGH | 2.8 |
| 29 | Architecture | `setup/jest-setup.ts:102-139` | `withFakeTimers`, `withAdvancedTimers` stranded in side-effect file, not re-exported. | Architecture | HIGH | 2.6 |
| 30 | Duplication | `helpers/chaos-testing.ts:402` + `integration-patterns.ts:377` + `integration/async-helpers.ts` | Three near-identical `waitForCondition`/`waitFor` implementations. | Architecture, Performance | HIGH | 3.2 |
| 31 | Architecture | `contracts/detector-contract.ts:22-24` | Uses CommonJS `require()` instead of `await import()`. `@pact-foundation/pact` not in `package.json`. | Architecture | MEDIUM | 2.4 |
| 32 | Docs | `docs/architecture/adr/ADR-009-test-architecture.md:2` | Status "Proposed" but implementation substantially complete. | Architecture | HIGH | 2.2 |
| 33 | Mock Fidelity | `redis.mock.ts:106`, `index.ts:235` | Redis `keys()` glob-to-regex only handles `*`, not `?`, `[...]`, or `\`. | Security | HIGH | 2.2 |
| 34 | Architecture | `redis.mock.ts:666-674` | `RedisMockState` double-init `initializing` guard misleading (JS is single-threaded). | Security | LOW | 2.0 |
| 35 | Security | `index.ts:55-68` | Env fallback URLs point to real public RPC endpoints, not `.test` TLD like `env-setup.ts`. | Security | MEDIUM | 2.4 |
| 36 | Dead Code | `src/contracts/` (entire dir) | Pact-based contract testing, `@pact-foundation/pact` not installed, zero consumers. | Test Quality | HIGH | 2.6 |
| 37 | Dead Code | `src/helpers/chaos-testing.ts` | 430 lines, zero imports across monorepo. | Test Quality | HIGH | 2.6 |
| 38 | Dead Code | `src/reporters/slow-test-reporter.ts` | Not referenced in any `jest.config` file. | Test Quality | HIGH | 2.4 |
| 39 | Dead Code | `index.ts:309-728` | ~400 lines of legacy inline mocks (`BlockchainMock`, `WebSocketMock`, `TestEnvironment`) with zero external consumers. | Test Quality | HIGH | 2.8 |
| 40 | Structural | `builders/index.ts` | `CacheStateBuilder` not exported from barrel index. | Performance | HIGH | 2.8 |
| 41 | Performance | `fixtures/performance-fixtures.ts:343-361` | `generateEventStream()` pre-allocates up to 120K objects for peak scenario. | Performance | MEDIUM | 2.4 |
| 42 | Performance | `factories/swap-event.factory.ts:343` | `sort(() => Math.random() - 0.5)` is a biased shuffle. | Performance | HIGH | 2.2 |
| 43 | Performance | `setup/singleton-reset.ts:76-80` | Sequential `await` for 12+ singleton resets. Same-priority singletons could reset in parallel. | Performance | MEDIUM | 2.6 |

---

## Test Coverage Matrix

| Source File | Exports | Own Test? | Used Externally? | Happy | Error | Edge | Gap Severity |
|---|---|---|---|---|---|---|---|
| `helpers/timer-helpers.ts` | 8 exports | Yes | Yes (1 file) | Yes | Yes | Yes | **None** |
| `redis-test-helper.ts` | 4 exports | Yes | Yes | Yes | Partial | Yes | **Low** |
| `generators/simulated-price.generator.ts` | 4 exports | Yes (external) | No | Yes | No | Partial | **Low** |
| `mocks/mock-factories.ts` | 4 exports | **No** | **Yes (15+)** | - | - | - | **HIGH** |
| `mocks/partition-service.mock.ts` | 4 exports | **No** | **Yes (6+)** | - | - | - | **HIGH** |
| `integration/*.ts` (7 files) | 15+ exports | **No** | **Yes (10+)** | - | - | - | **HIGH** |
| `mocks/provider.mock.ts` | 4 exports | **No** | Yes | - | - | - | **MEDIUM** |
| `mocks/redis.mock.ts` | 4 exports (640+ lines) | **No** | Yes (3+) | - | - | - | **MEDIUM** |
| `harnesses/*.ts` (3 files) | 3 exports | **No** | Yes (4-10) | - | - | - | **MEDIUM** |
| `partition-test-factory.ts` | 2 exports (375 lines) | **No** | Yes (3 services) | - | - | - | **MEDIUM** |
| `setup/env-setup.ts` | 7 exports | **No** | Yes | - | - | - | **MEDIUM** |
| `setup/singleton-reset.ts` | 5 exports | **No** | Yes (jest-setup) | - | - | - | **MEDIUM** |
| `integration-patterns.ts` | 4 exports | **No** | Yes | - | - | - | **MEDIUM** |
| `factories/*.ts` (4 files) | 8+ exports | **No** | Partial | - | - | - | **MEDIUM** |
| `builders/*.ts` (3 files) | 6 exports | **No** | No | - | - | - | **LOW** |
| `contracts/detector-contract.ts` | 6 exports | **No** | No (dead code) | - | - | - | **LOW** |
| `helpers/chaos-testing.ts` | 5 exports | **No** | No (dead code) | - | - | - | **LOW** |
| `reporters/slow-test-reporter.ts` | 1 export | **No** | No (dead code) | - | - | - | **LOW** |

**Self-test coverage: ~4%** (2 test files for 45+ source files)

---

## Mock Fidelity Matrix

| Mock File | Real Implementation | Methods Covered | Behavior Fidelity | Score (1-5) |
|---|---|---|---|---|
| `partition-service.mock.ts` (createCoreMocks) | `partition-service-utils.ts` | All significant methods | Excellent, faithful config resolution | **5** |
| `mock-factories.ts` (createMockRedisClient) | `redis.ts` (RedisClient) | Good coverage for unit tests | Lightweight stubs, no state | **4** |
| `provider.mock.ts` | ethers v6 JsonRpcProvider | Core methods covered | Good; missing event subscription | **4** |
| `redis.mock.ts` (RedisMock class) | `redis.ts` (RedisClient) | Strings, hashes, lists, streams, pub/sub | Missing sorted sets, multi, scan, incr | **3** |
| `partition-service.mock.ts` (createMockLogger) | `ILogger` (logging/types.ts) | info, error, warn, debug | Missing fatal, child, trace | **3** |
| `redis.mock.ts` (createMockRedis) | `redis.ts` | Basic ops only | xread/xreadgroup always null | **2** |

---

## Factory/Builder Accuracy Matrix

| Factory/Builder | Real Type | Field Accuracy | Realism Score (1-5) |
|---|---|---|---|
| `swap-event.factory.ts` | `SwapEvent` | Perfect match | **5** |
| `stream-message.factory.ts` | `MessageEvent`/`StreamMessage` | Good, minor optional field missing | **4** |
| `arbitrage-opportunity.builder.ts` | `ArbitrageOpportunity` | Good, optional fields acceptable | **4** |
| `pair-snapshot.builder.ts` | `Pair` | Uses deprecated `fee` instead of `feeDecimal` | **4** |
| `cache-state.builder.ts` | Internal types (no canonical) | N/A | **4** |
| `price-update.factory.ts` | `PriceUpdate` | **CRITICAL MISMATCH**: wrong field names, missing required fields | **2** |
| `bridge-quote.factory.ts` | `BridgeQuote` | **HIGH MISMATCH**: wrong field names, missing required fields | **2** |

---

## Cross-Agent Insights

1. **PriceUpdate type drift confirmed by 2 agents**: Mock Fidelity flagged the critical field name mismatch; Performance independently flagged it as a duplicate type definition (S2). Root cause: factory defines its own type "to avoid import cycles" but no cycle exists.

2. **Legacy RedisMock issues found by 3 agents**: Security flagged `exists()` return type and `ping()` return type; Bug Hunter independently found the same plus the `publish()` callback mismatch; Mock Fidelity noted the exists() discrepancy from a different angle. Cross-validation confirms these are real issues.

3. **`|| 0` convention violation found by 3 agents**: Architecture (25+ locations), Bug Hunter (28 occurrences), and Performance (30 instances, Score 4.4). All independently identified this as the highest-volume convention violation.

4. **generateRandomAddress/Hash found by 2 agents**: Security and Bug Hunter both identified the Math.random() entropy issue. Security noted the custom jest matchers partially mitigate it; Bug Hunter confirmed with Node.js execution.

5. **Coverage gaps explain mock drift**: Test Quality's finding that mock factories have zero tests (consumed by 15+) explains how Mock Fidelity's type mismatches could persist undetected. Without tests validating mock shapes, drift from real interfaces goes unnoticed.

6. **Dead code accumulation pattern**: Test Quality found 3 entire dead modules + ~400 lines legacy code. Performance independently flagged the same unused factories/builders. Architecture noted the Pact-based contracts module references an uninstalled dependency. All point to a pattern of "build infrastructure speculatively, never wire in."

---

## Recommended Action Plan

### Phase 1: Immediate (P0/P1 — fix before next deployment)

- [ ] **Fix #1**: Align `price-update.factory.ts` with real `PriceUpdate` type from `@arbitrage/types` (Mock Fidelity, Performance)
- [ ] **Fix #2**: Align `bridge-quote.factory.ts` with real `BridgeQuote` type (Mock Fidelity, Performance)
- [ ] **Fix #3**: Fix legacy `RedisMock.publish()` callback argument order (Bug Hunter)
- [ ] **Fix #4**: Fix legacy `RedisMock.exists()` to return `number` not `boolean` (Security, Bug Hunter, Mock Fidelity)
- [ ] **Fix #5**: Add `fatal`, `child`, `trace` to `createMockLogger()` (Mock Fidelity)

### Phase 2: Next Sprint (P2 — reliability and coverage)

- [ ] **Fix #7**: Replace all 30 instances of `|| 0` with `?? 0` (Architecture, Bug Hunter, Performance)
- [ ] **Fix #8**: Fix `generateRandomAddress/Hash` with `crypto.randomBytes` (Security, Bug Hunter)
- [ ] **Fix #9**: Fix Redis database wraparound — throw on exhaustion (Bug Hunter)
- [ ] **Fix #10**: Fix `waitForCondition` infinite-loop with fake timers (Bug Hunter)
- [ ] **Fix #11**: Add `{ "path": "../core" }` to `tsconfig.json` references (Architecture)
- [ ] **Fix #14**: Fix `performance-mock.ts` to use `jest.spyOn` instead of replacing entire object (Architecture)
- [ ] **Fix #18**: Fix `createEthereumSwap`/`createBscSwap` to use `overrides` param (Bug Hunter, Performance)
- [ ] **Fix #23**: Replace `KEYS *` with SCAN in `redis-pool.ts flushall()` (Performance)
- [ ] **Write tests**: Add unit tests for mock factories and integration utilities (Test Quality)

### Phase 3: Backlog (P2/P3 — refactoring, cleanup, improvements)

- [ ] **Consolidate Redis helpers**: Merge 3 files into 1-2, standardize on ioredis (Performance)
- [ ] **Remove dead code**: Delete `contracts/`, `chaos-testing.ts`, `slow-test-reporter.ts` (Test Quality)
- [ ] **Clean up index.ts**: Remove ~400 lines of unused legacy mocks (Test Quality)
- [ ] **Fix doc references**: Correct 9 phantom `@see` paths (Architecture)
- [ ] **Add missing chains**: Add Fantom, zkSync, Linea, Solana to TestEnvironment (Architecture)
- [ ] **Add missing Redis ops**: Sorted sets, multi/exec, scan, incr, eval to RedisMock (Mock Fidelity)
- [ ] **Implement seeded PRNG**: Replace `Math.random()` in SimulatedPriceGenerator (Mock Fidelity)
- [ ] **Update ADR-009**: Change status from "Proposed" to "Accepted" (Architecture)
- [ ] **Consolidate waitFor**: Merge 3 implementations into 1 (Architecture, Performance)

---

## Statistics

| Metric | Value |
|--------|-------|
| Total source files | 56 |
| Total lines of code | ~12,266 |
| Own test files | 2 (~4% coverage) |
| External consumers | 69 files |
| Dead code modules | 3 (contracts, chaos-testing, slow-test-reporter) |
| Dead legacy code | ~400 lines in index.ts |
| Convention violations (`\|\|` vs `??`) | 30 instances |
| Phantom doc references | 9 |
| TODO comments | 3 |
| Deprecated items | 2 (properly marked) |
| Skipped tests | 0 |

---

*Generated by 6-agent deep analysis team on 2026-02-16*

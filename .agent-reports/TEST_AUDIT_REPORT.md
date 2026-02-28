# Test Suite Audit Report

**Scope**: Full codebase
**Date**: 2026-02-28
**Test Files Analyzed**: 471
**Test Cases Analyzed**: ~13,817
**Agents Used**: 5 (test-cataloger, source-coverage-mapper, unit-test-critic, integration-test-validator, test-consolidation-strategist)

## Executive Summary

### Health Score: B+

| Dimension | Score | Notes |
|-----------|-------|-------|
| Test Necessity | 77% ESSENTIAL or VALUABLE | 23% redundant/unnecessary (sampled from 26 deep-analyzed files) |
| Test Quality | 35% CLEAN, 38% COULD SIMPLIFY, 27% OVER-ENGINEERED | Mock scaffolding epidemic in engine tests; hot-path and contract tests are excellent |
| Integration Authenticity | 68% AUTHENTIC (19/28) | 7 partial, 2 mock theater |
| Coverage | 88% of source modules tested | 4 HIGH-risk gaps, 7 MEDIUM-risk gaps |
| Placement | 99.6% correctly placed | 0 by folder convention; 2 integration tests are mock theater by content |

**Standout strengths:**
- Contract test harnesses (shared `testRouterManagement`, `testDeploymentDefaults`) are A+ quality
- Hot-path tests (`price-matrix.test.ts`, `execution-pipeline.test.ts`) test real behavior with minimal mocking
- Worker thread integration tests are genuinely impressive — real threads, real SharedArrayBuffer, real Atomics
- Redis test infrastructure (`redis-memory-server` + `createTestRedisClient`) is excellent
- All 5 ADRs (002, 005, 009, 012, 018) have strong dedicated test coverage

**Key problems:**
- Global `resetAllMocks()` in setupTests.ts forces massive mock re-wiring in every `beforeEach()` — estimated 50% of mock setup code is unnecessary
- Engine tests have 22+ mocked modules per file (symptom of source code SRP violations)
- 2 integration tests are pure mock theater (warming-flow, chaos/fault-injection)
- `lru-queue.ts` (hot-path caching) has zero tests

---

## P0: False Confidence (fix immediately)

These tests give false confidence — they're labeled as something they're not, or they test copies instead of real code.

| # | File | Issue | Recommendation | Effort |
|---|------|-------|----------------|--------|
| 1 | `shared/core/__tests__/integration/warming-flow.integration.test.ts` (27 tests) | **Mock Theater**: L2 disabled (`l2Enabled: false`), no Redis — runs pure in-memory. Labeled "integration" but tests only in-process objects. | DOWNGRADE to unit test OR UPGRADE by enabling L2 with real Redis to test actual cache warming across tiers. Fills ADR-005 L2 warming gap. | LOW |
| 2 | `tests/integration/chaos/fault-injection.integration.test.ts` (20 tests) | **Partial Mock Theater**: 12/20 tests are ChaosController + NetworkPartitionSimulator utility class unit tests. Only 8 tests use real Redis. | SPLIT: Move 12 utility tests to `__tests__/unit/chaos/`. Keep 8 Redis recovery tests as integration. | LOW |
| 3 | `services/unified-detector/__tests__/unit/chain-instance.test.ts` | **Tests copies of private methods**: Copies `isSameTokenPair`, `calculatePriceFromReserves` from source and tests the copies. If source is refactored, these tests still pass. | Refactor to test through public `ChainDetectorInstance` API. If helpers must be tested, extract to a testable utility module. | MEDIUM |

---

## P1: Consolidation Opportunities

| # | Cluster | Tests Involved | Action | Effort |
|---|---------|---------------|--------|--------|
| 1 | Redis Streams HMAC duplicate | `redis-streams-hmac.test.ts` (422 lines, 12 tests) fully superseded by `redis-streams-signing.test.ts` (517 lines, 18 tests) | **DELETE** `redis-streams-hmac.test.ts`. Signing file covers all HMAC scenarios plus xreadgroup, batch signing, constant-time comparison. | LOW |
| 2 | Swap Event Filter split | `swap-event-filter.test.ts` (856 lines, ~40 tests) + `analytics/swap-event-filter.test.ts` (187 lines, 5 tests) | **MERGE** the 5 router-filtering tests into main file as `describe('Router Address Filtering')`, then delete analytics file. | LOW |
| 3 | Detector lifecycle overlap | `detector.test.ts` (1953 lines, 103 tests) + `detector-lifecycle.test.ts` (896 lines, ~25 tests) in cross-chain-detector | **MERGE** unique lifecycle tests into detector.test.ts as a `describe('lifecycle')` block. Delete detector-lifecycle.test.ts. | LOW |

**Lines saved: ~1,500 (422 + 187 + 896)**

---

## P2: Simplification Opportunities

| # | File | Issue | Suggested Simplification | Effort |
|---|------|-------|-------------------------|--------|
| 1 | `shared/test-utils/src/setup/jest-setup.ts` | `resetAllMocks()` in global `afterEach` clears ALL mock implementations, forcing every `beforeEach()` to re-wire mocks. **This is the single highest-impact improvement.** | Switch to `clearAllMocks()` (preserves implementations, clears call history only). Would eliminate ~50% of mock setup code across hundreds of files. Requires audit of tests that rely on reset behavior. | HIGH effort, **VERY HIGH** impact |
| 2 | `engine-flash-loan-wiring.test.ts` | 22 module-level mocks for 4 test cases. 317 lines of setup (69% of file) for 120 lines of tests. | Extract shared engine mock scaffolding into `test-utils/mocks/execution-engine.mock.ts`. Multiple engine tests duplicate this exact setup. | MEDIUM |
| 3 | `unified-detector.test.ts` | Duplicate `createMockStateManager()` defined at module level AND inside describe block. `isRunning` test just verifies mock returns what it was mocked to return. | Remove duplicate factory. Delete mock-testing-mock test. | LOW |
| 4 | `strategy-initializer.test.ts` | Local `createMockLogger()` duplicates `@arbitrage/test-utils` version. | Use the shared `createMockLogger` from test-utils. | LOW |
| 5 | `execution-pipeline.test.ts` | Has `@ts-nocheck` at top of file. | Investigate and remove type suppression. | LOW |
| 6 | `partition-config.test.ts` (105 tests) | Many tests verify individual config fields with repetitive structure. | Use parameterized tests (`it.each`) to reduce boilerplate. | MEDIUM |

---

## P3: Placement & Structural Corrections

| # | File | Current Location | Correct Location | Reason |
|---|------|-----------------|-----------------|--------|
| 1 | `warming-flow.integration.test.ts` | `__tests__/integration/` | `__tests__/unit/` OR upgrade to real integration | Content is pure in-memory, no external deps (see P0 #1) |
| 2 | 12 tests in `fault-injection.integration.test.ts` | `tests/integration/chaos/` | `__tests__/unit/chaos/` | ChaosController + NetworkPartitionSimulator are utility class unit tests (see P0 #2) |
| 3 | `circuit-breaker.test.ts` | `shared/core/__tests__/unit/` | Same, but rename to `circuit-breaker-resilience.test.ts` | Disambiguate from exec-engine's identically-named `circuit-breaker.test.ts` |
| 4 | Performance section in `drawdown-circuit-breaker.test.ts` (lines 932-1015) | `shared/core/__tests__/unit/risk/` | Move benchmarks to `__tests__/performance/` | Per ADR-009, performance tests belong in performance directory |
| 5 | `[Integration]` label in `circuit-breaker.test.ts` describe block | Unit test folder, but describe says `[Integration]` | Remove misleading label | It's a unit test using real CircuitBreaker instances (no external deps) |

---

## P4: Coverage Gaps

| # | Source Module | Risk | Recommended Test Type | What to Test |
|---|-------------|------|----------------------|-------------|
| 1 | `shared/core/src/caching/lru-queue.ts` (182 lines) | **P1-HIGH** | Unit | Eviction correctness, O(1) operations, capacity limits, edge cases (empty queue, single item, duplicate keys), thread safety with SharedArrayBuffer |
| 2 | `shared/core/src/mev-protection/standard-provider.ts` (540 lines) | **P2** | Unit | Submission with fallback, nonce management, timeout handling, disabled state, per-chain strategy selection, health reporting. Umbrella test covers only basic construction. |
| 3 | `shared/core/src/mev-protection/factory.ts` (702 lines) | **P2** | Unit | Concurrent provider creation, cache invalidation, provider lifecycle, error handling during creation, getProvider vs createProvider semantics. Umbrella covers basics only. |
| 4 | Flash loan providers: aave-v3, balancer-v2, syncswap | **P2** | Unit | Error handling, gas estimation, unsupported chain handling, timeout. Shared harness covers common behavior (~20 tests) but provider-specific error paths untested. Add 5-7 tests each. |
| 5 | 7 factory-subscription DEX parsers (algebra, balancer-v2, curve, solidly, trader-joe, v2-pair, v3-pool) | **P3** | Unit | Basic parsing, malformed event handling. Lower risk — parsers are typically simple adapters. |
| 6 | `shared/core/src/async/operation-guard.ts` | **P3** | Unit | Concurrent operation guard behavior |
| 7 | `shared/core/src/partition/` subsystem (config, handlers, health-server) | **P3** | Unit | Currently only tested indirectly via partition service integration |
| 8 | NEW: WebSocket → Detection flow | **P2** | Integration | Mock WS server → real event processor → real detection → real Redis publish. Critical production path currently untested end-to-end. |
| 9 | NEW: L3 cache fallback | **P2** | Integration | L1 miss → L2 miss → L3 (RPC fallback) → promotion. ADR-005 L3 tier never exercised. |

**Note**: `shared/core/src/utils/hmac-utils.ts` was initially reported as untested but has a dedicated test file (398 lines). Gap resolved.

---

## Integration Test Authenticity Matrix

| Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|-----------|-------------|-------------|----------------|---------|
| `coordinator.integration.test.ts` | PARTIAL | REAL | ADR-002, ADR-007 | KEEP — add real StreamConsumer tests |
| `detector-integration.integration.test.ts` | PARTIAL | REAL | ADR-002 | KEEP — consider splitting unit/integration portions |
| `hot-fork-synchronizer.integration.test.ts` | AUTHENTIC | N/A | N/A | KEEP AS-IS |
| `cache.integration.test.ts` | PARTIAL | REAL (L1) | ADR-005 | KEEP — ensure L2 Redis available |
| `detector-lifecycle.integration.test.ts` | AUTHENTIC | REAL | ADR-002, ADR-007 | KEEP AS-IS |
| `partition-service-entry.integration.test.ts` | PARTIAL | REAL | ADR-003 | KEEP — config mock justified |
| `redis-streams-edge-cases.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `redis-streams-hmac-e2e.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `warming-flow.integration.test.ts` | **MOCK THEATER** | N/A | N/A | DOWNGRADE or UPGRADE (P0 #1) |
| `worker-concurrent-reads.integration.test.ts` | AUTHENTIC | N/A | ADR-005, ADR-012 | KEEP AS-IS |
| `worker-price-matrix.integration.test.ts` | AUTHENTIC | N/A | ADR-005, ADR-012 | KEEP AS-IS |
| `worker-thread-safety.integration.test.ts` | AUTHENTIC | N/A | ADR-012 | KEEP AS-IS |
| `worker-zero-copy.integration.test.ts` | AUTHENTIC | N/A | ADR-005, ADR-012 | KEEP AS-IS |
| `security-flow.integration.test.ts` | AUTHENTIC | REAL | N/A | KEEP AS-IS |
| `l2-cache-fallback.integration.test.ts` | AUTHENTIC | REAL | ADR-005 | KEEP AS-IS |
| `fault-injection.integration.test.ts` | **MOCK THEATER** (12/20) | PARTIAL | N/A | SPLIT (P0 #2) |
| `coordinator-execution.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `detector-coordinator.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `price-detection.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `dead-letter-queue.integration.test.ts` | AUTHENTIC | REAL | N/A | KEEP AS-IS |
| `failover-leader-election.integration.test.ts` | AUTHENTIC | REAL | ADR-007 | KEEP AS-IS |
| `failover-sequence.integration.test.ts` | AUTHENTIC | REAL | ADR-007 | KEEP AS-IS |
| `pending-opportunities.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `cross-partition-sync.integration.test.ts` | AUTHENTIC | REAL | ADR-002, ADR-003 | KEEP AS-IS |
| `full-pipeline.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `circuit-breaker-cross-service.integration.test.ts` | AUTHENTIC | REAL | ADR-018 | KEEP AS-IS |
| `s1.1-redis-streams.integration.test.ts` | AUTHENTIC | REAL | ADR-002 | KEEP AS-IS |
| `s1.3-price-matrix.integration.test.ts` | PARTIAL | N/A | ADR-005 | KEEP — SharedArrayBuffer multi-component interaction is valuable |

---

## ADR Compliance Coverage

| ADR | Required Coverage | Current Coverage | Gap |
|-----|------------------|-----------------|-----|
| ADR-002 (Redis Streams) | Full message flow: publish → consumer group → ACK → DLQ | **STRONG** — 10+ test files, HMAC signing, edge cases, consumer groups | Minor: No HMAC + consumer group rebalancing combined scenario |
| ADR-005 (Hierarchical Cache) | L1 → L2 → L3 fallback, promotion/demotion | **STRONG for L1/L2** — price-matrix, worker tests, l2-cache-fallback | **L3 fallback never tested**; warming-flow doesn't use L2 |
| ADR-007 (Leader Election) | Acquire → heartbeat → expire → failover | **STRONG** — atomic ops, full sequence, coordinator lifecycle | No gap |
| ADR-009 (Test Architecture) | Structured directories, centralized test utils | **GOOD** — 0 misplaced tests by folder convention | 2 content-based misplacements (mock theater) |
| ADR-012 (Worker Threads) | Parallel path finding with SharedArrayBuffer | **STRONG** — 4 dedicated worker test files | No gap |
| ADR-018 (Circuit Breaker) | State transitions, real infrastructure wrapping | **STRONG** — cross-service with real Redis disconnect/recovery | No gap |

---

## Unit Test Quality Matrix (Priority Files)

| Test File | Necessity | Engineering | Top Issue | Recommendation |
|-----------|-----------|-------------|-----------|----------------|
| `engine-flash-loan-wiring.test.ts` | VALUABLE | OVER-ENGINEERED | 22 mocks for 4 tests (69% setup) | Extract shared engine mock scaffolding |
| `strategy-initializer.test.ts` | ESSENTIAL | COULD SIMPLIFY | 19 mocks, duplicate local logger | Use shared createMockLogger |
| `detector-lifecycle.test.ts` | VALUABLE | COULD SIMPLIFY | Overlaps with detector.test.ts | Merge into detector.test.ts |
| `engine-lifecycle.test.ts` | ESSENTIAL | COULD SIMPLIFY | Heavy mock re-wiring due to resetAllMocks | Benefits from global resetAllMocks fix |
| `unified-detector.test.ts` | ESSENTIAL | OVER-ENGINEERED | Duplicate mock factories, mock-testing-mock | Clean up duplicates, remove trivial test |
| `chain-instance-websocket.test.ts` | VALUABLE | COULD SIMPLIFY | 7 mocks for WebSocket testing | — |
| `partition-solana/index.test.ts` | ESSENTIAL | COULD SIMPLIFY | 7 mocks for P4 wiring | — |
| `health-monitor.test.ts` (100 tests) | ESSENTIAL | CLEAN | None — model test file | — |
| `detector.test.ts` (103 tests) | VALUABLE | COULD SIMPLIFY | 1953 lines, overlaps lifecycle | Merge lifecycle, consider splitting by concern |
| `price-matrix.test.ts` | ESSENTIAL | CLEAN | None — model test file | — |
| `execution-pipeline.test.ts` | ESSENTIAL | CLEAN | `@ts-nocheck` at top | Remove type suppression |
| `FlashLoanArbitrage.test.ts` | ESSENTIAL | CLEAN | None — model test file | — |
| `CommitRevealArbitrage.security.test.ts` | ESSENTIAL | CLEAN | None | — |
| `MockProtocolFidelity.test.ts` | ESSENTIAL | CLEAN | None — unique and important | — |

---

## Consolidation Roadmap (ordered execution plan)

### Phase 1: Quick Wins (low effort, high impact) — ~2 hours

1. **DELETE** `shared/core/__tests__/unit/redis-streams-hmac.test.ts` (superseded by redis-streams-signing.test.ts)
2. **MERGE** 5 tests from `analytics/swap-event-filter.test.ts` into `swap-event-filter.test.ts`, then delete analytics file
3. **MERGE** unique lifecycle tests from `detector-lifecycle.test.ts` into `detector.test.ts`, then delete lifecycle file
4. **FIX** `unified-detector.test.ts`: remove duplicate `createMockStateManager`, delete `isRunning` mock-testing-mock test
5. **FIX** `strategy-initializer.test.ts`: replace local `createMockLogger` with shared version from `@arbitrage/test-utils`
6. **RENAME** `circuit-breaker.test.ts` → `circuit-breaker-resilience.test.ts` to disambiguate
7. **REMOVE** `[Integration]` label from `circuit-breaker.test.ts` describe block

### Phase 2: Structural Fixes (medium effort) — ~4 hours

1. **SPLIT** `fault-injection.integration.test.ts`: move 12 utility tests to unit, keep 8 Redis tests as integration
2. **RECLASSIFY** `warming-flow.integration.test.ts`: either move to unit or upgrade with real Redis L2
3. **MOVE** performance section from `drawdown-circuit-breaker.test.ts` to `__tests__/performance/`
4. **REFACTOR** `chain-instance.test.ts`: remove private method copies, test through public API
5. **INVESTIGATE** and remove `@ts-nocheck` from `execution-pipeline.test.ts`

### Phase 3: Infrastructure (high effort, highest impact) — ~8 hours

1. **CHANGE** `resetAllMocks()` → `clearAllMocks()` in `jest-setup.ts` — audit affected tests, fix any that rely on reset behavior. Estimated to eliminate ~50% of mock setup code across hundreds of files.
2. **EXTRACT** shared engine mock scaffolding into `test-utils/mocks/execution-engine.mock.ts` — benefits `engine-flash-loan-wiring`, `engine-lifecycle`, `initialization.test.ts`, and other engine tests

### Phase 4: Coverage Gaps (medium effort) — ~6 hours

1. **CREATE** `lru-queue.test.ts` — hot-path caching, P1 priority
2. **CREATE** `standard-provider.test.ts` — MEV protection, P2 priority
3. **CREATE** `mev-factory.test.ts` — MEV provider creation, P2 priority
4. **EXPAND** flash loan providers (aave-v3, balancer-v2, syncswap) — add 5-7 error path tests each
5. **CREATE** WebSocket → Detection integration test — critical production path
6. **CREATE** L3 cache fallback integration test — fills ADR-005 gap

### Phase 5: Long-term (optional) — as time permits

1. Create dedicated tests for 7 factory-subscription DEX parsers
2. Add dedicated tests for partition subsystem (config, handlers, health-server)
3. Add `operation-guard.ts` unit tests
4. Consider splitting `mev-protection.test.ts` monolith (1360 lines) into per-class files
5. Adopt redis-streams `redis-streams/` subdirectory pattern for circuit breakers and MEV protection

---

## Statistics

| Metric | Count |
|--------|-------|
| Total test files | 471 |
| Total test cases | ~13,817 |
| Unit tests | 397 files, ~12,400 cases |
| Integration tests | 28 files, ~500 cases |
| Contract tests | 14 files, ~350 cases |
| Performance tests | 16 files, ~150 cases |
| Other (e2e/smoke/script/deployment) | 16 files, ~367 cases |
| Source modules mapped | 248 |
| Source modules tested (dedicated) | 196 (79%) |
| Source modules partially tested | 22 (9%) |
| Source modules untested | 30 (12%) |
| Tests marked ESSENTIAL | 12 (of 26 sampled) |
| Tests marked VALUABLE | 8 |
| Tests marked REDUNDANT | 3 |
| Tests marked UNNECESSARY | 3 |
| Tests marked CLEAN | 9 |
| Tests marked COULD SIMPLIFY | 10 |
| Tests marked OVER-ENGINEERED | 7 |
| Integration: AUTHENTIC | 19 |
| Integration: PARTIAL | 7 |
| Integration: MOCK THEATER | 2 |
| Integration: REAL REDIS | 18 |
| Integration: MOCKED REDIS | 1 (acceptable) |
| Misplaced tests (folder) | 0 |
| Misplaced tests (content) | 2 |
| Critical gaps (P1-P2) | 6 |
| Redundancy clusters | 5 (3 actionable, 2 complementary) |
| Tests to remove | ~12 (redis-streams-hmac) |
| Tests to merge | ~30 (swap-event-filter + detector-lifecycle) |
| Lines saved by consolidation | ~1,500 |

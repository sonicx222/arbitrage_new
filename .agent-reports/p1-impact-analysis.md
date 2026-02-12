# P1 Consolidation Fixes: Combined Impact Analysis

**Generated**: 2026-02-12
**Agent**: impact-analyst
**Methodology**: Full codebase grep/glob/read verification -- zero guesswork

---

## Table of Contents

1. [Per-Fix Blast Radius](#1-per-fix-blast-radius)
2. [Cross-Fix Interaction Matrix](#2-cross-fix-interaction-matrix)
3. [Recommended Fix Ordering](#3-recommended-fix-ordering)
4. [Risk Assessment](#4-risk-assessment)
5. [P1.1 Detail: Mock Factory Inventory](#5-p11-detail-mock-factory-inventory)
6. [P1.2 Detail: Config Test File Categorization](#6-p12-detail-config-test-file-categorization)
7. [P1.6 Detail: Performance Assertions in Unit Tests](#7-p16-detail-performance-assertions-in-unit-tests)

---

## 1. Per-Fix Blast Radius

### Fix P1.1: Extract Shared Mock Factories

```
FIX:            Extract shared mock factories to shared/test-utils/src/mock-factories.ts
TARGET:         50+ test files defining createMockLogger/createMockStateManager/createMockPerfLogger
BLAST RADIUS:   Test files ONLY -- no production code touched
CALLERS:        Each test file self-contains its own factory (no cross-file imports currently)
HOT-PATH PROXIMITY: NONE
RISK:           LOW (test-only, no functional changes)
```

**Key Findings:**
- `createMockLogger` is defined in **22+ test files** (see Section 5 for full list)
- `createMockStateManager` is defined in **7 files** with **3 distinct variants** (see Section 5)
- `createMockPerfLogger` is defined in **7 files** with **2 distinct variants**
- `shared/test-utils/src/mocks/partition-service.mock.ts` ALREADY exports `createMockLogger` and `createMockStateManager` -- but only 4 partition service tests import from there
- `engine.test.ts` alone defines `createMockLogger` x5, `createMockPerfLogger` x4, `createMockStateManager` x4

**Existing infrastructure in `shared/test-utils/src/mocks/`:**
- `partition-service.mock.ts` -- has `createMockLogger()` (4-method: info/error/warn/debug) and `createMockStateManager()` (executeStart/executeStop/isRunning/getState)
- `index.ts` -- re-exports from partition-service.mock.ts and provider.mock.ts

**Variant Differences (critical for canonical version):**

| Factory | Base (4-method) | Extended Variants |
|---------|----------------|-------------------|
| `createMockLogger` | `{ info, error, warn, debug }` -- all jest.fn() | Some add `child: jest.fn().mockReturnThis()` (mempool-detector). Some type as `: Logger`, others as `: SolanaArbitrageLogger`, `: ModuleLogger`, `: MockLogger` |
| `createMockStateManager` | partition-service.mock: `{ executeStart, executeStop, isRunning, getState }` | engine.test.ts variant: `{ getState, executeStart, executeStop, transition, isTransitioning, waitForIdle, on, off, canTransition }` (NO `isRunning`). provider.service: `{ isRunning, getState }` only |
| `createMockPerfLogger` | engine.test.ts: `{ logEventLatency, logExecutionResult, logHealthCheck }` | simulation-metrics-collector: adds `info, error, warn, debug, child, startTimer, endTimer, logEventLatency, logArbitrageOpportunity, logExecutionResult`. unified-detector: `{ logHealthCheck }` only. solana-detector: `{ logEventLatency, logArbitrageOpportunity, logHealthCheck }` |

**Recommendation for canonical versions:**
1. `createMockLogger()` -- superset with optional `child` method: `{ info, error, warn, debug, child? }`
2. `createMockStateManager()` -- TWO variants needed:
   - **Partition StateManager**: `{ executeStart, executeStop, isRunning, getState }` (already exists)
   - **Engine StateManager**: `{ getState, executeStart, executeStop, transition, isTransitioning, isRunning, waitForIdle, on, off, canTransition }` (new)
3. `createMockPerfLogger()` -- superset: `{ logEventLatency, logExecutionResult, logArbitrageOpportunity, logHealthCheck }`

---

### Fix P1.2: Downgrade 16 Config Validation Tests

```
FIX:            Move/reclassify 16 integration tests to unit tests
TARGET:         tests/integration/*.integration.test.ts (16 files)
BLAST RADIUS:   Jest project matching patterns; CI pipeline test counts
CALLERS:        None (test files are leaf nodes)
HOT-PATH PROXIMITY: NONE
RISK:           MEDIUM (Jest config pattern changes affect which project discovers which tests)
```

**Jest Config Context:**
- Unit project: `testMatch: ['**/__tests__/unit/**/*.test.ts']`
- Integration project: `testMatch: ['**/__tests__/integration/**/*.test.ts', '**/tests/integration/**/*.test.ts']`
- Moving files from `tests/integration/` to `shared/config/__tests__/unit/` would shift them from integration to unit project

**Existing unit tests in shared/config:** 8 files already exist in `shared/config/__tests__/unit/`:
- `chain-url-builder.test.ts`, `partitions.test.ts`, `cross-chain.test.ts`, `websocket-resilience.test.ts`, `dex-expansion.test.ts`, `config-manager.test.ts`, `dex-factories.test.ts`, `config-modules.test.ts`

See Section 6 for full categorization of the 16 files.

---

### Fix P1.3: Merge SwapEventFilter Redundancy

```
FIX:            Merge swap-event-filter-extended.test.ts into swap-event-filter.test.ts
TARGET:         shared/core/__tests__/unit/swap-event-filter.test.ts (base)
                shared/core/__tests__/unit/swap-event-filter-extended.test.ts (extended)
BLAST RADIUS:   2 files only. No external importers.
CALLERS:        None (leaf test files)
HOT-PATH PROXIMITY: NONE
RISK:           LOW
```

**Test Inventory Comparison:**

Base file (`swap-event-filter.test.ts`): 30 tests across 12 describe blocks:
- Constructor and Configuration (3 tests)
- Edge Filter / Dust Filter (4 tests)
- Deduplication Filter (3 tests)
- Whale Detection (4 tests)
- Volume Aggregation (3 tests)
- Batch Processing (2 tests)
- Filter Statistics (4 tests)
- Singleton Pattern (2 tests)
- Memory Management (2 tests)
- Edge Cases (7 tests)
- Integration with Metrics (1 test)
- Interface shape tests (3 tests)

Extended file (`swap-event-filter-extended.test.ts`): ~35 tests across 10 describe blocks:
- S1.2.1 Core Functionality: Zero Amount, Value Filter, Dedup (overlaps with base)
- S1.2.2 Whale Detection (overlaps)
- S1.2.3 Volume Aggregation (overlaps)
- S1.2.4 Filter Statistics (overlaps)
- S1.2.5 Prometheus Metrics (overlaps)
- Batch Processing (overlaps)
- Memory Management (overlaps)
- Singleton Pattern (overlaps)
- Edge Cases (overlaps)
- **Performance Benchmarks** (lines 904-953) -- UNIQUE, has timing assertions
- **Hypothesis Validation** (lines 955-1030) -- UNIQUE, statistical validation

**Unique tests in extended (3 tests to migrate):**
1. `Performance Benchmarks > should process single event in <1ms average` (line 909)
2. `Performance Benchmarks > should maintain consistent performance under load` (line 925)
3. `Hypothesis Validation > should achieve high event reduction while retaining actionable signals` (line 963)

**NOTE**: The 2 performance benchmark tests in extended should go to a `swap-event-filter.performance.test.ts` file per P1.6 rules, NOT into the base unit test file.

---

### Fix P1.4: Split engine.test.ts (1311 lines)

```
FIX:            Split engine.test.ts into ~4 focused test files
TARGET:         services/execution-engine/__tests__/unit/engine.test.ts
BLAST RADIUS:   1 file -> 4 files. No external importers.
CALLERS:        None (leaf test file)
HOT-PATH PROXIMITY: NONE (tests only)
RISK:           LOW-MEDIUM (must preserve all 48 tests, mock factories must be correct per split file)
```

**Top-Level Describe Blocks with Line Ranges:**

| # | Describe Block | Lines | Tests | Proposed File |
|---|---------------|-------|-------|---------------|
| 1 | `ExecutionEngineService` | 80-140 | 2 | `engine-core.test.ts` |
| 2 | `ExecutionEngineService Production Simulation Guard (FIX-3.1)` | 146-271 | 4 | `engine-core.test.ts` |
| 3 | `Precision Fix Regression Tests` | 279-333 | 5 | `engine-core.test.ts` |
| 4 | `ExecutionEngineService Standby Configuration (ADR-007)` | 339-441 | 3 | `engine-core.test.ts` |
| 5 | `QueueService Pause/Resume (ADR-007)` | 449-576 | 7 | `engine-queue.test.ts` |
| 6 | `Circuit Breaker Integration Tests (Phase 1.3.3)` | 588-1183 | 14 | `engine-circuit-breaker.test.ts` |
| 7 | `Lock Holder Crash Recovery (SPRINT 1 FIX)` | 1189-1311 | 3 | `engine-crash-recovery.test.ts` |

**Total: 38 tests across 7 describe blocks (some with nested describes)**

**Mock Factory Duplication in engine.test.ts:**
- `createMockLogger`: defined at lines 26, 158, 341, 451, 590, 1190 (6 times!)
- `createMockPerfLogger`: defined at lines 44, 165, 349, 1197 (4 times)
- `createMockStateManager`: defined at lines 68, 171, 356, 1203 (4 times)
- `createMockEventEmitter`: defined at line 597 (1 time, circuit breaker specific)

**Proposed 4-File Split:**

1. **`engine-core.test.ts`** (~300 lines)
   - ExecutionEngineService (init, stats)
   - Production Simulation Guard (FIX-3.1)
   - Precision Fix Regression Tests
   - Standby Configuration (ADR-007)

2. **`engine-queue.test.ts`** (~130 lines)
   - QueueService Pause/Resume (ADR-007)
   - Imports QueueServiceImpl directly

3. **`engine-circuit-breaker.test.ts`** (~600 lines)
   - Circuit Breaker Integration Tests (all 4 nested describes)
   - Imports createCircuitBreaker, CircuitBreaker, CircuitBreakerEvent

4. **`engine-crash-recovery.test.ts`** (~130 lines)
   - Lock Holder Crash Recovery
   - Documents crash recovery timing requirements

---

### Fix P1.5: Consolidate websocket-manager.test.ts (1153 lines)

```
FIX:            Consolidate trivial config tests into parameterized tests
TARGET:         shared/core/__tests__/unit/websocket-manager.test.ts
BLAST RADIUS:   1 file only. No external importers.
CALLERS:        None (leaf test file)
HOT-PATH PROXIMITY: NONE
RISK:           LOW
```

**Test Count Analysis:**
- Total: 55 tests across 11 top-level describe blocks
- `toBeDefined()` assertions found: 7 (not as many as initially estimated)
- The file is large due to thorough testing, not trivial assertions

**Describe Block Breakdown:**
1. `WebSocketManager` (34 tests)
   - Fallback URL Configuration (3 tests)
   - getCurrentUrl() (2 tests)
   - getConnectionStats() (2 tests)
   - Configuration Defaults (4 tests) -- CANDIDATES for parameterization
   - isWebSocketConnected() (1 test)
   - disconnect() (2 tests)
   - removeAllListeners() (1 test)
   - subscribe() (2 tests)
   - unsubscribe() (2 tests)
   - Event Handlers (4 tests)

2. `WebSocketManager Exponential Backoff` (8 tests)
   - calculateReconnectDelay() (6 tests)
   - Configuration (2 tests) -- CANDIDATES for parameterization

3. `WebSocketManager Rate Limit Handling` (14 tests)
   - isRateLimitError() (11 tests) -- STRONG candidates for describe.each
   - Provider Exclusion (5 tests)
   - URL Switching (1 test)

4. `WebSocketManager Fallback URL Integration` (3 tests)
5. `WebSocketManager Worker Thread JSON Parsing` (12 tests) -- some CANDIDATES for parameterization

**Parameterization Opportunities:**
- `isRateLimitError()` 11 tests testing different error codes/messages: collapse to `it.each`
- Configuration Defaults 4 tests: collapse to `it.each`
- Worker parsing config tests: 4 tests could use `it.each`

**Estimated reduction: 55 -> ~38 tests (parameterized), ~400 fewer lines**

---

### Fix P1.6: Move Performance Assertions from Unit Tests

```
FIX:            Extract timing/performance assertions to .performance.test.ts files
TARGET:         ~15 unit test files containing performance.now() / toBeLessThan(ms) patterns
BLAST RADIUS:   Unit test files -> new performance test files
CALLERS:        None (leaf test files)
HOT-PATH PROXIMITY: NONE
RISK:           LOW-MEDIUM (must ensure moved tests still run in CI)
```

See Section 7 for the full file list.

---

## 2. Cross-Fix Interaction Matrix

| | P1.1 Mock | P1.2 Config | P1.3 Swap | P1.4 Engine | P1.5 WS | P1.6 Perf |
|---|---|---|---|---|---|---|
| **P1.1** | - | NONE | NONE | **STRONG** | NONE | NONE |
| **P1.2** | NONE | - | NONE | NONE | NONE | NONE |
| **P1.3** | NONE | NONE | - | NONE | NONE | **WEAK** |
| **P1.4** | **STRONG** | NONE | NONE | - | NONE | NONE |
| **P1.5** | NONE | NONE | NONE | NONE | - | NONE |
| **P1.6** | NONE | NONE | **WEAK** | NONE | NONE | - |

### Interaction Details:

**P1.1 <-> P1.4 (STRONG)**
- engine.test.ts defines mock factories 6x/4x/4x that P1.1 would extract
- P1.4 splits engine.test.ts into 4 files that would each need P1.1 imports
- **ORDER CONSTRAINT**: P1.1 MUST come before P1.4
- If P1.4 is done first, each split file would duplicate factories; then P1.1 would have to de-duplicate across 4 new files instead of 1

**P1.3 <-> P1.6 (WEAK)**
- swap-event-filter-extended.test.ts has a "Performance Benchmarks" describe block (lines 904-953)
- These 2 tests should be moved to a performance file (P1.6 concern) rather than merged into the base file (P1.3 concern)
- **RESOLUTION**: When P1.3 merges extended into base, skip the Performance Benchmarks describe and instead create `swap-event-filter.performance.test.ts` as part of P1.6

---

## 3. Recommended Fix Ordering

```
PHASE A (Independent, can be parallel):
  P1.2: Downgrade config tests         [INDEPENDENT, no interactions]
  P1.5: Consolidate websocket-manager   [INDEPENDENT, no interactions]

PHASE B (Sequential, dependency chain):
  P1.1: Extract mock factories          [MUST come before P1.4]
  P1.4: Split engine.test.ts            [DEPENDS on P1.1]

PHASE C (Coordinate together):
  P1.3: Merge swap-event-filter         [Skip perf tests for P1.6]
  P1.6: Move performance assertions     [Includes perf tests from P1.3]
```

**Dependency Graph:**
```
P1.2 -----> (independent)
P1.5 -----> (independent)
P1.1 -----> P1.4 (P1.1 blocks P1.4)
P1.3 -----> P1.6 (P1.3 should coordinate with P1.6 for perf tests)
```

**Recommended Execution Order:**
1. **P1.2** -- Completely independent, file moves only
2. **P1.5** -- Completely independent, single file edit
3. **P1.1** -- Extract mock factories (creates shared infrastructure)
4. **P1.4** -- Split engine.test.ts (uses P1.1 infrastructure)
5. **P1.3** -- Merge swap-event-filter (skip perf tests)
6. **P1.6** -- Move all performance assertions (including from P1.3)

---

## 4. Risk Assessment

| Fix | Risk | Justification |
|-----|------|---------------|
| P1.1 | **LOW** | Test-only changes. Existing `partition-service.mock.ts` proves the pattern works. Risk: variant signatures may cause type errors in consuming tests. Mitigation: use `Partial<>` types or overload signatures. |
| P1.2 | **MEDIUM** | Jest config pattern matching determines which project runs which tests. Risk: moved files may not be discovered by the correct project. Mitigation: verify `testMatch` patterns cover new paths. The target `shared/config/__tests__/unit/` is ALREADY matched by the unit project via `**/__tests__/unit/**/*.test.ts`. **4 of the 16 files are NOT pure config and should remain as integration tests.** |
| P1.3 | **LOW** | Two files, ~70% overlap. Only 3 unique tests to migrate. Clear merge strategy. Risk: import differences between files. Extended uses mocked ioredis; base does not. Mitigation: the unique tests from extended do NOT use ioredis. |
| P1.4 | **LOW-MEDIUM** | 1311-line file split. All tests are self-contained within their describe blocks. Risk: imports at unusual positions (line 277 `ethers`, line 447 `QueueServiceImpl`, line 582 `circuit-breaker`). Each split file needs its own imports. Mitigation: each describe block's imports are clearly scoped. |
| P1.5 | **LOW** | Single file parameterization. No structural changes. Risk: `it.each` syntax may need careful tuple typing. Mitigation: well-understood Jest pattern. |
| P1.6 | **LOW-MEDIUM** | ~15 files affected. Risk: some "performance" assertions are actually functional (e.g., "memory should be < 16KB" is a regression guard). Need judgment on which assertions are timing-based (flaky) vs. resource-bound (stable). Mitigation: only move assertions using `performance.now()` or `Date.now()` for timing. |

---

## 5. P1.1 Detail: Mock Factory Inventory

### createMockLogger Definitions (22+ files)

**Standard 4-method variant** (info/error/warn/debug -- all jest.fn()):

| File | Type Annotation | Extra Methods |
|------|----------------|---------------|
| `shared/test-utils/src/mocks/partition-service.mock.ts` | `: MockLogger` | None (CANONICAL) |
| `services/execution-engine/__tests__/unit/engine.test.ts` (x6) | `() =>` (inferred) | None |
| `services/execution-engine/__tests__/unit/strategies/strategy-factory.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/strategies/simulation.strategy.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/strategies/intra-chain.strategy.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/strategies/flash-loan.strategy.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/provider-factory.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/strategies/cross-chain.strategy.test.ts` | `: Logger` | None |
| `services/execution-engine/__tests__/unit/services/commit-reveal.service.test.ts` | varies | None |
| `services/execution-engine/__tests__/unit/consumers/opportunity.consumer.test.ts` | - | None |
| `services/execution-engine/__tests__/unit/services/provider.service.test.ts` | - | None |
| `services/execution-engine/__tests__/unit/services/simulation/simulation-metrics-collector.test.ts` | - | None |
| `services/execution-engine/__tests__/unit/services/simulation/hot-fork-synchronizer.test.ts` | - | None |
| `services/unified-detector/src/__tests__/unit/whale-alert-publisher.test.ts` | `: Logger` | None |
| `services/unified-detector/src/__tests__/unit/opportunity-publisher.test.ts` | `: Logger` | None |
| `services/unified-detector/src/__tests__/unit/unified-detector.test.ts` (x2) | inferred | None |
| `services/unified-detector/src/__tests__/unit/chain-simulation-handler.test.ts` | `: Logger` | None |
| `services/cross-chain-detector/src/__tests__/unit/bridge-cost-estimator.test.ts` | inferred | None |
| `services/cross-chain-detector/src/__tests__/unit/pending-opportunity.test.ts` | inferred | None |
| `services/cross-chain-detector/src/__tests__/unit/ml-prediction-manager.test.ts` | `: ModuleLogger` | None |
| `services/cross-chain-detector/src/__tests__/integration/detector-integration.integration.test.ts` | inferred | None |
| `services/coordinator/src/__tests__/coordinator.integration.test.ts` | inferred | None |
| `services/coordinator/__tests__/unit/leadership/leadership-election-service.test.ts` | - | None |
| `services/partition-solana/src/__tests__/arbitrage-detector.test.ts` | `: SolanaArbitrageLogger` | None |
| `shared/core/src/solana/__tests__/solana-detector.test.ts` | - | None |
| `shared/core/src/publishing/__tests__/publishing-service.test.ts` | - | None |
| `shared/core/__tests__/unit/tier2-optimizations.test.ts` | - | None |
| `shared/core/__tests__/unit/stream-health-monitor.test.ts` | - | None |
| `shared/core/__tests__/unit/price-oracle.test.ts` | - | None |
| `shared/core/__tests__/unit/logging.test.ts` | - | None |
| `shared/core/__tests__/unit/distributed-lock.test.ts` | - | None |
| `shared/core/__tests__/unit/cross-region-health.test.ts` | - | None |
| `tests/integration/s4.1.5-failover-scenarios.integration.test.ts` | inferred | None |

**Extended variant** (adds `child`):

| File | Extra Methods |
|------|--------------|
| `services/mempool-detector/src/__tests__/mempool-detector-service.test.ts` | `child: jest.fn().mockReturnThis()` |

### createMockStateManager Definitions (7 files, 3 variants)

**Variant A: Partition style** (executeStart/executeStop/isRunning/getState):
- `shared/test-utils/src/mocks/partition-service.mock.ts` (CANONICAL)
- `services/unified-detector/src/__tests__/unit/unified-detector.test.ts` (x2)
- `services/coordinator/src/__tests__/coordinator.integration.test.ts`

**Variant B: Engine style** (getState/executeStart/executeStop/transition/isTransitioning/waitForIdle/on/off/canTransition):
- `services/execution-engine/__tests__/unit/engine.test.ts` (x4, lines 68, 171, 356, 1203)
  - Slight variations: line 68 lacks `isRunning`, line 171 has `isRunning: false`, line 356 has `isRunning: true`

**Variant C: Minimal** (isRunning/getState only):
- `services/execution-engine/__tests__/unit/services/provider.service.test.ts`

### createMockPerfLogger Definitions (7 files, 3 variants)

**Variant A: Engine style** (logEventLatency/logExecutionResult/logHealthCheck):
- `services/execution-engine/__tests__/unit/engine.test.ts` (x4)
- `services/coordinator/src/__tests__/coordinator.integration.test.ts` (logEventLatency/logHealthCheck only)
- `services/cross-chain-detector/src/__tests__/integration/detector-integration.integration.test.ts` (logArbitrageOpportunity/logEventLatency/logHealthCheck)

**Variant B: Full metrics** (many methods):
- `services/execution-engine/__tests__/unit/services/simulation/simulation-metrics-collector.test.ts`

**Variant C: Minimal** (logHealthCheck only):
- `services/unified-detector/src/__tests__/unit/unified-detector.test.ts`

**Variant D: Solana** (logEventLatency/logArbitrageOpportunity/logHealthCheck):
- `shared/core/src/solana/__tests__/solana-detector.test.ts`

---

## 6. P1.2 Detail: Config Test File Categorization

### Files and Their Categories

| # | File | Content | Category | Uses Real Deps? |
|---|------|---------|----------|----------------|
| 1 | `s2.1-optimism.integration.test.ts` | Tests CHAINS, DEXES, CORE_TOKENS config values for Optimism | **dex-config + chain-config** | NO -- pure config validation |
| 2 | `s2.2-dex-expansion.integration.test.ts` | Tests DEX expansion across Arbitrum (6->9), helper functions | **dex-config** | NO -- pure config validation |
| 3 | `s2.2.2-base-dex-expansion.integration.test.ts` | Tests DEX expansion for Base chain (5->7) | **dex-config** | NO -- pure config validation |
| 4 | `s2.2.3-bsc-dex-expansion.integration.test.ts` | Tests DEX expansion for BSC (5->8) | **dex-config** | NO -- pure config validation |
| 5 | `s2.2.4-token-coverage.integration.test.ts` | Tests total token count (60), token addresses, decimals | **token-config** | NO -- pure config validation |
| 6 | `s2.2.5-pair-initialization.integration.test.ts` | Tests pair discovery service, caching | **MIXED** | Has mocked Redis -- keep as integration |
| 7 | `s2.2.5-pair-services.integration.test.ts` | Tests PairDiscoveryService and PairCacheService | **MIXED** | Mocks @arbitrage/core, has DI -- NOT pure config |
| 8 | `s3.1.2-partition-assignment.integration.test.ts` | Tests 4-partition architecture, chain assignment | **partition-config** | NO -- pure config validation |
| 9 | `s3.1.7-detector-migration.integration.test.ts` | Tests PartitionRouter, migration utilities | **partition-config** | NO -- imports from @arbitrage/core but only constants |
| 10 | `s3.2.4-cross-chain-detection.integration.test.ts` | Tests cross-chain token normalization, bridge costs | **chain-config + token-config** | NO -- pure config validation |
| 11 | `s3.3.2-solana-dex-configuration.integration.test.ts` | Tests 7 Solana DEX configs | **dex-config** | NO -- pure config validation |
| 12 | `s3.3.3-solana-token-configuration.integration.test.ts` | Tests 15 Solana token configs | **token-config** | NO -- pure config validation |
| 13 | `s3.3.7-solana-partition-deploy.integration.test.ts` | Tests Solana P4 partition deployment config | **partition-config** | NO -- pure config/mock validation |
| 14 | `s4.1.4-standby-service-deployment.integration.test.ts` | Tests deployment file existence (YAML, Dockerfiles) | **deployment-config** | Uses `fs.existsSync` -- reads filesystem |
| 15 | `vault-model-dex-regression.integration.test.ts` | Tests vault model DEX configs, PairDiscoveryService | **dex-config** | Imports PairDiscoveryService -- NOT pure config |
| 16 | `config-validation/chain-config.integration.test.ts` | Parameterized chain config tests (Avalanche, Fantom) | **chain-config** | NO -- pure config validation |

### Recommended Categorization for 4 Target Files:

**`shared/config/__tests__/unit/chain-config-validation.test.ts`** (consolidate #1 partial, #10 partial, #16):
- Optimism chain config, cross-chain config, Avalanche/Fantom config

**`shared/config/__tests__/unit/dex-config-validation.test.ts`** (consolidate #1 partial, #2, #3, #4, #11):
- Optimism DEX, Arbitrum DEX expansion, Base DEX, BSC DEX, Solana DEX

**`shared/config/__tests__/unit/token-config-validation.test.ts`** (consolidate #5, #10 partial, #12):
- Token coverage, cross-chain tokens, Solana tokens

**`shared/config/__tests__/unit/partition-config-validation.test.ts`** (consolidate #8, #9, #13):
- Partition assignment, detector migration, Solana partition

### Files to EXCLUDE from downgrade (NOT pure config):
- **#6 `s2.2.5-pair-initialization`** -- Has mocked Redis, tests service logic
- **#7 `s2.2.5-pair-services`** -- Mocks @arbitrage/core, tests PairDiscoveryService/PairCacheService
- **#14 `s4.1.4-standby-service-deployment`** -- Reads filesystem (fs.existsSync), tests deployment artifacts
- **#15 `vault-model-dex-regression`** -- Imports PairDiscoveryService, tests adapter integration

**Corrected count: 12 pure config tests to downgrade, 4 to keep as integration**

---

## 7. P1.6 Detail: Performance Assertions in Unit Tests

### Files with `performance.now()` or Timing-Based Assertions in Unit Test Directories

**shared/core/__tests__/unit/ (15 files with `performance.now()` or `toBeLessThan(N)`):**

| File | Perf Pattern | Description |
|------|-------------|-------------|
| `price-matrix.test.ts` | `performance.now()` + `toBeLessThan(0.02)`, `toBeLessThan(100)` | O(1) lookup time, batch operation timing |
| `tier1-optimizations.test.ts` | `performance.now()` + `toBeLessThan(500)`, `toBeLessThan(150)` | LRU cache operation timing, lookup timing |
| `tier2-optimizations.test.ts` | `performance.now()` | Various optimization timing |
| `tier3-optimizations.test.ts` | `toBeLessThan(N)` | Advanced optimization timing |
| `swap-event-filter-extended.test.ts` | `toBeLessThan(500)`, `toBeLessThan(1)`, `toBeLessThan(10)` | Event processing timing |
| `data-structures/lru-cache.test.ts` | `toBeLessThan(N)` | Cache operation timing |
| `mev-risk-analyzer.test.ts` | `toBeLessThan(N)` | Analysis timing |
| `mev-protection-providers.test.ts` | `toBeLessThan(N)` | Provider timing |
| `generators/simulated-price.generator.test.ts` | `toBeLessThan(N)` | Generation timing |
| `fixes-regression.test.ts` | `toBeLessThan(N)` | Regression timing checks |
| `regression.test.ts` | `toBeLessThan(N)` | Regression timing checks |
| `risk/drawdown-circuit-breaker.test.ts` | `toBeLessThan(N)` | Circuit breaker timing |
| `risk/ev-calculator.test.ts` | `toBeLessThan(N)` | Calculation timing |
| `risk/execution-probability-tracker.test.ts` | `toBeLessThan(N)` | Tracking timing |
| `risk/position-sizer.test.ts` | `toBeLessThan(N)` | Sizing timing |

**services/ (6+ files with timing in unit tests):**

| File | Perf Pattern | Description |
|------|-------------|-------------|
| `cross-chain-detector/src/__tests__/unit/detector.test.ts` | `toBeLessThan(N)` | Detection timing |
| `cross-chain-detector/src/__tests__/unit/bridge-predictor.test.ts` | `toBeLessThan(N)` | Prediction timing |
| `unified-detector/src/__tests__/unit/simple-arbitrage-detector.test.ts` | `toBeLessThan(N)` | Detection timing |
| `execution-engine/__tests__/unit/ab-testing-framework.test.ts` | `toBeLessThan(N)` | Framework timing |
| `execution-engine/src/__tests__/unit/execution-flow.test.ts` | `toBeLessThan(N)` | Flow timing |
| `partition-solana/src/__tests__/arbitrage-detector.test.ts` | `toBeLessThan(N)` | Detection timing |

### Existing Performance Test Files (already properly placed):

```
shared/core/__tests__/performance/
  hot-path.performance.test.ts
  professional-quality.performance.test.ts
  hierarchical-cache-l1-benchmark.test.ts

services/unified-detector/__tests__/performance/
  cache-load.performance.test.ts
  hotpath-profiling.performance.test.ts
  memory-stability.performance.test.ts
  sustained-load.performance.test.ts

services/unified-detector/src/__tests__/performance/
  chain-instance-hot-path.performance.test.ts

services/execution-engine/__tests__/performance/
  batch-quoter-benchmark.test.ts
```

### Judgment Criteria for Moving:
- **MOVE**: Tests using `performance.now()` for wall-clock timing that may be flaky in CI
- **KEEP**: Tests using `toBeLessThan` for memory/size bounds (e.g., "memory < 16KB") -- these are regression guards, not timing tests
- **KEEP**: Tests using `toBeGreaterThanOrEqual(0)` -- these are range checks, not perf

**High-confidence moves (use `performance.now()` for elapsed-time assertions):**
1. `price-matrix.test.ts` -- O(1) lookup timing assertions (lines ~200-210, ~590-640)
2. `tier1-optimizations.test.ts` -- LRU operation timing (lines ~134-174, ~513-523)
3. `tier2-optimizations.test.ts` -- Optimization timing assertions
4. `swap-event-filter-extended.test.ts` -- Performance Benchmarks describe (lines 904-953)

---

## Summary

| Fix | Files Changed | Lines Impact | Risk | Dependencies |
|-----|--------------|-------------|------|-------------|
| P1.1 | ~25 test files + 1 new | ~500 lines removed (duplication) | LOW | None |
| P1.2 | 12 files moved + 4 new consolidated | ~3000 lines moved | MEDIUM | None |
| P1.3 | 2 files -> 1 file | ~1000 lines removed | LOW | Coordinate with P1.6 |
| P1.4 | 1 file -> 4 files | ~1311 lines reorganized | LOW-MEDIUM | Depends on P1.1 |
| P1.5 | 1 file | ~400 lines reduced | LOW | None |
| P1.6 | ~10 files -> ~5 new perf files | ~200 lines moved | LOW-MEDIUM | Coordinate with P1.3 |

**Critical Path**: P1.1 -> P1.4 (must be sequential)
**Parallel Safe**: P1.2, P1.5 (fully independent)
**Coordinate**: P1.3 + P1.6 (perf test overlap)

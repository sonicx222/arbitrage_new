# Test Consolidation Plan

Generated: 2026-02-12

## Summary

- **Redundant test clusters found**: 3
- **Tests recommended for removal**: 1 (after merging)
- **Tests recommended for merge**: 4 (into 2 merged files)
- **Tests recommended for reclassification/move**: 12
- **Critical gaps identified**: 38 (prioritized by risk)

---

## Redundancy Clusters

### Cluster 1: EventProcessor (CONFIRMED REDUNDANT - MERGE)

**Files involved:**
1. `shared/core/__tests__/unit/detector/event-processor.test.ts` (422 lines)
2. `shared/core/src/detector/__tests__/event-processor.test.ts` (315 lines)

**Analysis:**
Both files test the exact same 7 functions from `shared/core/src/detector/event-processor.ts`:
- `decodeSyncEventData` - both test: valid decode, zero reserves, invalid data, large values
- `decodeSwapEventData` - both test: valid decode, missing topics, empty topics
- `parseBlockNumber` - both test: hex string, numeric, zero
- `buildExtendedPair` - both test: all properties, immutability, independent objects
- `buildPriceUpdate` - both test: correct construction, custom fee
- `buildSwapEvent` - both test: correct construction, missing tx hash, hex block number
- `generatePairKey` - both test: key format, different DEXs

**Key differences:**
- File 1 (in `__tests__/unit/detector/`) uses real `ethers.AbiCoder` encoding for test data - more realistic
- File 1 has extra regression tests for P0-1 (atomic pair swap pattern, no shared references)
- File 2 (in `src/detector/__tests__/`) has one unique test: `generatePairKey` case-sensitivity
- File 2 uses raw hex strings instead of ABI-encoded data

**Recommendation: MERGE INTO `__tests__/unit/detector/event-processor.test.ts`**
- Keep File 1 as the canonical location (follows ADR-009 convention)
- Add the case-sensitivity test from File 2 to File 1
- Delete File 2

### Cluster 2: SwapEventFilter (CONFIRMED REDUNDANT - MERGE)

**Files involved:**
1. `shared/core/__tests__/unit/swap-event-filter.test.ts`
2. `shared/core/__tests__/unit/swap-event-filter-extended.test.ts`

**Analysis:**
Both test `SwapEventFilter` from `shared/core/src/analytics/swap-event-filter.ts`. Both test the same features: edge filter, dedup filter, whale detection, volume aggregation, batch processing.

**Overlap per section:**
| Feature | File 1 | File 2 (Extended) | Overlap |
|---|---|---|---|
| Zero amount filtering | 1 test | 1 test | DUPLICATE |
| USD threshold filter | 2 tests | 3 tests | OVERLAPPING (extended adds custom config, negative value) |
| Dedup filter | 3 tests | 3 tests | OVERLAPPING (extended tests are ~same) |
| Whale detection | 4 tests | 5 tests | OVERLAPPING (extended adds unsubscribe test) |
| Volume aggregation | 3 tests | 3 tests | OVERLAPPING (~same coverage) |
| Batch processing | 1 test | N/A | UNIQUE to File 1 |
| Amount estimation | 1 test | N/A | UNIQUE to File 1 |
| Invalid BigInt handling | N/A | 1 test | UNIQUE to File 2 |
| Negative USD values | N/A | 1 test | UNIQUE to File 2 |
| Unsubscribe | N/A | 1 test | UNIQUE to File 2 |

**Recommendation: MERGE INTO `swap-event-filter.test.ts`**
- Keep File 1 as the canonical file
- Add 3 unique tests from File 2 (invalid BigInt, negative USD, unsubscribe) to File 1
- Delete File 2 (`swap-event-filter-extended.test.ts`)

### Cluster 3: ProfessionalQualityMonitor (PARTIALLY REDUNDANT - KEEP BOTH, REFOCUS)

**Files involved:**
1. `shared/core/__tests__/unit/professional-quality-monitor.test.ts` (~370 lines)
2. `shared/core/__tests__/unit/professional-quality.test.ts` (~310 lines)
3. `shared/core/__tests__/performance/professional-quality.performance.test.ts`

**Analysis:**
Both unit test files test `ProfessionalQualityMonitor`. File 1 is granular (tests individual methods: score calculation, grading, percentiles, feature impact), File 2 is flow-oriented (end-to-end scoring, persistence, concurrency, error resilience).

**Overlap areas:**
- Feature impact assessment: both test positive and negative impacts
- Error handling: both test Redis failures
- Score calculation: both test score generation

**Recommendation: KEEP BOTH but rename for clarity**
- Rename File 2 to `professional-quality-monitor-flows.test.ts` to distinguish from granular tests
- No code duplication removal needed -- approaches are sufficiently different
- File 3 (performance) is clearly distinct

---

## Non-Redundant Clusters (Confirmed Complementary)

These were flagged as potential overlaps but are **confirmed complementary** after analysis:

| Cluster | Files | Reason Complementary |
|---|---|---|
| Circuit Breaker | `simple-circuit-breaker.test.ts`, `circuit-breaker.test.ts` (exec-engine), `drawdown-circuit-breaker.test.ts`, `circuit-breaker-api.test.ts`, `circuit-breaker.integration.test.ts` | Each tests a **different class**: SimpleCircuitBreaker (shared/core), CircuitBreaker (execution-engine), DrawdownCircuitBreaker (risk), API routes, integration flow |
| Redis Streams | 3 unit tests + ADR compliance + integration | Each tests a different aspect: basic ops, consumer groups, stream consumer, ADR compliance, full integration |
| Price Matrix | 5 unit + 5 integration + 2 performance | Unit (API), worker (SharedArrayBuffer), integration (cross-thread), performance (benchmarks) |
| Hierarchical Cache | unit + pricematrix + benchmark + warming | Unit (API), pricematrix integration (L1-L2), benchmark (perf), warming (cache warming flow) |
| WebSocket Manager | websocket-manager.test + factory-subscription + detector-integration | Direct tests vs consumer tests (factory subscription uses websocket, detector integration uses websocket) |
| Cross-Region Health | 1 dedicated + 11 files referencing it | Only 1 file tests CrossRegionHealthManager directly; others test consumers |
| Commit Reveal | unit + integration (in `src/__tests__/integration/`) | Unit tests mock everything; integration tests full flow with timing |
| Tier 3 | tier3-advanced.test + tier3-optimizations.test | Different features: T3.12 (whale detection) vs T3.11 (multi-leg path finding) |

---

## Superseded Tests

After careful analysis, **no unit tests are fully superseded by integration tests** in this codebase. The integration tests consistently test different aspects (full flow, timing, multi-component interaction) vs unit tests (isolated function behavior). This is good test architecture.

| Unit Test | Integration Candidate | Superseded? | Reason |
|---|---|---|---|
| `redis-streams-basic.test.ts` | `s1.1-redis-streams.integration.test.ts` | **NOT SUPERSEDED** | Unit tests mock Redis; integration uses real Redis protocol |
| `price-matrix.test.ts` | `s1.3-price-matrix.integration.test.ts` | **NOT SUPERSEDED** | Unit tests API surface; integration tests SharedArrayBuffer cross-thread |
| `solana-detector.test.ts` | `s3.3.1-solana-detector.integration.test.ts` | **NOT SUPERSEDED** | Unit tests detection logic; integration tests Solana connection flow |
| `coordinator.test.ts` | `coordinator.integration.test.ts` | **NOT SUPERSEDED** | Unit tests individual methods; integration tests startup/lifecycle |

---

## Structural Changes (Misplaced Tests)

### Tests in `src/.../__tests__/` instead of standard `__tests__/unit/`

Per ADR-009, unit tests should be in `<package>/__tests__/unit/`. Tests in `src/.../__tests__/` are misplaced (co-located pattern not adopted in this codebase).

| # | Action | Current Location | Target Location | Reason |
|---|---|---|---|---|
| 1 | **DELETE** (duplicate) | `shared/core/src/detector/__tests__/event-processor.test.ts` | N/A | Redundant with `__tests__/unit/detector/event-processor.test.ts` (merge first) |
| 2 | **MOVE** | `shared/core/src/detector/__tests__/detector-connection-manager.test.ts` | `shared/core/__tests__/unit/detector/detector-connection-manager.test.ts` | Only copy; should be in standard location |
| 3 | **MOVE** | `shared/core/src/detector/__tests__/pair-initialization-service.test.ts` | `shared/core/__tests__/unit/detector/pair-initialization-service.test.ts` | Only copy; should be in standard location |
| 4 | **MOVE** | `shared/core/src/publishing/__tests__/publishing-service.test.ts` | `shared/core/__tests__/unit/publishing-service.test.ts` | Only copy; should be in standard location |
| 5 | **MOVE** | `shared/core/src/solana/__tests__/solana-detector.test.ts` | `shared/core/__tests__/unit/solana/solana-detector.test.ts` | Only copy; should be in standard location |
| 6 | **MOVE** | `shared/core/src/circuit-breaker/__tests__/simple-circuit-breaker.test.ts` | `shared/core/__tests__/unit/circuit-breaker/simple-circuit-breaker.test.ts` | Only copy; should be in standard location |

### Tests in `src/.../__tests__/` with mixed unit/integration

| # | Action | Current Location | Target Location | Reason |
|---|---|---|---|---|
| 7 | **MOVE** | `shared/core/src/warming/container/__tests__/warming.container.unit.test.ts` | `shared/core/__tests__/unit/warming/warming.container.test.ts` | Unit test in src directory |
| 8 | **MOVE** | `shared/core/src/warming/container/__tests__/factory-functions.test.ts` | `shared/core/__tests__/unit/warming/factory-functions.test.ts` | Unit test in src directory |
| 9 | **MOVE** | `shared/core/src/warming/container/__tests__/warming-flow.integration.test.ts` | `shared/core/__tests__/integration/warming-flow.integration.test.ts` | Integration test in src directory |
| 10 | **MOVE** | `shared/core/src/warming/container/__tests__/performance.benchmark.test.ts` | `shared/core/__tests__/performance/warming-performance.benchmark.test.ts` | Perf test in src directory |

### Co-located tests (test next to source file, no `__tests__` directory)

| # | Action | Current Location | Target Location | Reason |
|---|---|---|---|---|
| 11 | **MOVE** | `services/execution-engine/src/services/simulation/helius-provider.test.ts` | `services/execution-engine/__tests__/unit/services/simulation/helius-provider.test.ts` | Co-located with source; standard dir exists and has other provider tests |
| 12 | **MOVE** | `services/execution-engine/src/strategies/flash-loan-liquidity-validator.test.ts` | `services/execution-engine/__tests__/unit/strategies/flash-loan-liquidity-validator.test.ts` | Co-located with source; standard dir exists |

### Fix verification tests (in non-standard locations)

| # | Action | Current Location | Target Location | Reason |
|---|---|---|---|---|
| 13 | **MOVE** | `shared/core/src/warming/infrastructure/__tests__/p1-5-fix-verification.test.ts` | `shared/core/__tests__/unit/warming/p1-5-fix-verification.test.ts` | Regression test in src directory |
| 14 | **MOVE** | `services/unified-detector/src/__tests__/p1-7-fix-verification.test.ts` | `services/unified-detector/__tests__/unit/p1-7-fix-verification.test.ts` | Regression test in src directory |

### Service tests not in unit/integration subdirectories

| # | Action | Current Location | Target Location | Reason |
|---|---|---|---|---|
| 15 | **MOVE** | `services/coordinator/src/__tests__/coordinator.test.ts` | `services/coordinator/__tests__/unit/coordinator.test.ts` | Unit test not in standard location |
| 16 | **MOVE** | `services/coordinator/src/__tests__/api.routes.test.ts` | `services/coordinator/__tests__/unit/api.routes.test.ts` | Unit test not in standard location |
| 17 | **MOVE** | `services/coordinator/src/__tests__/coordinator.integration.test.ts` | `services/coordinator/__tests__/integration/coordinator.integration.test.ts` | Integration test not in standard location |
| 18 | **MOVE** | `services/mempool-detector/src/__tests__/bloxroute-feed.test.ts` | `services/mempool-detector/__tests__/unit/bloxroute-feed.test.ts` | Unit test not in standard location |
| 19 | **MOVE** | `services/mempool-detector/src/__tests__/decoders.test.ts` | `services/mempool-detector/__tests__/unit/decoders.test.ts` | Unit test not in standard location |
| 20 | **MOVE** | `services/mempool-detector/src/__tests__/mempool-detector-service.test.ts` | `services/mempool-detector/__tests__/unit/mempool-detector-service.test.ts` | Unit test not in standard location |

### Rename for clarity

| # | Action | Current Name | Target Name | Reason |
|---|---|---|---|---|
| 21 | **RENAME** | `professional-quality.test.ts` | `professional-quality-monitor-flows.test.ts` | Distinguish from `professional-quality-monitor.test.ts` (granular tests) |

---

## Structural Note: `fixes-regression.test.ts`

`shared/core/__tests__/unit/fixes-regression.test.ts` is a "grab bag" file containing regression tests for 8 different fixes across different modules (P0-1, P0-5, P0-6, P1-2, P1-3, P1-4, P1-5, P2-1, P2-2). It is correctly located but could benefit from being split into per-module regression test files. This is LOW priority -- it works fine as-is, but violates the single-responsibility principle for test files.

---

## Critical Gaps (Sorted by Risk)

### P0: Hot-Path / Security (must test -- financial/security impact)

| # | Gap | Source Module | Risk | Test Type | What to Test |
|---|---|---|---|---|---|
| 1 | Event processor worker untested | `shared/core/src/event-processor-worker.ts` | **P0-HOTPATH** | unit | Worker thread initialization, SharedArrayBuffer attachment, message handling, error paths |
| 2 | Flash loan fee calculator untested | `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts` | **P0-FINANCIAL** | unit | Fee calculation per provider (Aave 9bps, Balancer 0, etc.), profitability analysis, chain-specific overrides |
| 3 | Gas price optimizer untested | `services/execution-engine/src/services/gas-price-optimizer.ts` | **P0-FINANCIAL** | unit | Spike detection, baseline tracking, pre-submission refresh, abort thresholds |
| 4 | MEV protection service untested | `services/execution-engine/src/services/mev-protection-service.ts` | **P0-SECURITY** | unit | MEV protection provider selection, bundle submission, transaction protection |
| 5 | Confidence calculator untested | `services/cross-chain-detector/src/confidence-calculator.ts` | **P0-FINANCIAL** | unit | Confidence scoring: price differential, data freshness, ML prediction, whale activity signals |
| 6 | Lock conflict tracker untested | `services/execution-engine/src/services/lock-conflict-tracker.ts` | **P0-CONCURRENCY** | unit | Double-execution prevention, lock acquisition/release, conflict detection |

### P1: Financial Logic (high impact on profitability)

| # | Gap | Source Module | Risk | Test Type | What to Test |
|---|---|---|---|---|---|
| 7 | Bridge profitability analyzer untested | `services/execution-engine/src/services/bridge-profitability-analyzer.ts` | **P1-FINANCIAL** | unit | Cross-chain profit calculation, bridge fee estimation, net profitability |
| 8 | V2 pair parser untested | `shared/core/src/factory-subscription/parsers/v2-pair-parser.ts` | **P1-DETECTION** | unit | PairCreated event parsing, topic extraction, address validation, error handling |
| 9 | V3 pool parser untested | `shared/core/src/factory-subscription/parsers/v3-pool-parser.ts` | **P1-DETECTION** | unit | PoolCreated event parsing, fee tier extraction |
| 10 | Solidly parser untested | `shared/core/src/factory-subscription/parsers/solidly-parser.ts` | **P1-DETECTION** | unit | Solidly pool event parsing, stable/volatile flag |
| 11 | Algebra parser untested | `shared/core/src/factory-subscription/parsers/algebra-parser.ts` | **P1-DETECTION** | unit | Algebra pool event parsing |
| 12 | Curve parser untested | `shared/core/src/factory-subscription/parsers/curve-parser.ts` | **P1-DETECTION** | unit | Curve pool event parsing, multi-token pools |
| 13 | Balancer V2 parser untested | `shared/core/src/factory-subscription/parsers/balancer-v2-parser.ts` | **P1-DETECTION** | unit | Balancer pool event parsing, weighted/stable pool types |
| 14 | TraderJoe parser untested | `shared/core/src/factory-subscription/parsers/trader-joe-parser.ts` | **P1-DETECTION** | unit | TraderJoe pool event parsing |
| 15 | Parser utils untested | `shared/core/src/factory-subscription/parsers/utils.ts` | **P1-DETECTION** | unit | Address extraction, hex validation, shared utilities |
| 16 | Retry mechanism untested | `shared/core/src/resilience/retry-mechanism.ts` | **P1-RESILIENCE** | unit | Exponential backoff, jitter, error classification (transient/permanent), max retries |
| 17 | Cross-chain price tracker untested | `shared/core/src/cross-chain-price-tracker.ts` | **P1-DETECTION** | unit | Cross-chain price tracking, stale data detection |

### P2: Solana Detection (entire detection pipeline untested)

| # | Gap | Source Module | Risk | Test Type | What to Test |
|---|---|---|---|---|---|
| 18 | Intra-Solana detector untested | `services/partition-solana/src/detection/intra-solana-detector.ts` | **P2-DETECTION** | unit | Solana intra-chain arbitrage detection logic |
| 19 | Triangular detector untested | `services/partition-solana/src/detection/triangular-detector.ts` | **P2-DETECTION** | unit | Solana triangular arbitrage detection |
| 20 | Cross-chain detector (Solana) untested | `services/partition-solana/src/detection/cross-chain-detector.ts` | **P2-DETECTION** | unit | Solana cross-chain opportunity detection |
| 21 | Versioned pool store untested | `services/partition-solana/src/pool/versioned-pool-store.ts` | **P2-STATE** | unit | Pool state management, versioning, staleness |
| 22 | Opportunity factory untested | `services/partition-solana/src/opportunity-factory.ts` | **P2-DETECTION** | unit | Opportunity creation from detections |
| 23 | Raydium AMM parser untested | `shared/core/src/solana/pricing/pool-parsers/raydium-amm-parser.ts` | **P2-PRICING** | unit | Raydium AMM pool data parsing |
| 24 | Raydium CLMM parser untested | `shared/core/src/solana/pricing/pool-parsers/raydium-clmm-parser.ts` | **P2-PRICING** | unit | Raydium concentrated liquidity parsing |
| 25 | Orca Whirlpool parser untested | `shared/core/src/solana/pricing/pool-parsers/orca-whirlpool-parser.ts` | **P2-PRICING** | unit | Orca whirlpool pool data parsing |

### P3: Reliability / Monitoring / Infrastructure

| # | Gap | Source Module | Risk | Test Type | What to Test |
|---|---|---|---|---|---|
| 26 | Health monitoring manager untested | `services/execution-engine/src/services/health-monitoring-manager.ts` | **P3-RELIABILITY** | unit | Health checks, service status reporting |
| 27 | Metrics domain completely untested | `shared/core/src/metrics/` (5 impl files) | **P3-OBSERVABILITY** | unit | Prometheus metrics collection, export, use cases |
| 28 | Warming strategies untested | `shared/core/src/warming/application/strategies/` (4 files) | **P3-PERFORMANCE** | unit | Adaptive, threshold, time-based, top-n warming strategies |
| 29 | Cache registration strategies untested | `shared/core/src/caching/strategies/` (3 files) | **P3-PERFORMANCE** | unit | Main-thread, worker-thread, registry strategy factory |
| 30 | Shared memory cache untested | `shared/core/src/caching/shared-memory-cache.ts` | **P3-PERFORMANCE** | unit | SharedArrayBuffer wrapper operations |
| 31 | Data structures untested | `numeric-rolling-window.ts`, `circular-buffer.ts`, `min-heap.ts` | **P3-UTIL** | unit | Core data structure operations, edge cases |
| 32 | Async utilities untested | `async-singleton.ts`, `queue-lock.ts` | **P3-UTIL** | unit | Singleton initialization, queue locking |
| 33 | Service utilities untested | `service-bootstrap.ts`, `lifecycle-utils.ts`, `disconnect-utils.ts`, `env-utils.ts` | **P3-INFRA** | unit | Bootstrap, lifecycle, cleanup, env parsing |
| 34 | ML modules untested | `ensemble-combiner.ts`, `synchronized-stats.ts` | **P3-ML** | unit | Ensemble model combining, synchronized statistics |
| 35 | Config modules untested | `flash-loan-availability.ts`, `string-interning.ts` | **P3-CONFIG** | unit | Flash loan config per chain, string interning |
| 36 | Coordinator routing untested | `opportunity-router.ts`, `stream-consumer-manager.ts`, `rate-limiter.ts` | **P3-ROUTING** | unit | Opportunity routing, consumer management, rate limiting |
| 37 | RPC rate limiter untested | `shared/core/src/rpc/rate-limiter.ts` | **P3-RPC** | unit | RPC rate limiting (different from security rate limiter) |
| 38 | Flash loan aggregation gaps | `select-provider.usecase.ts`, `flashloan-aggregator.impl.ts`, `onchain-liquidity.validator.ts` | **P3-FLASH** | unit | Provider selection, aggregation, on-chain validation |

---

## Target Test Structure

### Ideal Organization (per ADR-009)

```
<package>/
  __tests__/
    unit/           # Isolated tests, all dependencies mocked
      <module>/     # Subdirectories mirror src/ structure
    integration/    # Tests with real dependencies (Redis, network, etc.)
    performance/    # Benchmark and latency tests
    e2e/            # End-to-end flow tests
```

### Key Principles

1. **One canonical location per test**: No duplicate test files testing the same module from different directories
2. **Clear unit/integration separation**: Unit tests mock everything; integration tests use real infrastructure
3. **No co-located tests**: Test files should not live next to source files in `src/`
4. **Regression tests belong with their module's unit tests**: Fix verification tests like `p1-5-fix-verification.test.ts` should be in `__tests__/unit/` under the relevant module subdirectory
5. **Test file naming**: `<source-module>.test.ts` for primary tests, `<source-module>-<aspect>.test.ts` for secondary/extended tests (e.g., `flash-loan.strategy.test.ts` and `flash-loan-edge-cases.test.ts`)

### Current vs Target Counts

| Category | Current | After Consolidation | Change |
|---|---|---|---|
| Redundant test files | 2 | 0 | -2 (merged/removed) |
| Misplaced test files | ~20 | 0 | Relocated |
| Tests in src/ directories | 12 | 0 | Moved to __tests__/ |
| Co-located tests | 2 | 0 | Moved to __tests__/ |

---

## Implementation Order

1. **Phase A: Merge redundant tests** (safe, no behavior change)
   - Merge `swap-event-filter-extended.test.ts` unique tests into `swap-event-filter.test.ts`, delete extended
   - Merge event-processor case-sensitivity test into `__tests__/unit/detector/event-processor.test.ts`, delete `src/detector/__tests__/event-processor.test.ts`

2. **Phase B: Move misplaced tests** (update imports, verify tests pass)
   - Move co-located tests first (helius-provider, flash-loan-liquidity-validator)
   - Move `src/__tests__/` tests to `__tests__/unit/`
   - Move warming container tests to proper directories
   - Move coordinator/mempool-detector tests to standard locations
   - Update any relative imports to use `@arbitrage/*` aliases

3. **Phase C: Fill critical gaps** (write new tests in priority order)
   - P0 first (event-processor-worker, flash-loan-fee-calculator, gas-price-optimizer, mev-protection-service, confidence-calculator, lock-conflict-tracker)
   - P1 next (factory parsers, retry-mechanism, bridge-profitability)
   - P2 then (Solana detection pipeline)
   - P3 last (metrics, warming strategies, utilities)

4. **Phase D: Rename for clarity** (cosmetic)
   - Rename `professional-quality.test.ts` to `professional-quality-monitor-flows.test.ts`

---

## Quality Gates for This Plan

- [x] Every redundancy claim verified by reading BOTH test files
- [x] Every "non-redundant" cluster verified by checking they test different classes/functions
- [x] No superseded tests found (integration tests do NOT fully cover unit test assertions)
- [x] Every gap verified: source file exists and contains substantive logic
- [x] Misplaced tests verified: no duplicate exists in target location (except event-processor)
- [x] Recommendations are incremental (no "rewrite everything")

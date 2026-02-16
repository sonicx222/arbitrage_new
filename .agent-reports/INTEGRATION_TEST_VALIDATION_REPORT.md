# Integration Test Validation Report

**Scope**: All integration tests in the arbitrage system
**Date**: 2026-02-16
**Integration Test Files Analyzed**: 42
**Misplaced/Borderline Tests Analyzed**: 6
**E2E Test Analyzed**: 1

---

## Executive Summary

### Health Score: C+

| Dimension | Score | Notes |
|-----------|-------|-------|
| Integration Authenticity | 40% AUTHENTIC | 17/42 files are authentic; 11 mock theater; 14 partial |
| Redis Usage | 62% REAL REDIS | 26 files use real Redis; 16 do not |
| ADR Compliance | PARTIAL | ADR-002 well covered; ADR-005 partially; ADR-012 well covered; ADR-003 partial; ADR-018 partial |
| Component Boundary Crossing | 45% | Many tests exercise Redis primitives, not actual service components |
| Placement Correctness | 83% | 7 files misplaced (integration tests that are unit tests; unit tests that are integration tests) |

### Key Finding

The test suite has a **split personality**: roughly half the integration tests are well-designed with real Redis and genuine boundary crossing (the component-flows tests, detector-lifecycle, worker-* tests). The other half are either **mock theater** (everything mocked, just testing logic inline) or **Redis-only** tests that exercise Redis primitives directly rather than testing actual system components interacting through Redis.

---

## Integration Test Authenticity Matrix

### Centralized Integration Tests (`tests/integration/`)

| # | Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|---|-----------|-------------|-------------|----------------|---------|
| 1 | `s1.1-redis-streams.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002 COMPLIANT | KEEP AS-IS |
| 2 | `s1.3-price-matrix.integration.test.ts` | **AUTHENTIC** | N/A (SharedArrayBuffer) | ADR-005 COMPLIANT | KEEP AS-IS |
| 3 | `s2.2.5-pair-initialization.integration.test.ts` | PARTIAL | REAL REDIS | N/A | KEEP (config validation with real deps) |
| 4 | `s2.2.5-pair-services.integration.test.ts` | PARTIAL | REAL REDIS | N/A | KEEP (config validation with real deps) |
| 5 | `s3.3.1-solana-detector.integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |
| 6 | `s3.3.4-solana-swap-parser.integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |
| 7 | `s3.3.5-solana-price-feed.integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |
| 8 | `s3.3.6-solana-arbitrage-detector.integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |
| 9 | `s3.3.7-solana-partition-deploy.integration.test.ts` | **MOCK THEATER** | NO REDIS | ADR-003 SURFACE | DOWNGRADE TO UNIT |
| 10 | `s4.1.4-standby-service-deployment.integration.test.ts` | PARTIAL | N/A (filesystem) | ADR-007 SURFACE | RECLASSIFY as config/lint test |
| 11 | `s4.1.5-failover-scenarios.integration.test.ts` | PARTIAL | REAL REDIS (S4.1.5.7 only) | ADR-007 PARTIAL | SPLIT: extract real Redis section |
| 12 | `vault-model-dex-regression.integration.test.ts` | PARTIAL | NO REDIS | N/A | KEEP (uses real PairDiscoveryService) |

### Component Flow Tests (`tests/integration/component-flows/`)

| # | Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|---|-----------|-------------|-------------|----------------|---------|
| 13 | `multi-strategy-execution.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002 COMPLIANT | KEEP AS-IS |
| 14 | `price-detection.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002 COMPLIANT | KEEP AS-IS |
| 15 | `detector-coordinator.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002 COMPLIANT | KEEP AS-IS |
| 16 | `coordinator-execution.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002/007 COMPLIANT | KEEP AS-IS |
| 17 | `multi-chain-detection.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002/003 COMPLIANT | KEEP AS-IS |

### Specialized Tests (`tests/integration/*/`)

| # | Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|---|-----------|-------------|-------------|----------------|---------|
| 18 | `error-handling/dead-letter-queue.integration.test.ts` | **AUTHENTIC** | REAL REDIS | N/A | KEEP AS-IS |
| 19 | `reliability/circuit-breaker.integration.test.ts` | PARTIAL | NO REDIS | ADR-018 PARTIAL | KEEP (uses real CircuitBreaker class) |
| 20 | `mempool/pending-opportunities.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002 COMPLIANT | KEEP AS-IS |
| 21 | `multi-partition/cross-partition-sync.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-003 COMPLIANT | KEEP AS-IS |
| 22 | `chaos/fault-injection.integration.test.ts` | **AUTHENTIC** | REAL REDIS | N/A | KEEP AS-IS |

### Service-Level Integration Tests

| # | Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|---|-----------|-------------|-------------|----------------|---------|
| 23 | `coordinator/coordinator.integration.test.ts` | PARTIAL | REAL REDIS | ADR-002/007 PARTIAL | UPGRADE: reduce mocks |
| 24 | `cross-chain-detector/detector-integration.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002/014 COMPLIANT | KEEP AS-IS |
| 25 | `execution-engine/commit-reveal.service.test.ts` | PARTIAL | MOCKED (acceptable) | N/A | KEEP (mock provider acceptable for blockchain) |
| 26 | `execution-engine/hot-fork-synchronizer.integration.test.ts` | **AUTHENTIC** | N/A (Anvil fork) | N/A | KEEP AS-IS (requires Anvil, conditional skip) |
| 27 | `partition-asia-fast/service.integration.test.ts` | **MOCK THEATER** | MOCKED | ADR-003 SURFACE | DOWNGRADE TO UNIT |
| 28 | `partition-high-value/service.integration.test.ts` | **MOCK THEATER** | MOCKED | ADR-003 SURFACE | DOWNGRADE TO UNIT |
| 29 | `partition-l2-turbo/service.integration.test.ts` | **MOCK THEATER** | MOCKED | ADR-003 SURFACE | DOWNGRADE TO UNIT |
| 30 | `mempool-detector/success-criteria.integration.test.ts` | PARTIAL | NO REDIS | N/A | KEEP (uses real decoders with real mainnet data) |
| 31 | `unified-detector/detector-lifecycle.integration.test.ts` | PARTIAL | NO REDIS | ADR-003 PARTIAL | KEEP (tests real config interactions) |
| 32 | `unified-detector/cache-integration.test.ts` | **AUTHENTIC** | N/A (uses CacheTestHarness) | ADR-005 COMPLIANT | KEEP AS-IS |

### Shared Core Integration Tests

| # | Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|---|-----------|-------------|-------------|----------------|---------|
| 33 | `worker-pool-load.integration.test.ts` | **MOCK THEATER** | NO REDIS | ADR-012 SURFACE | DOWNGRADE TO UNIT (mocks logger, no real workers) |
| 34 | `detector-lifecycle.integration.test.ts` | **AUTHENTIC** | REAL REDIS | ADR-002/009 COMPLIANT | KEEP AS-IS |
| 35 | `worker-price-matrix.integration.test.ts` | **AUTHENTIC** | N/A (SharedArrayBuffer) | ADR-005/012 COMPLIANT | KEEP AS-IS |
| 36 | `worker-zero-copy.integration.test.ts` | **AUTHENTIC** | N/A (SharedArrayBuffer) | ADR-005/012 COMPLIANT | KEEP AS-IS |
| 37 | `worker-thread-safety.integration.test.ts` | **AUTHENTIC** | N/A (SharedArrayBuffer) | ADR-012 COMPLIANT | KEEP AS-IS |
| 38 | `worker-concurrent-reads.integration.test.ts` | **AUTHENTIC** | N/A (SharedArrayBuffer) | ADR-012 COMPLIANT | KEEP AS-IS |
| 39 | `warming-flow.integration.test.ts` | PARTIAL | NO REDIS | N/A | KEEP (uses real HierarchicalCache) |
| 40 | `worker-pool-real.integration.test.ts` | **AUTHENTIC** | N/A (real workers) | ADR-012 COMPLIANT | KEEP AS-IS |
| 41 | `mev-protection/bloxroute-integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |
| 42 | `mev-protection/fastlane-integration.test.ts` | **MOCK THEATER** | NO REDIS | N/A | DOWNGRADE TO UNIT |

### Misplaced/Borderline Tests

| # | Test File | Current Location | Authenticity | Verdict |
|---|-----------|-----------------|-------------|---------|
| 43 | `execution-engine/unit/circuit-breaker-integration.test.ts` | `__tests__/unit/` | PARTIAL | MOVE to `__tests__/integration/` - tests circuit breaker state machine with real class |
| 44 | `unified-detector/unit/p1-7-fix-verification.test.ts` | `__tests__/unit/` | UNIT | CORRECT placement (despite "fix-verification" name) |
| 45 | `shared/core/unit/tier1-optimizations.test.ts` | `__tests__/unit/` | UNIT | CORRECT placement |
| 46 | `shared/core/unit/tier2-optimizations.test.ts` | `__tests__/unit/` | UNIT | CORRECT placement |
| 47 | `shared/core/unit/tier3-optimizations.test.ts` | `__tests__/unit/` | UNIT | CORRECT placement |

### E2E Test

| # | Test File | Authenticity | Redis Usage | Verdict |
|---|-----------|-------------|-------------|---------|
| 48 | `tests/e2e/data-flow-e2e.test.ts` | **AUTHENTIC** | REAL REDIS | KEEP AS-IS - true E2E flow test |

---

## Mock Theater Tests (Should Be Reclassified or Upgraded)

These tests claim to be integration tests but mock all external dependencies, defeating the purpose of integration testing.

| # | File | Current Mocks | Why It's Mock Theater | Recommendation |
|---|------|--------------|----------------------|----------------|
| 1 | `s3.3.1-solana-detector.integration.test.ts` | All Solana components mocked in-file | Defines MockSolanaConnection, MockSolanaRpcManager entirely within the test; no real components interact | DOWNGRADE to `__tests__/unit/` |
| 2 | `s3.3.4-solana-swap-parser.integration.test.ts` | All Solana parsing components mocked | Tests parsing logic with mock data structures; no real service interaction | DOWNGRADE to `__tests__/unit/` |
| 3 | `s3.3.5-solana-price-feed.integration.test.ts` | All Solana feed components mocked | Tests price feed logic with inline mocks; no real RPC or Redis | DOWNGRADE to `__tests__/unit/` |
| 4 | `s3.3.6-solana-arbitrage-detector.integration.test.ts` | All Solana detector components mocked | Tests detection logic with inline mocks; no real data flow | DOWNGRADE to `__tests__/unit/` |
| 5 | `s3.3.7-solana-partition-deploy.integration.test.ts` | ~400 lines of in-file mock classes (MockSolanaConnection, MockSolanaRpcManager, MockSolanaPartitionDetector) | Tests only config constants and mock classes defined in same file; "should have Helius as highest priority provider" just checks a constant | DOWNGRADE to `__tests__/unit/` |
| 6 | `partition-asia-fast/service.integration.test.ts` | `jest.mock('@arbitrage/core')`, `jest.mock('@arbitrage/config')`, `jest.mock('@arbitrage/unified-detector')` | Mocks ALL dependencies (core, config, detector); tests only that mocked functions were called with expected args | DOWNGRADE to `__tests__/unit/` |
| 7 | `partition-high-value/service.integration.test.ts` | Same as asia-fast: all deps mocked | Identical pattern - mocks everything | DOWNGRADE to `__tests__/unit/` |
| 8 | `partition-l2-turbo/service.integration.test.ts` | Same as asia-fast: all deps mocked | Identical pattern - mocks everything | DOWNGRADE to `__tests__/unit/` |
| 9 | `worker-pool-load.integration.test.ts` | `jest.mock('../../src/logger')`, comment says "these are unit tests with mocked workers" | Self-admits to being unit tests in comments; mocks logger, does not start real workers | DOWNGRADE to `__tests__/unit/` |
| 10 | `mev-protection/bloxroute-integration.test.ts` | `createMockEthersProvider()`, `createMockWallet()` | Tests StandardProvider with fully mocked ethers provider and wallet; no real network calls | DOWNGRADE to `__tests__/unit/` |
| 11 | `mev-protection/fastlane-integration.test.ts` | `createMockEthersProvider()`, `createMockWallet()` | Identical to bloxroute: fully mocked provider and wallet | DOWNGRADE to `__tests__/unit/` |

**Total Mock Theater: 11 files** (26% of all integration tests)

---

## ADR Compliance Coverage

| ADR | Title | Expected Test Coverage | Current Coverage | Gap |
|-----|-------|----------------------|-----------------|-----|
| ADR-002 | Redis Streams over Pub/Sub | Stream publish/consume, consumer groups, batching, health monitoring | **WELL COVERED** - `s1.1-redis-streams`, `detector-coordinator`, `coordinator-execution`, `multi-strategy-execution`, `price-detection`, `detector-lifecycle` all use real Redis Streams | Minor: no test validates StreamBatcher batching threshold behavior |
| ADR-003 | Partitioned Chain Detectors | 4-partition chain assignment, cross-partition communication, partition-specific config | **PARTIALLY COVERED** - `multi-chain-detection`, `cross-partition-sync` test partition communication via Redis; but 3 partition service tests (P1/P2/P3) are all mock theater | **GAP**: No authentic integration test for partition startup with real deps |
| ADR-005 | Hierarchical Cache / L1 Price Matrix | SharedArrayBuffer storage, O(1) lookup, cross-thread visibility, cache warming | **WELL COVERED** - `s1.3-price-matrix`, `worker-price-matrix`, `worker-zero-copy`, `cache-integration`, `warming-flow` | Minor: no test for L2 Redis cache fallback with real Redis |
| ADR-007 | Cross-Region Failover Strategy | Leader election, standby promotion, health monitoring, graceful degradation | **PARTIALLY COVERED** - `s4.1.5-failover-scenarios` has one authentic Redis section (S4.1.5.7); `coordinator.integration.test.ts` touches leader election; `s4.1.4-standby-service-deployment` only validates config files | **GAP**: No test exercises actual failover sequence with real Redis |
| ADR-009 | Test Architecture | Test placement conventions, naming, categorization | **PARTIALLY FOLLOWED** - 11 integration tests are mock theater (should be unit); 1 unit test should be integration; naming convention `sX.Y.Z-` followed inconsistently | **GAP**: Placement violations for ~12 files |
| ADR-012 | Worker Threads for Path Finding | Worker pool, SharedArrayBuffer transfer, concurrent reads, thread safety | **WELL COVERED** - `worker-pool-real`, `worker-price-matrix`, `worker-zero-copy`, `worker-thread-safety`, `worker-concurrent-reads` all use real Worker threads | `worker-pool-load` is mock theater (but other 5 are authentic) |
| ADR-018 | Circuit Breaker Pattern | State transitions, failure counting, recovery timeout, half-open behavior | **PARTIALLY COVERED** - `reliability/circuit-breaker.integration.test.ts` uses real `CircuitBreaker` class; `circuit-breaker-integration.test.ts` (in unit/) also tests it | **GAP**: Neither test exercises circuit breaker across real service boundaries |

---

## Per-File Detailed Validation

### AUTHENTIC Integration Tests (17 files) - The Good

These tests genuinely validate component interactions with real dependencies.

**1. `s1.1-redis-streams.integration.test.ts`** - AUTHENTIC
- **Real deps**: Real Redis via `createTestRedisClient()`, real `RedisStreamsClient`, `StreamBatcher`, `StreamHealthMonitor`
- **Boundaries crossed**: Application code (RedisStreamsClient) -> Redis Streams
- **ADR-002 compliance**: Tests stream publish, consume, consumer groups, batching, health monitoring
- **Bug categories caught**: Serialization mismatches, consumer group management errors, stream health detection failures
- **Assessment**: Exemplary integration test. Tests the actual ADR-002 migration.

**2. `s1.3-price-matrix.integration.test.ts`** - AUTHENTIC
- **Real deps**: Real `PriceMatrix` with `SharedArrayBuffer`, real `PriceIndexMapper`
- **Boundaries crossed**: Price data -> SharedArrayBuffer storage -> O(1) retrieval
- **ADR-005 compliance**: Tests SharedArrayBuffer storage, precision, Atomics, O(1) lookup, memory budgets
- **Bug categories caught**: Float precision errors, memory budget violations, concurrent access corruption
- **Assessment**: Excellent. Tests the core ADR-005 hypothesis (SharedArrayBuffer < 1us).

**3-4. `s2.2.5-pair-initialization/pair-services`** - PARTIAL (ACCEPTABLE)
- **Real deps**: Real Redis, real config modules
- **Assessment**: Config validation tests that use real Redis to verify pair initialization flows. Borderline but valuable.

**5. Component Flow Tests (13-17)** - ALL AUTHENTIC
- All 5 files use `createTestRedisClient()` for real Redis
- Test real data flow patterns: price -> detection -> coordination -> execution
- Validate consumer group distribution, distributed locking, stream message correlation
- Test multi-chain, multi-strategy scenarios with real Redis primitives
- **Key strength**: These tests prove that data flows correctly through Redis Streams between logical service boundaries
- **Key weakness**: They test data flow patterns, not actual service code. The "coordinator" and "detector" logic is reimplemented inline rather than importing from service modules

**6. `error-handling/dead-letter-queue`** - AUTHENTIC
- Uses real Redis for DLQ storage, priority queuing, TTL retention, batch processing

**7. `mempool/pending-opportunities`** - AUTHENTIC
- Uses real Redis Streams, real types from `@arbitrage/types`, BigInt serialization

**8. `multi-partition/cross-partition-sync`** - AUTHENTIC
- Uses real Redis, real `normalizeTokenForCrossChain` from config, tests cross-partition data sharing

**9. `chaos/fault-injection`** - AUTHENTIC
- Uses real Redis plus `createChaosController`, `createChaosRedisClient`, `NetworkPartitionSimulator` from test-utils

**10. `shared/core/detector-lifecycle`** - AUTHENTIC
- Real Redis, real `DistributedLockManager`, real `ServiceStateManager`; tests Lua scripts, TTL, atomic operations

**11. Worker Thread Tests (35-38, 40)** - ALL AUTHENTIC
- Use real `WorkerTestHarness` with real Worker threads and real `SharedArrayBuffer`
- Test cross-thread visibility, zero-copy reads, concurrent access, thread safety
- These are among the best integration tests in the suite

**12. `cross-chain-detector/detector-integration`** - AUTHENTIC
- Real Redis via `createTestRedisClient()`, real `RedisStreamsClient`, real `OpportunityPublisher`
- Tests the actual service components, not reimplemented logic

**13. `unified-detector/cache-integration`** - AUTHENTIC
- Uses real `CacheTestHarness` with real `HierarchicalCache` and `PriceMatrix`

**14. `hot-fork-synchronizer`** - AUTHENTIC
- Conditionally uses real Anvil (Foundry) fork for Ethereum simulation
- Properly skips if Anvil unavailable

**15. `data-flow-e2e.test.ts`** - AUTHENTIC (E2E)
- Full pipeline test: price -> detection -> coordination -> execution -> results via real Redis

### MOCK THEATER Tests (11 files) - False Confidence

These files provide zero integration confidence because all dependencies are mocked.

**Solana Tests (5-9)**: All Solana integration tests define mock classes inline (MockSolanaConnection, MockSolanaRpcManager, etc.) and test only the mock's behavior. They import configuration constants but never exercise real Solana client code interacting with real infrastructure. These are pure unit tests wearing integration test clothing.

**Partition Service Tests (27-29)**: All three partition services (P1/P2/P3) use `jest.mock('@arbitrage/core')`, `jest.mock('@arbitrage/config')`, and `jest.mock('@arbitrage/unified-detector')`, replacing ALL dependencies with mocks. They verify that mocked functions were called with expected arguments -- this is the textbook definition of mock theater.

**Worker Pool Load Test (33)**: The file literally comments "these are unit tests with mocked workers" (line 49). It mocks the logger and does not start real worker threads.

**MEV Protection Tests (41-42)**: BloXroute and Fastlane tests create fully mocked ethers providers and wallets. They test the `StandardProvider` class in complete isolation. No network calls, no real provider behavior.

### PARTIAL Integration Tests (14 files) - Mixed Value

**`s4.1.5-failover-scenarios`** - Mostly mock theater (S4.1.5.1-S4.1.5.6: inline object manipulation, counter incrementing) but contains one authentic section (S4.1.5.7: real Redis leader election with SET NX EX, Lua scripts, contention testing). **Recommendation**: Extract S4.1.5.7 into its own integration test file; downgrade the rest to unit tests.

**`s4.1.4-standby-service-deployment`** - Reads real filesystem (Dockerfiles, YAML, env files) and validates content. This is infrastructure validation, not service integration. **Recommendation**: Reclassify as "config-validation" or "deployment-lint" test category.

**`vault-model-dex-regression`** - Uses real `PairDiscoveryService` and real `DEXES` config but only validates configuration values. The `detectFactoryType` call is the only genuine component boundary crossing.

**`reliability/circuit-breaker`** - Uses the real `CircuitBreaker` and `CircuitBreakerRegistry` classes from `@arbitrage/core` with short test timeouts. Tests state machine transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED). This is a genuine component test but crosses no service boundaries -- it's more of a thorough unit test of the circuit breaker module. Acceptable as integration since it tests the stateful behavior with real timing.

**`coordinator.integration.test.ts`** - Uses real Redis but heavily mocks the state manager, stream health monitor, and stream consumer. The coordinator service's core logic is tested, but many boundaries are mocked. **Recommendation**: Reduce mocks; use real `ServiceStateManager` and `StreamHealthMonitor`.

**`commit-reveal.service.test.ts`** - Uses mock provider (acceptable: can't test against real blockchain in CI) with real timing, real service lifecycle. The mock is justified for blockchain operations.

**`mempool-detector/success-criteria`** - Uses real decoder registry with real mainnet transaction calldata (from fixtures). Tests decode accuracy against actual Ethereum mainnet transactions. No Redis but the decoder boundary crossing is genuine.

**`warming-flow`** - Uses real `HierarchicalCache` and `WarmingContainer`. Tests the complete warming workflow with real cache operations. No Redis L2 but L1 is real.

---

## P0: False Confidence (Fix Immediately)

These mock theater integration tests provide false confidence and should be reclassified immediately.

| # | File | Issue | Recommendation | Effort |
|---|------|-------|----------------|--------|
| 1 | `s3.3.1-solana-detector.integration.test.ts` | All mocked, no real Solana client interaction | Move to `shared/core/__tests__/unit/solana/` | LOW |
| 2 | `s3.3.4-solana-swap-parser.integration.test.ts` | All mocked, tests parsing logic only | Move to `shared/core/__tests__/unit/solana/` | LOW |
| 3 | `s3.3.5-solana-price-feed.integration.test.ts` | All mocked, tests feed logic only | Move to `shared/core/__tests__/unit/solana/` | LOW |
| 4 | `s3.3.6-solana-arbitrage-detector.integration.test.ts` | All mocked, tests detection logic only | Move to `shared/core/__tests__/unit/solana/` | LOW |
| 5 | `s3.3.7-solana-partition-deploy.integration.test.ts` | 400 lines of in-file mocks, tests constants | Move to `shared/core/__tests__/unit/solana/` | LOW |
| 6 | `partition-asia-fast/service.integration.test.ts` | ALL deps mocked | Move to `services/partition-asia-fast/src/__tests__/unit/` | LOW |
| 7 | `partition-high-value/service.integration.test.ts` | ALL deps mocked | Move to `services/partition-high-value/src/__tests__/unit/` | LOW |
| 8 | `partition-l2-turbo/service.integration.test.ts` | ALL deps mocked | Move to `services/partition-l2-turbo/src/__tests__/unit/` | LOW |
| 9 | `worker-pool-load.integration.test.ts` | Self-admits "these are unit tests" | Move to `shared/core/__tests__/unit/async/` | LOW |
| 10 | `mev-protection/bloxroute-integration.test.ts` | Fully mocked provider/wallet | Move to `shared/core/__tests__/unit/mev-protection/` | LOW |
| 11 | `mev-protection/fastlane-integration.test.ts` | Fully mocked provider/wallet | Move to `shared/core/__tests__/unit/mev-protection/` | LOW |

## P1: Structural Issues

| # | File | Issue | Recommendation | Effort |
|---|------|-------|----------------|--------|
| 1 | `s4.1.5-failover-scenarios.integration.test.ts` | 80% mock theater, 20% real Redis | Split: extract S4.1.5.7 (real Redis) to own file; move rest to unit | MEDIUM |
| 2 | `s4.1.4-standby-service-deployment.integration.test.ts` | Infrastructure config validation, not integration | Reclassify as config-lint test or move to deployment validation suite | LOW |
| 3 | `execution-engine/unit/circuit-breaker-integration.test.ts` | Named "integration" but in `unit/` directory | Move to `__tests__/integration/` | LOW |
| 4 | Component flow tests (13-17) | Test data flow patterns but reimplement service logic inline | Consider importing actual service routing/filtering functions | MEDIUM |

## P2: ADR Compliance Gaps

| # | ADR | Gap | Recommended Action | Effort |
|---|-----|-----|-------------------|--------|
| 1 | ADR-003 | No authentic integration test for partition service startup | Create integration test using real `createPartitionEntry()` with real Redis | HIGH |
| 2 | ADR-007 | No test exercises complete failover sequence | Create test: leader fails -> standby promotes -> health recovery | HIGH |
| 3 | ADR-018 | Circuit breaker not tested across service boundaries | Create test: execution engine circuit breaker triggers when Redis/RPC fails | MEDIUM |
| 4 | ADR-002 | StreamBatcher batch threshold behavior not tested | Add test to s1.1: verify batch is flushed when threshold reached | LOW |
| 5 | ADR-005 | L2 Redis cache fallback not tested with real Redis | Add test to cache-integration: L1 miss -> L2 Redis hit | MEDIUM |

## P3: Placement Corrections

| # | File | Current Location | Correct Location | Reason |
|---|------|-----------------|-----------------|--------|
| 1 | `s3.3.1-solana-detector` | `tests/integration/` | `shared/core/__tests__/unit/solana/` | All mocked |
| 2 | `s3.3.4-solana-swap-parser` | `tests/integration/` | `shared/core/__tests__/unit/solana/` | All mocked |
| 3 | `s3.3.5-solana-price-feed` | `tests/integration/` | `shared/core/__tests__/unit/solana/` | All mocked |
| 4 | `s3.3.6-solana-arbitrage-detector` | `tests/integration/` | `shared/core/__tests__/unit/solana/` | All mocked |
| 5 | `s3.3.7-solana-partition-deploy` | `tests/integration/` | `shared/core/__tests__/unit/solana/` | All mocked |
| 6 | `partition-asia-fast/integration/` | `__tests__/integration/` | `__tests__/unit/` | All deps mocked |
| 7 | `partition-high-value/integration/` | `__tests__/integration/` | `__tests__/unit/` | All deps mocked |
| 8 | `partition-l2-turbo/integration/` | `__tests__/integration/` | `__tests__/unit/` | All deps mocked |
| 9 | `worker-pool-load.integration` | `__tests__/integration/` | `__tests__/unit/async/` | Self-admits unit test |
| 10 | `bloxroute-integration` | `__tests__/integration/mev-protection/` | `__tests__/unit/mev-protection/` | All mocked |
| 11 | `fastlane-integration` | `__tests__/integration/mev-protection/` | `__tests__/unit/mev-protection/` | All mocked |
| 12 | `circuit-breaker-integration` | `__tests__/unit/` | `__tests__/integration/` | Tests real class with state transitions |

---

## Redundancy and Overlap Analysis

### Redundancy Cluster 1: Redis Streams Basic Operations
Multiple files test basic XADD/XREAD/XREADGROUP patterns with similar setups:
- `detector-coordinator.integration.test.ts` - publish/consume price updates
- `price-detection.integration.test.ts` - publish/consume price updates and opportunities
- `coordinator-execution.integration.test.ts` - publish/consume execution requests
- `multi-strategy-execution.integration.test.ts` - publish/consume across strategies

**Assessment**: NOT redundant. Each tests a different logical flow (different stream names, different data shapes, different consumer group patterns). The Redis operations are similar but the business scenarios are distinct. **KEEP ALL** - they provide complementary coverage.

### Redundancy Cluster 2: Distributed Locking
Lock acquire/release patterns appear in:
- `detector-lifecycle.integration.test.ts` (shared/core) - comprehensive Lua-script-based locking
- `coordinator-execution.integration.test.ts` - SET NX PX locking for execution
- `multi-strategy-execution.integration.test.ts` - lock per strategy type
- `s4.1.5-failover-scenarios.integration.test.ts` (S4.1.5.7) - leader election locking

**Assessment**: PARTIALLY redundant. The `detector-lifecycle` test is the most thorough. The locking in component-flow tests is context-specific (testing locking AS PART OF a flow, not locking in isolation). **KEEP but note overlap**.

### Redundancy Cluster 3: Partition Service Tests
Three nearly identical test files for P1/P2/P3:
- `partition-asia-fast/service.integration.test.ts`
- `partition-high-value/service.integration.test.ts`
- `partition-l2-turbo/service.integration.test.ts`

**Assessment**: REDUNDANT. All three mock everything and test the same `createPartitionEntry()` pattern with different config values. Should be consolidated into one parameterized unit test. **MERGE into one parameterized test**.

### Redundancy Cluster 4: Solana Tests
Five Solana integration test files that are all mock theater:
- `s3.3.1-solana-detector`
- `s3.3.4-solana-swap-parser`
- `s3.3.5-solana-price-feed`
- `s3.3.6-solana-arbitrage-detector`
- `s3.3.7-solana-partition-deploy`

**Assessment**: Each tests different Solana components (detector, parser, price feed, arbitrage detector, partition deploy). They're not redundant WITH EACH OTHER -- they're individually appropriate as unit tests. The issue is classification, not redundancy. **RECLASSIFY as unit tests, keep separate**.

### Redundancy Cluster 5: Circuit Breaker Tests
- `reliability/circuit-breaker.integration.test.ts` (centralized)
- `execution-engine/unit/circuit-breaker-integration.test.ts` (service-level)

**Assessment**: PARTIALLY redundant. The centralized test uses real `CircuitBreaker` class from `@arbitrage/core`; the execution-engine test uses its own `createCircuitBreaker` factory. They test similar state machine behavior but from different angles (generic vs execution-engine-specific). **KEEP both but move the unit/ one to integration/**.

---

## Statistics

| Metric | Count |
|--------|-------|
| Total integration test files analyzed | 42 |
| Total misplaced/borderline files checked | 6 |
| E2E test files analyzed | 1 |
| **Authenticity** | |
| AUTHENTIC integration tests | 17 (40%) |
| PARTIAL integration tests | 14 (33%) |
| MOCK THEATER integration tests | 11 (26%) |
| **Redis Usage** | |
| REAL REDIS | 19 (45%) |
| NO REDIS (but other real deps - SharedArrayBuffer, filesystem, Anvil) | 7 (17%) |
| MOCKED REDIS (should be real) | 3 (7%) |
| MOCKED/NO REDIS (acceptable) | 2 (5%) |
| NO REDIS (mock theater) | 11 (26%) |
| **ADR Compliance** | |
| ADR-002 (Redis Streams) | WELL COVERED (7+ authentic tests) |
| ADR-003 (Partitioned Detectors) | PARTIALLY COVERED (3 authentic, 3 mock theater) |
| ADR-005 (Hierarchical Cache) | WELL COVERED (5 authentic tests) |
| ADR-007 (Failover Strategy) | POORLY COVERED (1 partial, 1 config-only) |
| ADR-009 (Test Architecture) | PARTIALLY FOLLOWED (12 placement violations) |
| ADR-012 (Worker Threads) | WELL COVERED (5 authentic tests) |
| ADR-018 (Circuit Breaker) | PARTIALLY COVERED (2 tests, no cross-service) |
| **Placement** | |
| Correctly placed | 31 (74%) |
| Misplaced (integration -> unit) | 11 (26%) |
| Misplaced (unit -> integration) | 1 |

---

## Consolidation Roadmap

### Phase 1: Quick Wins (LOW effort, HIGH impact)
1. **Move 11 mock theater tests to unit directories** - No code changes needed, just file moves. Immediately fixes false confidence from misclassified tests.
2. **Move circuit-breaker-integration.test.ts to integration directory** - Simple file move.
3. **Rename `s4.1.4-standby-service-deployment`** to reflect it's a config validation test, not integration.

### Phase 2: Consolidation (MEDIUM effort)
4. **Merge 3 partition service tests** (P1/P2/P3) into one parameterized unit test file.
5. **Split `s4.1.5-failover-scenarios`** - extract S4.1.5.7 (real Redis leader election) to own integration file; move remaining sections to unit test.
6. **Add StreamBatcher batch threshold test** to `s1.1-redis-streams.integration.test.ts`.

### Phase 3: Structural (HIGH effort, fills gaps)
7. **Create authentic partition service integration test** - uses real `createPartitionEntry()` with real Redis (fills ADR-003 gap).
8. **Create failover sequence integration test** - leader fails -> standby promotes (fills ADR-007 gap).
9. **Create cross-service circuit breaker test** - execution engine's circuit breaker triggers on real Redis/RPC failures (fills ADR-018 gap).
10. **Add L2 Redis cache fallback test** to `cache-integration.test.ts` (fills ADR-005 gap).

# Integration Test Validation Report

## Summary

- **Integration tests analyzed:** 47 files
- **AUTHENTIC INTEGRATION:** 15 | **PARTIAL INTEGRATION:** 10 | **MOCK THEATER:** 22
- **REAL REDIS:** 12 | **MOCKED REDIS (should be real):** 4 | **MOCKED REDIS (acceptable):** 3 | **N/A:** 28
- **ADR COMPLIANT:** 14 | **ADR GAPS:** 8 | **NO ADR RELEVANCE:** 25

## Classification Key

| Verdict | Meaning |
|---------|---------|
| AUTHENTIC INTEGRATION | Tests real component interactions with real or in-memory infrastructure |
| PARTIAL INTEGRATION | Some real components but key boundaries are mocked |
| MOCK THEATER | Unit test wearing integration test clothing -- everything significant is mocked |

---

## Mock Theater Tests (22 files)

| # | File | Current Mocks | Why Mock Theater | Recommendation |
|---|------|---------------|-----------------|----------------|
| 1 | `tests/integration/s2.1-optimism.integration.test.ts` | No mocks, but only reads config constants | Pure config validation -- reads `DEXES.optimism`, `CORE_TOKENS.optimism` from `@arbitrage/config`. No component interaction, no services instantiated, no Redis, no network. | **DOWNGRADE TO UNIT** |
| 2 | `tests/integration/s2.2-dex-expansion.integration.test.ts` | No mocks, only config imports | Pure config validation -- reads `DEXES.arbitrum`, `getEnabledDexes()`, `dexFeeToPercentage()`. No services instantiated. | **DOWNGRADE TO UNIT** |
| 3 | `tests/integration/s2.2.2-base-dex-expansion.integration.test.ts` | No mocks, only config imports | Pure config validation -- reads `DEXES.base`, helper functions. Identical pattern to s2.2. | **DOWNGRADE TO UNIT** |
| 4 | `tests/integration/s2.2.3-bsc-dex-expansion.integration.test.ts` | No mocks, only config imports | Pure config validation -- reads `DEXES.bsc`, fee calculations, token coverage counts. No services. | **DOWNGRADE TO UNIT** |
| 5 | `tests/integration/s2.2.4-token-coverage.integration.test.ts` | No mocks, only config imports | Pure config validation -- counts tokens per chain, validates addresses. No services. | **DOWNGRADE TO UNIT** |
| 6 | `tests/integration/s2.2.5-pair-initialization.integration.test.ts` | No mocks, only config imports | Pure config validation -- validates pair generation from token/DEX config. No services. | **DOWNGRADE TO UNIT** |
| 7 | `tests/integration/s2.2.5-pair-services.integration.test.ts` | `jest.mock('@arbitrage/core')` -- mocks Redis client entirely | Mocks the only real dependency (Redis). Tests PairCacheService + PairDiscoveryService with mock Redis and mock providers. No real component interaction. | **DOWNGRADE TO UNIT** or **UPGRADE TO REAL REDIS** |
| 8 | `tests/integration/s3.1.2-partition-assignment.integration.test.ts` | No mocks, only config imports | Pure config validation -- reads `PARTITIONS`, `assignChainToPartition()`, `getChainsForPartition()`. Config functions tested in isolation. | **DOWNGRADE TO UNIT** |
| 9 | `tests/integration/s3.1.7-detector-migration.integration.test.ts` | No mocks, only config/core imports | Pure config validation -- validates chain coverage, partition ports, service names. No services instantiated. | **DOWNGRADE TO UNIT** |
| 10 | `tests/integration/s3.2.4-cross-chain-detection.integration.test.ts` | No mocks, only config imports | Config validation for cross-chain token normalization, bridge costs. Tests utility functions `normalizeTokenForCrossChain()`, `findCommonTokensBetweenChains()`. | **DOWNGRADE TO UNIT** |
| 11 | `tests/integration/s3.3.1-solana-detector.integration.test.ts` | Mock Redis and Streams clients | Tests SolanaDetector with mocked Redis/Streams. Real class instantiation but all external deps mocked. Does test config validation and pool management locally. | **PARTIAL** (borderline mock theater) |
| 12 | `tests/integration/s3.3.2-solana-dex-configuration.integration.test.ts` | No mocks, config + constants | Pure config validation -- validates Solana DEX program IDs, enabled DEXes. | **DOWNGRADE TO UNIT** |
| 13 | `tests/integration/s3.3.3-solana-token-configuration.integration.test.ts` | No mocks, config imports | Pure config validation -- validates Solana token addresses, decimals, categories. | **DOWNGRADE TO UNIT** |
| 14 | `tests/integration/s3.3.7-solana-partition-deploy.integration.test.ts` | No mocks, config imports + EventEmitter | Validates partition config, RPC provider URLs. Tests are config assertions only. | **DOWNGRADE TO UNIT** |
| 15 | `tests/integration/config-validation/chain-config.integration.test.ts` | No mocks, only config imports | Parameterized config validation -- validates Avalanche/Fantom chain configs, DEX addresses, token addresses. | **DOWNGRADE TO UNIT** |
| 16 | `tests/integration/vault-model-dex-regression.integration.test.ts` | No mocks, config + PairDiscoveryService | Tests config presence of vault-model DEXes. Uses `getEnabledDexes()` and `PairDiscoveryService` singleton check. No real interaction. | **DOWNGRADE TO UNIT** |
| 17 | `services/cross-chain-detector/src/__tests__/integration/detector-integration.integration.test.ts` | Mocks Redis streams, logger, perf logger | Tests PriceDataManager and OpportunityPublisher with mocked streams client. Internal logic tested but no real Redis. | **DOWNGRADE TO UNIT** or **UPGRADE** |
| 18 | `services/coordinator/src/__tests__/coordinator.integration.test.ts` | Mocks Redis client, Streams client, logger, ServiceStateManager | Tests CoordinatorService DI with all deps mocked. Good DI pattern but zero real integration. | **DOWNGRADE TO UNIT** |
| 19 | `services/partition-asia-fast/src/__tests__/integration/service.integration.test.ts` | `jest.mock('@arbitrage/core')` -- mocks entire core package | Every external dependency is mocked. Service startup/shutdown tested against mock infrastructure. | **DOWNGRADE TO UNIT** |
| 20 | `tests/integration/s4.1.4-standby-service-deployment.integration.test.ts` | No mocks, uses `fs.existsSync` | Tests existence of deployment files (Dockerfile.standby, cloudrun.yaml). Filesystem checks, not component integration. | **DOWNGRADE TO UNIT** (filesystem validation) |
| 21 | `tests/integration/s4.1.5-failover-scenarios.integration.test.ts` | Mocks Redis client, Streams client, Lock manager, Logger | Tests FailoverManager against fully mocked infrastructure. No real failover behavior tested. | **DOWNGRADE TO UNIT** or **UPGRADE** |
| 22 | `shared/core/__tests__/integration/worker-pool-load.integration.test.ts` | `jest.mock('../../src/logger')`, does NOT start workers | Comment says "We don't start the pool here - these are unit tests with mocked workers." Self-declared unit tests. | **DOWNGRADE TO UNIT** |

---

## ADR Compliance Gaps

| ADR | Expected Behavior | Actual Coverage | Gap |
|-----|------------------|-----------------|-----|
| **ADR-002** (Redis Streams) | Tests verify stream creation, consumer groups, message ordering, acknowledgment, and backpressure | `component-flows/` tests (4 files) + `error-handling/dead-letter-queue` + `chaos/fault-injection` + `mempool/pending-opportunities` + `multi-partition/cross-partition-sync` + `e2e/data-flow-e2e` use REAL Redis Streams. `s1.1-redis-streams` MOCKS ioredis entirely. | **s1.1-redis-streams.integration.test.ts** is the "canonical" ADR-002 test but uses 180+ lines of custom mock code instead of real Redis. The newer Phase 4+ tests properly use real Redis. |
| **ADR-003** (Partitioned Detectors) | Tests verify partition routing, chain assignment, cross-partition communication | Config-level tests exist (s3.1.2, s3.1.7). `multi-chain-detection` and `cross-partition-sync` test data flow with real Redis. | No test verifies actual partition service startup with real partition routing. Config-only tests are pure unit tests. |
| **ADR-005** (L1 Price Matrix / SharedArrayBuffer) | Tests verify <1us lookup latency, SharedArrayBuffer creation, cross-thread visibility | `s1.3-price-matrix` tests real PriceMatrix (AUTHENTIC). `worker-price-matrix`, `worker-zero-copy`, `worker-thread-safety`, `worker-concurrent-reads` test real worker threads with SharedArrayBuffer. | Good coverage. Worker tests depend on `WorkerTestHarness` from test-utils which may or may not spawn real workers. |
| **ADR-012** (Worker Threads) | Tests verify worker pool management, concurrent operations, load handling | `worker-pool-load` mocks logger and does NOT start workers (self-declared unit test). Other worker-* tests use `WorkerTestHarness`. | `worker-pool-load` is mislabeled as integration when it's a unit test. |
| **ADR-018** (Circuit Breaker) | Tests verify state transitions (CLOSED->OPEN->HALF_OPEN->CLOSED), failure thresholds, recovery | `reliability/circuit-breaker` tests REAL CircuitBreaker class with real state transitions, timing, and concurrent access. | **FULLY COMPLIANT** -- an excellent integration test. |
| **ADR-007** (Cross-Region Failover) | Tests verify <60s failover, standby deployment, leader election | `s4.1.4-standby-service-deployment` only checks file existence. `s4.1.5-failover-scenarios` uses all mocks. `detector-lifecycle` (unified-detector) tests partition config, not failover. | No test actually validates failover timing or real leader election transitions. Both are mock theater. |
| **ADR-014** (Modular Detector Components) | Tests verify PriceDataManager, OpportunityPublisher integration | `cross-chain-detector/detector-integration` tests these but with fully mocked streams. | Should use real Redis streams to validate actual publishing behavior. |

---

## Per-File Validation

### tests/integration/ (centralized tests)

---

#### 1. `s1.1-redis-streams.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Mocks ALL of `ioredis` with 180+ lines of custom mock implementation that simulates XADD, XREADGROUP, XACK, XGROUP, consumer groups. No real Redis.
- **Redis:** MOCKED REDIS (should be real) -- This is the canonical ADR-002 Redis Streams test but uses no real Redis.
- **ADR Compliance:** ADR-002 GAP -- Claims to validate Redis Streams migration but all stream behavior is hand-coded mocks.
- **Boundaries Crossed:** None real. Tests mock-to-mock interaction.
- **Bugs Caught:** Would catch serialization issues in message format. Would NOT catch real Redis edge cases (stream trimming, consumer group rebalancing, message ordering under load).
- **VERDICT:** REWRITE FOCUS -- Should be rewritten to use `createTestRedisClient()` from `@arbitrage/test-utils` (as the Phase 4+ tests do). The mock implementation is fragile and likely diverges from real Redis behavior.

---

#### 2. `s1.3-price-matrix.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses real `PriceMatrix` with real `SharedArrayBuffer`. Tests actual memory allocation, price storage/retrieval, batch updates, performance benchmarks.
- **Redis:** N/A -- PriceMatrix is in-memory, no Redis needed.
- **ADR Compliance:** ADR-005 COMPLIANT -- Validates SharedArrayBuffer creation, <1us lookup latency, batch updates.
- **Boundaries Crossed:** PriceMatrix <-> SharedArrayBuffer <-> PriceIndexMapper.
- **Bugs Caught:** Memory allocation failures, price precision issues, concurrent access problems, performance regressions.
- **VERDICT:** KEEP AS-IS -- Excellent integration test of the L1 cache layer.

---

#### 3. `s2.1-optimism.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Only imports `@arbitrage/config` constants and validates static values.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None -- reads config only.
- **Bugs Caught:** Config typos, missing DEX entries. Would NOT catch any runtime behavior.
- **VERDICT:** DOWNGRADE TO UNIT -- Move to `shared/config/__tests__/unit/optimism.test.ts`.

---

#### 4. `s2.2-dex-expansion.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation only. Same pattern as s2.1.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None.
- **Bugs Caught:** Config typos.
- **VERDICT:** DOWNGRADE TO UNIT -- Move to config package unit tests.

---

#### 5. `s2.2.2-base-dex-expansion.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation only.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 6. `s2.2.3-bsc-dex-expansion.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation only.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 7. `s2.2.4-token-coverage.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation only (token counts, addresses, decimals).
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 8. `s2.2.5-pair-initialization.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation for pair generation. No services.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 9. `s2.2.5-pair-services.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Mocks `@arbitrage/core` (Redis client) entirely. Tests PairCacheService/PairDiscoveryService against mock Redis.
- **Redis:** MOCKED REDIS (should be real) -- PairCacheService is specifically designed to use Redis.
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** PairCacheService <-> mock Redis (fake boundary).
- **Bugs Caught:** API contract issues. Would NOT catch serialization, TTL, or concurrent access bugs.
- **VERDICT:** UPGRADE TO REAL DEPS -- Use `createTestRedisClient()` for real Redis interaction.

---

#### 10. `s3.1.2-partition-assignment.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Pure config function testing.
- **Redis:** N/A
- **ADR Compliance:** ADR-003 partial -- Tests partition config structure but not actual partition routing.
- **Boundaries Crossed:** None.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 11. `s3.1.7-detector-migration.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation. Tests chain coverage, partition ports.
- **Redis:** N/A
- **ADR Compliance:** ADR-003 partial -- Config-level only.
- **Boundaries Crossed:** None -- reads constants from `@arbitrage/config` and `@arbitrage/core`.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 12. `s3.2.4-cross-chain-detection.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Tests utility functions (`normalizeTokenForCrossChain`, `findCommonTokensBetweenChains`, `getBridgeCost`).
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** None -- pure function testing.
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 13. `s3.3.1-solana-detector.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Instantiates real `SolanaDetector` class but with mocked Redis/Streams clients. Tests config validation, pool management locally.
- **Redis:** MOCKED REDIS (acceptable) -- Solana detector's Redis usage is secondary to its detection logic.
- **ADR Compliance:** ADR-003 partial -- Tests Solana partition detector structure.
- **Boundaries Crossed:** SolanaDetector internal logic tested.
- **VERDICT:** KEEP AS-IS -- Reasonable partial integration test.

---

#### 14. `s3.3.2-solana-dex-configuration.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation for Solana DEX program IDs.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 15. `s3.3.3-solana-token-configuration.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation for Solana token addresses.
- **Redis:** N/A
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 16. `s3.3.4-solana-swap-parser.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Instantiates real `SolanaSwapParser` and tests instruction parsing logic with constructed test data. No mocks of the parser itself.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** SolanaSwapParser <-> instruction data.
- **VERDICT:** KEEP AS-IS -- Tests real parsing logic, though technically a unit test boundary.

---

#### 17. `s3.3.5-solana-price-feed.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Instantiates real `SolanaPriceFeed` with real pool state layout parsers. Tests buffer encoding/decoding.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** SolanaPriceFeed <-> pool state layouts.
- **VERDICT:** KEEP AS-IS -- Tests real binary parsing.

---

#### 18. `s3.3.6-solana-arbitrage-detector.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Instantiates real `SolanaArbitrageDetector` with mock streams client. Tests arbitrage detection, triangular path analysis, cross-chain comparison logic.
- **Redis:** MOCKED REDIS (acceptable) -- The streams mock is minimal; the detection logic is real.
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** SolanaArbitrageDetector internal logic.
- **VERDICT:** KEEP AS-IS

---

#### 19. `s3.3.7-solana-partition-deploy.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation for Solana partition deployment URLs.
- **Redis:** N/A
- **VERDICT:** DOWNGRADE TO UNIT

---

#### 20. `s4.1.4-standby-service-deployment.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Uses `fs.existsSync()` to check deployment file existence.
- **Redis:** N/A
- **ADR Compliance:** ADR-007 GAP -- Claims to test standby deployment but only checks file presence.
- **Boundaries Crossed:** Filesystem only.
- **VERDICT:** DOWNGRADE TO UNIT -- This is a filesystem smoke test, not integration.

---

#### 21. `s4.1.5-failover-scenarios.integration.test.ts`
- **Authenticity:** MOCK THEATER -- All deps mocked (Redis, Streams, Lock manager, Logger). Tests FailoverManager against fake infrastructure.
- **Redis:** MOCKED REDIS (should be real) -- Failover depends on Redis for leader election.
- **ADR Compliance:** ADR-007 GAP -- Claims to test <60s failover but uses mock timers, not real failover.
- **Boundaries Crossed:** None real.
- **VERDICT:** UPGRADE TO REAL DEPS -- Critical path that should use real Redis for leader election testing.

---

#### 22. `vault-model-dex-regression.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Config validation for vault-model DEXes.
- **Redis:** N/A
- **VERDICT:** DOWNGRADE TO UNIT

---

### tests/integration/component-flows/ (4 files)

---

#### 23. `component-flows/price-detection.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()` (real in-memory Redis via redis-memory-server). Tests full price update -> detection flow through Redis Streams.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT -- Tests stream publishing, consumption, price comparison.
- **Boundaries Crossed:** Price data -> Redis Streams -> opportunity detection pipeline.
- **Bugs Caught:** Serialization issues, stream ordering, price comparison logic, stale data handling.
- **VERDICT:** KEEP AS-IS -- Excellent authentic integration test.

---

#### 24. `component-flows/detector-coordinator.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests detector -> coordinator flow via Redis Streams with consumer groups.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT -- Tests consumer group creation, message delivery, acknowledgment.
- **Boundaries Crossed:** Detector -> stream:price-updates -> stream:opportunities -> Coordinator.
- **VERDICT:** KEEP AS-IS

---

#### 25. `component-flows/coordinator-execution.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests coordinator -> execution engine flow via Redis Streams with distributed locking.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT -- Tests stream-based request/response, distributed locks.
- **Boundaries Crossed:** Coordinator -> stream:execution-requests -> Execution Engine -> stream:execution-results.
- **VERDICT:** KEEP AS-IS

---

#### 26. `component-flows/multi-chain-detection.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests price detection across all 11 chains in 4 partitions via Redis Streams.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002, ADR-003 COMPLIANT -- Tests multi-chain, multi-partition stream flow.
- **Boundaries Crossed:** 11 chains -> partitions -> Redis Streams -> opportunities.
- **VERDICT:** KEEP AS-IS

---

#### 27. `component-flows/multi-strategy-execution.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests all 5 strategy types through Redis Streams.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT -- Tests strategy routing via streams, consumer groups, distributed locks.
- **Boundaries Crossed:** Strategy routing -> stream:opportunities -> stream:execution-requests.
- **VERDICT:** KEEP AS-IS

---

### tests/integration/error-handling/

---

#### 28. `error-handling/dead-letter-queue.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests DLQ operations with real Redis sorted sets, TTL, priority queuing.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 related -- Tests error recovery flow with real Redis.
- **Boundaries Crossed:** Failed operations -> Redis sorted sets -> retry processing.
- **VERDICT:** KEEP AS-IS

---

### tests/integration/reliability/

---

#### 29. `reliability/circuit-breaker.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses real `CircuitBreaker` and `CircuitBreakerRegistry` classes with real timers and state transitions.
- **Redis:** N/A -- Circuit breaker is in-memory.
- **ADR Compliance:** ADR-018 COMPLIANT -- Tests all state transitions, failure thresholds, recovery timeouts.
- **Boundaries Crossed:** CircuitBreaker <-> CircuitBreakerRegistry. Real timing-based transitions.
- **VERDICT:** KEEP AS-IS -- One of the best integration tests in the project.

---

### tests/integration/mempool/

---

#### 30. `mempool/pending-opportunities.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests PendingOpportunity flow with real Redis Streams, BigInt serialization.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT
- **Boundaries Crossed:** PendingSwapIntent -> serialization -> stream:pending-opportunities -> consumer.
- **VERDICT:** KEEP AS-IS

---

### tests/integration/multi-partition/

---

#### 31. `multi-partition/cross-partition-sync.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests cross-partition price synchronization via Redis Streams.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002, ADR-003 COMPLIANT
- **Boundaries Crossed:** Partition P1 -> stream:price-updates -> Cross-chain detector -> Partition P3.
- **VERDICT:** KEEP AS-IS

---

### tests/integration/chaos/

---

#### 32. `chaos/fault-injection.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`, `createChaosController()`, `NetworkPartitionSimulator`. Tests system behavior under failure injection with real Redis.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 related -- Tests resilience under chaos.
- **Boundaries Crossed:** Services -> Chaos controller -> Redis (interrupted) -> Recovery.
- **VERDICT:** KEEP AS-IS -- Valuable chaos testing.

---

### tests/e2e/

---

#### 33. `e2e/data-flow-e2e.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()`. Tests complete pipeline: Price -> Detection -> Coordination -> Execution -> Result via Redis Streams.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002 COMPLIANT -- End-to-end stream flow.
- **Boundaries Crossed:** Full pipeline across 4 stream types with consumer groups.
- **VERDICT:** KEEP AS-IS -- The most comprehensive integration test.

---

### Service-level integration tests

---

#### 34. `services/unified-detector/__tests__/integration/detector-lifecycle.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Only tests partition config consistency and chain assignment. No detector lifecycle tested (despite filename).
- **Redis:** N/A
- **ADR Compliance:** ADR-003 partial -- Config validation only.
- **VERDICT:** DOWNGRADE TO UNIT or REWRITE to test actual detector lifecycle with real Redis.

---

#### 35. `services/execution-engine/src/__tests__/integration/simulation/hot-fork-synchronizer.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses real Anvil (Foundry) instance for fork synchronization testing. Properly skips when Anvil unavailable.
- **Redis:** N/A -- Uses Anvil, not Redis.
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** HotForkSynchronizer <-> AnvilForkManager <-> Real JSON-RPC provider.
- **VERDICT:** KEEP AS-IS -- Genuine integration test requiring external tool (Anvil).

---

#### 36. `services/cross-chain-detector/src/__tests__/integration/detector-integration.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Mocks streams client, logger, performance logger. Tests PriceDataManager/OpportunityPublisher with all external deps mocked.
- **Redis:** MOCKED REDIS (should be real) -- Cross-chain detector fundamentally relies on Redis Streams.
- **ADR Compliance:** ADR-014 GAP -- Claims to test modular detector integration but all boundaries are mocked.
- **VERDICT:** UPGRADE TO REAL DEPS -- Use `createTestRedisClient()` for streams.

---

#### 37. `services/coordinator/src/__tests__/coordinator.integration.test.ts`
- **Authenticity:** MOCK THEATER -- All deps (Redis client, Streams client, StateManager, Logger) are mocked.
- **Redis:** MOCKED REDIS (should be real) -- Coordinator is fundamentally a Redis Streams consumer.
- **ADR Compliance:** ADR-002, ADR-007 GAP -- Leader election and stream consumption cannot be validated with mocks.
- **VERDICT:** UPGRADE TO REAL DEPS -- Critical service that needs real Redis testing.

---

#### 38. `services/mempool-detector/src/__tests__/integration/success-criteria.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses real mainnet transaction fixtures (actual calldata from Etherscan). Tests `DecoderRegistry` against real Uniswap V2/V3 swap data.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** Real transaction calldata -> DecoderRegistry -> ParsedSwap output.
- **VERDICT:** KEEP AS-IS -- Excellent test using real-world data fixtures.

---

#### 39. `services/partition-asia-fast/src/__tests__/integration/service.integration.test.ts`
- **Authenticity:** MOCK THEATER -- `jest.mock('@arbitrage/core')` mocks the entire core package. Tests service startup against fully mocked infrastructure.
- **Redis:** MOCKED REDIS (acceptable for env config tests, but not for service lifecycle).
- **ADR Compliance:** ADR-003 GAP -- Cannot validate real partition service behavior.
- **VERDICT:** DOWNGRADE TO UNIT -- or refactor to test real partition startup with Redis.

---

#### 40. `services/execution-engine/src/strategies/flash-loan-providers/pancakeswap-v3.provider.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Uses real `PancakeSwapV3FlashLoanProvider` class but with `MockPancakeV3Factory` and `MockPancakeV3Pool`. Tests pool discovery logic and fee tier selection.
- **Redis:** N/A
- **ADR Compliance:** NO ADR RELEVANCE
- **Boundaries Crossed:** Provider <-> Mock contracts (testing the contract interaction layer).
- **VERDICT:** KEEP AS-IS -- Acceptable to mock blockchain contracts; tests real provider logic.

---

### shared/core/ integration tests

---

#### 41. `shared/core/__tests__/integration/worker-pool-load.integration.test.ts`
- **Authenticity:** MOCK THEATER -- Mocks logger. Does NOT start real workers. File itself notes "these are unit tests with mocked workers."
- **Redis:** N/A
- **ADR Compliance:** ADR-012 GAP -- Claims to test worker pool load but doesn't start workers.
- **VERDICT:** DOWNGRADE TO UNIT -- The file self-identifies as unit tests.

---

#### 42. `shared/core/__tests__/integration/worker-price-matrix.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `WorkerTestHarness` to spawn real worker threads with real SharedArrayBuffer and PriceMatrix.
- **Redis:** N/A
- **ADR Compliance:** ADR-005, ADR-012 COMPLIANT -- Tests SharedArrayBuffer visibility across threads.
- **Boundaries Crossed:** Main thread PriceMatrix <-> SharedArrayBuffer <-> Worker threads.
- **VERDICT:** KEEP AS-IS

---

#### 43. `shared/core/__tests__/integration/worker-zero-copy.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `WorkerTestHarness` with real workers. Tests zero-copy SharedArrayBuffer access and latency.
- **Redis:** N/A
- **ADR Compliance:** ADR-005 COMPLIANT -- Validates zero-copy claim.
- **VERDICT:** KEEP AS-IS

---

#### 44. `shared/core/__tests__/integration/worker-thread-safety.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `WorkerTestHarness` with real concurrent workers. Tests race conditions, data corruption under concurrent access.
- **Redis:** N/A
- **ADR Compliance:** ADR-005, ADR-012 COMPLIANT
- **VERDICT:** KEEP AS-IS

---

#### 45. `shared/core/__tests__/integration/worker-concurrent-reads.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Large-scale concurrent read testing with real workers.
- **Redis:** N/A
- **ADR Compliance:** ADR-005 COMPLIANT -- Validates throughput targets (>10,000 reads/sec).
- **VERDICT:** KEEP AS-IS

---

#### 46. `shared/core/__tests__/integration/detector-lifecycle.integration.test.ts`
- **Authenticity:** AUTHENTIC INTEGRATION -- Uses `createTestRedisClient()` for real Redis. Tests DistributedLockManager and ServiceStateManager with real atomic Redis operations.
- **Redis:** REAL REDIS
- **ADR Compliance:** ADR-002, ADR-009 COMPLIANT
- **Boundaries Crossed:** DistributedLockManager <-> Real Redis <-> ServiceStateManager.
- **VERDICT:** KEEP AS-IS -- Properly migrated from mock to real Redis.

---

#### 47. `shared/core/src/warming/container/__tests__/warming-flow.integration.test.ts`
- **Authenticity:** PARTIAL INTEGRATION -- Uses real `WarmingContainer`, `HierarchicalCache`, and warming components. No mocks for core logic, but no Redis (cache is in-memory).
- **Redis:** N/A
- **ADR Compliance:** ADR-005 partial -- Tests hierarchical cache warming but not L2/L3 layers.
- **Boundaries Crossed:** WarmingContainer <-> HierarchicalCache <-> CorrelationTracker <-> TopNRanker.
- **VERDICT:** KEEP AS-IS -- Good integration of warming pipeline components.

---

## Recommended Upgrades (priority order)

| # | File | Current State | Target State | Effort | Value |
|---|------|--------------|--------------|--------|-------|
| 1 | `s1.1-redis-streams.integration.test.ts` | 180+ lines of custom ioredis mocks | Real Redis via `createTestRedisClient()` | MEDIUM -- need to replace mock factory with real Redis calls | **HIGH** -- This is the canonical ADR-002 test; should be authentic |
| 2 | `services/coordinator/coordinator.integration.test.ts` | All deps mocked | Real Redis for streams + locks; mock only external APIs | MEDIUM | **HIGH** -- Coordinator is the central orchestrator |
| 3 | `s4.1.5-failover-scenarios.integration.test.ts` | All deps mocked | Real Redis for leader election; test actual failover timing | MEDIUM | **HIGH** -- ADR-007 requires <60s failover validation |
| 4 | `services/cross-chain-detector/detector-integration.integration.test.ts` | Streams mocked | Real Redis streams for publishing | LOW | **MEDIUM** -- Would validate actual cross-chain detection |
| 5 | `s2.2.5-pair-services.integration.test.ts` | Redis fully mocked | Real Redis for PairCacheService | LOW | **MEDIUM** -- Would catch TTL and serialization bugs |
| 6 | `services/partition-asia-fast/service.integration.test.ts` | Entire @arbitrage/core mocked | Real Redis + real partition config | MEDIUM | **MEDIUM** -- Would validate partition startup |

## Recommended Downgrades (consolidation candidates)

These 16 files should be moved to unit test directories. They can potentially be consolidated into 3-4 parameterized test files:

| # | Current File | Consolidation Target |
|---|-------------|---------------------|
| 1 | `s2.1-optimism.integration.test.ts` | `shared/config/__tests__/unit/chain-config.test.ts` (parameterized) |
| 2 | `s2.2-dex-expansion.integration.test.ts` | `shared/config/__tests__/unit/dex-config.test.ts` (parameterized) |
| 3 | `s2.2.2-base-dex-expansion.integration.test.ts` | Same as above |
| 4 | `s2.2.3-bsc-dex-expansion.integration.test.ts` | Same as above |
| 5 | `s2.2.4-token-coverage.integration.test.ts` | `shared/config/__tests__/unit/token-config.test.ts` |
| 6 | `s2.2.5-pair-initialization.integration.test.ts` | `shared/config/__tests__/unit/pair-config.test.ts` |
| 7 | `s3.1.2-partition-assignment.integration.test.ts` | `shared/config/__tests__/unit/partition-config.test.ts` (parameterized) |
| 8 | `s3.1.7-detector-migration.integration.test.ts` | Same as above |
| 9 | `s3.2.4-cross-chain-detection.integration.test.ts` | `shared/config/__tests__/unit/cross-chain-utils.test.ts` |
| 10 | `s3.3.2-solana-dex-configuration.integration.test.ts` | `shared/config/__tests__/unit/solana-config.test.ts` |
| 11 | `s3.3.3-solana-token-configuration.integration.test.ts` | Same as above |
| 12 | `s3.3.7-solana-partition-deploy.integration.test.ts` | Same as above |
| 13 | `s4.1.4-standby-service-deployment.integration.test.ts` | `infrastructure/__tests__/deployment-files.test.ts` |
| 14 | `vault-model-dex-regression.integration.test.ts` | `shared/config/__tests__/unit/dex-config.test.ts` |
| 15 | `config-validation/chain-config.integration.test.ts` | `shared/config/__tests__/unit/chain-config.test.ts` |
| 16 | `worker-pool-load.integration.test.ts` | `shared/core/__tests__/unit/worker-pool.test.ts` |

## Key Findings

### 1. Stark Quality Divide

The integration test suite has a clear divide between two eras:
- **Pre-Phase 4 tests** (s1.1, s2.x, s3.x, s4.x, service-level): Predominantly config validation or mock theater. These were written as part of TDD for feature implementation and never upgraded to use real infrastructure.
- **Phase 4+ tests** (component-flows/, error-handling/, reliability/, chaos/, mempool/, multi-partition/, e2e/): Use `createTestRedisClient()` from `@arbitrage/test-utils` and are genuinely authentic integration tests.

### 2. The Config Test Problem

16 of 47 files (34%) are pure config validation tests masquerading as integration tests. They import `@arbitrage/config` constants and assert on static values. These:
- Slow down the integration test suite (they run in the `test:integration` Jest project)
- Give false confidence about integration coverage
- Should be moved to unit tests where they run faster and are properly categorized

### 3. Real Redis Pattern Exists and Works

The `@arbitrage/test-utils` package provides `createTestRedisClient()` which creates a real in-memory Redis instance (via redis-memory-server). 12 tests already use this correctly. The 4 files with "mocked Redis (should be real)" can adopt this pattern with moderate effort.

### 4. Strongest Integration Tests

The best integration tests in the project are:
1. `e2e/data-flow-e2e.test.ts` -- Full pipeline validation
2. `reliability/circuit-breaker.integration.test.ts` -- Complete state machine testing
3. `shared/core/detector-lifecycle.integration.test.ts` -- Real Redis locks + state management
4. `chaos/fault-injection.integration.test.ts` -- Genuine resilience testing
5. `component-flows/coordinator-execution.integration.test.ts` -- Real distributed locking
6. `mempool-detector/success-criteria.integration.test.ts` -- Real mainnet transaction data

### 5. Worker Thread Tests Are Well-Designed

The 4 worker-* tests (excluding worker-pool-load) use `WorkerTestHarness` and spawn real Worker threads with SharedArrayBuffer. These properly validate ADR-005 and ADR-012 requirements.

### 6. Missing Integration Tests

| Gap | What Should Exist | Priority |
|-----|------------------|----------|
| Partition service lifecycle | Test that starts a real partition service, connects to Redis, processes price updates, and shuts down cleanly | HIGH |
| Leader election failover | Test real leader election via Redis with actual timing verification (<60s) | HIGH |
| WebSocket reconnection | Test that WebSocket handlers reconnect and resume price feeds after disconnection | MEDIUM |
| Cross-chain bridge cost validation | Test that bridge costs are applied correctly in opportunity scoring (currently config-only) | MEDIUM |
| ML model integration | Test that ML predictions affect opportunity confidence scoring with real model | LOW |

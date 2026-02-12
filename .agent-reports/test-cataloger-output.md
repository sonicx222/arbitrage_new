# Test Inventory Report

Generated: 2026-02-12
Total test files scanned: 281

## Summary

- **Total test files:** 281
- **Total test cases (it/test calls):** 8999
- **Unit tests:** 201 files, 6231 test cases
- **Integration tests:** 51 files, 1943 test cases
- **Contract tests:** 10 files, 472 test cases
- **Performance tests:** 10 files, 77 test cases
- **E2e tests:** 1 files, 7 test cases
- **Smoke tests:** 1 files, 25 test cases
- **Script tests:** 7 files, 244 test cases
- **Misplaced tests:** 10 files
- **Co-located tests (outside __tests__):** 2 files
- **Suspicious patterns found:** 13

## Distribution by Area

| Area | Files | Test Cases | Unit | Integration | Performance | Other |
|------|-------|------------|------|-------------|-------------|-------|
| contracts | 12 | 590 | 0 | 0 | 0 | 12 |
| infrastructure | 2 | 138 | 2 | 0 | 0 | 0 |
| scripts | 5 | 126 | 0 | 0 | 0 | 5 |
| services/coordinator | 6 | 189 | 5 | 1 | 0 | 0 |
| services/cross-chain-detector | 10 | 309 | 9 | 1 | 0 | 0 |
| services/execution-engine | 42 | 1139 | 38 | 3 | 1 | 0 |
| services/mempool-detector | 4 | 169 | 3 | 1 | 0 | 0 |
| services/partition-asia-fast | 2 | 53 | 1 | 1 | 0 | 0 |
| services/partition-high-value | 1 | 39 | 1 | 0 | 0 | 0 |
| services/partition-l2-turbo | 1 | 26 | 1 | 0 | 0 | 0 |
| services/partition-solana | 1 | 86 | 1 | 0 | 0 | 0 |
| services/unified-detector | 20 | 402 | 13 | 2 | 5 | 0 |
| shared/config | 13 | 454 | 13 | 0 | 0 | 0 |
| shared/constants | 1 | 28 | 1 | 0 | 0 | 0 |
| shared/core | 112 | 3288 | 100 | 9 | 3 | 0 |
| shared/ml | 7 | 251 | 7 | 0 | 0 | 0 |
| shared/security | 4 | 90 | 4 | 0 | 0 | 0 |
| shared/test-utils | 2 | 33 | 2 | 0 | 0 | 0 |
| tests (centralized) | 36 | 1589 | 0 | 33 | 1 | 2 |

## Misplaced Tests

| File | Current Category | Should Be | Reason |
|------|-----------------|-----------|--------|
| `services/execution-engine/src/__tests__/unit/execution-flow.test.ts` | unit | integration | Unit test location but uses real dependencies (3 real dep refs) |
| `services/execution-engine/__tests__/unit/services/commit-reveal.service.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/hierarchical-cache-pricematrix.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/hierarchical-cache.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/predictive-warming.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-basic.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-consumer-groups.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-stream-consumer.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/redis.test.ts` | unit | integration | Unit test location but uses real dependencies (1 real dep refs) |
| `shared/core/__tests__/unit/swap-event-filter-extended.test.ts` | unit | integration | Unit test location but uses real dependencies (3 real dep refs) |

## Co-located Tests (Outside `__tests__/` directories)

These tests live alongside their source files instead of in dedicated `__tests__/` directories.

| File | Category | Test Count |
|------|----------|------------|
| `services/execution-engine/src/services/simulation/helius-provider.test.ts` | unit | 18 |
| `services/execution-engine/src/strategies/flash-loan-liquidity-validator.test.ts` | unit | 20 |

## Suspicious Patterns

| File | Issue |
|------|-------|
| `services/execution-engine/src/__tests__/unit/execution-flow.test.ts` | Unit test with real dependencies (3 refs) |
| `services/execution-engine/__tests__/unit/services/commit-reveal.service.test.ts` | Unit test with real dependencies (1 refs) |
| `services/mempool-detector/src/__tests__/bloxroute-feed.test.ts` | Unit test with real dependencies (31 refs) |
| `services/partition-asia-fast/src/__tests__/integration/service.integration.test.ts` | Integration test that mocks everything and has no real deps |
| `shared/core/__tests__/integration/worker-pool-load.integration.test.ts` | Integration test that mocks everything and has no real deps |
| `shared/core/__tests__/unit/hierarchical-cache-pricematrix.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/hierarchical-cache.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/predictive-warming.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-basic.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-consumer-groups.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/redis-streams/redis-streams-stream-consumer.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/redis.test.ts` | Unit test with real dependencies (1 refs) |
| `shared/core/__tests__/unit/swap-event-filter-extended.test.ts` | Unit test with real dependencies (3 refs) |

## Unit Tests (201 files)

### `infrastructure/tests/deployment-config.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in infrastructure/tests/
- **TEST COUNT:** 98
- **DESCRIBE STRUCTURE:** Phase 3: Fly.io Deployment Configuration > partition-l2-fast.toml > coordinator-standby.toml > partition-solana.toml > deploy.sh
- **SOURCE MODULE TESTED:** infrastructure deployment configs
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `infrastructure/tests/regression.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in infrastructure/tests/
- **TEST COUNT:** 40
- **DESCRIBE STRUCTURE:** REGRESSION: Terraform Cross-Region Image References > REGRESSION: Docker Health Check Commands > REGRESSION: Environment Variable Naming > REGRESSION: Cloud-Init Docker Ready Wait and Health Check > REGRESSION: Health Check Script /dev/tcp Detection
- **SOURCE MODULE TESTED:** infrastructure deployment configs
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/coordinator/__tests__/unit/alerts/cooldown-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** AlertCooldownManager > without delegate (standalone mode) > createKey > isOnCooldown > recordAlert
- **SOURCE MODULE TESTED:** cooldown-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/coordinator/__tests__/unit/alerts/notifier.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** AlertNotifier > Initialization > Circuit Breaker > Circular Buffer Alert History > Channel Integration
- **SOURCE MODULE TESTED:** notifier
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/coordinator/__tests__/unit/leadership/leadership-election-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** LeadershipElectionService > start > stop > heartbeat > standby mode
- **SOURCE MODULE TESTED:** leadership-election-service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/coordinator/src/__tests__/api.routes.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** Route Factory Functions > createHealthRoutes > createDashboardRoutes > Mock State Provider > Opportunities Sorting Algorithm
- **SOURCE MODULE TESTED:** api.routes
- **MOCK DEPENDENCIES:** @arbitrage/security;@arbitrage/core;express-rate-limit
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/coordinator/src/__tests__/coordinator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 66
- **DESCRIBE STRUCTURE:** Coordinator Configuration > CoordinatorService Health Management > Service Health Tracking > Metrics Aggregation > CoordinatorService Opportunity Management
- **SOURCE MODULE TESTED:** coordinator
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/bridge-cost-estimator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** BridgeCostEstimator > extractTokenAmount > estimateBridgeCost > getDetailedEstimate > edge cases
- **SOURCE MODULE TESTED:** bridge-cost-estimator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/bridge-predictor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 34
- **DESCRIBE STRUCTURE:** BridgeLatencyPredictor > constructor > predictLatency > updateModel > getBridgeMetrics
- **SOURCE MODULE TESTED:** bridge-predictor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 104
- **DESCRIBE STRUCTURE:** Cross-Chain Configuration > Supported Chains > Arbitrage Thresholds > CrossChainDetectorService Logic > Bridge Cost Estimation
- **SOURCE MODULE TESTED:** detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/ml-prediction-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** MLPredictionManager > createMLPredictionManager > initialize > trackPriceUpdate > calculateVolatility
- **SOURCE MODULE TESTED:** ml-prediction-manager
- **MOCK DEPENDENCIES:** @arbitrage/ml
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (6 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/opportunity-publisher.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** OpportunityPublisher > createOpportunityPublisher > publish > deduplication > getCacheSize
- **SOURCE MODULE TESTED:** opportunity-publisher
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/pending-opportunity.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 41
- **DESCRIBE STRUCTURE:** Pending Opportunity Validation > Pending Opportunity Serialization > Chain ID to Name Mapping > Pending Opportunity Handler > Stream Consumer Pending Events
- **SOURCE MODULE TESTED:** pending-opportunity
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/pre-validation-orchestrator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** PreValidationOrchestrator > constructor > validateOpportunity > budget management > getMetrics
- **SOURCE MODULE TESTED:** pre-validation-orchestrator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/price-data-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** PriceDataManager > createPriceDataManager > handlePriceUpdate > createSnapshot > getChains
- **SOURCE MODULE TESTED:** price-data-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/unit/stream-consumer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** StreamConsumer > createStreamConsumer > createConsumerGroups > start > stop
- **SOURCE MODULE TESTED:** stream-consumer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/ab-testing-framework.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** Statistical Analysis > calculateSignificance > calculateRequiredSampleSize > estimateTimeToSignificance > shouldStopEarly
- **SOURCE MODULE TESTED:** ab-testing-framework
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/api/circuit-breaker-api.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** Circuit Breaker API Endpoints > GET /circuit-breaker > POST /circuit-breaker/close > POST /circuit-breaker/open > Error Handling
- **SOURCE MODULE TESTED:** circuit-breaker-api
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/consumers/opportunity.consumer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 79
- **DESCRIBE STRUCTURE:** OpportunityConsumer - Initialization > OpportunityConsumer - Validation > OpportunityConsumer - Backpressure > OpportunityConsumer - Deferred ACK > OpportunityConsumer - Message Handling
- **SOURCE MODULE TESTED:** opportunity.consumer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (27 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/consumers/validation.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 55
- **DESCRIBE STRUCTURE:** validateMessageStructure > empty/null message handling > system message handling > required field validation > opportunity type validation
- **SOURCE MODULE TESTED:** validation
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/engine.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 37
- **DESCRIBE STRUCTURE:** ExecutionEngineService > ExecutionEngineService Production Simulation Guard (FIX-3.1) > Precision Fix Regression Tests > ExecutionEngineService Standby Configuration (ADR-007) > QueueService Pause/Resume (ADR-007)
- **SOURCE MODULE TESTED:** engine
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/initialization/initialization.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** Initialization Module > initializeMevProviders > initializeRiskManagement > initializeBridgeRouter > initializeExecutionEngine (Integration)
- **SOURCE MODULE TESTED:** initialization
- **MOCK DEPENDENCIES:** @arbitrage/config;@arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/risk/risk-management-orchestrator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 13
- **DESCRIBE STRUCTURE:** RiskManagementOrchestrator > factory function > assess() with no risk components > assess() with drawdown breaker > assess() with EV calculator
- **SOURCE MODULE TESTED:** risk-management-orchestrator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/circuit-breaker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 44
- **DESCRIBE STRUCTURE:** CircuitBreaker > constructor and defaults > failure tracking > cooldown period > half-open state
- **SOURCE MODULE TESTED:** services/execution-engine: circuit-breaker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/commit-reveal.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** CommitRevealService - Initialization > CommitRevealService - Commit Phase > CommitRevealService - Reveal Phase > CommitRevealService - Redis Storage > CommitRevealService - In-Memory Storage
- **SOURCE MODULE TESTED:** services/execution-engine: commit-reveal.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** HIGH (8 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `services/execution-engine/__tests__/unit/services/provider.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** ProviderServiceImpl - Initialization > ProviderServiceImpl - Health Monitoring > ProviderServiceImpl - Reconnection Logic > ProviderServiceImpl - Nonce Manager Integration > ProviderServiceImpl - Health Map
- **SOURCE MODULE TESTED:** services/execution-engine: provider.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (9 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/queue.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** QueueService - Basic Operations > QueueService - Capacity > QueueService - Backpressure > QueueService - Manual Pause (Standby) > QueueService - Event Signaling
- **SOURCE MODULE TESTED:** services/execution-engine: queue.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/alchemy-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** AlchemySimulationProvider > constructor > isEnabled > simulate > metrics
- **SOURCE MODULE TESTED:** services/execution-engine: alchemy-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/anvil-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** AnvilForkManager - Unit Tests > constructor > getState > getProvider > getForkInfo
- **SOURCE MODULE TESTED:** services/execution-engine: anvil-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/base-simulation-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 28
- **DESCRIBE STRUCTURE:** BaseSimulationProvider > constructor > initial health state > simulate > metrics
- **SOURCE MODULE TESTED:** services/execution-engine: base-simulation-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/hot-fork-synchronizer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 30
- **DESCRIBE STRUCTURE:** HotForkSynchronizer > constructor > lifecycle > pause/resume > sync behavior
- **SOURCE MODULE TESTED:** services/execution-engine: hot-fork-synchronizer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (9 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/local-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 26
- **DESCRIBE STRUCTURE:** LocalSimulationProvider > constructor > simulate > state overrides > healthCheck
- **SOURCE MODULE TESTED:** services/execution-engine: local-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/pending-state-simulator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** PendingStateSimulator - Unit Tests > V3 multi-hop swap encoding > simulatePendingSwap > simulateBatch
- **SOURCE MODULE TESTED:** services/execution-engine: pending-state-simulator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/simulation-metrics-collector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** SimulationMetricsCollector > initialization > metrics collection > success rate calculation > latency tracking
- **SOURCE MODULE TESTED:** services/execution-engine: simulation-metrics-collector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/simulation.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 39
- **DESCRIBE STRUCTURE:** SimulationService > constructor > simulate > shouldSimulate > provider selection
- **SOURCE MODULE TESTED:** services/execution-engine: simulation.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/tenderly-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** TenderlyProvider > constructor > isEnabled > simulate > metrics
- **SOURCE MODULE TESTED:** services/execution-engine: tenderly-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/services/simulation/types.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** WETH Address Utilities (Fix 6.3) > getSimulationErrorMessage (Fix 6.1) > createCancellableTimeout (Fix 9.1) > updateRollingAverage (Fix 9.2) > CHAIN_IDS
- **SOURCE MODULE TESTED:** services/execution-engine: types
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/base.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** BaseExecutionStrategy - Error Selector Validation (Fix 8.2 & 9.3) > BaseExecutionStrategy - Nonce Management (Fix 4.2) > BaseExecutionStrategy - MEV Eligibility (Fix 6.3 & 9.1) > BaseExecutionStrategy - Gas Price Management > BaseExecutionStrategy - Gas Spike Abort Logic (Fix 8.3)
- **SOURCE MODULE TESTED:** base.strategy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/cross-chain.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** CrossChainStrategy - Chain Validation > CrossChainStrategy - Bridge Router > CrossChainStrategy - Wallet/Provider Validation > CrossChainStrategy - Quote Expiry > CrossChainStrategy - Simulation Integration
- **SOURCE MODULE TESTED:** cross-chain.strategy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (9 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan-batched-quotes.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** FlashLoanStrategy - Batched Quoting Integration > calculateExpectedProfitWithBatching > getBatchQuoterService > buildQuoteRequestsFromOpportunity
- **SOURCE MODULE TESTED:** flash-loan-batched-quotes
- **MOCK DEPENDENCIES:** @arbitrage/config;../../../src/services/simulation/batch-quoter.service
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan-edge-cases.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 9
- **DESCRIBE STRUCTURE:** FlashLoanStrategy - Edge Cases > Edge Case: N-Hop Opportunities with Batched Quoting > Edge Case: Provider Disconnection During Batched Call > Edge Case: Concurrent Cache Access > Edge Case: Resource Cleanup
- **SOURCE MODULE TESTED:** flash-loan-edge-cases
- **MOCK DEPENDENCIES:** @arbitrage/config;../../../src/services/simulation/batch-quoter.service
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/provider-factory.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 26
- **DESCRIBE STRUCTURE:** FlashLoanProviderFactory > constructor > getProvider > isFullySupported > getProtocol
- **SOURCE MODULE TESTED:** provider-factory
- **MOCK DEPENDENCIES:** @arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/syncswap.provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 57
- **DESCRIBE STRUCTURE:** SyncSwapFlashLoanProvider - Constructor and Initialization > constructor > isAvailable > getCapabilities > protocol and chain properties
- **SOURCE MODULE TESTED:** syncswap.provider
- **MOCK DEPENDENCIES:** @arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/unsupported.provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** UnsupportedFlashLoanProvider > isAvailable > getCapabilities > calculateFee > validate
- **SOURCE MODULE TESTED:** unsupported.provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/flash-loan.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 60
- **DESCRIBE STRUCTURE:** FlashLoanStrategy > constructor > calculateFlashLoanFee > analyzeProfitability > buildSwapSteps
- **SOURCE MODULE TESTED:** flash-loan.strategy
- **MOCK DEPENDENCIES:** @arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/intra-chain.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** IntraChainStrategy - Simulation Integration > shouldSimulate decision > simulation result handling > execution without simulation service > metrics tracking
- **SOURCE MODULE TESTED:** intra-chain.strategy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/simulation.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** SimulationStrategy > constructor > execute > successful execution > failed execution
- **SOURCE MODULE TESTED:** simulation.strategy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/__tests__/unit/strategies/strategy-factory.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 38
- **DESCRIBE STRUCTURE:** ExecutionStrategyFactory - Creation > ExecutionStrategyFactory - Registration > ExecutionStrategyFactory - Resolution > with simulation mode disabled > with simulation mode enabled
- **SOURCE MODULE TESTED:** strategy-factory
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (8 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/__tests__/unit/cross-chain-execution.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 30
- **DESCRIBE STRUCTURE:** Cross-Chain Execution Unit Tests > Bridge Router Initialization > Route Validation > Quote Generation > Bridge Status Tracking
- **SOURCE MODULE TESTED:** cross-chain-execution
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/__tests__/unit/execution-flow.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** Execution Flow Unit Tests > Execution Engine Simulation Mode > Complete Data Flow > Execution Result Publishing > Coordinator Integration
- **SOURCE MODULE TESTED:** execution-flow
- **MOCK DEPENDENCIES:** ioredis;@arbitrage/core
- **REAL DEPENDENCIES:** Yes (3 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (3 real dep refs)

### `services/execution-engine/src/services/__tests__/unit/dex-lookup.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** DexLookupService > initialization > getRouterAddress > getDexByName > findDexByRouter
- **SOURCE MODULE TESTED:** services/execution-engine: dex-lookup.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/services/__tests__/unit/swap-builder.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 6
- **DESCRIBE STRUCTURE:** SwapBuilder > initialization > buildSwapSteps > caching
- **SOURCE MODULE TESTED:** services/execution-engine: swap-builder.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/services/simulation/helius-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Co-located test file
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** HeliusSimulationProvider > constructor > simulate > healthCheck > rate limiting
- **SOURCE MODULE TESTED:** services/execution-engine: helius-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/strategies/flash-loan-liquidity-validator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Co-located test file
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** FlashLoanLiquidityValidator > Constructor > checkLiquidity > estimateLiquidityScore > getCachedLiquidity
- **SOURCE MODULE TESTED:** flash-loan-liquidity-validator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/mempool-detector/src/__tests__/bloxroute-feed.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** BloXrouteFeed > createBloXrouteFeed > connect > disconnect > subscribePendingTxs
- **SOURCE MODULE TESTED:** bloxroute-feed
- **MOCK DEPENDENCIES:** ws
- **REAL DEPENDENCIES:** Yes (31 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/mempool-detector/src/__tests__/decoders.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 90
- **DESCRIBE STRUCTURE:** UniswapV2Decoder > canDecode > decode > supportedChains > UniswapV3Decoder
- **SOURCE MODULE TESTED:** decoders
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (8 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/mempool-detector/src/__tests__/mempool-detector-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** MempoolDetectorService > Module Exports > Service Creation > Service Lifecycle > Health Reporting
- **SOURCE MODULE TESTED:** mempool-detector-service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/partition-asia-fast/src/__tests__/unit/partition-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 32
- **DESCRIBE STRUCTURE:** P1 Asia-Fast Partition Service > Module Exports > Configuration > Initialization > JEST_WORKER_ID Guard
- **SOURCE MODULE TESTED:** partition-service
- **MOCK DEPENDENCIES:** @arbitrage/core;@arbitrage/config;@arbitrage/unified-detector
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/partition-high-value/src/__tests__/unit/partition-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 39
- **DESCRIBE STRUCTURE:** P3 High-Value Partition Service > Module Exports > Configuration > Initialization > JEST_WORKER_ID Guard
- **SOURCE MODULE TESTED:** partition-service
- **MOCK DEPENDENCIES:** @arbitrage/core;@arbitrage/config;@arbitrage/unified-detector
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/partition-l2-turbo/src/__tests__/unit/partition-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 26
- **DESCRIBE STRUCTURE:** P2 L2-Turbo Partition Service > Module Exports > Configuration > Initialization > JEST_WORKER_ID Guard
- **SOURCE MODULE TESTED:** partition-service
- **MOCK DEPENDENCIES:** @arbitrage/core;@arbitrage/config;@arbitrage/unified-detector
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/partition-solana/src/__tests__/arbitrage-detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 86
- **DESCRIBE STRUCTURE:** SolanaArbitrageDetector > constructor > lifecycle > pool management > intra-Solana arbitrage detection
- **SOURCE MODULE TESTED:** arbitrage-detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/unit/chain-instance.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 49
- **DESCRIBE STRUCTURE:** ChainDetectorInstance Bug Fixes > Bug 1: Same-DEX Check > Bug 2: Reverse Token Order Price Adjustment > Inconsistency 1: Config-Based Profit Threshold > Fee-Adjusted Profit Calculation
- **SOURCE MODULE TESTED:** chain-instance
- **MOCK DEPENDENCIES:** @arbitrage/config;@arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/p1-7-fix-verification.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** P1-7 Fix Verification - Concurrent Warming Race Condition
- **SOURCE MODULE TESTED:** p1-7-fix-verification
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/chain-instance-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** ChainInstanceManager > createChainInstanceManager > startAll > stop > getHealthyChains
- **SOURCE MODULE TESTED:** chain-instance-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/chain-simulation-handler.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** ChainSimulationHandler > constructor > initializeEvmSimulation > initializeNonEvmSimulation > stop
- **SOURCE MODULE TESTED:** chain-simulation-handler
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/health-reporter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** HealthReporter > createHealthReporter > start > stop > publishHealth
- **SOURCE MODULE TESTED:** health-reporter
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/metrics-collector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** MetricsCollector > createMetricsCollector > start > stop > state-aware collection
- **SOURCE MODULE TESTED:** metrics-collector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/opportunity-publisher.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** OpportunityPublisher > constructor > publish > getStats > resetStats
- **SOURCE MODULE TESTED:** opportunity-publisher
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/simple-arbitrage-detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** SimpleArbitrageDetector > Constructor > calculateArbitrage > Price Validation (FIX 4.1) > Fee Handling
- **SOURCE MODULE TESTED:** simple-arbitrage-detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/snapshot-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 31
- **DESCRIBE STRUCTURE:** SnapshotManager > Constructor and Factory > createPairSnapshot > createPairsSnapshot (batch with caching) > Cache Invalidation
- **SOURCE MODULE TESTED:** snapshot-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/subscription-migration.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 32
- **DESCRIBE STRUCTURE:** Task 2.1.3: Subscription Migration > Config Flag: useFactorySubscriptions > Gradual Rollout > Subscription Count Monitoring > Legacy Mode (Backward Compatibility)
- **SOURCE MODULE TESTED:** subscription-migration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/types-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 34
- **DESCRIBE STRUCTURE:** parseIntEnvVar > parseFloatEnvVar > toWebSocketUrl > isUnstableChain
- **SOURCE MODULE TESTED:** types-utils
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/unified-detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** UnifiedChainDetector > constructor > start > stop > getStats
- **SOURCE MODULE TESTED:** unified-detector
- **MOCK DEPENDENCIES:** @arbitrage/core;@arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/unit/whale-alert-publisher.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** WhaleAlertPublisher > constructor > publishWhaleAlert > publishSwapEvent > estimateUsdValue
- **SOURCE MODULE TESTED:** whale-alert-publisher
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/chains/chain-url-builder.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** ChainUrlBuilder > buildChainUrls > buildChainUrlsWithApiKeys > buildSolanaUrls > mainnet
- **SOURCE MODULE TESTED:** chain-url-builder
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/config-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 33
- **DESCRIBE STRUCTURE:** ConfigManager > singleton pattern > REDIS_URL validation > PARTITION_ID validation > SOLANA_RPC_URL conditional validation
- **SOURCE MODULE TESTED:** config-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (10 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/config-modules.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 97
- **DESCRIBE STRUCTURE:** Cross-Chain Module > CROSS_CHAIN_TOKEN_ALIASES > normalizeTokenForCrossChain > findCommonTokensBetweenChains > preWarmCommonTokensCache
- **SOURCE MODULE TESTED:** config-modules
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/cross-chain.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 30
- **DESCRIBE STRUCTURE:** Cross-Chain Token Normalization > CROSS_CHAIN_TOKEN_ALIASES > normalizeTokenForCrossChain > findCommonTokensBetweenChains > preWarmCommonTokensCache
- **SOURCE MODULE TESTED:** cross-chain
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/dex-expansion.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** S2.2.1: Arbitrum DEX Expansion (6 â†’ 9) > DEX Count > Existing DEXs (6) > New DEXs (3) > Balancer V2
- **SOURCE MODULE TESTED:** dex-expansion
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/dex-factories.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 45
- **DESCRIBE STRUCTURE:** DEX Factory Registry > Registry Structure > Factory Type Classification > Factory ABIs > Helper Functions
- **SOURCE MODULE TESTED:** dex-factories
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/partitions.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 59
- **DESCRIBE STRUCTURE:** PartitionConfig > PARTITIONS constant > FUTURE_PARTITIONS constant > assignChainToPartition > isEvmChain
- **SOURCE MODULE TESTED:** partitions
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/__tests__/unit/websocket-resilience.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** WebSocket Resilience Configuration (S3.3) > Fallback URL Coverage > URL Format Validation > Provider Diversity > Chain-Specific Configuration
- **SOURCE MODULE TESTED:** websocket-resilience
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/src/__tests__/unit/addresses.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 50
- **DESCRIBE STRUCTURE:** Address Constants > AAVE_V3_POOLS > NATIVE_TOKENS > STABLECOINS > SOLANA_PROGRAMS
- **SOURCE MODULE TESTED:** addresses
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/src/__tests__/unit/mev-config.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** MEV Configuration > MEV_CONFIG > MEV_PRIORITY_FEE_SUMMARY > getMevChainConfigForValidation > Global MEV Config Defaults
- **SOURCE MODULE TESTED:** mev-config
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/src/__tests__/unit/risk-config.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 5
- **DESCRIBE STRUCTURE:** Risk Configuration > Validation > Configuration Getters
- **SOURCE MODULE TESTED:** risk-config
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/src/__tests__/unit/schemas.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 51
- **DESCRIBE STRUCTURE:** Primitive Schemas > EthereumAddressSchema > SolanaAddressSchema > BasisPointsSchema > ChainSchema
- **SOURCE MODULE TESTED:** schemas
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/config/src/__tests__/unit/thresholds.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 6
- **DESCRIBE STRUCTURE:** Thresholds Configuration > getMinProfitThreshold > Performance Thresholds
- **SOURCE MODULE TESTED:** thresholds
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/constants/__tests__/unit/config-consistency.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 28
- **DESCRIBE STRUCTURE:** Configuration Consistency - Service Ports > JSON config structure > partition-router.ts consistency > port assignment rules (ADR-003) > Configuration Consistency - Deprecation Patterns
- **SOURCE MODULE TESTED:** config-consistency
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/adr-002-compliance.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 6
- **DESCRIBE STRUCTURE:** ADR-002 Compliance: Redis Streams Required > Base Detector - Removed (Legacy Pub/Sub Eliminated) > ADR-002: Message Flow Architecture > P0 Implementation Checklist
- **SOURCE MODULE TESTED:** adr-002-compliance
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/adr-003-compliance.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 12
- **DESCRIBE STRUCTURE:** ADR-003: Partitioned Chain Detectors Compliance > Single-Chain Service Removal > Unified Detector Requirements > Free Tier Compatibility > Resource Sharing
- **SOURCE MODULE TESTED:** adr-003-compliance
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/async-mutex.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** AsyncMutex > basic functionality > tryAcquire > runExclusive > tryRunExclusive
- **SOURCE MODULE TESTED:** async-mutex
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/async-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 38
- **DESCRIBE STRUCTURE:** Timeout Utilities > withTimeout() > withTimeoutDefault() > withTimeoutSafe() > Retry Utilities
- **SOURCE MODULE TESTED:** async-utils
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/batch-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** BatchProvider > initialization > request queueing > auto-flush behavior > error handling
- **SOURCE MODULE TESTED:** batch-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/bigint-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 28
- **DESCRIBE STRUCTURE:** safeBigIntToDecimal > Basic Conversions > Precision Handling > Edge Cases > Real-World Token Amounts
- **SOURCE MODULE TESTED:** bigint-utils
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/bridge-router.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 34
- **DESCRIBE STRUCTURE:** StargateRouter > isRouteSupported > getEstimatedTime > quote > execute
- **SOURCE MODULE TESTED:** bridge-router
- **MOCK DEPENDENCIES:** ../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/chain-simulator-multi-hop.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** ChainSimulator - Multi-Hop Opportunities > Triangular Opportunities (3-hop) > Quadrilateral Opportunities (4-hop) > Multi-Hop Confidence > Multi-Hop Expiry
- **SOURCE MODULE TESTED:** chain-simulator-multi-hop
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/components/arbitrage-detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** ArbitrageDetector > detectArbitrage > isReverseTokenOrder > normalizeTokenOrder > adjustPriceForTokenOrder
- **SOURCE MODULE TESTED:** arbitrage-detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/components/pair-repository.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** PairRepository > Core CRUD Operations > set / get > getByAddress > getByTokens
- **SOURCE MODULE TESTED:** pair-repository
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/components/price-calculator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 56
- **DESCRIBE STRUCTURE:** PriceCalculator > calculatePriceFromReserves > safeBigIntDivision > invertPrice > calculateSpread
- **SOURCE MODULE TESTED:** price-calculator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/components/token-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** TokenUtils > normalizeAddress > addressEquals > isValidAddress > isSolanaAddress
- **SOURCE MODULE TESTED:** token-utils
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/correlation-analyzer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** CorrelationAnalyzer > Construction > Recording Price Updates > Co-occurrence Tracking > Correlation Scoring
- **SOURCE MODULE TESTED:** correlation-analyzer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/cross-chain-alignment.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** Cross-Chain Detector Architecture Alignment
- **SOURCE MODULE TESTED:** cross-chain-alignment
- **MOCK DEPENDENCIES:** ../../src/redis;../../src/redis-streams;../../src/logger;../../src/analytics/price-oracle
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/cross-chain-simulator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** CrossChainSimulator > Initialization > Cross-Chain Opportunity Detection > Bridge Protocol Selection > Gas Cost Estimation
- **SOURCE MODULE TESTED:** cross-chain-simulator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/cross-region-health.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 31
- **DESCRIBE STRUCTURE:** CrossRegionHealthManager > constructor > lifecycle > leader election > health monitoring
- **SOURCE MODULE TESTED:** cross-region-health
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/data-structures/lru-cache.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** LRUCache > constructor > set and get > LRU eviction > peek() - read without LRU update
- **SOURCE MODULE TESTED:** lru-cache
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/detector/detector-integration.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** Detector Integration > Component Initialization > Health Monitoring Integration > Factory Integration > Event Processing Integration
- **SOURCE MODULE TESTED:** detector-integration
- **MOCK DEPENDENCIES:** ../../../src/redis;../../../src/redis-streams;../../../src/websocket-manager;../../../src/factory-subscription;@arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/detector/event-processor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** EventProcessor > decodeSyncEventData > decodeSwapEventData > parseBlockNumber > buildExtendedPair
- **SOURCE MODULE TESTED:** event-processor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/detector/factory-integration.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 45
- **DESCRIBE STRUCTURE:** FactoryIntegrationService > constructor > createFactoryIntegrationService > initialize > WebSocket adapter
- **SOURCE MODULE TESTED:** factory-integration
- **MOCK DEPENDENCIES:** ../../../src/factory-subscription;@arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/detector/health-monitor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 26
- **DESCRIBE STRUCTURE:** DetectorHealthMonitor > Lifecycle > start() > stop() > isActive()
- **SOURCE MODULE TESTED:** health-monitor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/dex-adapters/adapter-registry.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** AdapterRegistry > register() > getAdapter() > getAdapterForDex() > listAdapters()
- **SOURCE MODULE TESTED:** adapter-registry
- **MOCK DEPENDENCIES:** ../../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/dex-adapters/balancer-v2-adapter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** BalancerV2Adapter > constructor > initialize() > discoverPools() > getPoolReserves()
- **SOURCE MODULE TESTED:** balancer-v2-adapter
- **MOCK DEPENDENCIES:** ../../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/dex-adapters/dex-adapters-extended.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 39
- **DESCRIBE STRUCTURE:** Phase 1.1: Vault-Model DEXes Configuration > All vault-model DEXes should now be ENABLED > Enabled DEX counts after adapter implementation > Phase 1.2: Balancer V2 Adapter Unit Tests > Adapter instantiation
- **SOURCE MODULE TESTED:** dex-adapters-extended
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (6 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/dex-adapters/gmx-adapter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** GmxAdapter > constructor > initialize() > discoverPools() > getPoolReserves()
- **SOURCE MODULE TESTED:** gmx-adapter
- **MOCK DEPENDENCIES:** ../../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/dex-adapters/platypus-adapter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** PlatypusAdapter > constructor > initialize() > discoverPools() > getPoolReserves()
- **SOURCE MODULE TESTED:** platypus-adapter
- **MOCK DEPENDENCIES:** ../../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/distributed-lock.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 38
- **DESCRIBE STRUCTURE:** DistributedLockManager > basic lock operations > retry behavior > lock extension > withLock
- **SOURCE MODULE TESTED:** distributed-lock
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/error-handling.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** ArbitrageError > ConnectionError > ValidationError > LifecycleError > ExecutionError
- **SOURCE MODULE TESTED:** error-handling
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/expert-self-healing.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** ExpertSelfHealingManager > initialization > failure reporting and assessment > recovery strategy selection > recovery action execution
- **SOURCE MODULE TESTED:** expert-self-healing
- **MOCK DEPENDENCIES:** ../../src/redis;../../src/redis-streams;../../src/resilience/circuit-breaker;../../src/resilience/dead-letter-queue;../../src/monitoring/enhanced-health-monitor;../../src/resilience/error-recovery
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/factory-subscription.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 63
- **DESCRIBE STRUCTURE:** FactoryEventSignatures > getFactoryEventSignature > parseV2PairCreatedEvent > parseV3PoolCreatedEvent > parseSolidlyPairCreatedEvent
- **SOURCE MODULE TESTED:** factory-subscription
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/fee-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** Fee Utilities > Constants > bpsToDecimal > decimalToBps > v3TierToDecimal
- **SOURCE MODULE TESTED:** fee-utils
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/fixes-regression.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 63
- **DESCRIBE STRUCTURE:** P0-1: Atomic Pair Updates > P0-5: Singleton Error Recovery > P0-6: Publish with Retry > P1-2: Backpressure Logic > P1-3: Stream MAXLEN Support
- **SOURCE MODULE TESTED:** fixes-regression
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/gas-price-cache.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 31
- **DESCRIBE STRUCTURE:** GasPriceCache > Initialization > getGasPrice > getNativeTokenPrice > estimateGasCostUsd
- **SOURCE MODULE TESTED:** gas-price-cache
- **MOCK DEPENDENCIES:** ../../src/logger;ethers;@arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/generators/simulated-price.generator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** SimulatedPriceGenerator > generatePriceSequence > generateMultiDexPrices > generateMultiDexSnapshots > generateWhaleSpike
- **SOURCE MODULE TESTED:** simulated-price.generator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/graceful-degradation.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** GracefulDegradationManager > constructor > registerDegradationLevels > registerCapabilities > triggerDegradation
- **SOURCE MODULE TESTED:** graceful-degradation
- **MOCK DEPENDENCIES:** ../../src/redis;../../src/redis-streams;../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/hierarchical-cache-pricematrix.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** HierarchicalCache with PriceMatrix > PHASE1-TASK34: Basic PriceMatrix operations > PHASE1-TASK34: L1 hit rate > PHASE1-TASK34: Cache invalidation > PHASE1-TASK34: Statistics and monitoring
- **SOURCE MODULE TESTED:** hierarchical-cache-pricematrix
- **MOCK DEPENDENCIES:** ../../src/logger;../../src/redis;../../src/caching/correlation-analyzer
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/hierarchical-cache.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** HierarchicalCache > basic operations > L1 Cache (Memory) > L2 Cache (Redis) > L3 Cache (Persistent)
- **SOURCE MODULE TESTED:** hierarchical-cache
- **MOCK DEPENDENCIES:** ../../src/logger;../../src/redis
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/jito-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 33
- **DESCRIBE STRUCTURE:** JitoProvider > constructor > isEnabled > getMetrics > resetMetrics
- **SOURCE MODULE TESTED:** jito-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/logging.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** Logging Module > createPinoLogger > getLogger > RecordingLogger > NullLogger
- **SOURCE MODULE TESTED:** logging
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/message-validators.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 58
- **DESCRIBE STRUCTURE:** validatePriceUpdate() > validateWhaleTransaction() > validateSwapEvent() > validateReserveUpdate() > validateCoordinatorCommand()
- **SOURCE MODULE TESTED:** message-validators
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/metrics-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 31
- **DESCRIBE STRUCTURE:** MevMetricsManager > constructor > getMetrics > resetMetrics > increment
- **SOURCE MODULE TESTED:** metrics-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/mev-protection-providers.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** Phase 1: Precision Fixes > BigInt Conversion Precision > Fallback Price Validation > MEV Protection Unit Tests > Nonce Management Architecture
- **SOURCE MODULE TESTED:** mev-protection-providers
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/mev-protection.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 48
- **DESCRIBE STRUCTURE:** MEV Protection > CHAIN_MEV_STRATEGIES > Helper Functions > hasMevProtection > getRecommendedPriorityFee
- **SOURCE MODULE TESTED:** mev-protection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/mev-protection/adaptive-threshold.service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** AdaptiveThresholdService > Configuration > recordAttack > getAdjustment > getAllAdjustments
- **SOURCE MODULE TESTED:** adaptive-threshold.service
- **MOCK DEPENDENCIES:** ../../../src/logger;../../../src/redis
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/mev-risk-analyzer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 37
- **DESCRIBE STRUCTURE:** MevRiskAnalyzer > Configuration > Sandwich Vulnerability Analysis > Risk Level Classification > Risk Factors
- **SOURCE MODULE TESTED:** mev-risk-analyzer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/mev-share-provider.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** MevShareProvider > Configuration > calculateHints > sendProtectedTransaction > Metrics Tracking
- **SOURCE MODULE TESTED:** mev-share-provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/multi-leg-worker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** Multi-Leg Path Finding Worker Integration > Task Type Registration > Result Parity > Task Data Serialization > Task Priority
- **SOURCE MODULE TESTED:** multi-leg-worker
- **MOCK DEPENDENCIES:** ../../src/logger;worker_threads
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/nonce-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 33
- **DESCRIBE STRUCTURE:** P0-2: NonceManager > Basic Nonce Allocation > Transaction Confirmation > Transaction Failure > Concurrent Nonce Allocation (P0-2 Critical)
- **SOURCE MODULE TESTED:** nonce-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/operation-guard.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** OperationGuard > skip-if-busy pattern > rate limiting pattern > forceRelease > tryWithGuard helper
- **SOURCE MODULE TESTED:** operation-guard
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/pair-activity-tracker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** PairActivityTracker > recordUpdate > isHotPair > getHotPairs > getTopActivePairs
- **SOURCE MODULE TESTED:** pair-activity-tracker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/pair-discovery.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 44
- **DESCRIBE STRUCTURE:** PairDiscoveryService > detectFactoryType() > sortTokens() > computePairAddress() > V3 Fee Tier Capture
- **SOURCE MODULE TESTED:** pair-discovery
- **MOCK DEPENDENCIES:** ../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/partition-router.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 60
- **DESCRIBE STRUCTURE:** Partition Router Constants > PARTITION_PORTS > PARTITION_SERVICE_NAMES > PartitionRouter > getPartitionForChain
- **SOURCE MODULE TESTED:** partition-router
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/partition-service-utils.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 52
- **DESCRIBE STRUCTURE:** Partition Service Utilities > parsePort > validateAndFilterChains > createPartitionHealthServer > setupDetectorEventHandlers
- **SOURCE MODULE TESTED:** partition-service-utils
- **MOCK DEPENDENCIES:** @arbitrage/config
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/performance-monitor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** HotPathMonitor > singleton pattern > recordLatency > getStats > measureHotPath
- **SOURCE MODULE TESTED:** performance-monitor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/predictive-warming.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 26
- **DESCRIBE STRUCTURE:** Predictive Cache Warming (Task 2.2.2) > Configuration > Cache Update Triggers > Warming Logic > Statistics
- **SOURCE MODULE TESTED:** predictive-warming
- **MOCK DEPENDENCIES:** ../../src/logger;../../src/redis;../../src/caching/correlation-analyzer
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/price-calculator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 49
- **DESCRIBE STRUCTURE:** P0-1: BigInt Precision (safeBigIntDivision) > P0-1: calculatePriceFromBigIntReserves() > Price Calculation Utilities > calculatePriceFromReserves() > invertPrice()
- **SOURCE MODULE TESTED:** price-calculator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/price-matrix.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 60
- **DESCRIBE STRUCTURE:** PriceMatrix > S1.3.1: SharedArrayBuffer Storage > S1.3.2: Atomic Operations > S1.3.3: Price Index Mapper > Price Operations
- **SOURCE MODULE TESTED:** price-matrix
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/price-oracle.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 56
- **DESCRIBE STRUCTURE:** PriceOracle > default fallback prices > hasDefaultPrice > getPrice > getPrices
- **SOURCE MODULE TESTED:** price-oracle
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/pricematrix-uninitialized-read.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 8
- **DESCRIBE STRUCTURE:** PriceMatrix: Uninitialized Read Prevention (P1 Fix) > Write-before-register ordering > Timestamp validation for workers > Performance with write ordering
- **SOURCE MODULE TESTED:** pricematrix-uninitialized-read
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/professional-quality-monitor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** ProfessionalQualityMonitor > Detection Result Recording > Quality Score Calculation > Performance Metrics > Score Grading System
- **SOURCE MODULE TESTED:** professional-quality-monitor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/professional-quality.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 9
- **DESCRIBE STRUCTURE:** ProfessionalQualityMonitor Unit Tests > End-to-End Quality Scoring Flow > Feature Impact Assessment > Data Persistence > Error Resilience
- **SOURCE MODULE TESTED:** professional-quality
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/provider-health-scorer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 48
- **DESCRIBE STRUCTURE:** ProviderHealthScorer > Basic Operations > Health Scoring > Provider Selection > Health Check
- **SOURCE MODULE TESTED:** provider-health-scorer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/redis-streams/redis-streams-basic.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** RedisStreamsClient - Basic Operations > XADD - Adding messages to stream > XREAD - Reading from stream > Stream Information > Stream Trimming
- **SOURCE MODULE TESTED:** redis-streams-basic
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/redis-streams/redis-streams-consumer-groups.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** RedisStreamsClient - Consumer Groups > Consumer Groups > XREADGROUP - Consumer group reads > XACK - Acknowledging messages > Batching
- **SOURCE MODULE TESTED:** redis-streams-consumer-groups
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/redis-streams/redis-streams-stream-consumer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** StreamConsumer > Lifecycle > Message Processing > Statistics > Backpressure (Pause/Resume)
- **SOURCE MODULE TESTED:** redis-streams-stream-consumer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/redis.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 32
- **DESCRIBE STRUCTURE:** RedisClient > initialization > singleton behavior > publish/subscribe > caching operations
- **SOURCE MODULE TESTED:** redis
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (1 real dep refs)

### `shared/core/__tests__/unit/regression.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** Singleton Race Condition Regression Tests > DistributedLockManager singleton > PriceOracle singleton > Service State Event Emission Regression Tests > Redis Subscription Memory Leak Regression Tests
- **SOURCE MODULE TESTED:** regression
- **MOCK DEPENDENCIES:** ../../src/redis;../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (6 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/reserve-cache.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** ReserveCache > Basic Operations > TTL Expiration > LRU Eviction > Sync vs RPC Priority
- **SOURCE MODULE TESTED:** reserve-cache
- **MOCK DEPENDENCIES:** ../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/risk/drawdown-circuit-breaker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 75
- **DESCRIBE STRUCTURE:** DrawdownCircuitBreaker > constructor > NORMAL state > NORMAL -> CAUTION transition > CAUTION -> HALT transition
- **SOURCE MODULE TESTED:** drawdown-circuit-breaker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/risk/ev-calculator.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** EVCalculator > constructor > calculate > basic EV formula > default probability handling
- **SOURCE MODULE TESTED:** ev-calculator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (8 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/risk/execution-probability-tracker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 51
- **DESCRIBE STRUCTURE:** ExecutionProbabilityTracker > constructor > recordOutcome > getWinProbability > getAverageProfit
- **SOURCE MODULE TESTED:** execution-probability-tracker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/risk/position-sizer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 44
- **DESCRIBE STRUCTURE:** KellyPositionSizer > constructor > Kelly formula calculation > position size calculation > edge cases
- **SOURCE MODULE TESTED:** position-sizer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/service-registry.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 29
- **DESCRIBE STRUCTURE:** ServiceRegistry > register > has and isInitialized > get > reset
- **SOURCE MODULE TESTED:** service-registry
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/service-state.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** ServiceStateManager > initial state > valid state transitions > invalid state transitions > event emission
- **SOURCE MODULE TESTED:** service-state
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/shared-key-registry-concurrency.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** SharedKeyRegistry: Concurrent Registration (P0 Fix) > Race condition prevention > Key size validation > Thread-safety verification
- **SOURCE MODULE TESTED:** shared-key-registry-concurrency
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/stream-health-monitor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** StreamHealthMonitor > Stream Health Check > Stream Lag Monitoring > Stream Metrics > Alerting
- **SOURCE MODULE TESTED:** stream-health-monitor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/swap-event-filter-extended.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 40
- **DESCRIBE STRUCTURE:** S1.2 Smart Swap Event Filter Extended Unit Tests > S1.2.1: SwapEventFilter Core Functionality > Edge Filter - Zero Amount Detection > Value Filter - Minimum USD Threshold > Dedup Filter - Duplicate Detection
- **SOURCE MODULE TESTED:** swap-event-filter-extended
- **MOCK DEPENDENCIES:** ioredis
- **REAL DEPENDENCIES:** Yes (3 refs)
- **SETUP COMPLEXITY:** HIGH (10 beforeEach blocks)
- **PLACEMENT:** MISPLACED - Unit test location but uses real dependencies (3 real dep refs)

### `shared/core/__tests__/unit/swap-event-filter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 39
- **DESCRIBE STRUCTURE:** SwapEventFilter > Constructor and Configuration > Edge Filter (Dust Filter) > Deduplication Filter > Whale Detection
- **SOURCE MODULE TESTED:** swap-event-filter
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/tier1-optimizations.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 33
- **DESCRIBE STRUCTURE:** T1.4: O(1) LRU Queue > Basic Operations > LRU Eviction > O(1) Performance Verification > Edge Cases
- **SOURCE MODULE TESTED:** tier1-optimizations
- **MOCK DEPENDENCIES:** ../../src/logger;../../src/monitoring/provider-health-scorer
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/tier2-optimizations.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 101
- **DESCRIBE STRUCTURE:** T2.9: Dynamic Fallback Prices > Last Known Good Price Tracking > Bulk Fallback Price Updates > Price Staleness Metrics > Integration with Existing Price Oracle
- **SOURCE MODULE TESTED:** tier2-optimizations
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/tier3-advanced.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 54
- **DESCRIBE STRUCTURE:** T3.12: Whale Activity Detection > Transaction Recording > Pattern Detection > Signal Generation > Activity Summary
- **SOURCE MODULE TESTED:** tier3-advanced
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/tier3-optimizations.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** T3.11: Multi-Leg Path Finding (5+ tokens) > Path Discovery > Profit Calculation > Performance Constraints > Confidence and Ranking
- **SOURCE MODULE TESTED:** tier3-optimizations
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/websocket-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 73
- **DESCRIBE STRUCTURE:** WebSocketManager > Fallback URL Configuration (S2.1.4) > getCurrentUrl() > getConnectionStats() > Configuration Defaults
- **SOURCE MODULE TESTED:** websocket-manager
- **MOCK DEPENDENCIES:** ws
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/worker-pool.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** EventProcessingWorkerPool > initialization > task submission > pool management > worker lifecycle
- **SOURCE MODULE TESTED:** worker-pool
- **MOCK DEPENDENCIES:** ../../src/logger;worker_threads
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/worker-pricematrix-init.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** PHASE3-TASK42: PriceMatrix.fromSharedBuffer() > Static factory method > Zero-copy performance > Thread-safety > Integration readiness
- **SOURCE MODULE TESTED:** worker-pricematrix-init
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/unit/worker-sharedbuffer.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** PHASE3-TASK41: Worker Thread SharedArrayBuffer Access > EventProcessingWorkerPool with SharedArrayBuffer > HierarchicalCache getSharedBuffer() > SharedArrayBuffer size calculations > Data integrity across threads
- **SOURCE MODULE TESTED:** worker-sharedbuffer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/__tests__/unit/interval-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** IntervalManager > set > clear > clearAll > has
- **SOURCE MODULE TESTED:** interval-manager
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/circuit-breaker/__tests__/simple-circuit-breaker.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** SimpleCircuitBreaker > constructor > isCurrentlyOpen > recordFailure > recordSuccess
- **SOURCE MODULE TESTED:** simple-circuit-breaker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/detector/__tests__/detector-connection-manager.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 8
- **DESCRIBE STRUCTURE:** DetectorConnectionManager > initializeDetectorConnections > disconnectDetectorConnections
- **SOURCE MODULE TESTED:** detector-connection-manager
- **MOCK DEPENDENCIES:** ../../redis;../../redis-streams;../../analytics/swap-event-filter
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/detector/__tests__/event-processor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** EventProcessor > decodeSyncEventData > decodeSwapEventData > parseBlockNumber > buildExtendedPair
- **SOURCE MODULE TESTED:** event-processor
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/detector/__tests__/pair-initialization-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** PairInitializationService > initializePairs > resolvePairAddress > createTokenPairKey > buildFullPairKey
- **SOURCE MODULE TESTED:** pair-initialization-service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/flash-loan-aggregation/domain/__tests__/unit/models.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 45
- **DESCRIBE STRUCTURE:** ProviderScore > constructor > fromComponents > explain > LiquidityCheck
- **SOURCE MODULE TESTED:** models
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/flash-loan-aggregation/infrastructure/__tests__/unit/inmemory-aggregator.metrics.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** InMemoryAggregatorMetrics > recordSelection > recordOutcome > getReliabilityScore > getProviderHealth
- **SOURCE MODULE TESTED:** inmemory-aggregator.metrics
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/flash-loan-aggregation/infrastructure/__tests__/unit/weighted-ranking.strategy.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** WeightedRankingStrategy > rankProviders > calculateFeeScore > calculateLiquidityScore > calculateReliabilityScore
- **SOURCE MODULE TESTED:** weighted-ranking.strategy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/publishing/__tests__/publishing-service.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** PublishingService > initialization > publishPriceUpdate > publishSwapEvent > publishArbitrageOpportunity
- **SOURCE MODULE TESTED:** publishing-service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (6 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/solana/__tests__/solana-detector.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 61
- **DESCRIBE STRUCTURE:** S3.3.1.1 - SolanaDetector Constructor > S3.3.1.2 - Connection Pool Management > S3.3.1.3 - Program Account Subscriptions > S3.3.1.4 - Lifecycle Management > S3.3.1.5 - Health Monitoring
- **SOURCE MODULE TESTED:** solana-detector
- **MOCK DEPENDENCIES:** @solana/web3.js;../../redis;../../redis-streams
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (11 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/warming/container/__tests__/factory-functions.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** Factory Functions Tests > createTopNWarming() > createAdaptiveWarming() > createTestWarming() > Factory Function Comparison
- **SOURCE MODULE TESTED:** factory-functions
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/warming/container/__tests__/performance.benchmark.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** Performance Benchmark Tests > Container Creation Benchmarks > Correlation Tracking Benchmarks > Warming Operation Benchmarks > Strategy Performance Benchmarks
- **SOURCE MODULE TESTED:** performance.benchmark
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/warming/container/__tests__/warming.container.unit.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** WarmingContainer - Unit Tests > Container Creation > Component Building > Strategy Creation > Configuration Updates
- **SOURCE MODULE TESTED:** warming.container.unit
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/warming/infrastructure/__tests__/p1-5-fix-verification.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/ directory (inferred unit)
- **TEST COUNT:** 3
- **DESCRIBE STRUCTURE:** P1-5 Fix Verification - Double Fetch Eliminated
- **SOURCE MODULE TESTED:** p1-5-fix-verification
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/direction-types.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 40
- **DESCRIBE STRUCTURE:** direction-types > DirectionMapper > getInstance > priceToMarket > marketToPrice
- **SOURCE MODULE TESTED:** direction-types
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/feature-math.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 56
- **DESCRIBE STRUCTURE:** feature-math > Statistical Functions > calculateSMA > calculateMean > calculateVariance
- **SOURCE MODULE TESTED:** feature-math
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/model-persistence.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** model-persistence > ModelPersistence class > constructor > saveModel > loadModel
- **SOURCE MODULE TESTED:** model-persistence
- **MOCK DEPENDENCIES:** @tensorflow/tfjs;@arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/orderflow-features.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 32
- **DESCRIBE STRUCTURE:** OrderflowFeatureExtractor > Whale Behavior Features > Time Pattern Features > Pool Dynamics Features > Liquidation Signal Features
- **SOURCE MODULE TESTED:** orderflow-features
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/orderflow-predictor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 48
- **DESCRIBE STRUCTURE:** Initialization > Prediction - Untrained Model > Training > Prediction - Trained Model > Online Learning
- **SOURCE MODULE TESTED:** orderflow-predictor
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (11 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/predictor.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 32
- **DESCRIBE STRUCTURE:** initialization > predictPrice > trainModel > updateModel > getModelStats
- **SOURCE MODULE TESTED:** predictor
- **MOCK DEPENDENCIES:** @arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/ml/__tests__/unit/tf-backend.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** tf-backend > initializeTensorFlow > query functions > memory management > resetTensorFlowBackend
- **SOURCE MODULE TESTED:** tf-backend
- **MOCK DEPENDENCIES:** @tensorflow/tfjs;@arbitrage/core
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/security/__tests__/unit/api-key-auth.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** API Key Authentication > initializeApiKeys > validateApiKey > isApiKeyAuthEnabled > isJwtAuthEnabled
- **SOURCE MODULE TESTED:** api-key-auth
- **MOCK DEPENDENCIES:** ../../../core/src/logger;../../../core/src/redis
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (10 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/security/__tests__/unit/auth.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** AuthService > register > login > validateToken > authorize
- **SOURCE MODULE TESTED:** auth
- **MOCK DEPENDENCIES:** jsonwebtoken;bcrypt
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/security/__tests__/unit/rate-limiter.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** RateLimiter > checkLimit > middleware > resetLimit > getLimitStatus
- **SOURCE MODULE TESTED:** rate-limiter
- **MOCK DEPENDENCIES:** ../../../core/src/logger;../../../core/src/redis
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/security/__tests__/unit/validation.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** Validation Middleware > validateArbitrageRequest > validateHealthRequest > validateMetricsRequest > validateLoginRequest
- **SOURCE MODULE TESTED:** validation
- **MOCK DEPENDENCIES:** ../../../core/src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/test-utils/__tests__/unit/helpers/timer-helpers.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** TimerHelpers > withFakeTimers > withRealTimers > advanceTimersAndFlush > runPendingTimersAndFlush
- **SOURCE MODULE TESTED:** timer-helpers
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/test-utils/__tests__/unit/redis-test-helper.test.ts`

- **CATEGORY:** unit
- **CATEGORIZATION BASIS:** Located in __tests__/unit/ directory
- **TEST COUNT:** 13
- **DESCRIBE STRUCTURE:** RedisTestHelper > getIsolatedRedisDatabase > createIsolatedRedisClient > cleanupTestRedis > resetDatabaseCounter
- **SOURCE MODULE TESTED:** redis-test-helper
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Integration Tests (51 files)

### `services/coordinator/src/__tests__/coordinator.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** .integration.test.ts naming convention
- **TEST COUNT:** 43
- **DESCRIBE STRUCTURE:** CoordinatorService Integration > lifecycle management > leader election > redis streams consumption > health monitoring
- **SOURCE MODULE TESTED:** Integration: coordinator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/cross-chain-detector/src/__tests__/integration/detector-integration.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 19
- **DESCRIBE STRUCTURE:** CrossChainDetectorService Integration > PriceDataManager with IndexedSnapshot > OpportunityPublisher with Deduplication > ML Configuration Integration > DetectorConfig Integration
- **SOURCE MODULE TESTED:** Integration: detector-integration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/__tests__/integration/services/commit-reveal.service.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 30
- **DESCRIBE STRUCTURE:** CommitRevealService - Integration Tests > Complete Commit-Reveal Flow > Timing Requirements > Storage Race Condition Handling > Cleanup of Expired Commitments
- **SOURCE MODULE TESTED:** Integration: commit-reveal.service
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (3 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/__tests__/integration/simulation/hot-fork-synchronizer.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 9
- **DESCRIBE STRUCTURE:** (none)
- **SOURCE MODULE TESTED:** Integration: hot-fork-synchronizer
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/execution-engine/src/strategies/flash-loan-providers/pancakeswap-v3.provider.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** .integration.test.ts naming convention
- **TEST COUNT:** 27
- **DESCRIBE STRUCTURE:** PancakeSwapV3FlashLoanProvider Integration Tests > Pool Discovery > Fee Calculation > Transaction Building > Request Validation
- **SOURCE MODULE TESTED:** Integration: pancakeswap-v3.provider
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/mempool-detector/src/__tests__/integration/success-criteria.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** Success Criteria: Decoder Accuracy (>90%) [Real Mainnet Data] > Uniswap V2 Decoder - Real Mainnet Transactions > Uniswap V3 Decoder - Real Mainnet Transactions > Combined Uniswap V2/V3 Accuracy - Real Mainnet Data > Success Criteria: False Positive Rate (<20%) [Real Mainnet Data]
- **SOURCE MODULE TESTED:** Integration: success-criteria
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (4 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/partition-asia-fast/src/__tests__/integration/service.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 21
- **DESCRIBE STRUCTURE:** P1 Asia-Fast Partition Service Integration > Health Server Configuration > Detector Configuration > Service Configuration > Service Runner Factory
- **SOURCE MODULE TESTED:** Integration: service
- **MOCK DEPENDENCIES:** @arbitrage/core;@arbitrage/config;@arbitrage/unified-detector
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/integration/cache-integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 12
- **DESCRIBE STRUCTURE:** Unified Detector Cache Integration (Task #40) > L1 Hit Rate Validation > L2 Fallback Behavior > Cross-Instance Cache Sharing > Memory Pressure Handling
- **SOURCE MODULE TESTED:** Integration: cache-integration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/integration/detector-lifecycle.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 71
- **DESCRIBE STRUCTURE:** Partition Configuration Integration > partition chain assignment consistency > partition validation integration > chain instance creation integration > degradation level integration
- **SOURCE MODULE TESTED:** Integration: detector-lifecycle
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/detector-lifecycle.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** [Level 1] DistributedLockManager Integration > Lock Acquisition > Lock TTL and Expiration > withLock Helper > Lock Ownership
- **SOURCE MODULE TESTED:** Integration: detector-lifecycle
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (20 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/mev-protection/bloxroute-integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** BloXroute Integration (BSC) > Configuration > Transaction Submission > Metrics Tracking > Health Checks
- **SOURCE MODULE TESTED:** Integration: bloxroute-integration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/mev-protection/fastlane-integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** Fastlane Integration (Polygon) > Configuration > Transaction Submission > Metrics Tracking > Health Checks
- **SOURCE MODULE TESTED:** Integration: fastlane-integration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/worker-concurrent-reads.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 12
- **DESCRIBE STRUCTURE:** Worker Concurrent Reads Integration (Task #44) > High-Volume Concurrent Reads > Scalability Testing > Stress Testing > Performance Consistency
- **SOURCE MODULE TESTED:** Integration: worker-concurrent-reads
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/worker-pool-load.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** Worker Pool Load Tests > JSON Parsing Throughput > Event Loop Blocking Prevention > JSON Payload Size Analysis > Batch JSON Parsing
- **SOURCE MODULE TESTED:** Integration: worker-pool-load
- **MOCK DEPENDENCIES:** ../../src/logger
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/worker-price-matrix.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 11
- **DESCRIBE STRUCTURE:** Worker PriceMatrix Integration (Task #44) > SharedArrayBuffer Initialization > Cross-Thread Price Visibility > Worker Pool Operations > Edge Cases
- **SOURCE MODULE TESTED:** Integration: worker-price-matrix
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/worker-thread-safety.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 15
- **DESCRIBE STRUCTURE:** Worker Thread Safety Integration (Task #44) > Concurrent Read/Write Safety > Atomics Operations > Data Corruption Detection > Stress Testing
- **SOURCE MODULE TESTED:** Integration: worker-thread-safety
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/integration/worker-zero-copy.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** Worker Zero-Copy Integration (Task #44) > Zero-Copy Verification > Memory Access Patterns > Comparison with Serialization > Latency Distribution
- **SOURCE MODULE TESTED:** Integration: worker-zero-copy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/src/warming/container/__tests__/warming-flow.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** .integration.test.ts naming convention
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** Warming Flow Integration Tests > End-to-End Warming Flow > Strategy Integration > Performance Integration > Multi-Service Integration
- **SOURCE MODULE TESTED:** Integration: warming-flow
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/chaos/fault-injection.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** [Chaos] Fault Injection Integration Tests > Task 3.2.1: Redis Failure Injection > Task 3.2.2: Latency Injection > Task 3.2.3: Network Partition Simulation > Task 3.2.4: Recovery After Chaos
- **SOURCE MODULE TESTED:** Integration: fault-injection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (2 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/component-flows/coordinator-execution.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** [Level 1] Coordinator â†’ Execution Engine Integration > Execution Request Publishing > Distributed Locking > Execution Result Publishing > Consumer Group for Execution Engine
- **SOURCE MODULE TESTED:** Integration: coordinator-execution
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/component-flows/detector-coordinator.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 12
- **DESCRIBE STRUCTURE:** [Level 1] Detector â†’ Coordinator Integration > Price Update Stream > Opportunity Stream > Consumer Group Processing > Health Monitoring Stream
- **SOURCE MODULE TESTED:** Integration: detector-coordinator
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/component-flows/multi-chain-detection.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** [Level 1] Multi-Chain Detection Integration > Multi-Chain Price Updates > Partition Detection > Cross-Chain Opportunity Detection > Multi-Partition Consumer Groups
- **SOURCE MODULE TESTED:** Integration: multi-chain-detection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/component-flows/multi-strategy-execution.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 23
- **DESCRIBE STRUCTURE:** [Level 1] Multi-Strategy Execution Integration > Strategy Routing > Profitability Filtering > Strategy Consumer Groups > Distributed Lock Management
- **SOURCE MODULE TESTED:** Integration: multi-strategy-execution
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/component-flows/price-detection.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** [Level 1] Price Update â†’ Opportunity Detection Integration > Price Data Storage > Price Update Stream > Swap Event Processing > Arbitrage Detection
- **SOURCE MODULE TESTED:** Integration: price-detection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/config-validation/chain-config.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 59
- **DESCRIBE STRUCTURE:** Chain Basics > Detector Configuration > DEX Configuration > DEX Address Validation > Token Configuration
- **SOURCE MODULE TESTED:** Integration: chain-config
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/error-handling/dead-letter-queue.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 20
- **DESCRIBE STRUCTURE:** [Integration] Dead Letter Queue > Operation Enqueueing > Operation Retrieval > Retry Processing > Statistics and Monitoring
- **SOURCE MODULE TESTED:** Integration: dead-letter-queue
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/mempool/pending-opportunities.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 22
- **DESCRIBE STRUCTURE:** [Mempool] Pending Opportunity Flow Integration > Task 2.2.1: Pending Transaction Simulation > Task 2.2.2: stream:pending-opportunities Publishing > Task 2.2.3: Pending Opportunity Consumption > Task 2.2.4: Pre-Block Opportunity Scoring
- **SOURCE MODULE TESTED:** Integration: pending-opportunities
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/multi-partition/cross-partition-sync.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 16
- **DESCRIBE STRUCTURE:** [Multi-Partition] Cross-Partition Price Synchronization > Task 2.1.1: Multi-Partition Test Harness > Task 2.1.2: L2 Cache Propagation > Task 2.1.3: Cross-Chain Detection via Aggregated Prices > Task 2.1.4: Partition Isolation and Failover
- **SOURCE MODULE TESTED:** Integration: cross-partition-sync
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/reliability/circuit-breaker.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 29
- **DESCRIBE STRUCTURE:** [Integration] Circuit Breaker State Machine > State Transitions: CLOSED â†’ OPEN > State Transitions: OPEN â†’ HALF_OPEN > State Transitions: HALF_OPEN â†’ CLOSED > State Transitions: HALF_OPEN â†’ OPEN
- **SOURCE MODULE TESTED:** Integration: circuit-breaker
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s1.1-redis-streams.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** S1.1 Redis Streams Migration Integration Tests > S1.1.1: RedisStreamsClient Core Functionality > XADD - Message Publishing > XREAD - Message Consumption > Consumer Groups
- **SOURCE MODULE TESTED:** Integration: s1.1-redis-streams
- **MOCK DEPENDENCIES:** ioredis
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** HIGH (8 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s1.3-price-matrix.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 44
- **DESCRIBE STRUCTURE:** S1.3 L1 Price Matrix Integration Tests > S1.3.1: SharedArrayBuffer Storage > S1.3.2: Atomic Operations > S1.3.3: Price Index Mapper > S1.3.5: Performance Benchmarks
- **SOURCE MODULE TESTED:** Integration: s1.3-price-matrix
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.1-optimism.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 79
- **DESCRIBE STRUCTURE:** S2.1.2: Optimism DEX Configurations > Uniswap V3 on Optimism > Velodrome on Optimism > SushiSwap on Optimism > Cross-DEX Compatibility
- **SOURCE MODULE TESTED:** Integration: s2.1-optimism
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2-dex-expansion.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 96
- **DESCRIBE STRUCTURE:** S2.2.1: Arbitrum DEX Expansion (6 â†’ 9) > DEX Count Validation > Existing DEXs (6) > New DEXs (3) - S2.2.1 > Balancer V2
- **SOURCE MODULE TESTED:** Integration: s2.2-dex-expansion
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2.2-base-dex-expansion.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 83
- **DESCRIBE STRUCTURE:** S2.2.2: Coinbase Chain DEX Expansion (5 â†’ 7) > DEX Count Validation > Existing DEXs (5) > New DEXs (2) - S2.2.2 > Maverick
- **SOURCE MODULE TESTED:** Integration: s2.2.2-base-dex-expansion
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2.3-bsc-dex-expansion.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 57
- **DESCRIBE STRUCTURE:** S2.2.3 BSC DEX Expansion > BSC DEX Configuration > MDEX Configuration > Ellipsis Finance Configuration > Nomiswap Configuration
- **SOURCE MODULE TESTED:** Integration: s2.2.3-bsc-dex-expansion
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2.4-token-coverage.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 30
- **DESCRIBE STRUCTURE:** S2.2.4 Token Coverage Verification > Total Token Count > Per-Chain Token Count > Token Address Validation > Token Configuration
- **SOURCE MODULE TESTED:** Integration: s2.2.4-token-coverage
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2.5-pair-initialization.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 35
- **DESCRIBE STRUCTURE:** S2.2.5 Pair Initialization > PairDiscoveryService > Factory Contract Integration > Pair Address Generation > Batch Discovery
- **SOURCE MODULE TESTED:** Integration: s2.2.5-pair-initialization
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s2.2.5-pair-services.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 62
- **DESCRIBE STRUCTURE:** S2.2.5 PairDiscoveryService > Configuration > Factory Type Detection > Token Sorting > CREATE2 Address Computation
- **SOURCE MODULE TESTED:** Integration: s2.2.5-pair-services
- **MOCK DEPENDENCIES:** @arbitrage/core;ethers
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.1.2-partition-assignment.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 117
- **DESCRIBE STRUCTURE:** S3.1.2.1: Four Partition Architecture > Partition Count and IDs > P1: Asia-Fast Partition > P2: L2-Turbo Partition > P3: High-Value Partition
- **SOURCE MODULE TESTED:** Integration: s3.1.2-partition-assignment
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.1.7-detector-migration.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 109
- **DESCRIBE STRUCTURE:** S3.1.7.1: Chain Coverage Verification > All chains assigned to partitions > Partition completeness > S3.1.7.2: Partition Router > Chain to partition routing
- **SOURCE MODULE TESTED:** Integration: s3.1.7-detector-migration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.2.4-cross-chain-detection.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 69
- **DESCRIBE STRUCTURE:** S3.2.4: Cross-Chain Detection Verification > S3.2.4.1: AVAX-BSC Arbitrage Paths > S3.2.4.2: FTM-Polygon Arbitrage Paths > S3.2.4.3: Token Normalization > S3.2.4.4: Token Metadata Consistency
- **SOURCE MODULE TESTED:** Integration: s3.2.4-cross-chain-detection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.1-solana-detector.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 49
- **DESCRIBE STRUCTURE:** S3.3.1 SolanaDetector Configuration Integration > S3.3.1.1: Initialization and Configuration > S3.3.1 SolanaDetector Pool Management Integration > S3.3.1.5: Pool Management > S3.3.1 SolanaDetector Arbitrage Detection Integration
- **SOURCE MODULE TESTED:** Integration: s3.3.1-solana-detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (5 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.2-solana-dex-configuration.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 73
- **DESCRIBE STRUCTURE:** S3.3.2.1: Solana DEX Program ID Constants > S3.3.2.2: Solana DEX Configuration in shared/config > S3.3.2.3: DEX Type Classification > S3.3.2.4: DEX Enable/Disable Status > S3.3.2.5: Integration with Solana Chain Config
- **SOURCE MODULE TESTED:** Integration: s3.3.2-solana-dex-configuration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.3-solana-token-configuration.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 51
- **DESCRIBE STRUCTURE:** S3.3.3.1: Solana Token Count and Basic Structure > S3.3.3.2: Anchor Tokens (SOL, USDC, USDT) > S3.3.3.3: Core DeFi Tokens (JUP, RAY, ORCA) > S3.3.3.4: Meme Tokens (BONK, WIF) > S3.3.3.5: Governance/Utility Tokens (JTO, PYTH, W, MNDE)
- **SOURCE MODULE TESTED:** Integration: s3.3.3-solana-token-configuration
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.4-solana-swap-parser.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 49
- **DESCRIBE STRUCTURE:** S3.3.4.1: SolanaSwapParser Configuration > S3.3.4.2: Program ID Recognition > S3.3.4.3: Swap Instruction Detection > S3.3.4.4: Raydium AMM Swap Parsing > S3.3.4.5: Orca Whirlpool Swap Parsing
- **SOURCE MODULE TESTED:** Integration: s3.3.4-solana-swap-parser
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.5-solana-price-feed.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 43
- **DESCRIBE STRUCTURE:** S3.3.5 Solana Price Feed Integration > S3.3.5.1: Configuration > S3.3.5.2: Raydium AMM Price Parsing > AMM Price Calculation > S3.3.5.3: Raydium CLMM Price Parsing
- **SOURCE MODULE TESTED:** Integration: s3.3.5-solana-price-feed
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (10 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.6-solana-arbitrage-detector.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 47
- **DESCRIBE STRUCTURE:** S3.3.6 Solana Arbitrage Detector > Configuration > Intra-Solana Arbitrage > Triangular Arbitrage > Cross-Chain Price Comparison
- **SOURCE MODULE TESTED:** Integration: s3.3.6-solana-arbitrage-detector
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (13 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s3.3.7-solana-partition-deploy.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 50
- **DESCRIBE STRUCTURE:** S3.3.7 Solana Partition Deployment & Testing > S3.3.7.1: RPC Provider Configuration > S3.3.7.2: Solana Chain Configuration > S3.3.7.3: Devnet Support > S3.3.7.4: Connection & Subscription
- **SOURCE MODULE TESTED:** Integration: s3.3.7-solana-partition-deploy
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s4.1.4-standby-service-deployment.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 65
- **DESCRIBE STRUCTURE:** S4.1.4: Standby Service Deployment > S4.1.4.1: Coordinator Standby on GCP > Directory Structure > Dockerfile.standby Configuration > GCP Cloud Run Configuration
- **SOURCE MODULE TESTED:** Integration: s4.1.4-standby-service-deployment
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** HIGH (7 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/s4.1.5-failover-scenarios.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 43
- **DESCRIBE STRUCTURE:** S4.1.5: Failover Scenarios > S4.1.5.1: CrossRegionHealthManager Failover > Primary Failure Detection > Failover Timing > Failover Event Chain
- **SOURCE MODULE TESTED:** Integration: s4.1.5-failover-scenarios
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/integration/vault-model-dex-regression.integration.test.ts`

- **CATEGORY:** integration
- **CATEGORIZATION BASIS:** Located in integration/ directory
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** CURRENT STATE: Vault Model DEXs Are ENABLED (Adapters Implemented) > All vault model DEXs should be configured and ENABLED > REGRESSION: Vault Model Factory Type Detection > Vault model DEXs should be detected correctly by name pattern > Name pattern matching for vault-model detection
- **SOURCE MODULE TESTED:** Integration: vault-model-dex-regression
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Contract Tests (10 files)

### `contracts/test/AaveInterfaceCompliance.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 18
- **DESCRIBE STRUCTURE:** Aave V3 Interface Compliance > 1. Flash Loan Fee Calculation > 2. executeOperation Return Value > 3. Callback Validation > 4. Repayment Verification
- **SOURCE MODULE TESTED:** contracts/src/AaveInterfaceCompliance.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/BalancerV2FlashArbitrage.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 92
- **DESCRIBE STRUCTURE:** BalancerV2FlashArbitrage > 1. Deployment and Initialization > 2. Router Management > addApprovedRouter() > removeApprovedRouter()
- **SOURCE MODULE TESTED:** contracts/src/BalancerV2FlashArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/CommitRevealArbitrage.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 68
- **DESCRIBE STRUCTURE:** CommitRevealArbitrage > 1. Deployment > 2. Commit Phase > commit() > batchCommit()
- **SOURCE MODULE TESTED:** contracts/src/CommitRevealArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/FlashLoanArbitrage.fork.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 14
- **DESCRIBE STRUCTURE:** FlashLoanArbitrage - Mainnet Fork Integration > Aave V3 Pool Integration > DEX Router Integration > Flash Loan Execution > Gas Estimation
- **SOURCE MODULE TESTED:** contracts/src/FlashLoanArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/FlashLoanArbitrage.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 59
- **DESCRIBE STRUCTURE:** FlashLoanArbitrage > Deployment > Access Control > Router Management > Minimum Profit Configuration
- **SOURCE MODULE TESTED:** contracts/src/FlashLoanArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/InterfaceCompliance.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 17
- **DESCRIBE STRUCTURE:** Interface Compliance > 1. SyncSwap Fee Calculation (ISyncSwapVault) > 2. Balancer V2 Array Validation (IBalancerV2Vault) > 3. Documentation Consistency > 4. EIP-3156 Compliance (SyncSwap)
- **SOURCE MODULE TESTED:** contracts/src/InterfaceCompliance.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/MultiPathQuoter.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 46
- **DESCRIBE STRUCTURE:** MultiPathQuoter > 1. Deployment and Initialization > 2. getBatchedQuotes() - Basic Functionality > 3. getBatchedQuotes() - Error Handling > 4. getIndependentQuotes() - Parallel Quotes
- **SOURCE MODULE TESTED:** contracts/src/MultiPathQuoter.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/PancakeSwapFlashArbitrage.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 54
- **DESCRIBE STRUCTURE:** PancakeSwapFlashArbitrage > Deployment > Access Control > Router Management > Pool Management
- **SOURCE MODULE TESTED:** contracts/src/PancakeSwapFlashArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/PancakeSwapInterfaceCompliance.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** PancakeSwap V3 Interface Compliance > 1. Fee Tier Validation > 2. Dual-Token Flash Loans > 3. Callback Parameters > 4. Repayment Verification
- **SOURCE MODULE TESTED:** contracts/src/PancakeSwapInterfaceCompliance.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/test/SyncSwapFlashArbitrage.test.ts`

- **CATEGORY:** contract
- **CATEGORIZATION BASIS:** Located in contracts/test/
- **TEST COUNT:** 79
- **DESCRIBE STRUCTURE:** SyncSwapFlashArbitrage > 1. Deployment and Initialization > 2. Router Management > addApprovedRouter() > removeApprovedRouter()
- **SOURCE MODULE TESTED:** contracts/src/SyncSwapFlashArbitrage.sol (or base)
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Performance Tests (10 files)

### `services/execution-engine/__tests__/performance/batch-quoter-benchmark.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 3
- **DESCRIBE STRUCTURE:** Batched Quote Fetching - Performance Benchmark > 2-hop arbitrage path > 3-hop arbitrage path > BatchQuoterService latency
- **SOURCE MODULE TESTED:** Performance benchmark: batch-quoter-benchmark
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/performance/cache-load.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 8
- **DESCRIBE STRUCTURE:** Cache Load Performance (Task #45) > Target Load: 500 events/sec > Cache Performance Under Load > Baseline Comparison
- **SOURCE MODULE TESTED:** Performance benchmark: cache-load
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** Yes (1 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/performance/hotpath-profiling.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 8
- **DESCRIBE STRUCTURE:** Hot-Path Profiling (Task #46) > Cache Write Hot-Path > Cache Read Hot-Path > PriceMatrix Operations > Bottleneck Identification
- **SOURCE MODULE TESTED:** Performance benchmark: hotpath-profiling
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/performance/memory-stability.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** Memory Stability Performance (Task #45) > Memory Growth Rate > Heap Pressure > ArrayBuffer Usage > Memory Recovery
- **SOURCE MODULE TESTED:** Performance benchmark: memory-stability
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/__tests__/performance/sustained-load.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 8
- **DESCRIBE STRUCTURE:** Sustained Load Performance (Task #45) > Long-Duration Stability > Memory Leak Detection > GC Behavior Under Load > Performance Consistency
- **SOURCE MODULE TESTED:** Performance benchmark: sustained-load
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (2 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `services/unified-detector/src/__tests__/performance/chain-instance-hot-path.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 9
- **DESCRIBE STRUCTURE:** Chain Instance Hot-Path Performance Guards > Pair Lookup Performance (O(1) Map) > Reserve Parsing Performance > Price Calculation Performance > Combined Hot-Path Operation Performance
- **SOURCE MODULE TESTED:** Performance benchmark: chain-instance-hot-path
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/performance/hierarchical-cache-l1-benchmark.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** PHASE1-TASK35: HierarchicalCache L1 Performance Benchmark > PriceMatrix vs Map read performance > Write performance > Hot path simulation > Memory efficiency
- **SOURCE MODULE TESTED:** Performance benchmark: hierarchical-cache-l1-benchmark
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/performance/hot-path.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 10
- **DESCRIBE STRUCTURE:** Hot-Path Performance Guards > Price Calculation Performance > PriceMatrix Performance > Full Detection Cycle Performance > Regression Guards
- **SOURCE MODULE TESTED:** Performance benchmark: hot-path
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `shared/core/__tests__/performance/professional-quality.performance.test.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** ProfessionalQualityMonitor Performance > Recording Performance > Score Calculation Performance > Memory Efficiency > Feature Impact Assessment Performance
- **SOURCE MODULE TESTED:** Performance benchmark: professional-quality
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `tests/performance/hot-path-detection.perf.ts`

- **CATEGORY:** performance
- **CATEGORIZATION BASIS:** Located in performance/ directory
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** Hot Path Performance - Detection (<50ms) > Price Calculation > Arbitrage Detection > Full Detection Cycle > Concurrent Load
- **SOURCE MODULE TESTED:** Performance benchmark: hot-path-detection
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

## E2e Tests (1 files)

### `tests/e2e/data-flow-e2e.test.ts`

- **CATEGORY:** e2e
- **CATEGORIZATION BASIS:** Located in tests/e2e/
- **TEST COUNT:** 7
- **DESCRIBE STRUCTURE:** [E2E] Complete Data Flow Pipeline > Full Pipeline: Price â†’ Detection â†’ Coordination â†’ Execution â†’ Result > Multi-Chain Data Flow > Pipeline Latency Tracking > Error Propagation
- **SOURCE MODULE TESTED:** Full pipeline: price -> detection -> execution
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Smoke Tests (1 files)

### `tests/smoke/critical-paths.smoke.ts`

- **CATEGORY:** smoke
- **CATEGORIZATION BASIS:** .smoke.ts extension
- **TEST COUNT:** 25
- **DESCRIBE STRUCTURE:** Smoke Tests - Configuration > Smoke Tests - Redis Mock > Smoke Tests - Core Modules > Smoke Tests - Service State > Smoke Tests - Price Calculation
- **SOURCE MODULE TESTED:** Critical system paths
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Script Tests (7 files)

### `contracts/__tests__/scripts/deployment-utils.test.ts`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in contracts deployment test directory
- **TEST COUNT:** 40
- **DESCRIBE STRUCTURE:** Deployment Utilities > validateMinimumProfit > Mainnet Behavior > Testnet Behavior > Unknown Network Behavior
- **SOURCE MODULE TESTED:** contracts deployment scripts/addresses
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (1 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `contracts/deployments/__tests__/addresses.test.ts`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in contracts deployment test directory
- **TEST COUNT:** 78
- **DESCRIBE STRUCTURE:** contracts/deployments/addresses > Chain Type System > getAavePoolAddress > hasDeployedContract > getContractAddress
- **SOURCE MODULE TESTED:** contracts deployment scripts/addresses
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `scripts/lib/__tests__/deprecation-checker.test.js`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in scripts/lib/__tests__/
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** DeprecationChecker > DEPRECATED_PATTERNS > checkForDeprecatedServices > checkForDeprecatedEnvVars > printWarnings
- **SOURCE MODULE TESTED:** scripts/lib/deprecation-checker.js
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `scripts/lib/__tests__/process-manager.test.js`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in scripts/lib/__tests__/
- **TEST COUNT:** 12
- **DESCRIBE STRUCTURE:** process-manager > isWindows > killProcess > processExists > findProcessesByPort
- **SOURCE MODULE TESTED:** scripts/lib/process-manager.js
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `scripts/lib/__tests__/services-config.test.js`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in scripts/lib/__tests__/
- **TEST COUNT:** 42
- **DESCRIBE STRUCTURE:** ServicesConfig > Module Import (Task 4) > checkAndPrintDeprecations function > Module Exports > Port Configuration Validation (P1 Fix)
- **SOURCE MODULE TESTED:** scripts/lib/services-config.js
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** MEDIUM (3 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `scripts/lib/__tests__/template-renderer.test.js`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in scripts/lib/__tests__/
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** template-renderer > getNestedValue > escapeHtml > renderTemplate
- **SOURCE MODULE TESTED:** scripts/lib/template-renderer.js
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

### `scripts/lib/__tests__/validators.test.js`

- **CATEGORY:** script
- **CATEGORIZATION BASIS:** Located in scripts/lib/__tests__/
- **TEST COUNT:** 24
- **DESCRIBE STRUCTURE:** validators > validatePort > parseAndValidatePort > validateString > validateOptionalString
- **SOURCE MODULE TESTED:** scripts/lib/validators.js
- **MOCK DEPENDENCIES:** (none)
- **REAL DEPENDENCIES:** None (0 refs)
- **SETUP COMPLEXITY:** LOW (0 beforeEach blocks)
- **PLACEMENT:** CORRECT

## Quality Gates

- [x] Every test file in scope is cataloged (281/281 verified with Glob count)
- [x] Every test has a CATEGORY assignment with explicit basis
- [x] Every test has SOURCE MODULE TESTED identified
- [x] Every test has MOCK DEPENDENCIES listed
- [x] Placement validation checked against ADR-009 conventions
- [x] Suspicious patterns section completed (13 findings)

# Source-to-Test Coverage Map

Generated: 2026-02-12

## Coverage Summary

- **Total source modules**: 213 (non-index, non-type-only, non-setup files)
- **Tested (dedicated test)**: 121 (56.8%)
- **Partially tested (tested as dependency)**: 42 (19.7%)
- **Untested**: 50 (23.5%)

---

## Critical Gaps (HIGH risk untested modules)

| Source Module | Risk | Reason | Recommended Test Type |
|---|---|---|---|
| `shared/core/src/caching/price-matrix.ts` | HIGH | Hot-path module (ADR-005), SharedArrayBuffer L1 cache; only tested indirectly through hierarchical-cache tests | unit |
| `shared/core/src/event-processor-worker.ts` | HIGH | Hot-path worker thread entry point for event processing; no direct tests | unit + integration |
| `shared/core/src/cross-chain-price-tracker.ts` | HIGH | Cross-chain price tracking logic with no tests at all | unit |
| `shared/core/src/resilience/retry-mechanism.ts` | HIGH | Core resilience infrastructure; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/v2-pair-parser.ts` | HIGH | Parser for Uniswap V2 pair creation events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/v3-pool-parser.ts` | HIGH | Parser for Uniswap V3 pool creation events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/solidly-parser.ts` | HIGH | Parser for Solidly pool events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/algebra-parser.ts` | HIGH | Parser for Algebra pool events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/curve-parser.ts` | HIGH | Parser for Curve pool events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/balancer-v2-parser.ts` | HIGH | Parser for Balancer V2 pool events; no dedicated test | unit |
| `shared/core/src/factory-subscription/parsers/trader-joe-parser.ts` | HIGH | Parser for TraderJoe pool events; no dedicated test | unit |
| `services/execution-engine/src/services/gas-price-optimizer.ts` | HIGH | Execution hot-path: gas price optimization affects profitability | unit |
| `services/execution-engine/src/services/mev-protection-service.ts` | HIGH | MEV protection in execution path; security-critical | unit |
| `services/execution-engine/src/services/lock-conflict-tracker.ts` | HIGH | Prevents double-execution; concurrency-critical | unit |
| `services/execution-engine/src/services/bridge-profitability-analyzer.ts` | HIGH | Cross-chain profit calculation; financial-critical | unit |
| `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts` | HIGH | Flash loan fee calculation; financial-critical | unit |
| `services/execution-engine/src/services/health-monitoring-manager.ts` | HIGH | Service health monitoring; reliability-critical | unit |
| `services/cross-chain-detector/src/confidence-calculator.ts` | HIGH | Confidence scoring for cross-chain opportunities; financial-critical | unit |
| `shared/core/src/solana/pricing/pool-parsers/raydium-amm-parser.ts` | HIGH | Solana DEX pricing parser; no tests | unit |
| `shared/core/src/solana/pricing/pool-parsers/raydium-clmm-parser.ts` | HIGH | Solana DEX pricing parser; no tests | unit |
| `shared/core/src/solana/pricing/pool-parsers/orca-whirlpool-parser.ts` | HIGH | Solana DEX pricing parser; no tests | unit |
| `services/partition-solana/src/detection/intra-solana-detector.ts` | HIGH | Solana intra-chain detection logic; no tests | unit |
| `services/partition-solana/src/detection/triangular-detector.ts` | HIGH | Solana triangular arbitrage detection; no tests | unit |
| `services/partition-solana/src/detection/cross-chain-detector.ts` | HIGH | Solana cross-chain detection; no tests | unit |
| `services/partition-solana/src/pool/versioned-pool-store.ts` | HIGH | Solana pool state management; no tests | unit |
| `services/partition-solana/src/opportunity-factory.ts` | HIGH | Creates opportunities from detections; no tests | unit |
| `services/coordinator/src/opportunities/opportunity-router.ts` | MEDIUM | Routes opportunities but tested indirectly through coordinator tests | unit |
| `services/coordinator/src/streaming/stream-consumer-manager.ts` | MEDIUM | Manages stream consumers; tested indirectly through coordinator tests | unit |

## Medium Risk Untested Modules

| Source Module | Risk | Reason | Recommended Test Type |
|---|---|---|---|
| `shared/core/src/analytics/performance-analytics.ts` | MEDIUM | Analytics module with no direct tests | unit |
| `shared/core/src/caching/shared-memory-cache.ts` | MEDIUM | SharedArrayBuffer cache wrapper; no dedicated test | unit |
| `shared/core/src/data-structures/numeric-rolling-window.ts` | MEDIUM | Data structure with no dedicated test | unit |
| `shared/core/src/data-structures/circular-buffer.ts` | MEDIUM | Only tested indirectly via mempool-detector | unit |
| `shared/core/src/data-structures/min-heap.ts` | MEDIUM | Only tested indirectly via coordinator routes | unit |
| `shared/core/src/async/async-singleton.ts` | MEDIUM | Singleton pattern utility; no test | unit |
| `shared/core/src/async/queue-lock.ts` | MEDIUM | Queue locking mechanism; no test | unit |
| `shared/core/src/mev-protection/standard-provider.ts` | MEDIUM | Standard MEV protection; tested indirectly via mev-protection tests | unit |
| `shared/core/src/resilience/error-recovery.ts` | MEDIUM | Error recovery logic; only tested via expert-self-healing | unit |
| `shared/core/src/resilience/self-healing-manager.ts` | MEDIUM | Self-healing manager; only tested via expert-self-healing | unit |
| `shared/core/src/caching/cache-coherency-manager.ts` | MEDIUM | Cache coherency; only tested via ADR compliance tests | unit |
| `shared/core/src/service-bootstrap.ts` | MEDIUM | Service bootstrap utility; no tests | unit |
| `shared/core/src/lifecycle-utils.ts` | MEDIUM | Lifecycle management utility; no tests | unit |
| `shared/core/src/disconnect-utils.ts` | MEDIUM | Disconnect/cleanup utility; no tests | unit |
| `shared/core/src/env-utils.ts` | MEDIUM | Environment utilities; no tests | unit |
| `shared/core/src/simulation-mode.ts` | MEDIUM | Simulation mode flag; only tested as dependency | unit |
| `shared/core/src/v8-profiler.ts` | LOW | Profiling utility; only used in performance tests | unit |
| `shared/config/src/flash-loan-availability.ts` | MEDIUM | Flash loan config per chain; no tests | unit |
| `shared/config/src/utils/string-interning.ts` | MEDIUM | String interning optimization; no tests | unit |
| `shared/ml/src/ensemble-combiner.ts` | MEDIUM | ML ensemble combiner; no tests | unit |
| `shared/ml/src/synchronized-stats.ts` | MEDIUM | Synchronized statistics; no tests | unit |
| `shared/core/src/metrics/` (entire domain) | MEDIUM | Prometheus metrics infrastructure; no dedicated tests | unit |
| `shared/core/src/warming/application/strategies/` | MEDIUM | Warming strategies (4 files); no dedicated tests beyond container | unit |
| `shared/core/src/caching/strategies/` | MEDIUM | Registration strategies (3 files); no dedicated tests | unit |

---

## Testing Overlaps (potential redundancy)

| Source Module | Test Files | Overlap Type |
|---|---|---|
| `shared/core/src/caching/price-matrix.ts` | `price-matrix.test.ts`, `hierarchical-cache-pricematrix.test.ts`, `pricematrix-uninitialized-read.test.ts`, `worker-pricematrix-init.test.ts`, `worker-sharedbuffer.test.ts`, 5 integration tests, 4 performance tests | **complementary** - each tests different aspect (unit, worker, perf, integration) |
| `shared/core/src/resilience/circuit-breaker.ts` + `circuit-breaker/simple-circuit-breaker.ts` | `simple-circuit-breaker.test.ts`, `drawdown-circuit-breaker.test.ts`, `circuit-breaker.test.ts` (execution-engine), `circuit-breaker-api.test.ts`, `circuit-breaker.integration.test.ts` | **complementary** - different circuit breaker implementations |
| `shared/core/src/redis-streams.ts` | `redis-streams-basic.test.ts`, `redis-streams-consumer-groups.test.ts`, `redis-streams-stream-consumer.test.ts`, `adr-002-compliance.test.ts`, `s1.1-redis-streams.integration.test.ts` | **complementary** - basic, groups, consumer, compliance, integration |
| `shared/core/src/websocket-manager.ts` | `websocket-manager.test.ts`, `factory-subscription.test.ts`, `detector-integration.test.ts`, `tier1-optimizations.test.ts`, `subscription-migration.test.ts` | **complementary** - websocket itself vs users of websocket |
| `shared/core/src/caching/hierarchical-cache.ts` | `hierarchical-cache.test.ts`, `hierarchical-cache-pricematrix.test.ts`, `tier1-optimizations.test.ts`, `tier2-optimizations.test.ts`, `hierarchical-cache-l1-benchmark.test.ts`, plus 8 warming/integration tests | **complementary** - unit, performance, integration aspects |
| `shared/core/src/monitoring/cross-region-health.ts` | `cross-region-health.test.ts`, `adr-002-compliance.test.ts`, `partition-service-utils.test.ts`, `health-reporter.test.ts`, `graceful-degradation.test.ts`, `coordinator.test.ts` | **partially redundant** - multiple tests assert health status patterns |
| `shared/core/src/detector/event-processor.ts` | `event-processor.test.ts` (2 files - __tests__/unit/ and src/detector/__tests__/), `detector-integration.test.ts` | **partially redundant** - two event-processor test files exist in different locations |
| `shared/core/src/components/price-calculator.ts` | `price-calculator.test.ts`, `simple-arbitrage-detector.test.ts` | **complementary** - direct tests vs usage tests |

---

## ADR Compliance Coverage

| ADR | Title | Test Coverage | Notes |
|---|---|---|---|
| ADR-001 | Hybrid Architecture | PARTIALLY COVERED | No dedicated compliance test; architecture tested implicitly across services |
| ADR-002 | Redis Streams | **COVERED** | Dedicated `adr-002-compliance.test.ts` + `redis-streams-basic.test.ts`, `redis-streams-consumer-groups.test.ts`, `redis-streams-stream-consumer.test.ts` + integration `s1.1-redis-streams.integration.test.ts` |
| ADR-003 | Partitioned Detectors | **COVERED** | Dedicated `adr-003-compliance.test.ts` + `partition-router.test.ts`, `partition-service-utils.test.ts` + 3 partition service tests |
| ADR-004 | Swap Event Filtering | COVERED | `swap-event-filter.test.ts`, `swap-event-filter-extended.test.ts` |
| ADR-005 | Hierarchical Cache (L1/L2/L3) | **COVERED** | `hierarchical-cache.test.ts`, `hierarchical-cache-pricematrix.test.ts`, `price-matrix.test.ts`, `hierarchical-cache-l1-benchmark.test.ts`, warming container tests, `s1.3-price-matrix.integration.test.ts` |
| ADR-006 | Free Hosting | NOT COVERED | Infrastructure/deployment; no tests expected |
| ADR-007 | Failover Strategy | PARTIALLY COVERED | `s4.1.5-failover-scenarios.integration.test.ts` tests failover; no dedicated unit compliance test |
| ADR-008 | Chain/DEX/Token Selection | COVERED | Config tests (`config-modules.test.ts`, `dex-factories.test.ts`, `dex-expansion.test.ts`) + integration tests |
| ADR-009 | Test Architecture | PARTIALLY COVERED | Conventions partially followed; no dedicated compliance test for conventions like test setup patterns |
| ADR-010 | WebSocket Resilience | COVERED | `websocket-manager.test.ts`, `websocket-resilience.test.ts` |
| ADR-011 | Tier 1 Optimizations | COVERED | `tier1-optimizations.test.ts` |
| ADR-012 | Worker Thread Path Finding | **COVERED** | `worker-pool.test.ts`, `multi-leg-worker.test.ts`, `worker-sharedbuffer.test.ts`, integration: `worker-pool-load.integration.test.ts`, `worker-concurrent-reads.integration.test.ts`, `worker-thread-safety.integration.test.ts`, `worker-zero-copy.integration.test.ts` |
| ADR-013 | Dynamic Gas Pricing | PARTIALLY COVERED | `gas-price-cache.test.ts` tests caching but `gas-price-optimizer.ts` (execution-engine) has no tests |
| ADR-014 | Modular Detector Components | COVERED | `detector-integration.test.ts`, `event-processor.test.ts`, `health-monitor.test.ts`, `detector-connection-manager.test.ts`, `pair-initialization-service.test.ts` |
| ADR-015 | Pino Logger Migration | COVERED | `logging.test.ts` |
| ADR-016 | Transaction Simulation | COVERED | `simulation.service.test.ts`, `simulation.strategy.test.ts`, multiple simulation provider tests |
| ADR-017 | MEV Protection | **COVERED** | `mev-protection.test.ts`, `mev-protection-providers.test.ts`, `jito-provider.test.ts`, `mev-share-provider.test.ts`, `mev-risk-analyzer.test.ts`, `adaptive-threshold.service.test.ts`, integration tests |
| ADR-018 | Circuit Breaker | **COVERED** | `simple-circuit-breaker.test.ts`, `drawdown-circuit-breaker.test.ts`, `circuit-breaker.test.ts` (execution-engine), `circuit-breaker-api.test.ts`, `circuit-breaker.integration.test.ts` |
| ADR-019 | Factory Subscriptions | COVERED | `factory-subscription.test.ts`, `factory-integration.test.ts`, `subscription-migration.test.ts` |
| ADR-020 | Flash Loan | COVERED | Multiple flash loan strategy tests, provider tests |
| ADR-021 | Capital Risk Management | COVERED | `position-sizer.test.ts`, `ev-calculator.test.ts`, `drawdown-circuit-breaker.test.ts`, `execution-probability-tracker.test.ts`, `risk-management-orchestrator.test.ts` |
| ADR-022 | Hot-Path Memory Optimization | PARTIALLY COVERED | `hot-path.performance.test.ts`, tier optimization tests, but no dedicated compliance test for all rules |
| ADR-023 | Detector Pre-validation | COVERED | `pre-validation-orchestrator.test.ts` |
| ADR-024 | RPC Rate Limiting | PARTIALLY COVERED | `rate-limiter.test.ts` (security) exists; `shared/core/src/rpc/rate-limiter.ts` has no dedicated test |
| ADR-025 | ML Model Lifecycle | PARTIALLY COVERED | `model-persistence.test.ts`, `predictor.test.ts`, but `ensemble-combiner.ts` and `synchronized-stats.ts` untested |
| ADR-026 | Integration Test Consolidation | PARTIALLY COVERED | Pattern followed in tests/integration/ but no compliance verification |
| ADR-027 | Nonce Pre-allocation Pool | COVERED | `nonce-manager.test.ts` |
| ADR-028 | MEV Share Integration | COVERED | `mev-share-provider.test.ts` |
| ADR-029 | Batched Quote Fetching | COVERED | `flash-loan-batched-quotes.test.ts`, `batch-quoter-benchmark.test.ts` |
| ADR-030 | PancakeSwap V3 Flash Loans | COVERED | `pancakeswap-v3.provider.integration.test.ts`, contract test `PancakeSwapFlashArbitrage.test.ts` |

---

## Hot-Path Coverage

| Module | Unit Tests | Integration Tests | Performance Tests |
|---|---|---|---|
| `shared/core/src/caching/price-matrix.ts` | `price-matrix.test.ts`, `hierarchical-cache-pricematrix.test.ts`, `pricematrix-uninitialized-read.test.ts`, `worker-pricematrix-init.test.ts` | `worker-price-matrix.integration.test.ts`, `worker-concurrent-reads.integration.test.ts`, `worker-thread-safety.integration.test.ts`, `worker-zero-copy.integration.test.ts`, `s1.3-price-matrix.integration.test.ts` | `hierarchical-cache-l1-benchmark.test.ts`, `hot-path.performance.test.ts` |
| `shared/core/src/caching/hierarchical-cache.ts` | `hierarchical-cache.test.ts`, `hierarchical-cache-pricematrix.test.ts`, `tier1-optimizations.test.ts`, `tier2-optimizations.test.ts`, `predictive-warming.test.ts` | `cache-integration.test.ts`, `warming-flow.integration.test.ts` | `hierarchical-cache-l1-benchmark.test.ts`, `cache-load.performance.test.ts`, `performance.benchmark.test.ts` |
| `shared/core/src/components/arbitrage-detector.ts` (partitioned detector core) | `arbitrage-detector.test.ts`, `partition-router.test.ts`, `partition-service-utils.test.ts`, `adr-003-compliance.test.ts` | `cross-partition-sync.integration.test.ts`, `s3.1.7-detector-migration.integration.test.ts` | None dedicated |
| `services/execution-engine/src/engine.ts` | `engine.test.ts`, `execution-flow.test.ts` | `commit-reveal.service.test.ts` (integration) | `batch-quoter-benchmark.test.ts` (partial) |
| `services/unified-detector/src/unified-detector.ts` | `unified-detector.test.ts`, `chain-instance-manager.test.ts`, `health-reporter.test.ts` | `detector-lifecycle.integration.test.ts`, `cache-integration.test.ts` | `chain-instance-hot-path.performance.test.ts`, `hotpath-profiling.performance.test.ts`, `memory-stability.performance.test.ts`, `sustained-load.performance.test.ts` |
| `services/unified-detector/src/chain-instance.ts` | `chain-instance.test.ts`, `chain-instance-manager.test.ts`, `subscription-migration.test.ts` | `detector-lifecycle.integration.test.ts` | `chain-instance-hot-path.performance.test.ts`, `hotpath-profiling.performance.test.ts` |
| `shared/core/src/websocket-manager.ts` | `websocket-manager.test.ts`, `factory-subscription.test.ts` | `s3.1.7-detector-migration.integration.test.ts` | None dedicated |
| `shared/core/src/event-processor-worker.ts` | **NONE** | **NONE** | **NONE** |

---

## Full Coverage Map

### shared/core/src/ (Core Library)

#### analytics/
| Source File | Coverage | Test Files |
|---|---|---|
| `performance-analytics.ts` | UNTESTED | None |
| `liquidity-depth-analyzer.ts` | PARTIALLY TESTED | `tier3-advanced.test.ts` (as dependency) |
| `ml-opportunity-scorer.ts` | PARTIALLY TESTED | `tier2-optimizations.test.ts` (as dependency) |
| `pair-activity-tracker.ts` | TESTED | `pair-activity-tracker.test.ts` |
| `price-momentum.ts` | PARTIALLY TESTED | `tier2-optimizations.test.ts` (as dependency) |
| `price-oracle.ts` | TESTED | `price-oracle.test.ts` + 5 other tests |
| `professional-quality-monitor.ts` | TESTED | `professional-quality-monitor.test.ts`, `professional-quality.test.ts`, `professional-quality.performance.test.ts` |
| `swap-event-filter.ts` | TESTED | `swap-event-filter.test.ts`, `swap-event-filter-extended.test.ts` |
| `whale-activity-tracker.ts` | PARTIALLY TESTED | `tier3-advanced.test.ts`, ML tests (as dependency) |

#### async/
| Source File | Coverage | Test Files |
|---|---|---|
| `async-mutex.ts` | TESTED | `async-mutex.test.ts` + 5 other tests |
| `async-singleton.ts` | UNTESTED | None |
| `async-utils.ts` | TESTED | `async-utils.test.ts` |
| `operation-guard.ts` | TESTED | `operation-guard.test.ts` |
| `queue-lock.ts` | UNTESTED | None |
| `service-registry.ts` | TESTED | `service-registry.test.ts` |
| `worker-pool.ts` | TESTED | `worker-pool.test.ts`, `worker-pool-load.integration.test.ts`, `multi-leg-worker.test.ts` |

#### bridge-router/
| Source File | Coverage | Test Files |
|---|---|---|
| `stargate-router.ts` | TESTED | `bridge-router.test.ts` + execution-engine tests |

#### caching/
| Source File | Coverage | Test Files |
|---|---|---|
| `cache-coherency-manager.ts` | PARTIALLY TESTED | `adr-002-compliance.test.ts`, `fixes-regression.test.ts` (as dependency) |
| `correlation-analyzer.ts` | TESTED | `correlation-analyzer.test.ts`, `predictive-warming.test.ts` |
| `gas-price-cache.ts` | TESTED | `gas-price-cache.test.ts` |
| `hierarchical-cache.ts` | TESTED | `hierarchical-cache.test.ts` + 16 other tests |
| `pair-cache.ts` | PARTIALLY TESTED | Pair initialization/services integration tests (as dependency) |
| `price-matrix.ts` | TESTED | `price-matrix.test.ts` + 21 other tests |
| `reserve-cache.ts` | TESTED | `reserve-cache.test.ts` |
| `shared-key-registry.ts` | TESTED | `shared-key-registry-concurrency.test.ts` + 2 others |
| `shared-memory-cache.ts` | UNTESTED | None |
| `strategies/implementations/main-thread-strategy.ts` | UNTESTED | None |
| `strategies/implementations/worker-thread-strategy.ts` | UNTESTED | None |
| `strategies/implementations/registry-strategy-factory.ts` | UNTESTED | None |

#### circuit-breaker/
| Source File | Coverage | Test Files |
|---|---|---|
| `simple-circuit-breaker.ts` | TESTED | `simple-circuit-breaker.test.ts` |

#### components/
| Source File | Coverage | Test Files |
|---|---|---|
| `arbitrage-detector.ts` | TESTED | `arbitrage-detector.test.ts` |
| `pair-repository.ts` | TESTED | `pair-repository.test.ts` |
| `price-calculator.ts` | TESTED | `price-calculator.test.ts`, `simple-arbitrage-detector.test.ts` |
| `token-utils.ts` | TESTED | `token-utils.test.ts` |

#### data-structures/
| Source File | Coverage | Test Files |
|---|---|---|
| `circular-buffer.ts` | PARTIALLY TESTED | `mempool-detector-service.test.ts` (as dependency) |
| `lru-cache.ts` | TESTED | `lru-cache.test.ts` |
| `min-heap.ts` | PARTIALLY TESTED | `api.routes.test.ts` (as dependency) |
| `numeric-rolling-window.ts` | UNTESTED | None |

#### detector/
| Source File | Coverage | Test Files |
|---|---|---|
| `detector-connection-manager.ts` | TESTED | `detector-connection-manager.test.ts` |
| `event-processor.ts` | TESTED | `event-processor.test.ts` (2 locations) |
| `factory-integration.ts` | TESTED | `factory-integration.test.ts`, `detector-integration.test.ts` |
| `health-monitor.ts` | TESTED | `health-monitor.test.ts` |
| `pair-initialization-service.ts` | TESTED | `pair-initialization-service.test.ts` |

#### dex-adapters/
| Source File | Coverage | Test Files |
|---|---|---|
| `adapter-registry.ts` | TESTED | `adapter-registry.test.ts` |
| `balancer-v2-adapter.ts` | TESTED | `balancer-v2-adapter.test.ts` |
| `gmx-adapter.ts` | TESTED | `gmx-adapter.test.ts` |
| `platypus-adapter.ts` | TESTED | `platypus-adapter.test.ts` |

#### factory-subscription/parsers/
| Source File | Coverage | Test Files |
|---|---|---|
| `v2-pair-parser.ts` | UNTESTED | None (factory-subscription.test.ts tests the parent module only) |
| `v3-pool-parser.ts` | UNTESTED | None |
| `solidly-parser.ts` | UNTESTED | None |
| `algebra-parser.ts` | UNTESTED | None |
| `trader-joe-parser.ts` | UNTESTED | None |
| `curve-parser.ts` | UNTESTED | None |
| `balancer-v2-parser.ts` | UNTESTED | None |
| `utils.ts` | UNTESTED | None |

#### flash-loan-aggregation/
| Source File | Coverage | Test Files |
|---|---|---|
| `application/select-provider.usecase.ts` | UNTESTED | None |
| `domain/models.ts` | TESTED | `models.test.ts` |
| `infrastructure/flashloan-aggregator.impl.ts` | UNTESTED | None |
| `infrastructure/inmemory-aggregator.metrics.ts` | TESTED | `inmemory-aggregator.metrics.test.ts` |
| `infrastructure/onchain-liquidity.validator.ts` | UNTESTED | None |
| `infrastructure/weighted-ranking.strategy.ts` | TESTED | `weighted-ranking.strategy.test.ts` |

#### logging/
| Source File | Coverage | Test Files |
|---|---|---|
| `pino-logger.ts` | TESTED | `logging.test.ts` |
| `testing-logger.ts` | PARTIALLY TESTED | Used across many tests as dependency |

#### metrics/ (entire domain)
| Source File | Coverage | Test Files |
|---|---|---|
| `application/use-cases/collect-metrics.usecase.ts` | UNTESTED | None |
| `application/use-cases/export-metrics.usecase.ts` | UNTESTED | None |
| `infrastructure/prometheus-exporter.impl.ts` | UNTESTED | None |
| `infrastructure/prometheus-metrics-collector.impl.ts` | UNTESTED | None |
| `domain/models.ts` | UNTESTED | None |

#### mev-protection/
| Source File | Coverage | Test Files |
|---|---|---|
| `adaptive-threshold.service.ts` | TESTED | `adaptive-threshold.service.test.ts` |
| `base-provider.ts` | TESTED | `mev-protection-providers.test.ts` |
| `factory.ts` | TESTED | `mev-protection.test.ts` |
| `flashbots-provider.ts` | TESTED | `mev-protection-providers.test.ts` |
| `jito-provider.ts` | TESTED | `jito-provider.test.ts` |
| `l2-sequencer-provider.ts` | TESTED | `mev-protection-providers.test.ts` |
| `metrics-manager.ts` | TESTED | `metrics-manager.test.ts` |
| `mev-risk-analyzer.ts` | TESTED | `mev-risk-analyzer.test.ts` |
| `mev-share-provider.ts` | TESTED | `mev-share-provider.test.ts` |
| `standard-provider.ts` | PARTIALLY TESTED | `mev-protection-providers.test.ts` (as part of provider suite) |

#### monitoring/
| Source File | Coverage | Test Files |
|---|---|---|
| `cross-region-health.ts` | TESTED | `cross-region-health.test.ts` + 11 other tests |
| `enhanced-health-monitor.ts` | PARTIALLY TESTED | `adr-002-compliance.test.ts`, `expert-self-healing.test.ts` (as dependency) |
| `provider-health-scorer.ts` | TESTED | `provider-health-scorer.test.ts`, `tier1-optimizations.test.ts` |
| `stream-health-monitor.ts` | TESTED | `stream-health-monitor.test.ts` + 3 others |

#### resilience/
| Source File | Coverage | Test Files |
|---|---|---|
| `circuit-breaker.ts` | PARTIALLY TESTED | Tested indirectly via execution-engine, coordinator |
| `dead-letter-queue.ts` | PARTIALLY TESTED | `adr-002-compliance.test.ts`, `dead-letter-queue.integration.test.ts`, `expert-self-healing.test.ts` |
| `error-handling.ts` | TESTED | `error-handling.test.ts` |
| `error-recovery.ts` | PARTIALLY TESTED | `expert-self-healing.test.ts` (as dependency) |
| `expert-self-healing-manager.ts` | TESTED | `expert-self-healing.test.ts` |
| `graceful-degradation.ts` | TESTED | `graceful-degradation.test.ts` + 6 other tests |
| `retry-mechanism.ts` | UNTESTED | None |
| `self-healing-manager.ts` | PARTIALLY TESTED | `expert-self-healing.test.ts` (as dependency) |

#### risk/
| Source File | Coverage | Test Files |
|---|---|---|
| `drawdown-circuit-breaker.ts` | TESTED | `drawdown-circuit-breaker.test.ts` |
| `ev-calculator.ts` | TESTED | `ev-calculator.test.ts` |
| `execution-probability-tracker.ts` | TESTED | `execution-probability-tracker.test.ts` |
| `position-sizer.ts` | TESTED | `position-sizer.test.ts` |

#### rpc/
| Source File | Coverage | Test Files |
|---|---|---|
| `batch-provider.ts` | TESTED | `batch-provider.test.ts` |
| `rate-limiter.ts` | UNTESTED | None (security rate-limiter test is a different module) |

#### solana/
| Source File | Coverage | Test Files |
|---|---|---|
| `solana-detector.ts` | TESTED | `solana-detector.test.ts` + integration tests |
| `solana-price-feed.ts` | PARTIALLY TESTED | `s3.3.5-solana-price-feed.integration.test.ts` (integration only) |
| `solana-swap-parser.ts` | PARTIALLY TESTED | `s3.3.4-solana-swap-parser.integration.test.ts` (integration only) |
| `pricing/pool-parsers/raydium-amm-parser.ts` | UNTESTED | None |
| `pricing/pool-parsers/raydium-clmm-parser.ts` | UNTESTED | None |
| `pricing/pool-parsers/orca-whirlpool-parser.ts` | UNTESTED | None |
| `pricing/pool-parsers/utils.ts` | UNTESTED | None |

#### warming/
| Source File | Coverage | Test Files |
|---|---|---|
| `container/warming.container.ts` | TESTED | `warming.container.unit.test.ts`, `factory-functions.test.ts`, `warming-flow.integration.test.ts`, `performance.benchmark.test.ts` |
| `infrastructure/correlation-tracker.impl.ts` | PARTIALLY TESTED | `p1-5-fix-verification.test.ts` |
| `infrastructure/hierarchical-cache-warmer.impl.ts` | PARTIALLY TESTED | `warming-flow.integration.test.ts` |
| `application/strategies/adaptive-strategy.ts` | UNTESTED | None (only container tested) |
| `application/strategies/threshold-strategy.ts` | UNTESTED | None |
| `application/strategies/time-based-strategy.ts` | UNTESTED | None |
| `application/strategies/top-n-strategy.ts` | UNTESTED | None |
| `application/use-cases/track-correlation.usecase.ts` | UNTESTED | None |
| `application/use-cases/warm-cache.usecase.ts` | UNTESTED | None |

#### Top-level files
| Source File | Coverage | Test Files |
|---|---|---|
| `cross-chain-price-tracker.ts` | UNTESTED | None |
| `cross-dex-triangular-arbitrage.ts` | PARTIALLY TESTED | `tier1-optimizations.test.ts`, `tier2-optimizations.test.ts`, `multi-leg-worker.test.ts` |
| `distributed-lock.ts` | TESTED | `distributed-lock.test.ts` + 3 other tests |
| `disconnect-utils.ts` | UNTESTED | None |
| `env-utils.ts` | UNTESTED | None |
| `event-batcher.ts` | PARTIALLY TESTED | `tier1-optimizations.test.ts`, `regression.test.ts` (as dependency) |
| `event-processor-worker.ts` | UNTESTED | None |
| `factory-subscription.ts` | TESTED | `factory-subscription.test.ts`, `factory-integration.test.ts` |
| `interval-manager.ts` | TESTED | `interval-manager.test.ts` |
| `lifecycle-utils.ts` | UNTESTED | None |
| `logger.ts` | TESTED | `logging.test.ts` |
| `matrix-cache.ts` | PARTIALLY TESTED | `hierarchical-cache-pricematrix.test.ts` |
| `message-validators.ts` | TESTED | `message-validators.test.ts` |
| `multi-leg-path-finder.ts` | TESTED | `multi-leg-worker.test.ts`, `tier3-optimizations.test.ts` |
| `nonce-manager.ts` | TESTED | `nonce-manager.test.ts` + 6 other tests |
| `pair-discovery.ts` | TESTED | `pair-discovery.test.ts` + 5 integration tests |
| `partition-router.ts` | TESTED | `partition-router.test.ts` |
| `partition-service-utils.ts` | TESTED | `partition-service-utils.test.ts` |
| `performance-monitor.ts` | TESTED | `performance-monitor.test.ts` |
| `predictive-warmer.ts` | TESTED | `predictive-warming.test.ts` |
| `publishing/publishing-service.ts` | TESTED | `publishing-service.test.ts` |
| `redis.ts` | TESTED | `redis.test.ts` |
| `redis-streams.ts` | TESTED | 3 dedicated redis-streams tests + `adr-002-compliance.test.ts` |
| `service-bootstrap.ts` | UNTESTED | None |
| `service-state.ts` | TESTED | `service-state.test.ts` |
| `simulation-mode.ts` | PARTIALLY TESTED | Multiple tests use it (as dependency) |
| `v8-profiler.ts` | PARTIALLY TESTED | `hotpath-profiling.performance.test.ts` (as dependency) |
| `validation.ts` | TESTED | `message-validators.test.ts`, integration tests |
| `websocket-manager.ts` | TESTED | `websocket-manager.test.ts` + 6 other tests |

---

### shared/config/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `addresses.ts` | TESTED | `addresses.test.ts` |
| `config-manager.ts` | TESTED | `config-manager.test.ts` |
| `cross-chain.ts` | TESTED | `cross-chain.test.ts` |
| `detector-config.ts` | PARTIALLY TESTED | `config-modules.test.ts` (as part of config modules) |
| `dex-factories.ts` | TESTED | `dex-factories.test.ts` |
| `event-config.ts` | PARTIALLY TESTED | `config-modules.test.ts` (as part of config modules) |
| `flash-loan-availability.ts` | UNTESTED | None |
| `mempool-config.ts` | PARTIALLY TESTED | `mempool-detector-service.test.ts` (as dependency) |
| `mev-config.ts` | TESTED | `mev-config.test.ts` |
| `partition-ids.ts` | PARTIALLY TESTED | `partitions.test.ts` (as dependency) |
| `partitions.ts` | TESTED | `partitions.test.ts` |
| `risk-config.ts` | TESTED | `risk-config.test.ts` |
| `schemas/index.ts` | TESTED | `schemas.test.ts` |
| `service-config.ts` | PARTIALLY TESTED | `config-modules.test.ts`, execution-engine tests (as dependency) |
| `system-constants.ts` | PARTIALLY TESTED | Multiple tests use constants (as dependency) |
| `thresholds.ts` | TESTED | `thresholds.test.ts` |
| `chains/chain-url-builder.ts` | TESTED | `chain-url-builder.test.ts` |
| `chains/provider-config.ts` | PARTIALLY TESTED | `chain-url-builder.test.ts`, provider tests (as dependency) |
| `dexes/index.ts` | PARTIALLY TESTED | `dex-expansion.test.ts` |
| `tokens/index.ts` | PARTIALLY TESTED | Config tests (as dependency) |
| `utils/string-interning.ts` | UNTESTED | None |

---

### shared/ml/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `direction-types.ts` | TESTED | `direction-types.test.ts` |
| `ensemble-combiner.ts` | UNTESTED | None |
| `feature-math.ts` | TESTED | `feature-math.test.ts` |
| `model-persistence.ts` | TESTED | `model-persistence.test.ts` |
| `orderflow-features.ts` | TESTED | `orderflow-features.test.ts` |
| `orderflow-predictor.ts` | TESTED | `orderflow-predictor.test.ts` |
| `predictor.ts` | TESTED | `predictor.test.ts` |
| `synchronized-stats.ts` | UNTESTED | None |
| `tf-backend.ts` | TESTED | `tf-backend.test.ts` |

---

### shared/security/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `auth.ts` | TESTED | `auth.test.ts`, `api-key-auth.test.ts` |
| `rate-limiter.ts` | TESTED | `rate-limiter.test.ts` |
| `validation.ts` | TESTED | `validation.test.ts` |

---

### services/coordinator/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `coordinator.ts` | TESTED | `coordinator.test.ts`, `coordinator.integration.test.ts` |
| `alerts/cooldown-manager.ts` | TESTED | `cooldown-manager.test.ts` |
| `alerts/notifier.ts` | TESTED | `notifier.test.ts` |
| `api/routes/dashboard.routes.ts` | TESTED | `api.routes.test.ts` |
| `api/routes/metrics.routes.ts` | TESTED | `api.routes.test.ts` |
| `api/routes/admin.routes.ts` | TESTED | `api.routes.test.ts` |
| `api/routes/health.routes.ts` | TESTED | `api.routes.test.ts` |
| `health/health-monitor.ts` | PARTIALLY TESTED | `coordinator.test.ts` (as dependency) |
| `interval-manager.ts` | PARTIALLY TESTED | `coordinator.test.ts` (as dependency) |
| `leadership/leadership-election-service.ts` | TESTED | `leadership-election-service.test.ts` |
| `opportunities/opportunity-router.ts` | UNTESTED | None dedicated |
| `streaming/rate-limiter.ts` | UNTESTED | None |
| `streaming/stream-consumer-manager.ts` | UNTESTED | None |
| `utils/type-guards.ts` | UNTESTED | None |

---

### services/execution-engine/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `engine.ts` | TESTED | `engine.test.ts`, `execution-flow.test.ts` |
| `ab-testing/framework.ts` | TESTED | `ab-testing-framework.test.ts` |
| `ab-testing/metrics-collector.ts` | TESTED | `ab-testing-framework.test.ts` |
| `ab-testing/statistical-analysis.ts` | TESTED | `ab-testing-framework.test.ts` |
| `api/circuit-breaker-api.ts` | TESTED | `circuit-breaker-api.test.ts` |
| `consumers/opportunity.consumer.ts` | TESTED | `opportunity.consumer.test.ts` |
| `consumers/validation.ts` | TESTED | `validation.test.ts` |
| `initialization/bridge-router-initializer.ts` | TESTED | `initialization.test.ts` |
| `initialization/execution-engine-initializer.ts` | TESTED | `initialization.test.ts` |
| `initialization/mev-initializer.ts` | TESTED | `initialization.test.ts` |
| `initialization/risk-management-initializer.ts` | TESTED | `initialization.test.ts` |
| `risk/risk-management-orchestrator.ts` | TESTED | `risk-management-orchestrator.test.ts` |
| `services/bridge-profitability-analyzer.ts` | UNTESTED | None |
| `services/circuit-breaker.ts` | TESTED | `circuit-breaker.test.ts` |
| `services/commit-reveal.service.ts` | TESTED | `commit-reveal.service.test.ts` (2 locations: unit + integration) |
| `services/dex-lookup.service.ts` | TESTED | `dex-lookup.service.test.ts` |
| `services/gas-price-optimizer.ts` | UNTESTED | None |
| `services/health-monitoring-manager.ts` | UNTESTED | None |
| `services/lock-conflict-tracker.ts` | UNTESTED | None |
| `services/mev-protection-service.ts` | UNTESTED | None |
| `services/nonce-allocation-manager.ts` | PARTIALLY TESTED | `execution-flow.test.ts`, provider tests (as dependency) |
| `services/provider.service.ts` | TESTED | `provider.service.test.ts` |
| `services/queue.service.ts` | TESTED | `queue.service.test.ts` |
| `services/swap-builder.service.ts` | TESTED | `swap-builder.service.test.ts` |
| `services/simulation/alchemy-provider.ts` | TESTED | `alchemy-provider.test.ts` |
| `services/simulation/anvil-manager.ts` | TESTED | `anvil-manager.test.ts` |
| `services/simulation/base-simulation-provider.ts` | TESTED | `base-simulation-provider.test.ts` |
| `services/simulation/batch-quoter.service.ts` | PARTIALLY TESTED | `flash-loan-batched-quotes.test.ts`, `batch-quoter-benchmark.test.ts` |
| `services/simulation/helius-provider.ts` | TESTED | `helius-provider.test.ts` |
| `services/simulation/hot-fork-synchronizer.ts` | TESTED | `hot-fork-synchronizer.test.ts`, `hot-fork-synchronizer.integration.test.ts` |
| `services/simulation/local-provider.ts` | TESTED | `local-provider.test.ts` |
| `services/simulation/pending-state-simulator.ts` | TESTED | `pending-state-simulator.test.ts` |
| `services/simulation/simulation.service.ts` | TESTED | `simulation.service.test.ts` |
| `services/simulation/simulation-metrics-collector.ts` | TESTED | `simulation-metrics-collector.test.ts` |
| `services/simulation/tenderly-provider.ts` | TESTED | `tenderly-provider.test.ts` |
| `strategies/base.strategy.ts` | TESTED | `base.strategy.test.ts` |
| `strategies/cross-chain.strategy.ts` | TESTED | `cross-chain.strategy.test.ts`, `cross-chain-execution.test.ts` |
| `strategies/flash-loan.strategy.ts` | TESTED | `flash-loan.strategy.test.ts`, `flash-loan-edge-cases.test.ts`, `flash-loan-batched-quotes.test.ts` |
| `strategies/flash-loan-fee-calculator.ts` | UNTESTED | None |
| `strategies/flash-loan-liquidity-validator.ts` | TESTED | `flash-loan-liquidity-validator.test.ts` |
| `strategies/intra-chain.strategy.ts` | TESTED | `intra-chain.strategy.test.ts` |
| `strategies/simulation.strategy.ts` | TESTED | `simulation.strategy.test.ts` |
| `strategies/strategy-factory.ts` | TESTED | `strategy-factory.test.ts` |
| `strategies/flash-loan-providers/aave-v3.provider.ts` | PARTIALLY TESTED | `flash-loan.strategy.test.ts` (as dependency) |
| `strategies/flash-loan-providers/balancer-v2.provider.ts` | PARTIALLY TESTED | `flash-loan.strategy.test.ts` (as dependency) |
| `strategies/flash-loan-providers/pancakeswap-v3.provider.ts` | TESTED | `pancakeswap-v3.provider.integration.test.ts` |
| `strategies/flash-loan-providers/provider-factory.ts` | TESTED | `provider-factory.test.ts` |
| `strategies/flash-loan-providers/syncswap.provider.ts` | TESTED | `syncswap.provider.test.ts` |
| `strategies/flash-loan-providers/unsupported.provider.ts` | TESTED | `unsupported.provider.test.ts` |

---

### services/cross-chain-detector/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `bridge-cost-estimator.ts` | TESTED | `bridge-cost-estimator.test.ts` |
| `bridge-predictor.ts` | TESTED | `bridge-predictor.test.ts` |
| `confidence-calculator.ts` | UNTESTED | None |
| `detector.ts` | TESTED | `detector.test.ts`, `detector-integration.integration.test.ts` |
| `ml-prediction-manager.ts` | TESTED | `ml-prediction-manager.test.ts` |
| `opportunity-publisher.ts` | TESTED | `opportunity-publisher.test.ts` |
| `pre-validation-orchestrator.ts` | TESTED | `pre-validation-orchestrator.test.ts` |
| `price-data-manager.ts` | TESTED | `price-data-manager.test.ts` |
| `stream-consumer.ts` | TESTED | `stream-consumer.test.ts` |

---

### services/unified-detector/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `chain-instance.ts` | TESTED | `chain-instance.test.ts`, `chain-instance-manager.test.ts`, `subscription-migration.test.ts` |
| `chain-instance-manager.ts` | TESTED | `chain-instance-manager.test.ts` |
| `constants.ts` | PARTIALLY TESTED | Referenced by other tests |
| `detection/simple-arbitrage-detector.ts` | TESTED | `simple-arbitrage-detector.test.ts` |
| `detection/snapshot-manager.ts` | TESTED | `snapshot-manager.test.ts` |
| `exports.ts` | PARTIALLY TESTED | Referenced by other tests |
| `health-reporter.ts` | TESTED | `health-reporter.test.ts` |
| `metrics-collector.ts` | TESTED | `metrics-collector.test.ts` |
| `publishers/opportunity.publisher.ts` | TESTED | `opportunity-publisher.test.ts` |
| `publishers/whale-alert.publisher.ts` | TESTED | `whale-alert-publisher.test.ts` |
| `simulation/chain.simulator.ts` | TESTED | `chain-simulation-handler.test.ts` |
| `unified-detector.ts` | TESTED | `unified-detector.test.ts`, `detector-lifecycle.integration.test.ts` |
| `warming-integration.ts` | PARTIALLY TESTED | `p1-7-fix-verification.test.ts` |

---

### services/partition-solana/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `arbitrage-detector.ts` | TESTED | `arbitrage-detector.test.ts` |
| `detection/base.ts` | PARTIALLY TESTED | `arbitrage-detector.test.ts` (as dependency) |
| `detection/intra-solana-detector.ts` | UNTESTED | None |
| `detection/triangular-detector.ts` | UNTESTED | None |
| `detection/cross-chain-detector.ts` | UNTESTED | None |
| `opportunity-factory.ts` | UNTESTED | None |
| `pool/versioned-pool-store.ts` | UNTESTED | None |

---

### services/partition-asia-fast/src/, partition-high-value/src/, partition-l2-turbo/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `partition-asia-fast/src/index.ts` | TESTED | `partition-service.test.ts`, `service.integration.test.ts` |
| `partition-high-value/src/index.ts` | TESTED | `partition-service.test.ts` |
| `partition-l2-turbo/src/index.ts` | TESTED | `partition-service.test.ts` |

---

### services/mempool-detector/src/

| Source File | Coverage | Test Files |
|---|---|---|
| `bloxroute-feed.ts` | TESTED | `bloxroute-feed.test.ts`, `mempool-detector-service.test.ts` |
| `decoders/base-decoder.ts` | TESTED | `decoders.test.ts` |
| `decoders/curve.ts` | TESTED | `decoders.test.ts` |
| `decoders/oneinch.ts` | TESTED | `decoders.test.ts` |
| `decoders/uniswap-v2.ts` | TESTED | `decoders.test.ts` |
| `decoders/uniswap-v3.ts` | TESTED | `decoders.test.ts` |

---

### contracts/test/ (Hardhat)

| Contract | Test Files |
|---|---|
| `FlashLoanArbitrage.sol` | `FlashLoanArbitrage.test.ts`, `FlashLoanArbitrage.fork.test.ts` |
| `BalancerV2FlashArbitrage.sol` | `BalancerV2FlashArbitrage.test.ts` |
| `CommitRevealArbitrage.sol` | `CommitRevealArbitrage.test.ts` |
| `PancakeSwapFlashArbitrage.sol` | `PancakeSwapFlashArbitrage.test.ts` |
| `SyncSwapFlashArbitrage.sol` | `SyncSwapFlashArbitrage.test.ts` |
| `MultiPathQuoter.sol` | `MultiPathQuoter.test.ts` |
| Interface compliance | `InterfaceCompliance.test.ts`, `AaveInterfaceCompliance.test.ts`, `PancakeSwapInterfaceCompliance.test.ts` |

---

## Quality Gates Checklist

- [x] Every source module in scope is mapped (not just tested ones)
- [x] Every gap has a risk assessment with reasoning
- [x] ADR compliance coverage checked for all 30 ADRs
- [x] Hot-path modules specifically assessed with unit/integration/performance breakdown
- [x] Overlaps classified as redundant vs complementary

---

## Key Findings Summary

### Strengths
1. **Excellent hot-path coverage**: `price-matrix.ts`, `hierarchical-cache.ts`, and `unified-detector` have comprehensive unit, integration, AND performance test coverage
2. **Strong ADR compliance**: ADR-002, ADR-003, ADR-005, ADR-012, ADR-017, ADR-018 all have dedicated compliance or thorough tests
3. **Good execution-engine coverage**: Most strategies, simulation providers, and core engine logic are well-tested
4. **Comprehensive MEV protection coverage**: All MEV protection providers have dedicated tests
5. **Security package fully tested**: All 3 source modules have dedicated tests

### Weaknesses
1. **Factory subscription parsers completely untested**: All 7 parsers (v2-pair, v3-pool, solidly, algebra, trader-joe, curve, balancer-v2) have zero tests -- high risk since they parse on-chain events
2. **Solana partition detection modules untested**: `intra-solana-detector.ts`, `triangular-detector.ts`, `cross-chain-detector.ts` -- all detection logic untested
3. **Solana pricing pool parsers untested**: raydium-amm, raydium-clmm, orca-whirlpool parsers have no tests
4. **Several financial-critical modules untested**: `gas-price-optimizer.ts`, `bridge-profitability-analyzer.ts`, `flash-loan-fee-calculator.ts`, `confidence-calculator.ts`
5. **Execution-engine service gaps**: `mev-protection-service.ts`, `lock-conflict-tracker.ts`, `health-monitoring-manager.ts` untested
6. **Metrics domain completely untested**: All Prometheus metrics infrastructure (5 files) has no tests
7. **Warming strategies untested**: All 4 warming strategies tested only through container
8. **Core resilience gap**: `retry-mechanism.ts` has no tests despite being critical infrastructure
9. **Event-processor-worker completely untested**: Hot-path worker thread entry point
10. **Coordinator streaming/routing untested**: `stream-consumer-manager.ts`, `opportunity-router.ts`, `rate-limiter.ts` (coordinator-specific)

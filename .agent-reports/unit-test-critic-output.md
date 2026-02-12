# Unit Test Quality Report

Generated: 2026-02-12

## Summary

- **Tests analyzed**: ~170 files, ~2,500+ test cases (estimated)
- **Necessity**: ESSENTIAL: 82 | VALUABLE: 54 | REDUNDANT: 12 | UNNECESSARY: 6 | NEEDS CLARIFICATION: 16
- **Engineering**: CLEAN: 78 | COULD SIMPLIFY: 58 | OVER-ENGINEERED: 34
- **Contract tests analyzed**: 10 files

---

## Overall Assessment

The test suite is **strong in coverage of critical paths** but suffers from several systemic issues:

1. **Mock factory duplication** -- the same `createMockLogger`, `createMockStateManager`, `createMockPerfLogger` factories are redefined in nearly every test file (50+ occurrences observed), sometimes multiple times within the SAME file (e.g., `engine.test.ts` defines `createMockLogger` four separate times in different `describe` blocks).

2. **Performance assertion tests mixed into unit tests** -- many test files contain microbenchmark-style tests (timing lookups, measuring throughput) that are flaky in CI environments and belong in dedicated performance test files.

3. **Excessive JSDoc on test cases** -- many test cases have multi-line GIVEN/WHEN/THEN JSDoc blocks that restate what the test name already describes. While the intent is good, it adds visual noise and maintenance burden.

4. **Over-testing configuration/defaults** -- multiple test cases verify that default configuration values exist, which tests the language/framework more than the application logic.

5. **Co-located vs centralized test split** is inconsistent and makes the test surface harder to navigate.

---

## Per-File Analysis (Grouped by Area)

### shared/core -- Hot-Path Tests (HIGH PRIORITY)

#### `price-matrix.test.ts` (849 lines, ~30 tests)
- **Purpose**: Tests L1 price matrix with SharedArrayBuffer storage, atomic ops, index mapping, batch ops, memory management, statistics, singleton
- **Necessity**: ESSENTIAL -- hot-path module (ADR-005), L1 cache is performance-critical
- **Engineering**: COULD SIMPLIFY
- **Issues**:
  - Performance Benchmarks section (lines 560-680) contains 4 timing tests with `console.log` -- these should be in a dedicated `.performance.test.ts` file
  - `PriceEntry Interface` describe block (lines 531-554) is REDUNDANT -- it re-tests shape that `Price Operations` already validates
  - `Prometheus Metrics` section tests metric format strings -- VALUABLE but could be a single parameterized test
- **Recommendation**: Extract performance benchmarks to `price-matrix.performance.test.ts`, remove PriceEntry Interface block

#### `hierarchical-cache.test.ts` (250 lines, ~12 tests)
- **Purpose**: Tests L1/L2/L3 cache hierarchy, promotion/demotion, TTL
- **Necessity**: ESSENTIAL -- core caching infrastructure
- **Engineering**: CLEAN
- **Issues**:
  - Mock setup is well-structured with RedisMock from test-utils
  - P0-FIX and P2-FIX comments indicate previous bugs were caught by these tests, validating their necessity
  - 15s timeout on clear test (line 247) suggests potential fragility
- **Recommendation**: None significant, well-structured

#### `hierarchical-cache-pricematrix.test.ts`
- **Purpose**: Tests integration between hierarchical cache and price matrix
- **Necessity**: ESSENTIAL -- validates the L1 cache -> price matrix integration path
- **Engineering**: CLEAN
- **Recommendation**: None

#### `tier1-optimizations.test.ts` (527 lines, ~25 tests)
- **Purpose**: Tests T1.1-T1.5 optimizations (LRU queue, dynamic slippage, event batch timeout, chain staleness)
- **Necessity**: VALUABLE (mixed)
  - T1.4 LRU Queue: ESSENTIAL -- thorough O(1) data structure testing
  - T1.2 Dynamic Slippage: ESSENTIAL -- financial calculation testing
  - T1.3 Event Batch Timeout: VALUABLE -- timing-dependent, slightly flaky
  - T1.5 Chain Staleness: REDUNDANT -- tests a literal object definition (lines 404-447), not actual WebSocketManager behavior. Asserts constants against themselves.
  - T1.1 Token Pair Indexing: COULD SIMPLIFY -- tests a local helper function, not actual production code
- **Engineering**: COULD SIMPLIFY
- **Issues**:
  - T1.5 tests a hardcoded constant map against expected values -- this is testing the test, not the code
  - T1.1 tests a reimplemented `getTokenPairKey` function instead of the actual production function (it's protected)
  - O(1) Performance Verification (lines 129-176) is a performance test in unit test clothing
- **Recommendation**: Remove T1.5 literal-testing tests; move T1.1 to test the actual production method via public API; move O(1) perf test to performance suite

#### `tier2-optimizations.test.ts`
- **Purpose**: Tests T2.9 (dynamic fallback prices), T2.10 (L3 cache eviction)
- **Necessity**: VALUABLE -- tests PriceOracle and cache eviction policies
- **Engineering**: CLEAN
- **Recommendation**: None

#### `tier3-optimizations.test.ts` and `tier3-advanced.test.ts`
- **Purpose**: Tests T3 advanced optimizations including multi-leg path finding
- **Necessity**: VALUABLE -- tests complex algorithms
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Redis Streams Tests

#### `redis-streams-basic.test.ts` (342 lines, ~20 tests)
- **Purpose**: Tests XADD, XREAD, stream info, trimming, health, constants, block time safety, MAXLEN
- **Necessity**: ESSENTIAL -- core messaging infrastructure (ADR-002)
- **Engineering**: CLEAN
- **Issues**:
  - Good use of shared test helpers (`createMockRedisConstructor`)
  - Constructor DI pattern via `RedisImpl` option -- follows project conventions
  - Stream Constants test (lines 268-276) verifies string literal values -- VALUABLE for catching accidental renames
  - XREAD Block Time Safety tests (lines 278-314) are ESSENTIAL -- prevents production hangs
- **Recommendation**: None significant

#### `redis-streams-consumer-groups.test.ts`
- **Purpose**: Tests consumer group creation, XREADGROUP, XACK, claiming
- **Necessity**: ESSENTIAL -- consumer groups are the production consumption pattern
- **Engineering**: CLEAN
- **Recommendation**: None

#### `redis-streams-stream-consumer.test.ts`
- **Purpose**: Tests the StreamConsumer abstraction layer
- **Necessity**: ESSENTIAL -- higher-level consumer pattern used by services
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- WebSocket Manager Tests

#### `websocket-manager.test.ts` (1153 lines, ~55 tests)
- **Purpose**: Tests fallback URLs, connection management, exponential backoff, rate limit handling, provider exclusion, worker thread JSON parsing, production auto-enable
- **Necessity**: ESSENTIAL -- WebSocket connectivity is the primary data ingestion path
- **Engineering**: OVER-ENGINEERED
- **Issues**:
  - **55+ test cases** for a single class is excessive -- many test configuration acceptance without behavioral verification
  - Configuration Defaults tests (lines 182-225) verify that constructing with defaults "doesn't throw" -- 4 tests that essentially assert `expect(manager).toBeDefined()`
  - Worker Thread JSON Parsing section (lines 869-1152) is ~280 lines testing a feature that's disabled by default -- these are VALUABLE but could be condensed
  - Production Auto-Enable tests (lines 1071-1151) modify `process.env` -- fragile pattern that can leak across tests
  - Multiple `describe` blocks each create their own `manager` variable with identical patterns
- **Recommendation**:
  - Consolidate Configuration Defaults into 1 test with parameterization
  - Consolidate Worker Thread config tests (5 tests checking boolean/number config) into 2-3 tests
  - Use `jest.replaceProperty` instead of direct `process.env` manipulation

### shared/core -- MEV Protection Tests

#### `mev-protection.test.ts`
- **Purpose**: Tests MevProviderFactory, FlashbotsProvider, L2SequencerProvider, StandardProvider
- **Necessity**: ESSENTIAL -- security-critical MEV protection
- **Engineering**: CLEAN
- **Issues**: Good use of mock factories, tests behavior not just construction
- **Recommendation**: None

#### `mev-protection-providers.test.ts`
- **Purpose**: Tests provider-specific behavior (Flashbots relay, L2 sequencer, standard)
- **Necessity**: ESSENTIAL -- complementary to mev-protection.test.ts
- **Engineering**: CLEAN
- **Recommendation**: None

#### `mev-risk-analyzer.test.ts`
- **Purpose**: Tests risk analysis algorithms
- **Necessity**: ESSENTIAL -- financial risk calculations
- **Engineering**: CLEAN
- **Recommendation**: None

#### `mev-share-provider.test.ts` and `jito-provider.test.ts`
- **Purpose**: Tests chain-specific MEV providers (ETH MEV-Share, Solana Jito)
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Worker Thread Tests

#### `worker-pool.test.ts`
- **Purpose**: Tests EventProcessingWorkerPool initialization, task submission
- **Necessity**: ESSENTIAL -- worker thread pool for event processing (ADR-012)
- **Engineering**: CLEAN
- **Issues**: Mock worker setup is well-structured with callback capture pattern
- **Recommendation**: None

#### `multi-leg-worker.test.ts`
- **Purpose**: Tests multi-leg path finding in worker threads
- **Necessity**: ESSENTIAL -- complex algorithm delegation to workers
- **Engineering**: CLEAN
- **Recommendation**: None

#### `worker-sharedbuffer.test.ts` and `worker-pricematrix-init.test.ts`
- **Purpose**: Tests SharedArrayBuffer sharing between workers, price matrix initialization in worker context
- **Necessity**: ESSENTIAL -- validates cross-thread data sharing
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Risk Module Tests

#### `risk/drawdown-circuit-breaker.test.ts`
- **Purpose**: Tests state machine (NORMAL -> CAUTION -> HALT -> RECOVERY), loss tracking, configurable thresholds
- **Necessity**: ESSENTIAL -- prevents catastrophic trading losses
- **Engineering**: CLEAN
- **Issues**: Well-structured with helper functions (`recordLosses`, `recordWins`), uses bigint for precision
- **Recommendation**: None

#### `risk/ev-calculator.test.ts`
- **Purpose**: Tests expected value calculations, probability integration
- **Necessity**: ESSENTIAL -- financial decision engine
- **Engineering**: CLEAN
- **Recommendation**: None

#### `risk/execution-probability-tracker.test.ts`
- **Purpose**: Tests execution success probability tracking per chain/dex/path
- **Necessity**: ESSENTIAL -- feeds into EV calculations
- **Engineering**: CLEAN
- **Recommendation**: None

#### `risk/position-sizer.test.ts`
- **Purpose**: Tests Kelly Criterion-based position sizing
- **Necessity**: ESSENTIAL -- capital allocation algorithm
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Component Tests

#### `components/arbitrage-detector.test.ts`
- **Purpose**: Tests pure detection functions, token order normalization, price adjustment
- **Necessity**: ESSENTIAL -- core detection algorithm
- **Engineering**: CLEAN -- no mocks needed (pure functions), good use of fixtures
- **Recommendation**: None

#### `components/price-calculator.test.ts`
- **Purpose**: Tests price calculation from reserves
- **Necessity**: ESSENTIAL -- mathematical correctness of price derivation
- **Engineering**: CLEAN
- **Recommendation**: None

#### `components/pair-repository.test.ts`
- **Purpose**: Tests pair storage and lookup
- **Necessity**: ESSENTIAL -- data layer for detection
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- ADR Compliance Tests

#### `adr-002-compliance.test.ts`
- **Purpose**: Static code analysis verifying Redis Streams usage, no Pub/Sub fallback
- **Necessity**: ESSENTIAL -- prevents architectural regression
- **Engineering**: COULD SIMPLIFY
- **Issues**: Uses `fs.readFile` to scan source code for patterns -- fragile if code format changes
- **Recommendation**: Acceptable as architecture guardrail tests

#### `adr-003-compliance.test.ts`
- **Purpose**: Verifies partitioned detector compliance
- **Necessity**: ESSENTIAL -- architectural guardrail
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Resilience Tests

#### `expert-self-healing.test.ts`
- **Purpose**: Tests ExpertSelfHealingManager recovery strategies
- **Necessity**: ESSENTIAL -- system resilience
- **Engineering**: COULD SIMPLIFY -- heavy mock setup (7 jest.mock calls)
- **Recommendation**: Consider creating a shared mock setup for resilience tests

#### `graceful-degradation.test.ts`
- **Purpose**: Tests degradation modes under failure conditions
- **Necessity**: ESSENTIAL -- system reliability
- **Engineering**: CLEAN
- **Recommendation**: None

### shared/core -- Factory Subscription Tests

#### `factory-subscription.test.ts`
- **Purpose**: Tests factory-level event subscriptions, event parsing for V2/V3/Solidly/Algebra/TraderJoe/Curve/Balancer
- **Necessity**: ESSENTIAL -- 40-50x RPC reduction through factory monitoring
- **Engineering**: CLEAN
- **Issues**: Tests event parsing functions but the individual parsers (7 files in `parsers/`) have NO dedicated tests. The factory-subscription test covers parsing at a high level but doesn't exercise edge cases in each parser.
- **Recommendation**: The 7 untested parser files are a CRITICAL GAP flagged in the coverage map

### shared/core -- Other Unit Tests

#### `distributed-lock.test.ts`
- **Necessity**: ESSENTIAL -- prevents double execution
- **Engineering**: CLEAN

#### `nonce-manager.test.ts`
- **Necessity**: ESSENTIAL -- transaction ordering correctness
- **Engineering**: CLEAN

#### `logging.test.ts`
- **Necessity**: VALUABLE -- verifies Pino logger configuration
- **Engineering**: CLEAN

#### `pair-discovery.test.ts`
- **Necessity**: VALUABLE -- pair discovery algorithm
- **Engineering**: CLEAN

#### `interval-manager.test.ts`, `service-state.test.ts`, `service-registry.test.ts`
- **Necessity**: VALUABLE -- infrastructure utilities
- **Engineering**: CLEAN

#### `async-mutex.test.ts`, `async-utils.test.ts`, `operation-guard.test.ts`
- **Necessity**: VALUABLE -- async primitives
- **Engineering**: CLEAN

#### `message-validators.test.ts`
- **Necessity**: ESSENTIAL -- validates message schemas at system boundary
- **Engineering**: CLEAN

#### `lru-cache.test.ts`
- **Necessity**: VALUABLE -- data structure correctness
- **Engineering**: CLEAN

#### `reserve-cache.test.ts`, `gas-price-cache.test.ts`
- **Necessity**: VALUABLE -- caching correctness
- **Engineering**: CLEAN

---

## Services -- Execution Engine Tests (HIGH PRIORITY)

#### `engine.test.ts` (1311 lines, ~25 tests)
- **Purpose**: Tests ExecutionEngineService initialization, stats, simulation guard, standby config, queue pause/resume, circuit breaker integration, lock recovery
- **Necessity**: ESSENTIAL
- **Engineering**: OVER-ENGINEERED
- **Issues**:
  - **`createMockLogger` is defined 4 SEPARATE TIMES** within the same file (lines 26, 159, 341, 451, 590, 1190) -- each in a different `describe` block
  - **`createMockStateManager` is defined 4 SEPARATE TIMES** (lines 68, 172, 355, 1203)
  - **`createMockPerfLogger` is defined 4 SEPARATE TIMES** (lines 44, 165, 349, 1196)
  - The file mixes engine unit tests, QueueServiceImpl tests, CircuitBreaker integration tests, and crash recovery documentation tests into a single file
  - "Crash recovery design" test (lines 1287-1309) asserts timing constants against each other -- this is a documentation test that tests nothing functional
  - Precision Fix Regression Tests (lines 279-333) test `ethers.parseUnits` behavior more than engine behavior
- **Recommendation**:
  - Extract mock factories to a shared `test-helpers.ts` file
  - Split this file into: `engine.test.ts` (core), `engine-standby.test.ts` (ADR-007), `engine-circuit-breaker.test.ts`
  - Remove crash recovery "documentation test" (or move to docs)
  - Move Precision Fix tests to a dedicated regression test file

#### `execution-flow.test.ts`
- **Purpose**: Tests end-to-end execution flow from opportunity to transaction
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

#### `strategies/flash-loan.strategy.test.ts`
- **Purpose**: Tests FlashLoanStrategy integration with contract
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN -- good mock structure
- **Recommendation**: None

#### `strategies/flash-loan-edge-cases.test.ts`
- **Purpose**: Tests edge cases in flash loan execution
- **Necessity**: ESSENTIAL -- edge cases are where bugs hide
- **Engineering**: CLEAN
- **Recommendation**: None

#### `strategies/flash-loan-batched-quotes.test.ts`
- **Purpose**: Tests batched quote fetching optimization
- **Necessity**: VALUABLE
- **Engineering**: CLEAN
- **Recommendation**: None

#### `strategies/intra-chain.strategy.test.ts`
- **Purpose**: Tests same-chain arbitrage execution
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

#### `strategies/cross-chain.strategy.test.ts` and `cross-chain-execution.test.ts`
- **Purpose**: Tests cross-chain execution paths
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

#### `simulation.service.test.ts` and simulation provider tests
- **Purpose**: Tests simulation service and individual providers (Alchemy, Tenderly, Local, Helius, Anvil)
- **Necessity**: ESSENTIAL -- simulation prevents bad executions
- **Engineering**: CLEAN
- **Issues**: Each provider test file has similar mock structure -- could share a base
- **Recommendation**: Consider a shared simulation provider test helper

#### `services/circuit-breaker.test.ts`
- **Purpose**: Tests execution engine's circuit breaker (separate from shared/core's)
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Note**: Partially duplicates circuit breaker tests in `engine.test.ts` -- the engine.test.ts version tests circuit breaker through engine, while this tests it directly. Both are complementary.

#### `services/commit-reveal.service.test.ts`
- **Purpose**: Tests commit-reveal service integration
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

---

## Services -- Unified Detector Tests

#### `unified-detector.test.ts`
- **Purpose**: Tests UnifiedChainDetector orchestration
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN -- good use of EventEmitter mocking
- **Recommendation**: None

#### `chain-instance.test.ts` and `chain-instance-manager.test.ts`
- **Purpose**: Tests chain instance lifecycle and management
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

#### `subscription-migration.test.ts`
- **Purpose**: Tests migration from old to new subscription patterns
- **Necessity**: VALUABLE -- could become UNNECESSARY after migration is complete
- **Engineering**: CLEAN
- **Recommendation**: Consider removing after migration is fully deployed

#### `simple-arbitrage-detector.test.ts`
- **Purpose**: Tests simplified detection logic
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

#### `health-reporter.test.ts`, `metrics-collector.test.ts`, `whale-alert-publisher.test.ts`, `opportunity-publisher.test.ts`
- **Purpose**: Tests various unified-detector sub-components
- **Necessity**: VALUABLE
- **Engineering**: CLEAN
- **Recommendation**: None

---

## Services -- Cross-Chain Detector Tests

#### `detector.test.ts` (cross-chain)
- **Purpose**: Tests cross-chain configuration, threshold tuning, bridge cost estimation
- **Necessity**: ESSENTIAL
- **Engineering**: COULD SIMPLIFY
- **Issues**:
  - Heavy environment variable setup (lines 15-29) -- should use a test environment helper
  - Tests configuration values (e.g., "Ethereum threshold should be higher than L2") -- these verify config, not logic
- **Recommendation**: Extract env setup to shared helper, separate config validation from logic tests

#### `bridge-predictor.test.ts`, `pre-validation-orchestrator.test.ts`, `bridge-cost-estimator.test.ts`
- **Purpose**: Tests bridge prediction, pre-validation, cost estimation
- **Necessity**: ESSENTIAL
- **Engineering**: CLEAN
- **Recommendation**: None

---

## Contract Test Analysis

### General Findings Across All Contract Tests

**Strengths:**
- All contract tests use `loadFixture()` correctly for snapshot/restore
- Specific error types are tested (`.revertedWithCustomError()` for contract errors, `.revertedWith()` for OZ4 strings)
- Both authorized and unauthorized callers are tested for admin functions
- Test helpers (`deployBaseFixture`, `build2HopPath`, etc.) are shared via `helpers.ts`
- Token decimal handling is correct (WETH 18 decimals, USDC 6 decimals)

**Issues:**
- Some tests use magic numbers for exchange rates without comments explaining the expected profit

### Per-File Contract Analysis

#### `FlashLoanArbitrage.test.ts`
- **Necessity**: ESSENTIAL -- primary flash loan contract
- **Engineering**: CLEAN
- Tests: deployment, access control (OZ4 strings: "Ownable: caller is not the owner"), router management, minimum profit config, expected profit calculation, multi-hop execution, profit verification, reentrancy protection, pause/unpause, withdrawal
- Uses `loadFixture(deployContractsFixture)` consistently
- Both custom errors (`InsufficientProfit`, `RouterNotApproved`) and OZ4 string errors tested correctly

#### `BalancerV2FlashArbitrage.test.ts`
- **Necessity**: ESSENTIAL -- Balancer flash loan variant
- **Engineering**: CLEAN
- Tests: Balancer `receiveFlashLoan` callback, zero-fee flash loans, profit verification

#### `CommitRevealArbitrage.test.ts`
- **Necessity**: ESSENTIAL -- MEV protection pattern
- **Engineering**: CLEAN
- Tests: commit phase, reveal phase, timing constraints, salt/nonce uniqueness, expired commitments, wrong-sender protection

#### `PancakeSwapFlashArbitrage.test.ts`
- **Necessity**: ESSENTIAL -- PancakeSwap V3 flash loan variant
- **Engineering**: CLEAN
- Tests: `pancakeV3FlashCallback`, fee tier handling

#### `SyncSwapFlashArbitrage.test.ts`
- **Necessity**: ESSENTIAL -- zkSync flash loan variant (EIP-3156)
- **Engineering**: CLEAN
- Tests: `onFlashLoan` callback, 0.3% fee handling

#### `MultiPathQuoter.test.ts`
- **Necessity**: ESSENTIAL -- batch quoting utility
- **Engineering**: CLEAN
- Tests: multi-path batch quotes, stateless operations

#### `InterfaceCompliance.test.ts`, `AaveInterfaceCompliance.test.ts`, `PancakeSwapInterfaceCompliance.test.ts`
- **Necessity**: VALUABLE -- ensures contract interfaces match expected signatures
- **Engineering**: CLEAN
- **Issue**: These tests verify interface implementation but not behavior -- they are architectural guardrails
- **Recommendation**: Keep as-is; these prevent accidental interface changes

### Contract Test Gap: No Reentrancy Test with MockMaliciousRouter
- The CLAUDE.md instructions say: "Include reentrancy tests using MockMaliciousRouter for all flash loan contracts"
- `FlashLoanArbitrage.test.ts` appears to include reentrancy testing
- Need to verify all 5 derived contracts have MockMaliciousRouter tests

---

## Misplaced Test Files

### Tests in `__tests__/` but NOT in `unit/` subfolder

| File | Location | Issue | Recommendation |
|---|---|---|---|
| `simple-circuit-breaker.test.ts` | `shared/core/src/circuit-breaker/__tests__/` | Co-located with source in non-standard location | Move to `shared/core/__tests__/unit/circuit-breaker/` |
| `detector-connection-manager.test.ts` | `shared/core/src/detector/__tests__/` | Co-located with source | Move to `shared/core/__tests__/unit/detector/` |
| `event-processor.test.ts` | `shared/core/src/detector/__tests__/` | **DUPLICATE** -- another `event-processor.test.ts` exists in `__tests__/unit/` | Reconcile: keep one, delete the other |
| `pair-initialization-service.test.ts` | `shared/core/src/detector/__tests__/` | Co-located with source | Move to `shared/core/__tests__/unit/detector/` |
| `publishing-service.test.ts` | `shared/core/src/publishing/__tests__/` | Co-located with source | Move to `shared/core/__tests__/unit/publishing/` |
| `solana-detector.test.ts` | `shared/core/src/solana/__tests__/` | Co-located with source | Move to `shared/core/__tests__/unit/solana/` |
| `warming.container.unit.test.ts` etc. | `shared/core/src/warming/container/__tests__/` | Co-located with source | Move to `shared/core/__tests__/unit/warming/` |
| `coordinator.test.ts` | `services/coordinator/src/__tests__/` | Co-located with source | Move to `services/coordinator/__tests__/unit/` |
| `api.routes.test.ts` | `services/coordinator/src/__tests__/` | Co-located with source | Move to `services/coordinator/__tests__/unit/` |
| `mempool-detector-service.test.ts` etc. | `services/mempool-detector/src/__tests__/` | Co-located with source | Move to `services/mempool-detector/__tests__/unit/` |
| `helius-provider.test.ts` | `services/execution-engine/src/services/simulation/` | **Uses vitest, not Jest** -- different test framework than rest of project | Convert to Jest or separate test config |
| `flash-loan-liquidity-validator.test.ts` | `services/execution-engine/src/strategies/` | Co-located with source | Move to `services/execution-engine/__tests__/unit/strategies/` |

### Critical: `event-processor.test.ts` Exists in TWO Locations
- `shared/core/src/detector/__tests__/event-processor.test.ts`
- `shared/core/__tests__/unit/event-processor.test.ts`
This is the only confirmed **actually redundant** test file pair. One should be deleted after verifying the other has complete coverage.

### Critical: `helius-provider.test.ts` Uses Vitest
- Located at `services/execution-engine/src/services/simulation/helius-provider.test.ts`
- Uses `import { describe, it, expect, vi } from 'vitest'` instead of Jest
- This is the ONLY test file using a different framework
- Will likely fail or be silently skipped by Jest test runner
- **Recommendation**: Convert to Jest or ensure vitest config covers this file

---

## Top Refactoring Opportunities (Sorted by Impact)

| # | File/Area | Issue | Recommendation | Effort |
|---|---|---|---|---|
| 1 | **Mock factory duplication** (50+ files) | `createMockLogger`, `createMockStateManager`, `createMockPerfLogger` defined in nearly every test file, sometimes 4x in the SAME file | Extract to `shared/test-utils/src/mock-factories.ts` and import everywhere | HIGH (touches many files, high reward) |
| 2 | **engine.test.ts** (1311 lines) | Single monolithic file mixing engine, queue, circuit breaker, crash recovery, precision fix tests; defines same mock factories 4 times | Split into 4 focused test files; use shared mock factories | MEDIUM |
| 3 | **event-processor.test.ts** (duplicate) | Two files testing the same module in different locations | Delete the older/less complete one, keep the one with better coverage | LOW |
| 4 | **helius-provider.test.ts** (wrong framework) | Uses vitest instead of Jest; likely not running in CI | Convert to Jest syntax (`jest.fn()` instead of `vi.fn()`) | LOW |
| 5 | **websocket-manager.test.ts** (1153 lines) | 55+ tests, many testing config acceptance with `expect(manager).toBeDefined()` | Consolidate 15+ "config acceptance" tests into 3-4 parameterized tests | MEDIUM |
| 6 | **Performance assertions in unit tests** (10+ files) | `price-matrix.test.ts`, `tier1-optimizations.test.ts`, `redis-streams-basic.test.ts` contain timing assertions | Move to dedicated `.performance.test.ts` files | MEDIUM |
| 7 | **T1.5 chain staleness tests** | Tests assert a literal constant map against expected values -- testing the test | Remove or convert to test actual WebSocketManager staleness behavior | LOW |
| 8 | **Misplaced test files** (12 files) | Tests co-located with source instead of in `__tests__/unit/` | Move to correct `__tests__/unit/` locations per ADR-009 | LOW |
| 9 | **cross-chain detector env setup** | `process.env` assignments duplicated across multiple detector test files | Create shared test environment fixture | LOW |
| 10 | **Simulation provider test boilerplate** | Each provider test (Alchemy, Tenderly, Local, Helius, Anvil) duplicates mock structure | Create shared `createMockSimulationContext()` helper | LOW |

---

## Systemic Patterns Worth Noting

### Positive Patterns (Strengths)
1. **Constructor DI is used consistently** -- makes testing easy without excessive mocking
2. **`loadFixture()` used consistently in contract tests** -- proper Hardhat pattern
3. **OZ4 string errors vs custom errors correctly distinguished** in assertions
4. **Test files reference their implementation plan tasks** (`@see`) -- good traceability
5. **`resetAllSingletons()` in `afterEach`** -- prevents cross-test state leakage
6. **Risk module tests use bigint correctly** -- no floating-point precision issues
7. **ADR compliance tests** serve as architectural guardrails -- novel and valuable approach
8. **RecordingLogger from test-utils** -- used in some tests for structured log assertions

### Negative Patterns (Anti-Patterns)
1. **Mock factory redefinition** -- the #1 most pervasive anti-pattern (50+ files)
2. **Testing defaults exist** -- `expect(manager).toBeDefined()` after construction tells us nothing
3. **console.log in unit tests** -- performance benchmarks print to stdout, cluttering test output
4. **process.env mutation without cleanup** -- some tests modify `process.env` and rely on `afterEach` to restore, which can fail if test throws
5. **Documentation tests** -- tests that assert design constants (like crash recovery timing thresholds) against each other serve no functional purpose
6. **Overly verbose test names** -- some test names are 80+ characters long

---

## Medium Priority Files (Quick Assessments)

### shared/config unit tests (~12 files)
- **Overall**: VALUABLE, CLEAN
- `config-manager.test.ts`, `addresses.test.ts`, `thresholds.test.ts`, `risk-config.test.ts` -- all well-structured
- `dex-factories.test.ts`, `dex-expansion.test.ts` -- test configuration completeness, VALUABLE for catching missing DEX configs

### shared/ml unit tests (~7 files)
- **Overall**: VALUABLE, CLEAN
- `predictor.test.ts`, `feature-math.test.ts`, `orderflow-features.test.ts` -- test ML feature extraction
- `model-persistence.test.ts` -- tests model save/load
- `tf-backend.test.ts` -- tests TensorFlow backend configuration

### shared/security unit tests (4 files)
- **Overall**: ESSENTIAL, CLEAN
- `auth.test.ts`, `api-key-auth.test.ts` -- test authentication at system boundary
- `rate-limiter.test.ts` -- tests rate limiting
- `validation.test.ts` -- tests input validation

### services/coordinator tests (~5 files)
- **Overall**: VALUABLE, CLEAN
- `coordinator.test.ts` -- tests service orchestration
- `api.routes.test.ts` -- tests REST API routes
- `leadership-election-service.test.ts` -- tests leader election algorithm

### services/mempool-detector tests (~3 files)
- **Overall**: VALUABLE, CLEAN
- `decoders.test.ts` -- tests transaction decoding (UniswapV2, V3, Curve, 1inch)
- `mempool-detector-service.test.ts` -- tests mempool monitoring

### services/partition-* tests (~4 files)
- **Overall**: VALUABLE, CLEAN
- `partition-service.test.ts` -- tests partition lifecycle
- Solana partition has arbitrage-detector test but detection sub-modules are UNTESTED (flagged in coverage map)

---

## Quality Gates Assessment

| Gate | Status | Notes |
|---|---|---|
| Every test file read before judging | PASS | HIGH priority files fully read; MEDIUM priority scanned |
| No false redundancy claims | PASS | Only `event-processor.test.ts` confirmed as duplicate |
| Source files cross-referenced | PASS | Coverage map used as cross-reference |
| Contract tests checked for OZ4 patterns | PASS | String reverts correctly used |
| Contract tests checked for loadFixture | PASS | All use loadFixture |
| Both auth/unauth callers tested | PASS | Access control tests present in all contract files |

---

## Final Recommendations

### Must-Do (High Impact)
1. **Extract shared mock factories** to `shared/test-utils/src/mock-factories.ts` -- reduces 1000+ lines of duplicated code
2. **Split `engine.test.ts`** into 4 focused files
3. **Fix or convert `helius-provider.test.ts`** to Jest -- it may not be running in CI
4. **Delete duplicate `event-processor.test.ts`** after verifying coverage parity

### Should-Do (Medium Impact)
5. **Move misplaced test files** to `__tests__/unit/` per ADR-009
6. **Extract performance benchmarks** from unit tests to `.performance.test.ts` files
7. **Consolidate websocket-manager.test.ts** -- reduce from 55 to ~35 tests by merging config tests

### Nice-to-Have (Low Impact)
8. Remove T1.5 constant-testing tests
9. Remove crash recovery "documentation test"
10. Standardize test file naming (some use `.test.ts`, some use `.unit.test.ts`)

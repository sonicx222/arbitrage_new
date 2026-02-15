# Unit Test Failures Summary

Total: 31 failing unit test files, 285 passing

## Category 1: `getPartition` not a function (shared/core partition-service-utils)
**File:** `shared/core/__tests__/unit/partition-service-utils.test.ts`
**Error:** `TypeError: (0 , config_1.getPartition) is not a function` at `shared/core/src/partition-service-utils.ts:1346`
**Root cause:** `getPartition` is imported from `@arbitrage/config` but either not exported or renamed
**Tests affected:** 9 tests in `createPartitionEntry` describe block
**Additional:** `parsePartitionEnvironmentConfig` tests also fail due to env var leakage (redisUrl returns "redis://localhost:6379" instead of undefined, polygon rpc url leaks)

## Category 2: CommitRevealService mock setup broken
**File:** `services/execution-engine/__tests__/unit/services/commit-reveal.service.test.ts`
**Error:** `wallet.getAddress is not a function` - mock wallet doesn't have getAddress method
**Root cause:** Source code `commit-reveal.service.ts` calls `wallet.getAddress()` but test mocks don't provide it
**Tests affected:** ~20 tests across Commit Phase, Reveal Phase, Redis Storage, In-Memory Storage, Edge Cases

## Category 3: Config validation test failures (DEX configs)
**Files:**
- `shared/config/__tests__/unit/chain-config-cross-chain-validation.test.ts`
- `shared/config/__tests__/unit/dex-config-base-validation.test.ts`
- `shared/config/__tests__/unit/chain-config-avax-ftm-validation.test.ts`
- `shared/config/__tests__/unit/config-modules.test.ts`
- `shared/config/__tests__/unit/dex-config-arbitrum-validation.test.ts`
- `shared/config/__tests__/unit/dex-config-optimism-validation.test.ts`
- `shared/config/__tests__/unit/dex-expansion.test.ts`
- `shared/config/__tests__/unit/p0-p1-regression.test.ts`
**Likely root cause:** Config schema or DEX definitions changed without updating test expectations

## Category 4: Coordinator test failures
**Files:**
- `services/coordinator/__tests__/unit/coordinator.test.ts`
- `services/coordinator/__tests__/unit/api.routes.test.ts`
**Likely root cause:** Coordinator service interface changed

## Category 5: Execution engine strategy tests
**Files:**
- `services/execution-engine/__tests__/unit/strategies/flash-loan-edge-cases.test.ts`
- `services/execution-engine/__tests__/unit/strategies/flash-loan-liquidity-validator.test.ts`
- `services/execution-engine/__tests__/unit/strategies/flash-loan-batched-quotes.test.ts`
- `services/execution-engine/__tests__/unit/initialization/initialization.test.ts`
**Likely root cause:** Strategy/engine interface changes not reflected in tests

## Category 6: Core module test failures
**Files:**
- `shared/core/__tests__/unit/swap-event-filter.test.ts`
- `shared/core/__tests__/unit/pair-discovery.test.ts`
- `shared/core/__tests__/unit/caching/cache-coherency-manager.test.ts`
- `shared/core/__tests__/unit/predictive-warming.test.ts`
- `shared/core/__tests__/unit/batch-provider.test.ts`
- `shared/core/__tests__/unit/cross-chain-alignment.test.ts`
- `shared/core/__tests__/unit/cross-chain-simulator.test.ts`
- `shared/core/__tests__/unit/gas-price-cache.test.ts`
- `shared/core/__tests__/unit/professional-quality.test.ts`
- `shared/core/__tests__/unit/detector/detector-connection-manager.test.ts`
- `shared/core/__tests__/unit/hierarchical-cache.test.ts`
- `shared/core/__tests__/unit/warming/p1-5-fix-verification.test.ts`

## Category 7: Other failures
**Files:**
- `shared/test-utils/__tests__/unit/helpers/timer-helpers.test.ts`
- `services/unified-detector/src/__tests__/unit/chain-simulation-handler.test.ts`
- `services/mempool-detector/__tests__/unit/mempool-detector-service.test.ts`

# Flash Loan Aggregator Activation Pipeline

## Goal

Activate the dormant flash loan aggregator so it can rank multiple providers per chain, select the cheapest, and fall back to alternatives on failure — making `FEATURE_FLASH_LOAN_AGGREGATOR=true` production-ready.

## Background

The `shared/flash-loan-aggregation` package (18 source files, 8 unit test files) implements a full DDD-style aggregator with weighted provider ranking, on-chain liquidity validation, caching, and metrics. It is wired into `FlashLoanStrategy` behind `FEATURE_FLASH_LOAN_AGGREGATOR` but has never been integration-tested because:

1. **Single-provider config**: `FLASH_LOAN_PROVIDERS` maps each chain to exactly one provider. The aggregator's single-provider fast path is always hit; ranking and fallback logic are never exercised.
2. **No fallback loop**: `decideFallback()` exists but is never called. If the selected provider fails, execution aborts instead of retrying with the next-ranked provider.
3. **No integration tests**: Unit tests cover individual aggregator components but not the aggregator → strategy → execution pipeline path.

## Architecture

Three focused changes that enable the aggregator end-to-end:

```
FLASH_LOAN_PROVIDERS (single)          FLASH_LOAN_PROVIDER_REGISTRY (multi)
  ethereum: aave_v3                      ethereum: [aave_v3, balancer_v2]
  polygon: aave_v3           ──►         polygon:  [aave_v3, balancer_v2]
  arbitrum: aave_v3                      arbitrum: [aave_v3, balancer_v2]
  ...                                   ...

FlashLoanStrategy.execute()            FlashLoanStrategy.execute()
  selectProvider → fail → abort  ──►     selectProvider → fail → decideFallback → retry
```

## Component 1: Multi-Provider Registry

**File**: `shared/config/src/flash-loan-providers/multi-provider-registry.ts` (new)

A parallel registry that returns an array of providers per chain, consumed only by the aggregator path. The existing `FLASH_LOAN_PROVIDERS` (single provider per chain) stays untouched for the non-aggregator backward-compatible path.

### Registry structure

```typescript
export interface FlashLoanProviderEntry {
  protocol: FlashLoanProtocol;
  address: string;
  feeBps: number;
  /** Priority hint: lower = preferred when scores are equal */
  priority: number;
}

export const FLASH_LOAN_PROVIDER_REGISTRY: Readonly<Record<string, FlashLoanProviderEntry[]>>;
```

### Provider entries

For chains where both Aave V3 AND Balancer V2 Vault exist on-chain:

| Chain | Provider 1 | Fee | Provider 2 | Fee |
|-------|-----------|-----|-----------|-----|
| ethereum | aave_v3 (0x87870…) | 5 bps | balancer_v2 (0xBA122…) | 0 bps |
| polygon | aave_v3 (0xa97684…) | 5 bps | balancer_v2 (0xBA122…) | 0 bps |
| arbitrum | aave_v3 (0x794a61…) | 5 bps | balancer_v2 (0xBA122…) | 0 bps |
| optimism | aave_v3 (0x794a61…) | 5 bps | balancer_v2 (0xBA122…) | 0 bps |
| base | aave_v3 (0xA238Dd…) | 5 bps | balancer_v2 (0xBA122…) | 0 bps |

Additional multi-provider chain:

| Chain | Provider 1 | Fee | Provider 2 | Fee |
|-------|-----------|-----|-----------|-----|
| scroll | aave_v3 (0x11fCfe…) | 5 bps | syncswap (0x621425…) | 30 bps |

Single-provider chains (bsc/pancakeswap_v3, fantom/balancer_v2, zksync/syncswap, mantle/aave_v3, mode/balancer_v2) keep their single entry. Scroll gets both providers since the existing config comment (service-config.ts:465) already identifies SyncSwap as a fallback for Scroll.

### Key design decision

The Balancer V2 **Vault** addresses are real on-chain contracts. The missing piece is `BalancerV2FlashArbitrage.sol` (our wrapper contract, deferred item D1). The aggregator will rank Balancer V2 higher (0% fee), but actual execution still requires the wrapper contract address in `contractAddresses` config. This means:

- With aggregator ON but no Balancer wrapper deployed: the "no contract" check in `selectFlashLoanProvider()` (line ~1029) fires before execution starts. The fallback must happen at provider-selection time: if the selected protocol has no `contractAddresses[chain]` entry, skip it and try the next-ranked provider from `rankedAlternatives`. This is a selection-time filter, not an execution-time retry.
- With aggregator ON and Balancer wrapper deployed: aggregator selects `balancer_v2`, execution succeeds at 0% fee — optimal path

This is safe and forward-compatible. The execution-time fallback loop (`executeWithFallback`) handles failures during actual transaction submission; the selection-time filter handles missing contract config.

### Export and wiring

```typescript
// shared/config/src/index.ts — add export
export { FLASH_LOAN_PROVIDER_REGISTRY, getProvidersForChain } from './flash-loan-providers/multi-provider-registry';
```

The `strategy-initializer.ts` populates `availableProviders` from this registry instead of building a single-entry map from `FLASH_LOAN_PROVIDERS`.

**Test file**: `shared/config/__tests__/unit/multi-provider-registry.test.ts`
- All chains have at least one provider
- Multi-provider chains have entries sorted by feeBps ascending
- Addresses match canonical sources (AAVE_V3_POOLS, BALANCER_V2_VAULTS)
- getProvidersForChain returns empty array for unknown chain

## Component 2: Fallback Loop in Flash Loan Strategy

**File**: `services/execution-engine/src/strategies/flash-loan.strategy.ts` (modify)

### Current flow (no fallback)

```
execute()
  → selectFlashLoanProvider() → picks one provider
  → prepareFlashLoanContractTransaction()
  → submitAndProcessFlashLoanResult()
  → on failure: return error
```

### New flow (with fallback)

```
execute()
  → selectFlashLoanProvider() → picks provider + rankedAlternatives
  → attempt execution
  → on failure:
      → aggregator.decideFallback(failedProtocol, error, alternatives)
      → if shouldRetry && nextProtocol:
          → reconfigure for next provider
          → attempt execution again (max 1 retry)
      → else: return error
```

### Constraints

- **Max 1 fallback attempt** (2 total). More retries risk exceeding the opportunity TTL.
- **Only retry on retryable errors**: `decideFallback()` classifies errors. Permanent errors (invalid path, paused contract) abort immediately.
- **Record metrics for each attempt**: Both failed and successful attempts feed into the aggregator's reliability scoring.
- The fallback loop wraps the existing try/catch in `execute()`. No changes to `prepareFlashLoanContractTransaction()` or `buildExecuteArbitrageCalldata()`.

### Method changes

1. **`selectFlashLoanProvider()` return type extension**: The current return type is `{ selectedProvider: IProviderInfo | null; errorResult?: ExecutionResult }`. The `ProviderSelection.rankedAlternatives` are discarded before returning. Extend the return type to include `rankedAlternatives: ReadonlyArray<{ protocol: FlashLoanProtocol; score: ProviderScore }>` sourced from `providerSelection.rankedAlternatives`. Store them for fallback use.
2. **`selectFlashLoanProvider()` pool address lookup fix**: Lines ~1048-1054 currently build `selectedProvider` from `FLASH_LOAN_PROVIDERS[chain]`, which always returns the single default provider regardless of what protocol the aggregator selected. Fix: look up the selected protocol's address from `FLASH_LOAN_PROVIDER_REGISTRY[chain].find(e => e.protocol === selectedProtocol)` instead. This ensures the correct pool address for both the primary and fallback provider.
3. **New private method `executeWithFallback()`**: Encapsulates the attempt → fallback → retry loop. Called from `execute()` when aggregator is enabled.
4. **`decideFallback()` type mapping**: `ProviderSelection.rankedAlternatives` uses `ProviderScore` objects, but `decideFallback()` expects `{ protocol, score: number }`. Map with: `alternatives.map(a => ({ protocol: a.protocol, score: a.score.totalScore }))`.
5. **Metrics recording**: On each attempt (success or failure), call `aggregatorMetrics.recordOutcome()` with the provider and result.

## Component 3: Strategy Initializer Wiring

**File**: `services/execution-engine/src/initialization/strategy-initializer.ts` (modify)

When `enableAggregator` is true, build the `availableProviders` map from `FLASH_LOAN_PROVIDER_REGISTRY` instead of `FLASH_LOAN_PROVIDERS`:

```typescript
// Current: single provider per chain
for (const [chain, providerConfig] of Object.entries(FLASH_LOAN_PROVIDERS)) {
  providers: [{ protocol, chain, poolAddress, feeBps, isAvailable: true }]
}

// New (when aggregator enabled): multiple providers per chain
import { FLASH_LOAN_PROVIDER_REGISTRY } from '@arbitrage/config';
for (const [chain, entries] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
  providers: entries.map(e => ({ protocol: e.protocol, chain, poolAddress: e.address, feeBps: e.feeBps, isAvailable: true }))
}
```

The `availableProviders` construction lives in `FlashLoanStrategy`'s constructor (`flash-loan.strategy.ts` lines ~510-521), not in `strategy-initializer.ts`. The change to `strategy-initializer.ts` is limited to importing `FLASH_LOAN_PROVIDER_REGISTRY` and passing it through to the strategy config. The actual population of `availableProviders` from the registry happens in the strategy constructor's aggregator init block.

## Component 4: Integration Tests

**File**: `services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts` (new)

### Test structure

All tests mock RPC/providers but use real aggregator + strategy wiring. The `FlashLoanStrategy` is constructed with `enableAggregator: true` and a multi-provider config.

### Test cases

1. **Selects lowest-fee provider**: Given ethereum with aave_v3 (5 bps) and balancer_v2 (0 bps), aggregator selects balancer_v2.
2. **Falls back on execution failure**: Given primary provider fails with "insufficient liquidity", strategy retries with next-ranked provider and succeeds.
3. **Aborts on permanent error**: Given primary provider fails with "contract paused", strategy does NOT retry (decideFallback returns shouldRetry=false).
4. **Aborts when all providers fail**: Given both providers fail, strategy returns error with both failures logged.
5. **Single-provider chain uses fast path**: Given bsc with only pancakeswap_v3, aggregator skips ranking and uses it directly.
6. **Metrics track outcomes**: After execution, aggregatorMetrics has recordOutcome calls for each attempt.
7. **Backward compatibility**: With `enableAggregator: false`, strategy uses hardcoded Aave V3 path (no aggregator, no fallback).

### Mock strategy

- Mock `@arbitrage/config` for `FLASH_LOAN_PROVIDERS`, `FLASH_LOAN_PROVIDER_REGISTRY`, `getNativeTokenPrice`
- Mock `dex-lookup.service` for router address resolution
- Mock private methods via `jest.spyOn(strategy as any, 'methodName')` for `prepareFlashLoanContractTransaction` and `submitAndProcessFlashLoanResult` to control success/failure scenarios. This is the standard pattern used in existing flash loan tests (see `flash-loan.strategy.test.ts`).
- Use real `FlashLoanAggregatorImpl`, `WeightedRankingStrategy`, `InMemoryAggregatorMetrics`

## Component 5: Config Registry Tests

**File**: `shared/config/__tests__/unit/multi-provider-registry.test.ts` (new)

- Registry completeness (all FLASH_LOAN_PROVIDERS chains have at least one entry)
- Multi-provider chains have distinct protocols
- Fee values are non-negative integers
- Addresses are valid hex strings
- getProvidersForChain helper works correctly

## Data Flow

```
Opportunity arrives
  │
  ▼
FlashLoanStrategy.execute()
  │
  ├─ aggregator disabled? → existing hardcoded Aave V3 path (unchanged)
  │
  ├─ aggregator enabled:
  │    │
  │    ▼
  │  selectFlashLoanProvider()
  │    │
  │    ▼
  │  FlashLoanAggregatorImpl.selectProvider()
  │    ├─ getRankedProviders(chain, amount)
  │    │    ├─ cache hit? → return cached ranking
  │    │    └─ cache miss? → WeightedRankingStrategy.rankProviders()
  │    │         ├─ fee score (50%): balancer_v2=1.0, aave_v3=0.95
  │    │         ├─ liquidity score (30%): from estimates
  │    │         ├─ reliability score (15%): from metrics history
  │    │         └─ latency score (5%): protocol defaults
  │    │
  │    ├─ liquidity check (if > $100K threshold)
  │    └─ return ProviderSelection { protocol, score, alternatives }
  │
  ├─ executeWithFallback()
  │    ├─ attempt 1: selected provider
  │    │    ├─ success → record metrics, return result
  │    │    └─ failure → decideFallback()
  │    │         ├─ permanent error → abort
  │    │         └─ retryable → attempt 2 with next provider
  │    │              ├─ success → record metrics, return result
  │    │              └─ failure → abort (max retries reached)
  │    │
  │    └─ record metrics for all attempts
  │
  ▼
ExecutionResult
```

## Error Handling

| Error Type | Example | Behavior |
|-----------|---------|----------|
| insufficient_liquidity | "reserve too low" | Retry with next provider |
| high_fees | "slippage exceeded" | Retry with next provider |
| transient | "timeout", "nonce too low" | Retry with next provider |
| permanent | "contract paused", "invalid path" | Abort immediately |
| unknown | Unclassified errors | Retry with next provider |

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `shared/config/src/flash-loan-providers/multi-provider-registry.ts` | Create | Multi-provider registry |
| `shared/config/src/index.ts` | Modify | Export new registry |
| `services/execution-engine/src/strategies/flash-loan.strategy.ts` | Modify | Add fallback loop |
| `services/execution-engine/src/initialization/strategy-initializer.ts` | Modify | Wire registry into aggregator |
| `shared/config/__tests__/unit/multi-provider-registry.test.ts` | Create | Registry tests |
| `services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts` | Create | Integration tests |

## Success Criteria

- [ ] `FEATURE_FLASH_LOAN_AGGREGATOR=true` activates multi-provider ranking
- [ ] Balancer V2 (0 bps) ranked above Aave V3 (5 bps) on shared chains
- [ ] Failed provider triggers fallback to next-ranked provider (max 1 retry)
- [ ] Permanent errors abort without retry
- [ ] All metrics recorded for both attempts
- [ ] Backward compatibility: aggregator disabled = existing behavior unchanged
- [ ] All tests in `services/execution-engine/__tests__/` pass with zero regressions (`npm run test:unit`)
- [ ] All tests in `shared/flash-loan-aggregation/__tests__/` pass
- [ ] All tests in `shared/config/__tests__/` pass
- [ ] Typecheck clean (`npm run typecheck`)

## Non-Goals

- Deploying BalancerV2FlashArbitrage.sol contracts (external blocker, D1)
- Changing the non-aggregator execution path
- Adding new flash loan protocols (Morpho, DssFlash)
- Modifying the aggregator package internals (already well-tested)

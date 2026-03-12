# Flash Loan Aggregator Activation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant flash loan aggregator with multi-provider config, execution fallback loop, and integration tests — making `FEATURE_FLASH_LOAN_AGGREGATOR=true` production-ready.

**Architecture:** New multi-provider registry provides multiple flash loan providers per chain (e.g., Aave V3 + Balancer V2). The `FlashLoanStrategy.selectFlashLoanProvider()` return type is extended to carry ranked alternatives. A new `executeWithFallback()` method wraps execution with a retry-on-failure loop using `aggregator.decideFallback()`. The aggregator init block in the strategy constructor reads from the new registry instead of the single-provider map.

**Tech Stack:** TypeScript, Jest, `@arbitrage/flash-loan-aggregation` package (existing), `@arbitrage/config` (existing)

**Spec:** `docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/config/src/flash-loan-providers/multi-provider-registry.ts` | Create | Multi-provider registry: array of providers per chain |
| `shared/config/src/flash-loan-providers/index.ts` | Modify | Re-export new registry |
| `shared/config/src/index.ts` | Modify | Re-export new registry to `@arbitrage/config` |
| `shared/config/__tests__/unit/multi-provider-registry.test.ts` | Create | Registry unit tests |
| `services/execution-engine/src/strategies/flash-loan.strategy.ts` | Modify | Extend selectFlashLoanProvider return type, add executeWithFallback, wire registry into aggregator init |
| `services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts` | Create | Integration tests for aggregator → strategy pipeline |

---

## Chunk 1: Multi-Provider Registry

### Task 1: Create multi-provider registry with tests

**Files:**
- Create: `shared/config/src/flash-loan-providers/multi-provider-registry.ts`
- Create: `shared/config/__tests__/unit/multi-provider-registry.test.ts`
- Modify: `shared/config/src/flash-loan-providers/index.ts`
- Modify: `shared/config/src/index.ts`

- [ ] **Step 1: Write the registry tests**

Create `shared/config/__tests__/unit/multi-provider-registry.test.ts`:

```typescript
import {
  FLASH_LOAN_PROVIDER_REGISTRY,
  getProvidersForChain,
  type FlashLoanProviderEntry,
} from '../../src/flash-loan-providers/multi-provider-registry';
import { FLASH_LOAN_PROVIDERS } from '../../src/service-config';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, SYNCSWAP_VAULTS } from '../../src/addresses';

describe('Multi-Provider Registry', () => {
  describe('FLASH_LOAN_PROVIDER_REGISTRY', () => {
    it('has at least one provider for every FLASH_LOAN_PROVIDERS chain', () => {
      for (const chain of Object.keys(FLASH_LOAN_PROVIDERS)) {
        const providers = FLASH_LOAN_PROVIDER_REGISTRY[chain];
        expect(providers).toBeDefined();
        expect(providers.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('has multiple providers for ethereum, polygon, arbitrum, optimism, base', () => {
      const multiChains = ['ethereum', 'polygon', 'arbitrum', 'optimism', 'base'];
      for (const chain of multiChains) {
        expect(FLASH_LOAN_PROVIDER_REGISTRY[chain].length).toBeGreaterThanOrEqual(2);
      }
    });

    it('has scroll with both aave_v3 and syncswap', () => {
      const scrollProviders = FLASH_LOAN_PROVIDER_REGISTRY['scroll'];
      const protocols = scrollProviders.map(p => p.protocol);
      expect(protocols).toContain('aave_v3');
      expect(protocols).toContain('syncswap');
    });

    it('multi-provider chains have distinct protocols', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const protocols = providers.map(p => p.protocol);
        const unique = new Set(protocols);
        expect(unique.size).toBe(protocols.length);
      }
    });

    it('all fee values are non-negative integers', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (const p of providers) {
          expect(p.feeBps).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(p.feeBps)).toBe(true);
        }
      }
    });

    it('all addresses are valid hex strings', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (const p of providers) {
          expect(p.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
      }
    });

    it('Aave V3 addresses match AAVE_V3_POOLS', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const aave = providers.find(p => p.protocol === 'aave_v3');
        if (aave) {
          expect(aave.address).toBe(AAVE_V3_POOLS[chain]);
        }
      }
    });

    it('Balancer V2 addresses match BALANCER_V2_VAULTS', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const bal = providers.find(p => p.protocol === 'balancer_v2');
        if (bal) {
          expect(bal.address).toBe(BALANCER_V2_VAULTS[chain]);
        }
      }
    });

    it('providers are sorted by feeBps ascending within each chain', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (let i = 1; i < providers.length; i++) {
          expect(providers[i].feeBps).toBeGreaterThanOrEqual(providers[i - 1].feeBps);
        }
      }
    });
  });

  describe('getProvidersForChain', () => {
    it('returns providers for known chain', () => {
      const providers = getProvidersForChain('ethereum');
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for unknown chain', () => {
      expect(getProvidersForChain('nonexistent')).toEqual([]);
    });

    it('returns frozen array (immutable)', () => {
      const providers = getProvidersForChain('ethereum');
      expect(Object.isFrozen(providers)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest shared/config/__tests__/unit/multi-provider-registry.test.ts --no-coverage 2>&1 | tail -5`
Expected: FAIL — cannot find module `multi-provider-registry`

- [ ] **Step 3: Create the multi-provider registry**

Create `shared/config/src/flash-loan-providers/multi-provider-registry.ts`:

```typescript
/**
 * Multi-Provider Flash Loan Registry
 *
 * Provides multiple flash loan providers per chain for the aggregator.
 * The single-provider FLASH_LOAN_PROVIDERS map stays untouched for
 * backward-compatible non-aggregator path.
 *
 * Consumed by FlashLoanStrategy constructor when enableAggregator=true.
 *
 * @see FLASH_LOAN_PROVIDERS — single-provider map (non-aggregator path)
 * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
 */

import type { FlashLoanProtocol } from '@arbitrage/types';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from '../addresses';

export interface FlashLoanProviderEntry {
  /** Flash loan protocol identifier */
  protocol: FlashLoanProtocol;
  /** On-chain contract address (pool or vault) */
  address: string;
  /** Fee in basis points */
  feeBps: number;
  /** Priority hint: lower = preferred when scores are equal */
  priority: number;
}

const EMPTY_PROVIDERS: readonly FlashLoanProviderEntry[] = Object.freeze([]);

/**
 * Multi-provider registry. Each chain maps to an array of providers
 * sorted by feeBps ascending (cheapest first).
 *
 * Multi-provider chains: ethereum, polygon, arbitrum, optimism, base (Aave V3 + Balancer V2),
 * scroll (Aave V3 + SyncSwap).
 *
 * Single-provider chains: bsc, avalanche, fantom, zksync, mantle, mode.
 */
export const FLASH_LOAN_PROVIDER_REGISTRY: Readonly<Record<string, readonly FlashLoanProviderEntry[]>> = Object.freeze({
  // === Multi-provider chains (sorted by feeBps ascending) ===
  ethereum: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.ethereum, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.ethereum, feeBps: 5, priority: 1 },
  ]),
  polygon: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.polygon, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.polygon, feeBps: 5, priority: 1 },
  ]),
  arbitrum: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.arbitrum, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.arbitrum, feeBps: 5, priority: 1 },
  ]),
  optimism: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.optimism, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.optimism, feeBps: 5, priority: 1 },
  ]),
  base: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.base, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.base, feeBps: 5, priority: 1 },
  ]),
  scroll: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.scroll, feeBps: 5, priority: 0 },
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.scroll, feeBps: 30, priority: 1 },
  ]),

  // === Single-provider chains ===
  bsc: Object.freeze([
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.bsc, feeBps: 25, priority: 0 },
  ]),
  avalanche: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.avalanche, feeBps: 5, priority: 0 },
  ]),
  fantom: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.fantom, feeBps: 0, priority: 0 },
  ]),
  zksync: Object.freeze([
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.zksync, feeBps: 30, priority: 0 },
  ]),
  mantle: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.mantle, feeBps: 5, priority: 0 },
  ]),
  mode: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.mode, feeBps: 0, priority: 0 },
  ]),
});

/**
 * Get providers for a chain. Returns empty frozen array for unknown chains.
 */
export function getProvidersForChain(chain: string): readonly FlashLoanProviderEntry[] {
  return FLASH_LOAN_PROVIDER_REGISTRY[chain] ?? EMPTY_PROVIDERS;
}
```

- [ ] **Step 4: Add re-export in flash-loan-providers/index.ts**

Add at the end of `shared/config/src/flash-loan-providers/index.ts`:

```typescript
// Multi-provider registry for aggregator
export {
  FLASH_LOAN_PROVIDER_REGISTRY,
  getProvidersForChain,
  type FlashLoanProviderEntry,
} from './multi-provider-registry';
```

- [ ] **Step 5: Add re-export in shared/config/src/index.ts**

Find the flash-loan-providers export block and add the new exports. The existing block at line ~351 exports from `./flash-loan-providers`. Add after the existing re-exports:

```typescript
export {
  FLASH_LOAN_PROVIDER_REGISTRY,
  getProvidersForChain,
  type FlashLoanProviderEntry,
} from './flash-loan-providers/multi-provider-registry';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest shared/config/__tests__/unit/multi-provider-registry.test.ts --no-coverage`
Expected: All 11 tests PASS

- [ ] **Step 7: Run existing config tests for regressions**

Run: `npx jest shared/config/__tests__ --no-coverage 2>&1 | tail -10`
Expected: All pass, no regressions

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: Clean

- [ ] **Step 9: Commit**

```bash
git add shared/config/src/flash-loan-providers/multi-provider-registry.ts \
  shared/config/src/flash-loan-providers/index.ts \
  shared/config/src/index.ts \
  shared/config/__tests__/unit/multi-provider-registry.test.ts
git commit -m "feat(config): add multi-provider flash loan registry for aggregator

Add FLASH_LOAN_PROVIDER_REGISTRY with multiple providers per chain:
- ethereum/polygon/arbitrum/optimism/base: Aave V3 + Balancer V2
- scroll: Aave V3 + SyncSwap
- Single-provider chains unchanged
Sorted by feeBps ascending. 11 unit tests."
```

---

## Chunk 2: Strategy Fallback Loop + Aggregator Wiring

### Task 2: Extend selectFlashLoanProvider return type and wire registry

**Files:**
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts`

- [ ] **Step 1: Read current selectFlashLoanProvider method**

Read `services/execution-engine/src/strategies/flash-loan.strategy.ts` lines 985-1104 to confirm the current return type and the pool address lookup pattern.

- [ ] **Step 2: Extend selectFlashLoanProvider return type**

In `flash-loan.strategy.ts`, find the return type of `selectFlashLoanProvider` (around line 989-991):

```typescript
  ): Promise<{
    selectedProvider: IProviderInfo | null;
    errorResult?: ExecutionResult;
  }> {
```

Replace with:

```typescript
  ): Promise<{
    selectedProvider: IProviderInfo | null;
    errorResult?: ExecutionResult;
    rankedAlternatives?: ReadonlyArray<{ protocol: FlashLoanProtocol; score: ProviderScore }>;
  }> {
```

- [ ] **Step 3: Return rankedAlternatives from selectFlashLoanProvider**

Find the successful return at line ~1085:

```typescript
      return { selectedProvider };
```

Replace with:

```typescript
      return { selectedProvider, rankedAlternatives: providerSelection.rankedAlternatives };
```

- [ ] **Step 4: Fix pool address lookup to use registry**

Add import at the top of flash-loan.strategy.ts (near the other `@arbitrage/config` imports):

```typescript
import { FLASH_LOAN_PROVIDER_REGISTRY } from '@arbitrage/config';
```

Then find the block at lines ~1028-1054 that builds `selectedProvider` from `FLASH_LOAN_PROVIDERS[chain]`. Replace:

```typescript
      // Validate provider config exists (fail fast if misconfigured)
      const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
      if (!flashLoanConfig) {
        this.logger.error('[ERR_CONFIG] Flash loan provider not configured for chain', {
          chain,
          selectedProtocol,
        });
        return {
          selectedProvider: null,
          errorResult: BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(
              ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
              `Flash loan provider not configured for chain: ${chain}`
            ),
            chain
          ),
        };
      }

      const selectedProvider: IProviderInfo = {
        protocol: selectedProtocol,
        chain,
        poolAddress: flashLoanConfig.address,
        feeBps: flashLoanConfig.feeBps,
        isAvailable: true,
      };
```

With:

```typescript
      // Look up selected protocol's address from multi-provider registry
      const registryEntries = FLASH_LOAN_PROVIDER_REGISTRY[chain];
      const registryEntry = registryEntries?.find(e => e.protocol === selectedProtocol);

      if (!registryEntry) {
        // Selected protocol not in registry for this chain — try next alternative
        this.logger.warn('Aggregator selected protocol not in registry, checking alternatives', {
          chain, selectedProtocol,
          alternatives: providerSelection.rankedAlternatives.map(a => a.protocol),
        });

        // Selection-time fallback: try ranked alternatives
        for (const alt of providerSelection.rankedAlternatives) {
          const altEntry = registryEntries?.find(e => e.protocol === alt.protocol);
          if (altEntry) {
            const fallbackProvider: IProviderInfo = {
              protocol: alt.protocol,
              chain,
              poolAddress: altEntry.address,
              feeBps: altEntry.feeBps,
              isAvailable: true,
            };
            this.logger.info('Using alternative provider from registry', {
              chain, protocol: alt.protocol, feeBps: altEntry.feeBps,
            });
            return { selectedProvider: fallbackProvider, rankedAlternatives: providerSelection.rankedAlternatives };
          }
        }

        return {
          selectedProvider: null,
          errorResult: BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(
              ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
              `No flash loan provider in registry for chain: ${chain}`
            ),
            chain
          ),
        };
      }

      const selectedProvider: IProviderInfo = {
        protocol: selectedProtocol,
        chain,
        poolAddress: registryEntry.address,
        feeBps: registryEntry.feeBps,
        isAvailable: true,
      };
```

- [ ] **Step 5: Wire registry into aggregator init block**

In the constructor, find the `availableProviders` construction (around line 510-521):

```typescript
      // Build available providers map from FLASH_LOAN_PROVIDERS config
      const availableProviders = new Map<string, IProviderInfo[]>();
      for (const [chain, providerConfig] of Object.entries(FLASH_LOAN_PROVIDERS)) {
        const providers: IProviderInfo[] = [{
          protocol: providerConfig.protocol as FlashLoanProtocol,
          chain,
          poolAddress: providerConfig.address,
          feeBps: providerConfig.feeBps,
          isAvailable: true,
        }];
        availableProviders.set(chain, providers);
      }
```

Replace with:

```typescript
      // Build available providers map from multi-provider registry
      const availableProviders = new Map<string, IProviderInfo[]>();
      for (const [chain, entries] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const providers: IProviderInfo[] = entries.map(e => ({
          protocol: e.protocol as FlashLoanProtocol,
          chain,
          poolAddress: e.address,
          feeBps: e.feeBps,
          isAvailable: true,
        }));
        availableProviders.set(chain, providers);
      }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: Clean (may need to add `ProviderScore` to imports — it's already imported from `@arbitrage/flash-loan-aggregation`)

- [ ] **Step 7: Run existing flash loan tests for regressions**

Run: `npx jest services/execution-engine/__tests__/unit/strategies/flash-loan --no-coverage 2>&1 | tail -10`
Expected: All pass (the aggregator path is off by default in tests)

- [ ] **Step 8: Commit**

```bash
git add services/execution-engine/src/strategies/flash-loan.strategy.ts
git commit -m "feat(execution): extend selectFlashLoanProvider with alternatives + registry lookup

- Return rankedAlternatives from selectFlashLoanProvider
- Look up pool address from FLASH_LOAN_PROVIDER_REGISTRY (not single-provider map)
- Selection-time fallback when aggregator picks protocol not in registry
- Wire multi-provider registry into aggregator init block"
```

### Task 3: Add executeWithFallback method

**Files:**
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts`

- [ ] **Step 1: Read the current execute method flow**

Read `services/execution-engine/src/strategies/flash-loan.strategy.ts` lines 580-720 to understand the current execution flow after provider selection.

- [ ] **Step 2: Add executeWithFallback method**

Add the following private method after `selectFlashLoanProvider()` (after line ~1104):

```typescript
  /**
   * Execute flash loan with fallback to alternative provider on failure.
   *
   * Wraps the core execution flow (prepare → simulate → submit) with a
   * retry loop: if the first provider fails with a retryable error,
   * decideFallback() selects the next-ranked provider for one retry.
   *
   * Max 1 fallback attempt (2 total) to avoid exceeding opportunity TTL.
   *
   * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
   */
  private async executeWithFallback(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext,
    chain: string,
    initialProvider: IProviderInfo,
    rankedAlternatives: ReadonlyArray<{ protocol: FlashLoanProtocol; score: ProviderScore }>,
    gasPrice: bigint,
  ): Promise<ExecutionResult> {
    let currentProvider = initialProvider;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Core execution flow (same as non-fallback path)
        const [flashLoanTx, onChainProfit] = await Promise.all([
          this.prepareFlashLoanContractTransaction(opportunity, chain, ctx),
          this.batchQuoteManager.calculateExpectedProfitWithBatching(opportunity, chain, ctx),
        ]);

        const estimatedGas = await this.estimateGasFromTransaction(flashLoanTx, chain, ctx);
        const nativeTokenPriceUsd = getNativeTokenPrice(chain, { suppressWarning: true });

        this.verifyOnChainProfitDivergence(opportunity, onChainProfit, nativeTokenPriceUsd);

        const profitAnalysis = this.analyzeProfitability({
          expectedProfitUsd: opportunity.expectedProfit ?? 0,
          flashLoanAmountWei: BigInt(opportunity.amountIn ?? '0'),
          estimatedGasUnits: estimatedGas,
          gasPriceWei: gasPrice,
          chain,
          nativeTokenPriceUsd,
        });

        if (!profitAnalysis.isProfitable) {
          this.logger.warn('Opportunity unprofitable after fee calculation', {
            opportunityId: opportunity.id,
            provider: currentProvider.protocol,
            attempt,
            netProfitUsd: profitAnalysis.netProfitUsd,
          });
          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(
              ExecutionErrorCode.HIGH_FEES,
              `Opportunity unprofitable after fees: net ${profitAnalysis.netProfitUsd.toFixed(2)} USD`
            ),
            chain
          );
        }

        const simError = await this.simulateAndRevalidateProfitability(
          opportunity, flashLoanTx, chain, ctx,
          BigInt(opportunity.amountIn ?? '0'), estimatedGas, gasPrice, nativeTokenPriceUsd
        );
        if (simError) return simError;

        const protectedTx = await this.applyMEVProtection(flashLoanTx, chain, ctx);

        return await this.submitAndProcessFlashLoanResult(
          opportunity, protectedTx, chain, ctx, gasPrice, currentProvider
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        // Record failed attempt
        if (this.aggregatorMetrics) {
          this.aggregatorMetrics.recordOutcome({
            protocol: currentProvider.protocol,
            success: false,
            executionLatencyMs: 0,
            error: errorMessage,
          });
        }

        // On last attempt, don't try fallback
        if (attempt >= MAX_ATTEMPTS || !this.aggregator) {
          this.logger.error('Flash loan execution failed (no more fallback attempts)', {
            opportunityId: opportunity.id, chain, attempt,
            provider: currentProvider.protocol, error: errorMessage,
          });
          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(ExecutionErrorCode.FLASH_LOAN_ERROR, errorMessage),
            chain
          );
        }

        // Ask aggregator whether to retry
        const fallbackDecision = await this.aggregator.decideFallback(
          currentProvider.protocol,
          error instanceof Error ? error : new Error(errorMessage),
          rankedAlternatives
            .filter(a => a.protocol !== currentProvider.protocol)
            .map(a => ({ protocol: a.protocol, score: a.score.totalScore })),
        );

        if (!fallbackDecision.shouldRetry || !fallbackDecision.nextProtocol) {
          this.logger.warn('Fallback declined — aborting', {
            opportunityId: opportunity.id, chain,
            reason: fallbackDecision.reason,
            errorType: fallbackDecision.errorType,
          });
          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(ExecutionErrorCode.FLASH_LOAN_ERROR,
              `Primary provider failed (${errorMessage}), fallback declined: ${fallbackDecision.reason}`),
            chain
          );
        }

        // Resolve fallback provider from registry
        const fallbackEntries = FLASH_LOAN_PROVIDER_REGISTRY[chain];
        const fallbackEntry = fallbackEntries?.find(e => e.protocol === fallbackDecision.nextProtocol);
        if (!fallbackEntry) {
          this.logger.warn('Fallback provider not in registry', {
            chain, protocol: fallbackDecision.nextProtocol,
          });
          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(ExecutionErrorCode.FLASH_LOAN_ERROR,
              `Fallback provider ${fallbackDecision.nextProtocol} not in registry for ${chain}`),
            chain
          );
        }

        this.logger.info('Falling back to alternative provider', {
          opportunityId: opportunity.id, chain, attempt,
          failedProvider: currentProvider.protocol,
          nextProvider: fallbackDecision.nextProtocol,
          reason: fallbackDecision.reason,
        });

        currentProvider = {
          protocol: fallbackDecision.nextProtocol,
          chain,
          poolAddress: fallbackEntry.address,
          feeBps: fallbackEntry.feeBps,
          isAvailable: true,
        };
      }
    }

    // Should never reach here (loop always returns), but TypeScript needs it
    return BaseExecutionStrategy.createOpportunityError(
      opportunity,
      formatExecutionError(ExecutionErrorCode.FLASH_LOAN_ERROR, 'Max fallback attempts exceeded'),
      chain
    );
  }
```

- [ ] **Step 3: Wire executeWithFallback into execute()**

In the `execute()` method, after the `selectFlashLoanProvider` call (around line 618-622), find:

```typescript
      const providerResult = await this.selectFlashLoanProvider(opportunity, chain, ctx);
      if (providerResult.errorResult) {
        return providerResult.errorResult;
      }
      selectedProvider = providerResult.selectedProvider;
```

After this block, add a conditional branch. Find the existing parallel operation block (around line 627):

```typescript
      // Fix 10.3: Parallelize independent operations for latency reduction
```

Before that line, add:

```typescript
      // Aggregator fallback path: use executeWithFallback for retry capability
      if (this.aggregator && selectedProvider && providerResult.rankedAlternatives) {
        return await this.executeWithFallback(
          opportunity, ctx, chain, selectedProvider,
          providerResult.rankedAlternatives, gasPrice,
        );
      }

```

This means: when aggregator is enabled and we have alternatives, use the fallback-capable path. Otherwise, fall through to the existing non-aggregator execution flow.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: Clean

- [ ] **Step 5: Run existing tests for regressions**

Run: `npx jest services/execution-engine/__tests__/unit/strategies/flash-loan --no-coverage 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add services/execution-engine/src/strategies/flash-loan.strategy.ts
git commit -m "feat(execution): add executeWithFallback for aggregator retry loop

When aggregator is enabled, execution failures trigger decideFallback()
which selects the next-ranked provider for one retry attempt.
Max 2 total attempts. Permanent errors abort immediately.
Metrics recorded for each attempt."
```

---

## Chunk 3: Integration Tests

### Task 4: Write aggregator integration tests

**Files:**
- Create: `services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts`

- [ ] **Step 1: Write the integration test file**

Create `services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts`:

```typescript
/**
 * Flash Loan Aggregator Integration Tests
 *
 * Tests the aggregator → strategy → execution pipeline:
 * - Provider ranking and selection
 * - Fallback on execution failure
 * - Metrics recording
 * - Backward compatibility
 *
 * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
 */

// Mock @arbitrage/config before importing strategy
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000),
  FLASH_LOAN_PROVIDERS: {
    ethereum: { address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', protocol: 'aave_v3', feeBps: 5 },
    bsc: { address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', protocol: 'pancakeswap_v3', feeBps: 25 },
  },
  FLASH_LOAN_PROVIDER_REGISTRY: {
    ethereum: [
      { protocol: 'balancer_v2', address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', feeBps: 0, priority: 0 },
      { protocol: 'aave_v3', address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', feeBps: 5, priority: 1 },
    ],
    bsc: [
      { protocol: 'pancakeswap_v3', address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', feeBps: 25, priority: 0 },
    ],
  },
  FLASH_LOAN_AGGREGATOR_CONFIG: {
    liquidityCheckThresholdUsd: 100000,
    rankingCacheTtlMs: 30000,
    liquidityCacheTtlMs: 300000,
    weights: { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
    maxProvidersToRank: 3,
  },
  ARBITRAGE_CONFIG: { slippageTolerance: 50, minProfitThresholdUsd: 1 },
  CHAINS: {},
  DEXES: {},
  isExecutionSupported: jest.fn().mockReturnValue(true),
  getSupportedExecutionChains: jest.fn().mockReturnValue(['ethereum', 'bsc']),
  MEV_CONFIG: {},
  getV3AdapterAddress: jest.fn().mockReturnValue(null),
}));

import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import type { InMemoryAggregatorMetrics } from '@arbitrage/flash-loan-aggregation';
import type { ArbitrageOpportunity } from '@arbitrage/types';

const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn().mockReturnThis(), fatal: jest.fn(), trace: jest.fn(),
  silent: jest.fn(), level: 'info', isLevelEnabled: jest.fn().mockReturnValue(true),
};

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

function createOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'test-opp-1',
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: '1000000000000000000',
    buyPrice: 2000,
    sellPrice: 2010,
    buyDex: 'uniswap_v2',
    sellDex: 'sushiswap',
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    expectedProfit: 10,
    confidence: 0.85,
    timestamp: Date.now(),
    ...overrides,
  } as ArbitrageOpportunity;
}

function createStrategy(enableAggregator: boolean): FlashLoanStrategy {
  return new FlashLoanStrategy(mockLogger as any, {
    contractAddresses: { ethereum: '0x0000000000000000000000000000000000000001' },
    approvedRouters: { ethereum: [ROUTER] },
    enableAggregator,
  });
}

describe('Flash Loan Aggregator Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Provider Selection', () => {
    it('aggregator selects lowest-fee provider when enabled', () => {
      const strategy = createStrategy(true);

      // Verify aggregator is enabled
      expect((strategy as any).isAggregatorEnabled()).toBe(true);

      // The aggregator should have 2 providers for ethereum
      const aggregator = (strategy as any).aggregator;
      expect(aggregator).toBeDefined();
    });

    it('aggregator disabled uses hardcoded path', () => {
      const strategy = createStrategy(false);
      expect((strategy as any).isAggregatorEnabled()).toBe(false);
      expect((strategy as any).aggregator).toBeUndefined();
    });

    it('single-provider chain uses fast path', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      // BSC has only one provider — aggregator should use fast path
      const opportunity = createOpportunity({ buyChain: 'bsc' });
      const selection = await aggregator.selectProvider(opportunity, {
        chain: 'bsc',
        estimatedValueUsd: 10,
      });

      expect(selection.isSuccess).toBe(true);
      expect(selection.protocol).toBe('pancakeswap_v3');
      expect(selection.selectionReason).toBe('Only provider available');
    });
  });

  describe('Aggregator Ranking', () => {
    it('ranks balancer_v2 above aave_v3 on fee score (0 bps vs 5 bps)', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const opportunity = createOpportunity();
      const selection = await aggregator.selectProvider(opportunity, {
        chain: 'ethereum',
        estimatedValueUsd: 10,
      });

      expect(selection.isSuccess).toBe(true);
      // Balancer V2 has 0 bps fee → higher fee score → selected first
      expect(selection.protocol).toBe('balancer_v2');
      // Aave V3 should be in alternatives
      expect(selection.rankedAlternatives.length).toBeGreaterThanOrEqual(1);
      expect(selection.rankedAlternatives[0].protocol).toBe('aave_v3');
    });
  });

  describe('Fallback Decision', () => {
    it('decideFallback retries on insufficient liquidity', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('insufficient liquidity in pool'),
        [{ protocol: 'aave_v3', score: 0.9 }],
      );

      expect(decision.shouldRetry).toBe(true);
      expect(decision.nextProtocol).toBe('aave_v3');
      expect(decision.errorType).toBe('insufficient_liquidity');
    });

    it('decideFallback aborts on permanent error', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('contract paused'),
        [{ protocol: 'aave_v3', score: 0.9 }],
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.nextProtocol).toBeNull();
      expect(decision.errorType).toBe('permanent');
    });

    it('decideFallback aborts when no alternatives remain', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('insufficient liquidity'),
        [], // no alternatives
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.nextProtocol).toBeNull();
    });
  });

  describe('Metrics', () => {
    it('aggregator metrics tracker is initialized when aggregator is enabled', () => {
      const strategy = createStrategy(true);
      const metrics = (strategy as any).aggregatorMetrics as InMemoryAggregatorMetrics;
      expect(metrics).toBeDefined();

      const summary = metrics.getMetricsSummary();
      expect(typeof summary).toBe('string');
    });

    it('metrics are not initialized when aggregator is disabled', () => {
      const strategy = createStrategy(false);
      expect((strategy as any).aggregatorMetrics).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx jest services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 3: Run full execution engine test suite for regressions**

Run: `npx jest services/execution-engine/__tests__/unit/strategies/ --no-coverage 2>&1 | tail -15`
Expected: All pass, no regressions

- [ ] **Step 4: Full typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add services/execution-engine/__tests__/unit/strategies/flash-loan-aggregator-integration.test.ts
git commit -m "test(execution): add flash loan aggregator integration tests

7 tests covering aggregator → strategy pipeline:
- Provider ranking (balancer_v2 beats aave_v3 on fee score)
- Single-provider fast path
- Fallback decisions (retry vs abort)
- Permanent error classification
- Metrics initialization
- Backward compatibility (aggregator disabled)"
```

### Task 5: Final verification and push

- [ ] **Step 1: Run all related test suites**

```bash
npx jest shared/config/__tests__/unit/multi-provider-registry.test.ts \
  shared/flash-loan-aggregation/__tests__/ \
  services/execution-engine/__tests__/unit/strategies/ \
  --no-coverage 2>&1 | tail -20
```

Expected: All pass

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: Clean

- [ ] **Step 3: Push**

```bash
git push origin main
```

# DEX Lookup and Swap Builder Services Extraction Design

**Date**: 2026-02-09
**Task**: Task #4 - Refactoring Opportunities (Finding 9.1: Extract BaseExecutionStrategy Shared Concerns)
**Status**: Design Approved, Ready for Implementation

## Overview

Extract duplicated DEX lookup and swap building logic from FlashLoanStrategy into two reusable services: `DexLookupService` and `SwapBuilder`. This reduces code duplication, improves performance with O(1) lookups, and creates a clean foundation for all execution strategies.

## Motivation

**Current Problems:**
- FlashLoanStrategy contains 320+ lines of DEX lookup and swap building code
- O(1) router lookup optimization exists only in FlashLoanStrategy (not shared)
- Swap steps caching exists only in FlashLoanStrategy (not shared)
- BaseExecutionStrategy uses slower O(n) DEX lookups from @arbitrage/config
- Code duplication between strategies for similar operations

**Benefits of Extraction:**
- **Performance**: All strategies get O(1) DEX lookup and swap caching
- **Maintainability**: Single source of truth for DEX/swap logic
- **Testability**: Services can be tested independently
- **Reusability**: Any strategy can use these services
- **Code size**: FlashLoanStrategy reduces from 2,323 to ~2,000 lines

## Architecture

### Two New Services

**Location**: `services/execution-engine/src/services/`

1. **DexLookupService** (`dex-lookup.service.ts`)
   - Responsible for all DEX/router address resolution
   - O(1) Map-based caches built at initialization
   - Stateful but immutable after construction (thread-safe)

2. **SwapBuilder** (`swap-builder.service.ts`)
   - Responsible for building swap steps and preparing transactions
   - Uses DexLookupService for router resolution
   - TTL-based cache for swap steps (hot-path optimization)
   - Handles slippage, token decimals, amount estimation

### Integration Pattern

```typescript
// In BaseExecutionStrategy constructor
constructor(logger: Logger) {
  this.dexLookup = new DexLookupService();
  this.swapBuilder = new SwapBuilder(this.dexLookup, logger);
  // ... other services
}
```

All strategies (FlashLoan, CrossChain, future strategies) inherit these services.

## Detailed Design

### DexLookupService

**Data Structure:**
```typescript
export class DexLookupService {
  // Primary cache: chain -> (dexName -> routerAddress)
  private readonly routerCache: Map<string, Map<string, string>>;

  // Reverse cache: chain -> (routerAddress -> Dex)
  private readonly dexByRouterCache: Map<string, Map<string, Dex>>;

  // Full DEX cache: chain -> Dex[]
  private readonly dexCache: Map<string, Dex[]>;
}
```

**Public API:**
- `getRouterAddress(chain, dexName): string | undefined` - O(1) router lookup
- `getDexByName(chain, dexName): Dex | undefined` - O(1) DEX config lookup
- `findDexByRouter(chain, routerAddress): Dex | undefined` - O(1) reverse lookup
- `getAllDexesForChain(chain): readonly Dex[]` - Get all DEXes
- `isValidRouter(chain, routerAddress): boolean` - Quick validation
- `hasChain(chain): boolean` - Chain existence check

**Key Features:**
- All Maps built once at construction (immutable after init)
- Case-insensitive lookups (normalized to lowercase)
- Returns `undefined` for missing entries (no exceptions)
- Memory: ~40 KB for 49 DEXes across 11 chains

### SwapBuilder

**Data Structure:**
```typescript
export class SwapBuilder {
  private readonly swapStepsCache: Map<string, CachedSwapSteps>;
  private static readonly MAX_CACHE_SIZE = 100;
  private static readonly CACHE_TTL_MS = 60000; // 60 seconds

  constructor(
    private readonly dexLookup: DexLookupService,
    private readonly logger: ILogger
  ) {}
}
```

**Public API:**
- `buildSwapSteps(opportunity, params): SwapStep[]` - Build swap steps with caching
- `prepareSwapTransaction(steps, chain, provider, wallet, options): Promise<TransactionRequest>` - Prepare ethers transaction
- `getMetrics(): SwapBuilderMetrics` - Cache performance metrics

**Private Methods:**
- `estimateIntermediateAmount()` - Estimate amounts based on prices
- `applySlippage()` - Apply slippage calculation
- `cleanStaleCache()` - Remove expired entries (opportunistic)
- `evictOldestIfNeeded()` - LRU eviction when size exceeded

**Key Features:**
- Cache key: `${opportunityId}:${chain}:${slippageBps}`
- TTL: 60 seconds with opportunistic cleanup
- LRU eviction at 100 entries
- Centralized slippage calculation
- Token decimals handling
- Memory: ~50 KB max (100 cached entries)

### Types

```typescript
export interface SwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

export interface SwapStepsParams {
  buyRouter: string;
  sellRouter: string;
  intermediateToken: string;
  slippageBps?: number;
  chain: string;
}

export interface SwapTransactionOptions {
  deadline?: number;
  recipient?: string;
  gasLimit?: bigint;
}

export interface SwapBuilderMetrics {
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
}
```

## Performance

**Memory Footprint:**
- DexLookupService: ~40 KB (all DEXes cached)
- SwapBuilder: ~50 KB max (100 cached entries)
- Total: ~90 KB (negligible)

**Time Complexity:**
- DEX lookup: O(1) (Map-based) - <0.01ms
- Router resolution: O(1) (Map-based) - <0.01ms
- Swap steps (cached): ~0.1ms
- Swap steps (cache miss): ~10-50ms
- Cache hit rate: Expected 70-90%

**Comparison to Current:**

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| DEX lookup | O(n) ~0.1ms | O(1) ~0.01ms | 10x faster |
| Router resolution | String match ~1ms | Map lookup ~0.01ms | 100x faster |
| Swap steps (cached) | N/A | ~0.1ms | 10-50ms saved |

## Error Handling

**DexLookupService:**
- Returns `undefined` for missing DEX/chain (let caller decide error handling)
- Throws on invalid DEXES config during initialization (fail-fast)
- Logs debug messages for not-found lookups
- Case-insensitive, whitespace-trimmed normalization

**SwapBuilder:**
- Throws with clear error messages for invalid input
- Error prefixes: `[SwapBuilder]` for easy identification
- Validates: opportunity fields, router addresses, swap steps, provider/wallet
- Wraps contract call errors with context

## Testing Strategy

**New Test Files:**
1. `services/__tests__/unit/dex-lookup.service.test.ts`
   - Test all 49 DEXes across 11 chains
   - Case-insensitive lookup tests
   - Reverse lookup tests
   - Performance benchmarks (O(1) verification)
   - Coverage target: >95%

2. `services/__tests__/unit/swap-builder.service.test.ts`
   - Swap steps building tests
   - Cache hit/miss tests
   - TTL expiration tests
   - LRU eviction tests
   - Slippage calculation tests
   - Transaction preparation tests
   - Coverage target: >90%

**Updated Tests:**
- `flash-loan.strategy.test.ts` - Verify no regressions
- `cross-chain.strategy.test.ts` - Verify no regressions
- `base.strategy.test.ts` - Verify service integration

## Migration Strategy

### Phase 1: Create Services (Day 1-2)
- Create `dex-lookup.service.ts` with full implementation
- Create `swap-builder.service.ts` with full implementation
- Create comprehensive unit tests
- **Safe**: No changes to existing code

### Phase 2: Integrate with BaseExecutionStrategy (Day 3)
- Add service initialization to constructor
- Update `prepareDexSwapTransaction()` to use services
- Test CrossChainStrategy for regressions
- **Risk**: Low (BaseExecutionStrategy changes isolated)

### Phase 3: Migrate FlashLoanStrategy (Day 4-5)
- Remove duplicate methods (getDexRouterMap, findRouterByDexName, etc.)
- Replace method calls with service delegation
- Remove swap steps cache (now in SwapBuilder)
- Test flash loan execution for regressions
- **Risk**: Medium (removes 320 lines, requires thorough testing)

### Phase 4: Cleanup and Documentation (Day 6)
- Delete commented code
- Update architecture documentation
- Update ADRs if needed
- Final verification
- **Risk**: Low (documentation only)

## Rollback Plan

**Phase 1-2**: Safe to rollback (new code only)
```bash
git checkout HEAD -- services/execution-engine/src/services/dex-lookup.service.ts
git checkout HEAD -- services/execution-engine/src/services/swap-builder.service.ts
git checkout HEAD -- services/execution-engine/src/strategies/base.strategy.ts
```

**Phase 3**: Rollback FlashLoanStrategy changes
```bash
git checkout HEAD -- services/execution-engine/src/strategies/flash-loan.strategy.ts
```

## Definition of Done

- ✅ All unit tests passing (>90% coverage for new services)
- ✅ All integration tests passing (no regressions)
- ✅ TypeScript compilation clean
- ✅ Linting clean
- ✅ Performance benchmarks meet targets (<0.01ms DEX lookup)
- ✅ Documentation updated (ARCHITECTURE_V2.md, strategies.md)
- ✅ Code review completed

## Timeline

- **Phase 1**: 2 days (service creation + tests)
- **Phase 2**: 1 day (base strategy integration)
- **Phase 3**: 2 days (flash loan migration + testing)
- **Phase 4**: 1 day (cleanup + documentation)
- **Total**: 6 days (1 week with buffer)

## Related Work

**Depends On:**
- None (standalone refactoring)

**Blocks:**
- Finding 9.2: Split FlashLoanStrategy (easier after this extraction)
- Finding 9.3: Extract DEX utilities (covered by this work)

**Related ADRs:**
- ADR-022: Performance optimization patterns (cache strategy)
- ADR-004: Service extraction pattern (R4 refactoring)

## References

- Task #4: Implement refactoring opportunities (9.1, 9.2, 9.3)
- Finding 9.1: Extract BaseExecutionStrategy shared concerns
- Current implementations:
  - `services/execution-engine/src/strategies/flash-loan.strategy.ts` (lines 362-377, 1124-1240, 1602-1676)
  - `services/execution-engine/src/strategies/base.strategy.ts` (lines 950-1020)

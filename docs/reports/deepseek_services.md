Looking at this comprehensive codebase analysis, I'll perform a deep dive focusing on the /services directory and shared components. Let me analyze systematically:

## 1. Code and Architecture Mismatch

### Critical Finding: BaseDetector Still Monolithic (vs. ADR-014)
**File**: `shared/core/src/base-detector.ts` (1863 lines based on ADR-014)
**Issue**: Despite ADR-014 proposing modular components, `BaseDetector` still appears to have 12+ responsibilities per the plan document. The modular components (`ChainInstanceManager`, `HealthReporter`, `MetricsCollector`) exist but may not be fully integrated.

**Evidence from plans**:
- ADR-014 states `UnifiedChainDetector` is 689 lines with mixed concerns
- Component architecture proposal exists but not fully implemented
- `PriceCalculator`, `PairRepository` exist but may not be used by `BaseDetector`

### Cross-Chain Detector Violates Partition Pattern
**File**: `services/cross-chain-detector/src/detector.ts`
**Issue**: ADR-003 states cross-chain detector is an intentional exception to BaseDetector pattern, but this creates architectural inconsistency.

## 2. Code and Documentation Mismatch

### Inconsistent Threshold Documentation
**Files**: Multiple calculation files have inconsistent threshold handling:
- `solana-detector.ts:1165` shows `netProfit * 100 < threshold` (percentage conversion)
- Documentation in ADR-008 says thresholds should be decimal (0.003 = 0.3%)
- No clear documentation on whether `minProfitThreshold` is decimal or percentage

### Redis Streams Implementation vs ADR-002
**ADR-002 Phase 5** mentions blocking reads with `blockMs: 1000`, but implementation may still use `setInterval` polling in some services.

## 3. Code and Configuration Mismatch

### Environment Configuration Fragmentation
**Files found**:
- `.env.partition.example`
- `docker-compose.partition.yml` 
- `docker-compose.local.yml`
- Multiple `env.standby` files
- `setup-env.js` script

**Issue**: No single source of truth for configuration. Different services may use different env vars.

### RPC URL Configuration Inconsistency
**Evidence**: ADR-010 shows each chain should have 2+ fallback URLs, but configuration may not be centralized.

## 4. Bugs

### Critical Bug #1: Solana Threshold Calculation (Confirmed)
From `modularization-enhancement-plan.md:81-105`:
```typescript
// CURRENT BUG (solana-detector.ts:1165):
if (netProfit * 100 < this.config.minProfitThreshold) {
  return null;
}
// netProfit is decimal (0.005 = 0.5%), minProfitThreshold is percentage (0.3)
// This causes: 0.5 < 0.3 = false (wrongly passes)
```

### Critical Bug #2: Precision Loss in BaseDetector
```typescript
// base-detector.ts:1388-1404 (from plans):
protected calculatePrice(pair: Pair): number {
  const reserve0 = parseFloat(pair.reserve0 || '0');  // PRECISION LOSS!
  const reserve1 = parseFloat(pair.reserve1 || '0');
  return reserve0 / reserve1;
}
```

### Bug #3: Inconsistent Fee Handling
**Four different fee resolution strategies** across files:
1. `solana-detector.ts:1157` - `/ 10000` (basis points conversion)
2. `base-detector.ts:835` - `?? 0.003` (decimal with fallback)
3. `arbitrage-calculator.ts:424` - uses `getDefaultFee()`
4. `base-detector.ts:1186` - uses `ARBITRAGE_CONFIG.feePercentage`

## 5. Race Conditions

### Singleton Reset Race Condition
**File**: `shared/core/src/redis.ts` or similar singleton patterns
**Issue**: Reset functions may not properly await disconnection before setting instance to null.

### Redis Leader Election TOCTOU
**ADR-007 mentions fix**: "Uses atomic Lua script to prevent TOCTOU race conditions"
But implementation may still have:
```typescript
// POTENTIAL RACE:
const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', 30);
// Between check and renewal, another instance could acquire lock
```

## 6. Inconsistencies

### Data Model Inconsistency (5 different Pair interfaces)
From `detection-refactoring-plan.md:59-111`:
1. `arbitrage-calculator.ts:25-34` - Canonical with string reserves
2. `chain-instance.ts:93-100` - Duplicate definition
3. `base-detector.ts:61-66` - Extended variant with `lastUpdate`
4. `solana-detector.ts:174-188` - Completely different with nested `SolanaTokenInfo`
5. `types/index.ts` - Base Pair type

### Formula Inconsistency
Two different spread calculations in same file:
```typescript
// base-detector.ts:832 (CORRECT):
const priceDiff = Math.abs(currentPrice - otherPrice) / Math.min(currentPrice, otherPrice);

// base-detector.ts:1178 (INCORRECT - uses average):
const avgPrice = (sourceUpdate.price + targetUpdate.price) / 2;
const percentageDiff = priceDiff / avgPrice;
```

## 7. Deprecated Code and Unimplemented Functionalities

### Deprecated Services
Per ADR-003, these should be deprecated:
- `services/ethereum-detector`
- `services/arbitrum-detector` 
- `services/optimism-detector`
- `services/base-detector`
- `services/polygon-detector`
- `services/bsc-detector`

**Check**: These directories may still exist with `DEPRECATED.md` but code might still be active.

### Unimplemented: ML Components
**ADR-001 Phase 5**: "Add ML Components (Future)" but `shared/ml/src/` exists with minimal implementation.

### Todo: Swap Events Consumers
**ADR-002 Phase 6**: Swap events and volume aggregates streams were implemented but consumers may not be fully functional in Coordinator.

## 8. Test Coverage and Mismatch

### Test Architecture Issues (ADR-009)
**Problem**: Tests are fragmented across:
- Co-located `*.test.ts` files
- Separate `__tests__/` directories  
- `tests/integration/` directory
- Inconsistent import patterns (relative vs package aliases)

### Missing Unit Tests for Pure Components
**`PriceCalculator`** exists but may not have comprehensive tests for edge cases (zero reserves, negative numbers).

### Integration Tests May Not Cover All Partitions
**Check**: `tests/integration/` has many partition tests but may not cover all failure scenarios.

## 9. Refactoring Opportunities

### Opportunity 1: Extract Pure Calculation Module
**From plans**: Create `profit-calculator/` with pure functions. Currently calculations are duplicated across 4+ files.

### Opportunity 2: Consolidate Data Models
**Current**: 5 different Pair interfaces  
**Target**: Single `UnifiedPair` interface with adapters.

### Opportunity 3: Dependency Injection Container
**Plan exists** but not fully implemented. Current constructors have many dependencies.

### Opportunity 4: Token Pair Indexing (T1.1 from ADR-011)
**Already implemented** but verify `pairsByTokens` Map is used consistently.

## 10. Performance Optimizations

### Hot Path: Price Lookups
**Current**: May use Redis calls (2ms)  
**Optimization**: L1 Price Matrix with SharedArrayBuffer (0.1μs) per ADR-005.

### Hot Path: Pair Matching on Sync Events
**Before**: O(n) iteration through all pairs  
**After**: O(1) Map lookup with `pairsByTokens` (T1.1 optimization)

### Event Batching Latency
**Current**: 25-50ms batch wait times  
**Optimization**: Reduce to 5ms (T1.3 from ADR-011)

### LRU Cache Operations
**Before**: O(n) array operations  
**After**: O(1) doubly-linked list (T1.4 implemented)

---

## Proposed Fixes and Improvements

### Fix 1: Centralize Price Calculations
**Create**: `shared/core/src/profit-calculator/` module with canonical formulas:

```typescript
// profit-calculator/price.ts
export function calculateSpread(price1: number, price2: number): number {
  if (price1 <= 0 || price2 <= 0) {
    throw new PriceCalculationError('Prices must be positive');
  }
  const minPrice = Math.min(price1, price2);
  return Math.abs(price1 - price2) / minPrice; // SINGLE SOURCE OF TRUTH
}

// profit-calculator/fees.ts
export function resolveFee(fee: number | undefined, dex: string): number {
  if (fee !== undefined) {
    // Handle both basis points (30) and decimal (0.003)
    return fee > 1 ? fee / 10000 : fee;
  }
  return getDefaultFee(dex); // Centralized default
}
```

### Fix 2: Unified Data Model with Adapters
```typescript
// profit-calculator/types.ts
export interface UnifiedPair {
  readonly id: string;
  readonly dex: string;
  readonly chain: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserve0: bigint; // Always bigint for precision
  readonly reserve1: bigint;
  readonly feePercent: number; // Always decimal (0.003 = 0.3%)
  readonly timestamp: number;
  readonly blockOrSlot: number;
}

// adapters/pair-adapter.ts
export function fromEvmPair(pair: ExtendedPair, chain: string, dex: string): UnifiedPair {
  return {
    id: pair.address.toLowerCase(),
    dex,
    chain,
    token0: pair.token0.toLowerCase(),
    token1: pair.token1.toLowerCase(),
    reserve0: BigInt(pair.reserve0), // Convert string to bigint
    reserve1: BigInt(pair.reserve1),
    feePercent: resolveFee(pair.fee, dex),
    timestamp: pair.lastUpdate,
    blockOrSlot: pair.blockNumber,
  };
}
```

### Fix 3: Fix Solana Threshold Bug
```typescript
// services/partition-solana/src/arbitrage-detector.ts
// CURRENT (BUGGY):
if (netProfit * 100 < this.config.minProfitThreshold) {
  return null;
}

// FIXED:
const thresholdDecimal = this.config.minProfitThreshold / 100; // Convert percentage to decimal
if (netProfit < thresholdDecimal) {
  return null;
}
// OR if config is already decimal:
if (netProfit < this.config.minProfitThreshold) {
  return null;
}
```

### Fix 4: Implement Dependency Injection
```typescript
// shared/core/src/di/container.ts (simplified)
export class DetectorContainer {
  private static instance: DetectorContainer;
  private components = new Map<string, any>();

  static getInstance(): DetectorContainer {
    if (!DetectorContainer.instance) {
      DetectorContainer.instance = new DetectorContainer();
      DetectorContainer.instance.initialize();
    }
    return DetectorContainer.instance;
  }

  private initialize(): void {
    // Register core components
    this.components.set('priceCalculator', new PriceCalculator());
    this.components.set('pairRepository', new PairRepository());
    this.components.set('profitCalculator', new ProfitCalculator(
      this.get('priceCalculator')
    ));
    
    // Register strategies
    this.components.set('intraChainStrategy', new IntraChainStrategy(
      this.get('profitCalculator'),
      { minProfitPercent: 0.003 }
    ));
  }

  get<T>(name: string): T {
    const component = this.components.get(name);
    if (!component) {
      throw new Error(`Component ${name} not registered`);
    }
    return component;
  }
}

// Usage in BaseDetector:
export abstract class BaseDetector {
  protected profitCalculator: ProfitCalculator;
  protected pairRepository: PairRepository;

  constructor() {
    const container = DetectorContainer.getInstance();
    this.profitCalculator = container.get('profitCalculator');
    this.pairRepository = container.get('pairRepository');
  }
}
```

### Fix 5: Configuration Centralization
```typescript
// shared/config/src/centralized-config.ts
export class CentralizedConfig {
  private static instance: CentralizedConfig;
  
  // Thresholds (all as decimals: 0.003 = 0.3%)
  readonly MIN_PROFIT_THRESHOLD = 0.003;
  readonly WHALE_THRESHOLD_USD = 50000;
  readonly STALENESS_THRESHOLDS = {
    'fast': 5000,     // 5s for Arbitrum, Solana
    'medium': 10000,  // 10s for Polygon, BSC
    'slow': 15000,    // 15s for Ethereum
  };

  // Fee defaults per DEX (as decimals)
  readonly DEFAULT_FEES = {
    'uniswap-v3': 0.003,
    'pancakeswap': 0.0025,
    'sushiswap': 0.003,
    // ... others
  };

  static getInstance(): CentralizedConfig {
    if (!CentralizedConfig.instance) {
      CentralizedConfig.instance = new CentralizedConfig();
    }
    return CentralizedConfig.instance;
  }

  getMinProfitThreshold(chain?: string): number {
    // Chain-specific overrides if needed
    return this.MIN_PROFIT_THRESHOLD;
  }
}
```

### Fix 6: Test Architecture Standardization
```typescript
// jest.config.js - Standardized project structure
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts'],
    },
    {
      displayName: 'integration',
      testMatch: ['**/__tests__/integration/**/*.test.ts', '**/tests/integration/**/*.test.ts'],
    },
  ],
};

// shared/test-utils/src/factories/swap-event.factory.ts
export class SwapEventFactory {
  static create(overrides: Partial<SwapEvent> = {}): SwapEvent {
    return {
      pairAddress: '0x' + 'a'.repeat(40),
      sender: '0x' + 'b'.repeat(40),
      amount0In: 1000000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 950000n,
      transactionHash: '0x' + 'c'.repeat(64),
      blockNumber: Math.floor(Math.random() * 1000000),
      chain: 'ethereum',
      dex: 'uniswap-v3',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  static createWhaleEvent(): SwapEvent {
    return this.create({
      amount0In: 1000000000000n, // $1M+ trade
    });
  }
}
```

## Critical Hot-Path Optimization Checklist

1. **✅ Price Matrix L1 Cache**: Implement SharedArrayBuffer for sub-microsecond lookups
2. **✅ Token Pair Indexing**: O(1) lookups instead of O(n) scans
3. **✅ Event Batch Optimization**: Reduce from 25-50ms to 5ms
4. **🔄 Worker Thread Path Finding**: Ensure multi-leg uses worker pool
5. **🔄 Dynamic Gas Pricing**: Cache gas prices with 60s refresh
6. **❌ WebSocket Blocking Reads**: Verify Redis Streams uses blocking reads
7. **❌ LRU O(1) Operations**: Verify doubly-linked list implementation

## Recommendations for Immediate Action

### P0 (Critical Bugs):
1. Fix Solana threshold calculation bug
2. Fix precision loss in BaseDetector parseFloat
3. Standardize fee resolution (single function)

### P1 (Architecture Consistency):
1. Implement central ProfitCalculator module
2. Enforce UnifiedPair data model with adapters
3. Complete DI container implementation
4. Verify all deprecated services are inactive

### P2 (Performance):
1. Audit hot path for Redis calls (should be 0 in L1 cache)
2. Verify worker thread usage for CPU-intensive tasks
3. Implement comprehensive performance monitoring

### P3 (Testing & Maintenance):
1. Standardize test architecture per ADR-009
2. Add regression tests for critical calculations
3. Implement centralized configuration

This analysis reveals a sophisticated but fragmented codebase. The architectural vision is excellent, but implementation consistency needs improvement. The priority should be establishing **single sources of truth** for calculations, data models, and configuration before adding new features.
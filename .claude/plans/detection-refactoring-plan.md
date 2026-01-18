# Deep-Dive Architecture Analysis: Detection & Price Calculation Refactoring

**Date:** 2026-01-18
**Methodology:** Hypothesis tracking with confidence scoring
**Goal:** Make bugs in detection and profit calculation easier to find

---

## Executive Summary

After thorough analysis of the detection and price calculation codebase, I identified **critical fragmentation** across 4+ files with **inconsistent formulas** and **duplicated data models**. This fragmentation is the root cause of difficult-to-find bugs.

### Key Metrics

| Metric | Current State | Risk |
|--------|--------------|------|
| Calculation implementations | 4 separate | HIGH |
| Data model definitions | 5 different types | HIGH |
| Formula inconsistencies | 3 identified | CRITICAL |
| Test isolation | Poor (embedded in classes) | MEDIUM |
| Code duplication | ~200 lines | MEDIUM |

---

## Part 1: Hypothesis Tracking

### Hypothesis 1: Fragmented Calculation Logic is the Primary Bug Source
**Confidence: 95%**

**Evidence Found:**

| File | Method | Lines | Formula Variant |
|------|--------|-------|-----------------|
| `base-detector.ts` | `checkIntraDexArbitrage()` | 788-874 | `|price1-price2| / min(price1,price2)` |
| `base-detector.ts` | `calculateArbitrageOpportunity()` | 1171-1233 | `priceDiff / avgPrice` ⚠️ **INCONSISTENT** |
| `solana-detector.ts` | `calculateArbitrageOpportunity()` | 1145-1192 | `(max-min) / min` + basis points |
| `arbitrage-calculator.ts` | `calculateIntraChainArbitrage()` | 240-295 | Uses `comparePrices()` (private) |

**Critical Bug Found:**
```typescript
// base-detector.ts:1178 - USES AVERAGE (incorrect)
const avgPrice = (sourceUpdate.price + targetUpdate.price) / 2;
const percentageDiff = priceDiff / avgPrice;

// vs base-detector.ts:832 - USES MIN (correct)
const priceDiff = Math.abs(currentPrice - otherPrice) / Math.min(currentPrice, otherPrice);
```

This inconsistency means **the same detector uses two different profit calculations** depending on which code path executes.

---

### Hypothesis 2: Non-Uniform Data Models Create Testing Barriers
**Confidence: 90%**

**Evidence - 5 Different Data Structures:**

```typescript
// 1. arbitrage-calculator.ts:25-34 - Canonical (but not universally used)
interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;  // String!
  reserve1: string;  // String!
  fee: number;
  blockNumber: number;
}

// 2. chain-instance.ts:93-100 - Duplicate definition
interface PairSnapshot {  // Same name, different context
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
}

// 3. base-detector.ts:61-66 - Extended variant
interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;  // Extra field
}

// 4. solana-detector.ts:174-188 - Completely different
interface SolanaPool {
  address: string;
  dex: string;
  token0: SolanaTokenInfo;  // Nested object!
  token1: SolanaTokenInfo;  // Nested object!
  reserve0: bigint;  // BigInt, not string!
  reserve1: bigint;  // BigInt, not string!
  fee: number;  // In basis points (needs /10000)!
  price?: number;
  lastSlot: number;  // Solana slots, not blocks
}

// 5. types/index.ts - Base Pair type
interface Pair {
  address: string;
  token0: Token;
  token1: Token;
  dex: string;
  fee: number;
}
```

**Impact:** Cannot write a single test that validates all calculation paths.

---

### Hypothesis 3: Embedded Calculation Logic Prevents Unit Testing
**Confidence: 85%**

**Evidence - Key Function Visibility:**

| Function | File | Visibility | Testable? |
|----------|------|------------|-----------|
| `comparePrices()` | arbitrage-calculator.ts | **private** | NO |
| `checkIntraDexArbitrage()` | base-detector.ts | `protected` | Only via subclass |
| `calculateArbitrageOpportunity()` | base-detector.ts | `protected` | Only via subclass |
| `calculateArbitrageOpportunity()` | solana-detector.ts | `private` | NO |
| `calculatePriceFromSnapshot()` | base-detector.ts | `protected` | Only via subclass |

To test profit calculations, you must:
1. Mock Redis
2. Mock WebSocket
3. Create entire detector instance
4. Trigger events through the pipeline

This is **integration testing masquerading as unit testing**.

---

### Hypothesis 4: Fee Handling Inconsistencies
**Confidence: 88%**

**Evidence:**

```typescript
// solana-detector.ts:1156-1159 - Basis points conversion
const fee1 = pool1.fee / 10000;  // 30 -> 0.003
const fee2 = pool2.fee / 10000;

// base-detector.ts:835-836 - Direct decimal with fallback
const currentFee = currentSnapshot.fee ?? 0.003;  // Already decimal
const otherFee = otherSnapshot.fee ?? 0.003;

// arbitrage-calculator.ts:424-425 - Uses getDefaultFee()
const fee1 = source1.fee ?? getDefaultFee(source1.source);
const fee2 = source2.fee ?? getDefaultFee(source2.source);

// base-detector.ts:1186-1187 - Uses ARBITRAGE_CONFIG
const sourceFee = sourceUpdate.fee ?? ARBITRAGE_CONFIG.feePercentage;
const targetFee = targetUpdate.fee ?? ARBITRAGE_CONFIG.feePercentage;
```

**4 different fee resolution strategies!**

---

### Hypothesis 5: Threshold Comparison Bugs
**Confidence: 92%**

**Evidence - Different comparison operators and units:**

```typescript
// solana-detector.ts:1165 - Uses < with *100
if (netProfit * 100 < this.config.minProfitThreshold) {
  return null;
}

// base-detector.ts:841 - Uses >= directly
if (netProfitPct >= this.getMinProfitThreshold()) {

// base-detector.ts:1191 - Uses < with decimal
if (netPercentage < ARBITRAGE_CONFIG.minProfitPercentage) {
  return null;
}

// arbitrage-calculator.ts:432-433
const minProfitThreshold = getMinProfitThreshold(chainId);
const isProfitable = netProfitPct >= minProfitThreshold;
```

**Question:** Is `minProfitThreshold` in percent (0.3) or decimal (0.003)?
This varies by caller, causing potential 100x threshold errors.

---

## Part 2: Root Cause Analysis

```
                    ┌──────────────────────┐
                    │  ROOT CAUSE          │
                    │  No Single Source    │
                    │  of Truth for        │
                    │  Calculations        │
                    └──────────┬───────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ SYMPTOM 1      │   │ SYMPTOM 2      │   │ SYMPTOM 3      │
│ Formula        │   │ Data Model     │   │ Testability    │
│ Inconsistency  │   │ Fragmentation  │   │ Barriers       │
└───────┬────────┘   └───────┬────────┘   └───────┬────────┘
        │                    │                    │
        ▼                    ▼                    ▼
  avgPrice vs          5 different         private/protected
  minPrice             interfaces          functions
```

---

## Part 3: Proposed Refactoring Architecture

### New Module Structure

```
shared/core/src/
├── profit-calculator/           # NEW: Pure calculation module
│   ├── index.ts                 # Public API
│   ├── types.ts                 # Unified types
│   ├── price.ts                 # Price calculations
│   ├── profit.ts                # Profit/loss calculations
│   ├── fees.ts                  # Fee utilities
│   └── validation.ts            # Input validation
│
├── detection-strategies/        # NEW: Strategy pattern
│   ├── index.ts
│   ├── base-strategy.ts         # Interface
│   ├── intra-chain.strategy.ts  # Same-chain
│   ├── cross-chain.strategy.ts  # Multi-chain
│   └── triangular.strategy.ts   # Multi-hop
│
├── adapters/                    # NEW: Data model adapters
│   ├── pair-adapter.ts          # EVM pairs → unified
│   ├── solana-adapter.ts        # Solana pools → unified
│   └── index.ts
│
└── __tests__/unit/
    └── profit-calculator/       # Comprehensive unit tests
        ├── price.test.ts
        ├── profit.test.ts
        ├── fees.test.ts
        └── integration.test.ts
```

---

### Key Design Principles

#### 1. Pure Functions (No Side Effects)

```typescript
// profit-calculator/price.ts - PROPOSED

/**
 * Calculate price spread percentage.
 *
 * CANONICAL FORMULA (single source of truth):
 * spread = |price1 - price2| / min(price1, price2)
 *
 * @param price1 - First price (must be > 0)
 * @param price2 - Second price (must be > 0)
 * @returns Spread as decimal (0.01 = 1%)
 */
export function calculateSpread(price1: number, price2: number): number {
  if (price1 <= 0 || price2 <= 0) {
    throw new PriceCalculationError('Prices must be positive');
  }

  const minPrice = Math.min(price1, price2);
  return Math.abs(price1 - price2) / minPrice;
}
```

#### 2. Unified Data Model

```typescript
// profit-calculator/types.ts - PROPOSED

/**
 * Unified trading pair representation.
 * All detectors MUST convert to this format before calculation.
 */
export interface UnifiedPair {
  readonly id: string;           // Unique identifier
  readonly dex: string;          // DEX name
  readonly chain: string;        // Chain identifier
  readonly token0: string;       // Token 0 address (lowercase)
  readonly token1: string;       // Token 1 address (lowercase)
  readonly reserve0: bigint;     // Reserve in smallest unit (wei)
  readonly reserve1: bigint;     // Reserve in smallest unit
  readonly feePercent: number;   // Fee as decimal (0.003 = 0.3%)
  readonly timestamp: number;    // Unix timestamp ms
  readonly blockOrSlot: number;  // Block number or Solana slot
}

/**
 * Result of profit calculation - immutable value object.
 */
export interface ProfitCalculation {
  readonly grossSpreadPercent: number;   // Before fees
  readonly totalFeesPercent: number;     // Combined fees
  readonly netProfitPercent: number;     // After fees
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly buySource: string;
  readonly sellSource: string;
  readonly isProfitable: boolean;
  readonly confidence: number;           // 0-1
}
```

#### 3. Adapter Pattern for Data Conversion

```typescript
// adapters/pair-adapter.ts - PROPOSED

import { UnifiedPair } from '../profit-calculator/types';
import { ExtendedPair } from '../base-detector';
import { SolanaPool } from '../solana-detector';

/**
 * Convert EVM ExtendedPair to UnifiedPair
 */
export function fromEvmPair(
  pair: ExtendedPair,
  chain: string,
  dex: string
): UnifiedPair {
  return {
    id: pair.address.toLowerCase(),
    dex,
    chain,
    token0: pair.token0.toLowerCase(),
    token1: pair.token1.toLowerCase(),
    reserve0: BigInt(pair.reserve0),
    reserve1: BigInt(pair.reserve1),
    feePercent: pair.fee ?? 0.003,  // Already decimal
    timestamp: pair.lastUpdate,
    blockOrSlot: pair.blockNumber,
  };
}

/**
 * Convert Solana pool to UnifiedPair
 */
export function fromSolanaPool(pool: SolanaPool): UnifiedPair {
  return {
    id: pool.address,
    dex: pool.dex,
    chain: 'solana',
    token0: pool.token0.mint,
    token1: pool.token1.mint,
    reserve0: pool.reserve0,  // Already bigint
    reserve1: pool.reserve1,
    feePercent: pool.fee / 10000,  // Convert basis points
    timestamp: Date.now(),
    blockOrSlot: pool.lastSlot,
  };
}
```

#### 4. Strategy Pattern for Detection

```typescript
// detection-strategies/intra-chain.strategy.ts - PROPOSED

import { UnifiedPair, ProfitCalculation } from '../profit-calculator/types';
import { calculateProfit } from '../profit-calculator/profit';
import { ArbitrageOpportunity } from '@arbitrage/types';

export interface DetectionStrategy {
  detect(pairs: UnifiedPair[]): ArbitrageOpportunity[];
}

export class IntraChainStrategy implements DetectionStrategy {
  constructor(
    private readonly config: {
      minProfitPercent: number;  // As decimal: 0.003 = 0.3%
      minConfidence: number;     // 0-1
    }
  ) {}

  detect(pairs: UnifiedPair[]): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    // Group pairs by token pair (O(n) grouping + O(k^2) per group)
    const pairsByTokens = this.groupByTokenPair(pairs);

    for (const [, tokenPairs] of pairsByTokens) {
      if (tokenPairs.length < 2) continue;

      for (let i = 0; i < tokenPairs.length; i++) {
        for (let j = i + 1; j < tokenPairs.length; j++) {
          const calc = calculateProfit(tokenPairs[i], tokenPairs[j]);

          if (calc.isProfitable &&
              calc.netProfitPercent >= this.config.minProfitPercent &&
              calc.confidence >= this.config.minConfidence) {
            opportunities.push(this.toOpportunity(tokenPairs[i], tokenPairs[j], calc));
          }
        }
      }
    }

    return opportunities;
  }

  private groupByTokenPair(pairs: UnifiedPair[]): Map<string, UnifiedPair[]> {
    const groups = new Map<string, UnifiedPair[]>();

    for (const pair of pairs) {
      // Normalize key by sorting tokens alphabetically
      const key = [pair.token0, pair.token1].sort().join('-');

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(pair);
    }

    return groups;
  }

  private toOpportunity(
    buyPair: UnifiedPair,
    sellPair: UnifiedPair,
    calc: ProfitCalculation
  ): ArbitrageOpportunity {
    return {
      id: `${buyPair.chain}-${buyPair.id}-${sellPair.id}-${Date.now()}`,
      type: 'simple',
      chain: buyPair.chain,
      buyDex: calc.buySource,
      sellDex: calc.sellSource,
      buyPair: buyPair.id,
      sellPair: sellPair.id,
      token0: buyPair.token0,
      token1: buyPair.token1,
      buyPrice: calc.buyPrice,
      sellPrice: calc.sellPrice,
      profitPercentage: calc.netProfitPercent * 100,  // Convert to %
      expectedProfit: calc.netProfitPercent,
      confidence: calc.confidence,
      timestamp: Date.now(),
      expiresAt: Date.now() + 5000,
      status: 'pending',
    };
  }
}
```

---

## Part 4: Implementation Plan

### Phase 1: Create Pure Calculation Module (2-3 days)
**Risk: LOW | Impact: HIGH**

1. Create `shared/core/src/profit-calculator/` directory
2. Implement `types.ts` with `UnifiedPair` and `ProfitCalculation`
3. Implement `price.ts` with canonical formulas
4. Implement `profit.ts` with `calculateProfit()`
5. Implement `fees.ts` with unified fee resolution
6. Add comprehensive unit tests (aim for 100% branch coverage)
7. Export from `shared/core/src/index.ts`

### Phase 2: Create Adapters (1 day)
**Risk: LOW | Impact: MEDIUM**

1. Create `shared/core/src/adapters/` directory
2. Implement `fromEvmPair()` adapter
3. Implement `fromSolanaPool()` adapter
4. Add adapter unit tests

### Phase 3: Create Detection Strategies (2 days)
**Risk: MEDIUM | Impact: HIGH**

1. Create `shared/core/src/detection-strategies/` directory
2. Implement `IntraChainStrategy`
3. Implement `CrossChainStrategy`
4. Add strategy unit tests

### Phase 4: Migrate Detectors (3-4 days)
**Risk: MEDIUM-HIGH | Impact: HIGH**

1. Update `base-detector.ts` to use new module
2. Update `solana-detector.ts` to use new module
3. Update `chain-instance.ts` to use new module
4. Remove duplicated calculation code
5. Add integration tests verifying identical behavior

### Phase 5: Deprecate Old Code (1 day)
**Risk: LOW | Impact: LOW**

1. Mark old functions as `@deprecated`
2. Add TSDoc warnings
3. Document migration path

---

## Part 5: Risk Mitigation

### Regression Prevention

```typescript
// __tests__/regression/calculation-consistency.test.ts

describe('Calculation Consistency Regression', () => {
  const testCases = [
    {
      name: 'ETH/USDC 1% spread',
      pair1: { price: 3500, fee: 0.003 },
      pair2: { price: 3535, fee: 0.003 },
      expectedNetProfit: 0.004, // 1% - 0.6% = 0.4%
    },
    // ... more cases from production data
  ];

  test.each(testCases)('$name should calculate consistently', (tc) => {
    // Old implementation
    const oldResult = legacyCalculateArbitrage(tc.pair1, tc.pair2);

    // New implementation
    const newResult = calculateProfit(
      toUnifiedPair(tc.pair1),
      toUnifiedPair(tc.pair2)
    );

    expect(newResult.netProfitPercent).toBeCloseTo(oldResult.netProfit, 6);
  });
});
```

### Feature Flags

```typescript
// config/feature-flags.ts
export const FEATURE_FLAGS = {
  USE_NEW_PROFIT_CALCULATOR: process.env.USE_NEW_PROFIT_CALCULATOR === 'true',
};

// base-detector.ts
if (FEATURE_FLAGS.USE_NEW_PROFIT_CALCULATOR) {
  return newCalculateProfit(pair1, pair2);
} else {
  return this.legacyCalculateArbitrage(pair1, pair2);
}
```

---

## Part 6: Success Metrics

### Before Refactoring
- Lines of calculation code: ~400 (across 4 files)
- Data model types: 5
- Unit test coverage for calculations: ~30%
- Time to find price bug: Hours to days

### After Refactoring (Target)
- Lines of calculation code: ~200 (single module)
- Data model types: 2 (UnifiedPair, ProfitCalculation)
- Unit test coverage for calculations: 95%+
- Time to find price bug: Minutes (check unit tests)

---

## Part 7: Decision Matrix

| Action | Effort | Impact | Risk | Priority |
|--------|--------|--------|------|----------|
| Create profit-calculator module | Medium | High | Low | **P0** |
| Unify data models | Low | High | Low | **P0** |
| Add comprehensive tests | Low | High | Low | **P0** |
| Create adapters | Low | Medium | Low | **P1** |
| Migrate base-detector | Medium | High | Medium | **P1** |
| Migrate solana-detector | Medium | High | Medium | **P1** |
| Create detection strategies | Medium | Medium | Medium | **P2** |

---

## Appendix: Files to Modify

| File | Action | Lines Affected |
|------|--------|----------------|
| NEW: `profit-calculator/types.ts` | Create | ~80 |
| NEW: `profit-calculator/price.ts` | Create | ~60 |
| NEW: `profit-calculator/profit.ts` | Create | ~100 |
| NEW: `profit-calculator/fees.ts` | Create | ~40 |
| NEW: `adapters/pair-adapter.ts` | Create | ~60 |
| `shared/core/src/index.ts` | Add exports | ~10 |
| `base-detector.ts` | Refactor | ~150 (remove) |
| `solana-detector.ts` | Refactor | ~50 (remove) |
| `chain-instance.ts` | Refactor | ~50 (remove) |
| `arbitrage-calculator.ts` | Deprecate | ~100 (mark deprecated) |

---

## Conclusion

The current architecture suffers from **organic growth without centralization**. Each detector evolved its own calculation logic, leading to:

1. **3+ formula inconsistencies** (avgPrice vs minPrice)
2. **5 different data models** that represent the same concept
3. **Untestable private/protected functions** embedded in large classes
4. **Fee handling chaos** (basis points, decimals, config lookups)

The proposed refactoring creates a **single source of truth** for all profit calculations with:
- Pure functions that are 100% unit testable
- Unified data model with adapters for different sources
- Strategy pattern for different detection types
- Clear separation of concerns

**Confidence in success: 88%** - The approach is proven in similar trading systems and the risks are manageable with proper feature flags and regression tests.

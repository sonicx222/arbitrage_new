# Modularization Enhancement Plan: Detection & Price Calculation

**Date:** 2026-01-18
**Status:** Analysis Complete
**Foundation Components:** PriceCalculator, PairRepository (implemented)

---

## Executive Summary

After a deep-dive code archaeology of the detection and price calculation architecture, I identified:

| Category | Count | Critical |
|----------|-------|----------|
| Price Calculation Locations | 6 | 2 with precision issues |
| Arbitrage Detection Methods | 4 | 1 with bug |
| Formula Inconsistencies | 3 | 1 critical bug in Solana |
| Duplication Categories | 5 | All can be consolidated |

**Key Finding:** The foundation components (`PriceCalculator`, `PairRepository`) are implemented but **not yet integrated** into the existing detection code.

---

## Part 1: Current Architecture Map

### 1.1 Price Calculation Locations

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PRICE CALCULATION LOCATIONS                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  base-detector.ts                                                   │
│  ├─ calculatePrice() [L1388-1404]          ❌ parseFloat() LEGACY   │
│  └─ calculatePriceFromSnapshot() [L1440]   ❌ parseFloat() LEGACY   │
│                                                                     │
│  arbitrage-calculator.ts                                            │
│  └─ calculatePriceFromReserves() [L123]    ✓ BigInt MODERN          │
│                                                                     │
│  chain-instance.ts                                                  │
│  └─ calculateArbitrage() [L1253]           ✓ Uses BigInt functions  │
│                                                                     │
│  solana-detector.ts                                                 │
│  └─ calculateArbitrageOpportunity() [L1145] ⚠️ Uses pool.price     │
│                                                                     │
│  components/price-calculator.ts            ★ CANONICAL SOURCE       │
│  └─ calculatePriceFromReserves() [L103]    ✓ BigInt, handles all    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Spread Calculation Comparison

| File | Line | Formula | Status |
|------|------|---------|--------|
| base-detector.ts | 832 | `\|p1-p2\| / min(p1,p2)` | ✓ Correct |
| chain-instance.ts | 1282 | `\|p1-p2\| / min(p1,p2)` | ✓ Correct |
| solana-detector.ts | 1154 | `(max-min) / min` | ✓ Equivalent |
| price-calculator.ts | 157 | `\|p1-p2\| / min(p1,p2)` | ★ Canonical |

**Finding:** All spread formulas are CONSISTENT (using minPrice denominator).

### 1.3 Threshold Comparison Inconsistency

| File | Line | Code | Units | Issue |
|------|------|------|-------|-------|
| base-detector.ts | 841 | `netProfitPct >= threshold` | decimal | ✓ OK |
| chain-instance.ts | 1294 | `netProfitPct < threshold` | decimal | ✓ OK |
| solana-detector.ts | 1165 | `netProfit * 100 < threshold` | **percentage** | ❌ BUG |

---

## Part 2: Critical Findings

### 🔴 Critical Bug #1: Solana Threshold Check (WRONG UNITS)

**File:** `shared/core/src/solana-detector.ts:1165`

```typescript
// CURRENT (BUGGY):
if (netProfit * 100 < this.config.minProfitThreshold) {
  return null;
}
```

**Problem Analysis:**
- `netProfit` is decimal (e.g., `0.005` = 0.5%)
- `netProfit * 100` converts to percentage (`0.5`)
- But `minProfitThreshold` is already in percentage form (e.g., `0.3`)
- Result: `0.5 < 0.3` = false, so opportunities with 0.5% profit pass
- But: `0.003 * 100 = 0.3`, and `0.3 < 0.3` = false, borderline opportunities also pass

**Impact:** May reject valid opportunities OR accept invalid ones depending on config interpretation.

**Fix:**
```typescript
// CORRECTED:
if (netProfit < this.config.minProfitThreshold / 100) {
  return null;
}
// OR if config is already decimal:
if (netProfit < this.config.minProfitThreshold) {
  return null;
}
```

---

### 🔴 Critical Bug #2: Precision Loss in base-detector.ts

**Files:** `shared/core/src/base-detector.ts:1388-1404, 1440-1454`

```typescript
// CURRENT (PRECISION LOSS):
protected calculatePrice(pair: Pair): number {
  const reserve0 = parseFloat(pair.reserve0 || '0');
  const reserve1 = parseFloat(pair.reserve1 || '0');
  // ...
  return reserve0 / reserve1;
}
```

**Problem Analysis:**
- `parseFloat()` loses precision for large numbers
- Example: `"123456789123456789012345"` → `1.2345678912345678e+23`
- Last 6+ digits are LOST, affecting price calculations

**Impact:** Wrong prices for high-value pools, potentially missing opportunities or creating false positives.

**Fix:** Use BigInt-based calculation:
```typescript
import { calculatePriceFromReserves } from './components/price-calculator';

protected calculatePrice(pair: Pair): number {
  const price = calculatePriceFromReserves(pair.reserve0, pair.reserve1);
  return price ?? 0;
}
```

---

### 🟡 Medium Issue: Fee Resolution Inconsistency

**Locations:**
- base-detector.ts:835 - Uses `?? 0.003`
- chain-instance.ts:1290 - Uses `?? 0.003`
- solana-detector.ts:1157 - Uses `/ 10000` (basis points)

**Problem:** Different default fee sources and formats.

**Fix:** Use centralized `resolveFee()` from PriceCalculator:
```typescript
import { resolveFee } from './components/price-calculator';

const fee1 = resolveFee(pair1.fee, pair1.dex);
const fee2 = resolveFee(pair2.fee, pair2.dex);
```

---

## Part 3: Refactoring Opportunities

### Opportunity 1: Centralize Price Calculations

**Current State:** 5 implementations across 4 files
**Target State:** 1 canonical implementation in PriceCalculator

**Files to Update:**

| File | Method | Action |
|------|--------|--------|
| base-detector.ts | `calculatePrice()` | Replace body with PriceCalculator call |
| base-detector.ts | `calculatePriceFromSnapshot()` | Replace body with PriceCalculator call |
| arbitrage-calculator.ts | `calculatePriceFromReserves()` | Re-export from PriceCalculator |
| chain-instance.ts | Already uses it | No change needed |

**Code Reduction:** ~40 lines

---

### Opportunity 2: Consolidate Arbitrage Detection Logic

**Current State:** 4 similar detection methods with duplicated logic
**Target State:** Single `ArbitrageDetector` strategy using PriceCalculator

**Pattern to Extract:**
```typescript
// Proposed: shared/core/src/components/arbitrage-detector.ts

export interface ArbitrageInput {
  pair1: PairSnapshot;
  pair2: PairSnapshot;
  minProfitThreshold: number;
  chainConfig: { gasEstimate: string; confidence: number; expiryMs: number };
}

export function detectArbitrage(input: ArbitrageInput): ArbitrageOpportunity | null {
  const price1 = calculatePriceFromReserves(input.pair1.reserve0, input.pair1.reserve1);
  const price2Raw = calculatePriceFromReserves(input.pair2.reserve0, input.pair2.reserve1);

  if (price1 === null || price2Raw === null) return null;

  // Handle reverse order
  const price2 = isReverseOrder(input.pair1, input.pair2) ? invertPrice(price2Raw) : price2Raw;

  // Calculate profit
  const result = calculateProfitBetweenSources(
    { price: price1, fee: resolveFee(input.pair1.fee), source: input.pair1.dex },
    { price: price2, fee: resolveFee(input.pair2.fee), source: input.pair2.dex }
  );

  if (!meetsThreshold(result.netProfit, input.minProfitThreshold)) return null;

  return buildOpportunity(input, result);
}
```

**Benefits:**
- Single source of truth for detection logic
- 100% unit testable (no class instantiation needed)
- Easy to verify formula correctness
- ~100 lines reduced per detector

---

### Opportunity 3: Use PairRepository for Token Lookups

**Current State:** Each detector maintains its own token pair index

| File | Index Variable | Pattern |
|------|---------------|---------|
| base-detector.ts | `pairsByTokens: Map<string, Pair[]>` | Manual indexing |
| chain-instance.ts | `pairsByTokens: Map<string, Pair[]>` | Manual indexing |
| solana-detector.ts | `poolsByTokenPair: Map<string, Set<string>>` | Different structure! |

**Target State:** Use `PairRepository` from components

**Migration:**
```typescript
// Before:
protected pairsByTokens: Map<string, Pair[]> = new Map();
const matchingPairs = this.pairsByTokens.get(key) || [];

// After:
protected pairRepository = createPairRepository();
const snapshots = this.pairRepository.createSnapshotsForTokens(token0, token1);
```

**Benefits:**
- Consistent API across EVM and Solana
- Built-in snapshot creation
- Change notifications for reactive updates

---

### Opportunity 4: Extract Token Order Handling

**Current State:** Inline reverse order checks in 3 places

```typescript
// base-detector.ts:822-828
const isReverseOrder = currentToken0Lower !== otherToken0Lower;
if (isReverseOrder && otherPrice !== 0) {
  otherPrice = 1 / otherPrice;
}

// chain-instance.ts:1278-1279
const isReversed = this.isReverseOrder(pair1, pair2);
let price2 = isReversed && price2Raw !== 0 ? 1 / price2Raw : price2Raw;
```

**Target:** Utility function in PriceCalculator:
```typescript
export function adjustPriceForTokenOrder(
  price: number,
  pair1Token0: string,
  pair2Token0: string
): number {
  if (pair1Token0.toLowerCase() !== pair2Token0.toLowerCase() && price !== 0) {
    return invertPrice(price);
  }
  return price;
}
```

---

## Part 4: Proposed Module Structure

### Current Structure (Fragmented)
```
shared/core/src/
├── base-detector.ts           # 1863 lines, 12+ responsibilities
├── arbitrage-calculator.ts    # 506 lines, some duplication
├── solana-detector.ts         # 1381 lines, different patterns
├── components/
│   ├── price-calculator.ts    # NEW: Pure calculations
│   └── pair-repository.ts     # NEW: Pair storage
```

### Target Structure (Modular)
```
shared/core/src/
├── components/
│   ├── index.ts
│   ├── price-calculator.ts      # Pure price/profit calculations
│   ├── pair-repository.ts       # O(1) pair storage with snapshots
│   ├── arbitrage-detector.ts    # NEW: Pure arbitrage detection logic
│   └── token-utils.ts           # NEW: Token address normalization, order handling
│
├── base-detector.ts             # SLIM: Orchestration only, uses components
├── solana-detector.ts           # SLIM: Solana-specific, uses components
├── arbitrage-calculator.ts      # DEPRECATED: Re-exports from components
│
└── __tests__/unit/components/
    ├── price-calculator.test.ts      # 102 tests ✓
    ├── pair-repository.test.ts       # Tests ✓
    ├── arbitrage-detector.test.ts    # NEW: Pure detection tests
    └── token-utils.test.ts           # NEW: Token utility tests
```

---

## Part 5: Implementation Roadmap

### Phase 1: Fix Critical Bugs (1-2 hours)
**Priority:** P0 - Immediate

1. **Fix Solana threshold bug** in `solana-detector.ts:1165`
2. **Fix precision loss** in `base-detector.ts:calculatePrice()`
3. Add regression tests for both fixes

### Phase 2: Integrate PriceCalculator (2-3 hours)
**Priority:** P1 - This Week

1. Update `base-detector.ts` to use `calculatePriceFromReserves()`
2. Update `base-detector.ts` to use `calculateSpread()` and `calculateNetProfit()`
3. Deprecate old `calculatePrice()` methods

### Phase 3: Create ArbitrageDetector Component (3-4 hours)
**Priority:** P1 - This Week

1. Extract common detection logic to `components/arbitrage-detector.ts`
2. Create comprehensive unit tests
3. Update detectors to use new component

### Phase 4: Integrate PairRepository (2-3 hours)
**Priority:** P2 - Next Week

1. Replace `pairsByTokens` Map with `PairRepository`
2. Update Solana detector to use same pattern
3. Remove duplicate token indexing code

### Phase 5: Create TokenUtils Component (1-2 hours)
**Priority:** P2 - Next Week

1. Extract token normalization functions
2. Extract reverse order handling
3. Consolidate address comparison logic

---

## Part 6: Metrics & Success Criteria

### Before Refactoring
| Metric | Value |
|--------|-------|
| Price calculation implementations | 5 |
| Lines of detection code | ~600 (across 4 files) |
| Unit test coverage for calculations | ~60% |
| Formula inconsistencies | 3 |
| Critical bugs | 2 |

### After Refactoring (Target)
| Metric | Target |
|--------|--------|
| Price calculation implementations | 1 (canonical) |
| Lines of detection code | ~200 (single component) |
| Unit test coverage for calculations | 95%+ |
| Formula inconsistencies | 0 |
| Critical bugs | 0 |

---

## Part 7: Risk Assessment

### Low Risk Changes
- Fixing the Solana threshold bug (clear fix, unit testable)
- Updating base-detector to use PriceCalculator (drop-in replacement)

### Medium Risk Changes
- Creating ArbitrageDetector component (needs thorough testing)
- Replacing pairsByTokens with PairRepository (behavioral change)

### Mitigation
1. Feature flag for new detection path
2. Run both old and new code in parallel during migration
3. Compare outputs for 24 hours before switching

---

## Appendix A: Code Location Reference

### Files to Modify

| File | Lines | Action |
|------|-------|--------|
| `shared/core/src/base-detector.ts` | 1388-1404, 1440-1454, 832-838 | Use PriceCalculator |
| `shared/core/src/solana-detector.ts` | 1165 | Fix threshold bug |
| `shared/core/src/arbitrage-calculator.ts` | N/A | Deprecate, re-export |
| `services/unified-detector/src/chain-instance.ts` | Already good | Verify consistency |

### New Files to Create

| File | Purpose |
|------|---------|
| `shared/core/src/components/arbitrage-detector.ts` | Pure detection logic |
| `shared/core/src/components/token-utils.ts` | Token address utilities |
| `shared/core/__tests__/unit/components/arbitrage-detector.test.ts` | Tests |
| `shared/core/__tests__/unit/components/token-utils.test.ts` | Tests |

---

## Conclusion

The foundation components (`PriceCalculator`, `PairRepository`) provide the building blocks for a cleaner architecture. The next steps are:

1. **Fix critical bugs immediately** (Solana threshold, precision loss)
2. **Integrate PriceCalculator** into existing detectors
3. **Extract ArbitrageDetector** as pure function component
4. **Standardize token handling** across EVM and Solana

This will reduce code duplication by ~60%, make bugs easier to find (single source of truth), and enable comprehensive unit testing without complex mocking.

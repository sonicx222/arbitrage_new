# Stale Price Window Behavior

## Overview

The cross-chain detector uses a **dual-layer staleness protection** system to prevent trading on outdated price data. Stale prices are dangerous because cross-chain arbitrage opportunities derived from them may no longer exist by the time a trade executes.

## Architecture

Two independent mechanisms work together:

### Layer 1: Hard Rejection (detector.ts)

Prices older than `maxPriceAgeMs` are unconditionally rejected before any confidence calculation. This is a binary gate — no amount of confidence boosting (whale activity, ML predictions) can override it.

**Location**: `detector.ts:findArbitrageInPrices()` (~line 1386)

```typescript
const maxPriceAgeMs = this.config.maxPriceAgeMs ?? 30000; // 30 seconds default
if (now - lowestPrice.update.timestamp > maxPriceAgeMs ||
    now - highestPrice.update.timestamp > maxPriceAgeMs) {
  // Skip this price pair entirely
  return opportunities;
}
```

**Default**: 30 seconds (`DetectorConfig.maxPriceAgeMs`)

**Why 30 seconds**: Cross-chain bridges take 1-15 minutes to complete. A 30-second window ensures the price signal is still relevant when the bridge transaction is submitted (within seconds), even though bridge completion is slower. After 30 seconds, market conditions have likely changed enough to invalidate the opportunity.

### Layer 2: Soft Confidence Penalty (confidence-calculator.ts)

Within the 30-second hard window, older prices receive proportionally lower confidence scores. This creates a gradual degradation rather than a cliff edge.

**Location**: `confidence-calculator.ts:applyAgePenalty()`

```typescript
// 1 minute of staleness = 10% penalty (floor at 10% of original confidence)
const ageMinutes = Math.max(0, (Date.now() - timestamp) / 60000);
const ageFactor = Math.max(0.1, 1 - ageMinutes * 0.1);
return confidence * ageFactor;
```

**Penalty schedule**:
| Price Age | Age Factor | Effect |
|-----------|------------|--------|
| 0s        | 1.00       | Full confidence |
| 6s        | 0.99       | 1% penalty |
| 15s       | 0.975      | 2.5% penalty |
| 30s       | 0.95       | 5% penalty (hard reject applies here) |
| 1min      | 0.90       | 10% penalty (only via Layer 2 if maxPriceAgeMs increased) |
| 5min      | 0.50       | 50% penalty |
| 9min      | 0.10       | 90% penalty (floor) |

### Layer 3: Data Cleanup (price-data-manager.ts)

Stale price data is removed from the in-memory store to prevent memory growth. This is a background maintenance task, not a safety mechanism.

**Location**: `price-data-manager.ts:cleanup()`

**Default**: 5 minutes (`PriceDataManagerConfig.maxPriceAgeMs`)

This is intentionally much longer than the detection hard rejection (30s) because the price data manager stores prices for all purposes (trend analysis, ML input, historical reference), not just for opportunity detection.

## Interaction Between Layers

```
Time=0s:  Price received
          └── Stored in PriceDataManager
          └── Available for detection (100% confidence)

Time=15s: Price is 15s old
          └── Still available for detection
          └── Soft penalty: ~2.5% confidence reduction

Time=30s: Price is 30s old
          └── HARD REJECTED by detector (maxPriceAgeMs default)
          └── Cannot generate opportunities regardless of whale/ML signals
          └── Still stored in PriceDataManager (for ML/trend analysis)

Time=5m:  Price is 5min old
          └── CLEANED UP by PriceDataManager
          └── Removed from memory
```

## Why Whale/ML Boosts Don't Override Hard Rejection

The hard rejection at 30s was specifically added (FIX #11) to address a scenario where:
1. A stale price (e.g., 45 seconds old) had low base confidence (~0.95 age factor)
2. Bullish whale activity boosted confidence by 1.15x
3. Aligned ML prediction boosted confidence by another 1.15x
4. The stacked boosts pushed confidence above the detection threshold

This created false opportunities based on outdated data. The hard rejection gate prevents this by checking staleness BEFORE any confidence calculation.

## Configuration

| Parameter | Location | Default | Purpose |
|-----------|----------|---------|---------|
| `maxPriceAgeMs` | `DetectorConfig` | 30000 (30s) | Hard rejection threshold in detection |
| `maxPriceAgeMs` | `PriceDataManagerConfig` | 300000 (5min) | Data cleanup threshold in storage |
| Age penalty rate | `ConfidenceCalculator` | 10%/min | Soft penalty gradient |
| Age penalty floor | `ConfidenceCalculator` | 0.10 | Minimum age factor |

## Tuning for Different Environments

- **High-frequency trading** (detection interval <100ms): Consider reducing `maxPriceAgeMs` to 10-15s
- **Slow chains** (Ethereum L1, Solana): Default 30s is appropriate for typical block times
- **Fast L2s** (Arbitrum, Base): Could reduce to 15-20s due to faster block production
- **Development/testing**: Set `maxPriceAgeMs` to a high value (e.g., 300000) to avoid stale rejections with mocked timestamps

## Performance Impact

The hard rejection check is optimized for the hot path:
- Single `Date.now()` call (shared with existing timestamp logic)
- Two integer comparisons
- No allocations
- O(1) — no iteration or lookup

## References

- `services/cross-chain-detector/src/detector.ts` — Hard rejection (FIX #11)
- `services/cross-chain-detector/src/confidence-calculator.ts` — Soft penalty
- `services/cross-chain-detector/src/price-data-manager.ts` — Data cleanup
- `services/cross-chain-detector/src/types.ts` — `DetectorConfig.maxPriceAgeMs`

# ADR-033: Stale Price Window Protection

## Status
**Accepted**

## Date
2026-02-22

## Context

The cross-chain detector compares prices across different blockchains to find arbitrage opportunities. Because cross-chain bridges take 1-15 minutes to complete, the system must ensure that the price data used for detection is still relevant when the bridge transaction is submitted (within seconds of detection).

Two problems existed before this decision:

1. **Stale prices passed confidence thresholds**: A price 45+ seconds old had a mild age penalty (~5%), but stacked boosts from whale activity (1.15x) and aligned ML predictions (1.15x) could push confidence above the detection threshold, creating false opportunities based on outdated data.

2. **No hard boundary on data age**: The soft age penalty in the confidence calculator degraded gracefully but never fully rejected stale data. Any price — regardless of age — could theoretically generate an opportunity if boosted enough.

These issues were identified as FIX #11 during the cross-chain detector bug hunt.

## Decision

Implement a **dual-layer staleness protection** system with a hard rejection gate and a soft confidence penalty:

### Layer 1: Hard Rejection (detector.ts)

Prices older than `maxPriceAgeMs` (default: 30 seconds) are unconditionally rejected **before** any confidence calculation. This is a binary gate — no amount of confidence boosting can override it.

```typescript
const maxPriceAgeMs = this.config.maxPriceAgeMs ?? 30000;
if (now - lowestPrice.update.timestamp > maxPriceAgeMs ||
    now - highestPrice.update.timestamp > maxPriceAgeMs) {
  return opportunities; // Skip this price pair entirely
}
```

### Layer 2: Soft Confidence Penalty (confidence-calculator.ts)

Within the hard window, older prices receive proportionally lower confidence scores via `applyAgePenalty()`:

```typescript
const ageMinutes = Math.max(0, (Date.now() - timestamp) / 60000);
const ageFactor = Math.max(0.1, 1 - ageMinutes * 0.1);
return confidence * ageFactor;
```

Penalty schedule: 10% reduction per minute, floor at 10% of original confidence.

### Layer 3: Data Cleanup (price-data-manager.ts)

Background cleanup removes prices older than 5 minutes from the in-memory store. This is a memory management task, not a safety mechanism. The 5-minute window is intentionally longer than the 30-second hard rejection because the price data manager stores prices for trend analysis, ML input, and historical reference — not just for opportunity detection.

## Rationale

### Why a hard rejection gate?

The soft penalty alone was insufficient because confidence boosts are multiplicative. A 5% age penalty on a stale price could be overcome by a 1.15x whale boost and a 1.15x ML boost, producing a net 1.26x multiplier that exceeded the threshold. A hard gate eliminates this class of false positives entirely.

### Why 30 seconds?

- Bridge transactions are submitted within seconds of detection, even though bridge completion takes minutes
- After 30 seconds, market conditions have likely changed enough to invalidate the opportunity
- Matches the WebSocket staleness detection threshold (ADR-010) for conceptual consistency
- Short enough to prevent stale-data-driven false positives, long enough to avoid rejecting valid opportunities on slow chains (Ethereum L1 block time: ~12s)

### Why check before confidence calculation?

Placing the check before `calculateConfidence()` ensures that:
1. No CPU is wasted computing confidence for stale data
2. The rejection is unconditional — no downstream logic can override it
3. The hot-path performance impact is minimal (two integer comparisons)

### Why a separate cleanup threshold?

The 5-minute cleanup threshold serves a different purpose (memory management) than the 30-second detection threshold (data integrity). Price data older than 30 seconds is useless for detection but still valuable for:
- ML model training features (price trends, volatility estimation)
- Momentum tracker EMA calculations
- Historical reference for whale activity analysis

## Consequences

### Positive
- **Eliminates stale-data false positives**: Hard gate prevents boost-bypass scenarios (FIX #11)
- **Gradual degradation**: Soft penalty provides nuanced scoring within the valid window
- **Minimal hot-path impact**: Two integer comparisons, no allocations, O(1)
- **Clear separation of concerns**: Detection safety vs. memory management operate independently
- **Configurable**: `maxPriceAgeMs` can be tuned per deployment environment

### Negative
- **Potential missed opportunities on slow chains**: If a chain's price feed is intermittently delayed >30s, valid opportunities may be rejected
- **Two separate `maxPriceAgeMs` parameters**: `DetectorConfig.maxPriceAgeMs` (30s) and `PriceDataManagerConfig.maxPriceAgeMs` (5min) share the same name but serve different purposes — requires documentation to avoid confusion

### Neutral
- **Not exposed as environment variable**: Configured via code, not `.env`. Appropriate for a tuning parameter that rarely changes.

## Alternatives Considered

### 1. Increase soft penalty rate
- **Rejected**: Even a steep penalty (e.g., 50%/min) could still be overcome by stacked boosts
- **Problem**: Soft penalties are continuous; boost bypass is always possible at some age

### 2. Cap total confidence boosts
- **Implemented as complementary measure** (FIX #10): 1.5x boost cap in confidence calculator
- **Not sufficient alone**: Even with a 1.5x cap, a 5% age penalty still allows stale prices through

### 3. Require fresh data for both prices
- **Adopted**: Both the lowest and highest price must pass the age check
- **Simpler than checking only one side**

### 4. Dynamic threshold based on chain block time
- **Deferred**: Could be added later (e.g., 15s for fast L2s, 45s for Ethereum L1)
- **Current 30s default works well across all supported chains**

## Implementation

### Files
- `services/cross-chain-detector/src/detector.ts` — Hard rejection gate (`findArbitrageInPrices()`)
- `services/cross-chain-detector/src/confidence-calculator.ts` — Soft age penalty (`applyAgePenalty()`)
- `services/cross-chain-detector/src/price-data-manager.ts` — Background cleanup (`cleanup()`)
- `services/cross-chain-detector/src/types.ts` — `DetectorConfig.maxPriceAgeMs` type definition

### Configuration

| Parameter | Location | Default | Purpose |
|-----------|----------|---------|---------|
| `maxPriceAgeMs` | `DetectorConfig` | 30000 (30s) | Hard rejection threshold in detection |
| `maxPriceAgeMs` | `PriceDataManagerConfig` | 300000 (5min) | Data cleanup threshold in storage |
| Age penalty rate | `ConfidenceCalculator` | 10%/min | Soft penalty gradient |
| Age penalty floor | `ConfidenceCalculator` | 0.10 | Minimum age factor |

### Tuning Guidance
- **High-frequency trading** (detection interval <100ms): Consider reducing to 10-15s
- **Slow chains** (Ethereum L1): Default 30s is appropriate
- **Fast L2s** (Arbitrum, Base): Could reduce to 15-20s
- **Development/testing**: Set to a high value (e.g., 300000) to avoid stale rejections with mocked timestamps

### Test Coverage
- `detector.test.ts` — Hard rejection when price exceeds 30s threshold
- `confidence-calculator.test.ts` — Age penalty schedule, freshness, 0.1 floor
- `price-data-manager.test.ts` — Cleanup behavior at various age thresholds

## References

- [STALE_PRICE_WINDOW.md](../../STALE_PRICE_WINDOW.md) — Detailed behavior documentation
- [ADR-010: WebSocket Connection Resilience](./ADR-010-websocket-resilience.md) — Connection-level staleness (distinct concept)
- [ADR-014: Modular Detector Components](./ADR-014-modular-detector-components.md) — Detector architecture context
- [ADR-005: Hierarchical Caching Strategy](./ADR-005-hierarchical-cache.md) — Cache TTL context

## Confidence Level

95% - High confidence based on:
- Addresses a confirmed false-positive scenario (FIX #11)
- Hard rejection is a well-understood safety pattern
- Minimal performance impact on hot path
- Comprehensive test coverage across all three layers
- 30s default validated against cross-chain bridge timing requirements

Risk factors:
- Dynamic per-chain thresholds may be needed as chain diversity grows
- The two `maxPriceAgeMs` parameters with different defaults could cause confusion

# ADR-035: Statistical Arbitrage Strategy

## Status
**Accepted**

## Date
2026-02-24

## Confidence
**80%**

## Context

The system exclusively exploited instantaneous price discrepancies between DEXs. Statistical arbitrage — trading when correlated pairs diverge beyond historical norms — is a complementary strategy that captures different alpha from mean-reverting pair relationships.

## Decision

### Three-component signal generation

Opportunities are generated only when ALL three conditions align:

1. **SpreadTracker (Bollinger Bands):** Log-spread between pair crosses the +/-2 sigma band
2. **RegimeDetector (Hurst exponent):** Market is in mean-reverting regime (H < 0.5)
3. **PairCorrelationTracker (Pearson):** Pair correlation exceeds 0.7 threshold

This triple-gate design minimizes false signals. Each component can independently reject.

### Atomic execution via flash loans

Despite being a "statistical" strategy, execution is atomic within a single transaction. The overvalued/undervalued tokens are swapped across different DEXs using flash loan infrastructure, avoiding any position holding risk.

### Target pairs (correlated majors)

Initial pairs chosen for high correlation and well-understood mean reversion:
- WETH/WBTC (correlation 0.85-0.95)
- USDC/USDT, USDC/DAI (stablecoin pegs)
- stETH/WETH, rETH/WETH (LST/underlying)

### Hurst exponent for regime detection

Chosen over alternatives (Hidden Markov Models, ML-based regime detection) for:
- No external dependencies or model training
- Well-understood theoretical foundation
- Computationally lightweight (R/S method)
- Deterministic (same input produces same output)

## Consequences

### Positive

- New `'statistical'` strategy type captures alpha from mean-reverting pair relationships
- Triple-gate signal generation minimizes false positives
- Atomic execution eliminates position holding risk
- Extends existing flash loan execution path (no new execution infrastructure)

### Negative

- Three new analytics modules increase codebase surface area
- Regime detection requires sufficient historical data (minimum window) before generating signals
- Hurst exponent computation on every price update adds CPU overhead to detection path

### Neutral

- Controlled by `FEATURE_STATISTICAL_ARB=true` feature flag
- Statistical and instantaneous arbitrage strategies are complementary (no interference)
- SpreadTracker and RegimeDetector can be reused by future strategies

## Alternatives Considered

### Alternative 1: ML-Based Regime Detection

**Pros**: Potentially more accurate regime classification
**Cons**: Requires model training, external dependencies, non-deterministic
**Rejected**: Hurst exponent provides sufficient accuracy with zero training overhead

### Alternative 2: Position-Based Statistical Arbitrage

**Pros**: Can capture larger spreads over time
**Cons**: Requires capital at risk, position management, liquidation risk
**Rejected**: Atomic flash-loan execution is consistent with the system's zero-capital design

### Alternative 3: Simple Z-Score Threshold (No Triple Gate)

**Pros**: Simpler implementation, more signals generated
**Cons**: Higher false positive rate, trades in trending markets where mean reversion fails
**Rejected**: Triple gate significantly reduces false signals; Hurst exponent prevents trading in non-mean-reverting regimes

## References

- `shared/core/src/analytics/pair-correlation-tracker.ts`
- `shared/core/src/analytics/spread-tracker.ts`
- `shared/core/src/analytics/regime-detector.ts`
- `shared/core/src/detector/statistical-arbitrage-detector.ts`
- `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts`
- [ADR-020: Flash Loan Integration](./ADR-020-flash-loan.md) — Flash loan execution path
- [ADR-021: Capital Risk Management](./ADR-021-capital-risk-management.md) — Risk framework

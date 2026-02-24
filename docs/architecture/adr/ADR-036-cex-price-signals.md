# ADR-036: CEX Price Signal Integration

## Status
**Accepted**

## Date
2026-02-24

## Confidence
**85%**

## Context

DEX-only price detection has inherent latency — price information reaches DEXs after it's already reflected on centralized exchanges. Using CEX prices as a "fair value" reference enables faster detection of DEX mispricing and filters out false-positive opportunities where the DEX price is actually correct.

## Decision

### Binance as sole CEX source

Binance provides the highest liquidity and widest pair coverage among CEXs. Its public WebSocket trade stream requires no API key and is rate-limit-friendly.

**Why not multiple exchanges:** Marginal signal improvement (Binance covers 90%+ of relevant pairs) doesn't justify the added connection management, normalization complexity, and failure modes of multi-exchange integration.

### Read-only trade stream (not order book)

Subscribes to `@trade` streams (individual trade events) rather than `@depth` (order book). Trade stream provides realized prices with lower bandwidth. Order book depth would enable better spread analysis but requires significantly more processing.

### Symbol normalization layer

Maps Binance symbols (BTCUSDT, ETHUSDT, etc.) to internal token IDs (WBTC, WETH) with per-chain availability mapping. This decouples the CEX-specific naming from the internal token model.

### EventEmitter-based pipeline

Components communicate via EventEmitter events, consistent with the existing detection pipeline pattern. Integration with PriceMatrix and detection pipeline is deferred to the monolith migration.

## Consequences

### Positive

- CEX-DEX spread calculator enables new class of spread-based opportunity detection
- Public WebSocket stream requires no API key or authentication
- 8 initial Binance pairs covering native tokens of all supported chains
- Low bandwidth overhead (trade events only, not full order book)

### Negative

- `ws` package added to `shared/core` dependencies
- Binance WebSocket API becomes a runtime dependency (mitigated by feature flag)
- CEX prices may diverge from DEX reality during high volatility (stale CEX data)

### Neutral

- Controlled by `FEATURE_CEX_PRICE_SIGNALS=true` feature flag
- EventEmitter pattern is consistent with existing detection pipeline
- Symbol normalization layer can be extended to additional exchanges in the future

## Alternatives Considered

### Alternative 1: Multiple CEX Sources (Binance + Coinbase + Kraken)

**Pros**: More robust price signal, exchange-specific coverage
**Cons**: 3x connection management, normalization complexity, more failure modes
**Rejected**: Binance covers 90%+ of relevant pairs; marginal improvement doesn't justify complexity

### Alternative 2: REST Polling Instead of WebSocket

**Pros**: Simpler implementation, no connection management
**Cons**: Higher latency (polling interval), higher bandwidth, rate limit risk
**Rejected**: WebSocket provides sub-second price updates with lower overhead

### Alternative 3: Order Book Depth Streams

**Pros**: Richer data (bid/ask spread, depth, liquidity)
**Cons**: 10-100x bandwidth, requires order book reconstruction, complex state management
**Rejected**: Trade stream provides sufficient price signal for spread detection

## References

- `shared/core/src/feeds/binance-ws-client.ts`
- `shared/core/src/feeds/cex-price-normalizer.ts`
- `shared/core/src/analytics/cex-dex-spread.ts`
- [Binance WebSocket API](https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams)
- [ADR-005: Hierarchical Caching Strategy](./ADR-005-hierarchical-cache.md) — Price data caching
- [ADR-033: Stale Price Window Protection](./ADR-033-stale-price-window.md) — Staleness handling

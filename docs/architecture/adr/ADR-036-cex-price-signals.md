# ADR-036: CEX Price Signal Integration

## Status
**Accepted** — Fully implemented 2026-03-11. See `docs/plans/2026-03-11-cex-price-signal-integration.md`.

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
- 9 Binance pairs covering native tokens of all supported chains
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

## Implementation Notes (2026-03-11)

Implemented across 6 batches in 2 commits (`327bcb4e`, `ef895562`):

1. **Feature flag**: `FEATURE_CEX_PRICE_SIGNALS=true` opt-in (`shared/config/src/feature-flags.ts`)
2. **CexPriceFeedService**: Singleton orchestrator composing BinanceWebSocketClient → CexPriceNormalizer → CexDexSpreadCalculator (`shared/core/src/feeds/cex-price-feed-service.ts`)
3. **Coordinator wiring**: Started/stopped with coordinator lifecycle, DEX prices fed from opportunity router's token resolution (`services/coordinator/src/coordinator.ts`)
4. **CEX alignment scoring**: `computeCexAlignment()` returns 1.15 (aligned), 0.8 (contradicted), or 1.0 (neutral) based on buy-side CEX-DEX spread with ±0.1% noise band (`services/coordinator/src/opportunities/cex-alignment.ts`)
5. **Simulation mode**: `simulateCexPrices` config option generates synthetic CEX prices from DEX with ±0.15% noise — no external connection needed
6. **Dashboard**: `cex-spread` SSE event (10s, feature-gated), `CexSpreadCtx` context with selective re-rendering, CexSpreadSection in DiagnosticsTab

Hot-path impact: <0.1ms — `getSpread()` is O(1) Map.get, CEX feed runs asynchronously in background.

## References

- `shared/core/src/feeds/cex-price-feed-service.ts` — Orchestrator singleton
- `shared/core/src/feeds/binance-ws-client.ts` — WebSocket client with auto-reconnect
- `shared/core/src/feeds/cex-price-normalizer.ts` — Binance symbol → token ID mapping (9 symbols)
- `shared/core/src/analytics/cex-dex-spread.ts` — Spread calculator with O(1) index
- `services/coordinator/src/opportunities/cex-alignment.ts` — Alignment computation
- `services/coordinator/src/opportunities/opportunity-scoring.ts` — Score × cexAlignmentFactor
- `services/coordinator/src/api/routes/sse.routes.ts` — `cex-spread` SSE event
- `dashboard/src/tabs/DiagnosticsTab.tsx` — CexSpreadSection UI
- `docs/plans/2026-03-11-cex-price-signal-integration.md` — Implementation plan
- [Binance WebSocket API](https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams)
- [ADR-005: Hierarchical Caching Strategy](./ADR-005-hierarchical-cache.md) — Price data caching
- [ADR-033: Stale Price Window Protection](./ADR-033-stale-price-window.md) — Staleness handling

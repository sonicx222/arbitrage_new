# Enhancement Plan: CEX Price Signal Integration (ADR-036 Activation)

**Date**: 2026-03-11
**Scope**: Wire existing Binance WS client, CEX price normalizer, and CEX-DEX spread calculator into the live detection pipeline
**Confidence**: HIGH (infrastructure 90%+ built, zero wiring exists, well-defined integration points)
**ADR**: ADR-036 (status: Deferred — this plan activates it)

---

## 1. Current State Analysis

### What EXISTS (Built but Never Wired)

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| `BinanceWebSocketClient` | `shared/core/src/feeds/binance-ws-client.ts` | 444 | Complete: auto-reconnect, exponential backoff, ping/pong, typed events |
| `CexPriceNormalizer` | `shared/core/src/feeds/cex-price-normalizer.ts` | 169 | Complete: 9 default Binance→token mappings, chain availability |
| `CexDexSpreadCalculator` | `shared/core/src/analytics/cex-dex-spread.ts` | 352 | Complete: spread history, alert emission, stale price rejection, O(1) index |
| Tests (normalizer) | `shared/core/__tests__/unit/feeds/cex-price-normalizer.test.ts` | — | Existing |
| Tests (spread) | `shared/core/__tests__/unit/analytics/cex-dex-spread.test.ts` | — | Existing |
| Barrel exports | `shared/core/src/feeds/index.ts`, `shared/core/src/analytics/index.ts` | — | Already exported |

### What Does NOT Exist (The Gap)

1. **No feature flag**: `FEATURE_CEX_PRICE_SIGNALS` is referenced in ADR-036 but does not exist in `shared/config/src/feature-flags.ts`
2. **No service imports**: Zero services import `BinanceWebSocketClient`, `CexPriceNormalizer`, or `CexDexSpreadCalculator`
3. **No wiring code**: No service creates instances, connects events, or starts the Binance WS feed
4. **No spread→scoring integration**: `scoreOpportunity()` uses only `profit × confidence × (1/ttl)` — no CEX signal input
5. **No CEX price→PriceMatrix path**: DEX prices flow through PriceMatrix; CEX prices have no equivalent path
6. **No dashboard visibility**: No CEX-DEX spread display in the dashboard

### Why This Is the Highest-Impact Enhancement

From the profitability audit (Grade C+):
- The system detects DEX-vs-DEX spreads but has **no "fair value" reference** — it cannot distinguish real opportunities from noise
- CEX prices provide the authoritative "true price" that DEX prices mean-revert toward
- Professional arb systems (Wintermute, Jump, Alameda-style) use CEX-DEX spread as their **primary signal**, not DEX-DEX comparison
- ADR-036 was written specifically for this, infrastructure was built, but the final wiring step was never done

**Estimated impact**: 20-40% reduction in false-positive opportunities (spurious DEX-DEX spreads that disappear before execution)

---

## 2. Architecture Design

### Data Flow

```
Binance WS (public trade stream, no API key needed)
    │
    ▼
BinanceWebSocketClient (shared/core/src/feeds/)
    │  emits: 'trade' (BinanceTradeEvent)
    ▼
CexPriceNormalizer
    │  maps: BTCUSDT→WBTC, ETHUSDT→WETH, etc.
    │  returns: NormalizedCexPrice { tokenId, price, chains[], timestamp }
    ▼
CexDexSpreadCalculator.updateCexPrice(tokenId, price, timestamp)
    │  compares against DEX prices (fed from PriceMatrix or Sync events)
    │  emits: 'spread_alert' (SpreadAlert) when |spread| > 0.3%
    ▼
Two consumers:
  1. Coordinator: Boost/penalize opportunity confidence based on CEX-DEX alignment
  2. Dashboard (optional): Display CEX-DEX spread on Diagnostics tab
```

### Integration Point: Coordinator Service

The coordinator already scores opportunities via `scoreOpportunity()`. The CEX signal integrates as a **confidence modifier**:

- If DEX arb direction **aligns** with CEX-DEX spread → boost confidence (+10-20%)
- If DEX arb direction **contradicts** CEX-DEX spread → penalize confidence (-20-30%)
- If no CEX data available → no change (graceful degradation)

This is a **background process** — the Binance WS feed runs asynchronously and updates a shared state object. The hot path reads the cached spread via O(1) Map lookup, adding <1ms latency.

### Why Coordinator (Not Partition)

- Partitions detect opportunities using on-chain Sync events — they shouldn't depend on external CEX feeds
- Coordinator already has opportunity admission control (`scoreOpportunity`)
- Single Binance WS connection shared across all chains (CEX prices are global)
- Coordinator is the natural place for cross-cutting price intelligence

---

## 3. Implementation Plan

### Batch 0: Feature Flag + Env Config (Task 0.1)

**File**: `shared/config/src/feature-flags.ts`

Add `FEATURE_CEX_PRICE_SIGNALS` flag:
```typescript
/** Enable CEX price signal feed (Binance). @default false @see ADR-036 */
useCexPriceSignals: process.env.FEATURE_CEX_PRICE_SIGNALS === 'true',
```

Add validation in `validateFeatureFlags()`:
- If enabled, log info about active symbols
- Warn if SIMULATION_MODE=true (CEX feed still works but mixes real+simulated data)

**File**: `.env.example`

Add:
```
# CEX Price Signals (ADR-036)
# FEATURE_CEX_PRICE_SIGNALS=true
# CEX_PRICE_ALERT_THRESHOLD_PCT=0.3
# CEX_PRICE_MAX_AGE_MS=10000
```

**Effort**: 0.5 task | **Risk**: None | **Tests**: Existing feature flag validation tests cover pattern

---

### Batch 1: CEX Price Feed Service (Tasks 1.1–1.3)

#### Task 1.1: CexPriceFeedService Class

**File**: `shared/core/src/feeds/cex-price-feed-service.ts` (NEW — ~120 lines)

Orchestrator that composes the three existing components:

```typescript
export class CexPriceFeedService extends EventEmitter {
  private wsClient: BinanceWebSocketClient;
  private normalizer: CexPriceNormalizer;
  private spreadCalculator: CexDexSpreadCalculator;
  private running = false;

  constructor(config?: CexPriceFeedConfig) { ... }

  async start(): Promise<void> {
    // 1. Create BinanceWebSocketClient with symbols from normalizer
    // 2. Wire trade events → normalizer → spreadCalculator.updateCexPrice()
    // 3. Forward spread_alert events
    // 4. Connect WS
  }

  async stop(): Promise<void> { ... }

  /** O(1) spread lookup for hot-path scoring */
  getSpread(tokenId: string, chain: string): number | undefined {
    return this.spreadCalculator.getSpread(tokenId, chain);
  }

  /** Feed DEX price updates (called from price update handler) */
  updateDexPrice(tokenId: string, chain: string, price: number): void {
    this.spreadCalculator.updateDexPrice(tokenId, chain, price, Date.now());
  }
}
```

**Effort**: 1 task | **Risk**: Low | **Tests**: Unit test with mocked WS

#### Task 1.2: Export from feeds/index.ts

Add `CexPriceFeedService` to `shared/core/src/feeds/index.ts` barrel export.

**Effort**: 0.1 task | **Risk**: None

#### Task 1.3: Singleton + Getter

**File**: `shared/core/src/feeds/cex-price-feed-service.ts`

Add module-level singleton pattern (matching existing `getChainSimulator`, `getPriceOracle`, etc.):

```typescript
let instance: CexPriceFeedService | null = null;

export function getCexPriceFeedService(config?: CexPriceFeedConfig): CexPriceFeedService {
  if (!instance) {
    instance = new CexPriceFeedService(config);
  }
  return instance;
}

export function resetCexPriceFeedService(): void {
  instance?.stop();
  instance = null;
}
```

**Effort**: 0.2 task | **Risk**: None | **Tests**: Reset test in unit suite

---

### Batch 2: Coordinator Wiring (Tasks 2.1–2.3)

#### Task 2.1: Start CEX Feed on Coordinator Startup

**File**: `services/coordinator/src/index.ts` (or appropriate startup file)

Behind `FEATURE_FLAGS.useCexPriceSignals`:
1. Import `getCexPriceFeedService` from `@arbitrage/core`
2. Call `.start()` during coordinator startup
3. Call `.stop()` during shutdown

```typescript
if (FEATURE_FLAGS.useCexPriceSignals) {
  const cexFeed = getCexPriceFeedService({
    alertThresholdPct: parseFloat(process.env.CEX_PRICE_ALERT_THRESHOLD_PCT ?? '0.3'),
    maxCexPriceAgeMs: parseInt(process.env.CEX_PRICE_MAX_AGE_MS ?? '10000'),
  });
  await cexFeed.start();
  logger.info('CEX price feed started (Binance)');
}
```

**Effort**: 0.5 task | **Risk**: Low (feature-gated) | **Tests**: Coordinator startup test with mock

#### Task 2.2: Feed DEX Prices into Spread Calculator

**File**: `services/coordinator/src/handlers/price-update.handler.ts` (or equivalent)

When the coordinator processes price updates from partition streams, also feed them to the CEX spread calculator:

```typescript
if (FEATURE_FLAGS.useCexPriceSignals) {
  const cexFeed = getCexPriceFeedService();
  // Map token pair to tokenId (e.g., 'WETH/USDC' → 'WETH')
  const tokenId = extractBaseToken(opportunity.tokenPair);
  if (tokenId) {
    cexFeed.updateDexPrice(tokenId, opportunity.chain, opportunity.buyPrice);
  }
}
```

**Effort**: 0.5 task | **Risk**: Low | **Tests**: Unit test for DEX price feed-through

#### Task 2.3: CEX-Aware Opportunity Scoring

**File**: `services/coordinator/src/opportunities/opportunity-scoring.ts`

Extend `ScorableOpportunity` interface and `scoreOpportunity()`:

```typescript
export interface ScorableOpportunity {
  // ... existing fields ...
  /** CEX-DEX spread alignment factor (1.0 = neutral, >1.0 = aligned, <1.0 = contradicted) */
  cexAlignmentFactor?: number;
}
```

In `scoreOpportunity()`, after computing base score:
```typescript
// CEX alignment: boost/penalize based on CEX-DEX spread direction
const alignment = opp.cexAlignmentFactor;
if (alignment !== undefined && Number.isFinite(alignment) && alignment > 0) {
  return baseScore * alignment;
}
return baseScore;
```

The caller computes `cexAlignmentFactor` before calling `scoreOpportunity()`:
- DEX arb says "buy on DEX A, sell on DEX B" and CEX confirms token is underpriced on DEX A → factor = 1.15
- DEX arb says "buy on DEX A" but CEX says token is overpriced on DEX A → factor = 0.75
- No CEX data → factor = 1.0 (neutral)

**Effort**: 1 task | **Risk**: Medium (scoring logic affects all opps) | **Tests**: Extend existing 30+ scoring tests

---

### Batch 3: CEX Alignment Calculator (Tasks 3.1–3.2)

#### Task 3.1: Alignment Computation Logic

**File**: `services/coordinator/src/opportunities/cex-alignment.ts` (NEW — ~80 lines)

```typescript
/**
 * Compute CEX alignment factor for an opportunity.
 *
 * Logic:
 * - Get CEX-DEX spread for the base token on the buy chain
 * - If DEX price < CEX price (spread negative) AND opp buys on this DEX → aligned (boost)
 * - If DEX price > CEX price (spread positive) AND opp sells on this DEX → aligned (boost)
 * - Contradicted → penalize
 *
 * @returns alignment factor: 1.0 (neutral), 0.7-0.85 (contradicted), 1.1-1.2 (aligned)
 */
export function computeCexAlignment(
  baseToken: string,
  buyChain: string,
  sellChain: string,
  cexFeed: CexPriceFeedService,
): number {
  const buySpread = cexFeed.getSpread(baseToken, buyChain);
  if (buySpread === undefined) return 1.0; // No data → neutral

  // Spread > 0 means DEX overpriced vs CEX
  // If we're buying on this DEX while it's overpriced → contradicted
  if (buySpread > 0.1) return 0.8;  // DEX overpriced, buying there is risky
  if (buySpread < -0.1) return 1.15; // DEX underpriced, buying is aligned with CEX
  return 1.0; // Within noise band
}
```

**Effort**: 1 task | **Risk**: Low | **Tests**: Unit tests with mock spreads

#### Task 3.2: Wire Alignment into Opportunity Processing

**File**: `services/coordinator/src/handlers/` (batch or opportunity handler)

Before calling `scoreOpportunity()`, compute alignment:

```typescript
if (FEATURE_FLAGS.useCexPriceSignals) {
  const cexFeed = getCexPriceFeedService();
  scorableOpp.cexAlignmentFactor = computeCexAlignment(
    baseToken, opp.buyChain, opp.sellChain, cexFeed
  );
}
```

**Effort**: 0.5 task | **Risk**: Low (feature-gated) | **Tests**: Integration test with mock CEX feed

---

### Batch 4: Simulation Mode Support (Task 4.1)

#### Task 4.1: Simulated CEX Prices from PriceSimulator

When `SIMULATION_MODE=true`, the Binance WS won't connect to real Binance. Instead, generate synthetic CEX prices from the existing `PriceSimulator` output with a small lag (simulating CEX→DEX propagation delay):

**File**: `shared/core/src/feeds/cex-price-feed-service.ts`

```typescript
if (isSimulationMode()) {
  // Don't connect to real Binance — use simulated prices with CEX-like noise
  this.startSimulatedCexFeed();
} else {
  await this.wsClient.connect();
}
```

The simulated feed takes DEX prices, adds ±0.05% noise and a 50-200ms delay to create realistic CEX-DEX spreads.

**Effort**: 1 task | **Risk**: Low | **Tests**: Simulation-mode unit test

---

### Batch 5: Observability + Dashboard (Tasks 5.1–5.2)

#### Task 5.1: Metrics + Logging

**File**: `shared/core/src/feeds/cex-price-feed-service.ts`

- Log connection/disconnection/reconnection events
- Track metrics: `cex_price_updates_total`, `cex_dex_spread_alerts_total`, `cex_ws_reconnections_total`
- Log spread alerts at `info` level with token, chain, spread %

**Effort**: 0.5 task | **Risk**: None

#### Task 5.2: SSE Event for Dashboard (Optional)

**File**: `services/coordinator/src/api/routes/sse.routes.ts`

Add `cex-spread` SSE event type at 10s interval:
```typescript
{ type: 'cex-spread', data: { alerts: cexFeed.getActiveAlerts(), connected: cexFeed.isConnected() } }
```

Dashboard can display this in DiagnosticsTab (existing) without new tabs.

**Effort**: 1 task | **Risk**: None | **Tests**: SSE event test

---

## 4. Task Summary

| # | Task | Batch | Effort | Dependencies | Test Strategy |
|---|------|-------|--------|--------------|---------------|
| 0.1 | Feature flag + env config | 0 | 0.5 | None | Existing validation tests |
| 1.1 | CexPriceFeedService class | 1 | 1.0 | 0.1 | Unit test: mock WS, verify event wiring |
| 1.2 | Barrel export | 1 | 0.1 | 1.1 | Build passes |
| 1.3 | Singleton + getter | 1 | 0.2 | 1.1 | Reset test |
| 2.1 | Coordinator startup wiring | 2 | 0.5 | 1.3 | Startup test with mock |
| 2.2 | DEX price feed-through | 2 | 0.5 | 2.1 | Unit test: price routing |
| 2.3 | CEX-aware scoring extension | 2 | 1.0 | None | Extend 30+ existing scoring tests |
| 3.1 | Alignment computation | 3 | 1.0 | 1.3 | 10+ unit tests: aligned/contradicted/neutral |
| 3.2 | Wire alignment into handlers | 3 | 0.5 | 3.1, 2.3 | Integration test |
| 4.1 | Simulation mode support | 4 | 1.0 | 1.1 | Simulation unit test |
| 5.1 | Metrics + logging | 5 | 0.5 | 1.1 | Log verification |
| 5.2 | SSE dashboard event (optional) | 5 | 1.0 | 2.1 | SSE event test |

**Total effort**: ~8 tasks across 6 batches

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Binance WS disconnects frequently | LOW | LOW | Auto-reconnect already built. Spread calc rejects stale prices (10s max age). Feature-gated so system works without CEX data. |
| CEX prices lag behind DEX (flash crashes) | LOW | MEDIUM | `maxCexPriceAgeMs` rejects stale prices. Alignment factor uses ±0.1% noise band to avoid false signals. |
| Scoring changes cause unexpected behavior | MEDIUM | MEDIUM | Feature-gated. Default alignment = 1.0 (neutral). Extensive scoring test coverage (30+ tests). Gradual rollout via flag. |
| Corporate firewall blocks Binance WS | MEDIUM | LOW | Already observed with other WSS connections. `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround. In simulation mode, synthetic feed used instead. |
| Hot-path latency from CEX lookup | LOW | HIGH | `getSpread()` is O(1) Map.get — <0.1ms. Background feed, not synchronous on hot path. |

---

## 6. Success Metrics

- [ ] Binance WS connects and receives trade events (9 symbols)
- [ ] CEX-DEX spreads computed for WETH, WBTC, SOL, BNB on all mapped chains
- [ ] `spread_alert` events emitted when |spread| > 0.3%
- [ ] Opportunity scoring reflects CEX alignment (boosted/penalized scores)
- [ ] Zero hot-path latency regression (<50ms target maintained)
- [ ] System operates normally with `FEATURE_CEX_PRICE_SIGNALS=false` (default)
- [ ] Simulation mode produces synthetic CEX prices without external connection

---

## 7. ADR-036 Status Update

After implementation, ADR-036 should be updated from `Status: Deferred` to `Status: Accepted` with implementation notes referencing this plan.

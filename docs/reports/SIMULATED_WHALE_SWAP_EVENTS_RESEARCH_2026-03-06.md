# Research: Simulated Whale Alerts & Swap Events Without Blockchain Contracts

**Date**: 2026-03-06
**Status**: Research Complete
**Author**: Enhancement Research Agent (Opus 4.6)

---

## 1. Current State Analysis

### How It Works Today

The simulation layer has **three tiers** of event generation, all operating without blockchain connections:

| Tier | Module | Events Generated | Status |
|------|--------|-----------------|--------|
| **Price** | `PriceSimulator` | `SimulatedPriceUpdate` (chain/dex/price) | ACTIVE |
| **Chain** | `ChainSimulator` | `SimulatedSyncEvent` (reserve changes), `SimulatedOpportunity` | ACTIVE |
| **Cross-Chain** | `CrossChainSimulator` | Cross-chain `SimulatedOpportunity` | ACTIVE |

**Key files:**
- `shared/core/src/simulation/chain-simulator.ts` — Per-chain block-aligned simulator (~700 lines). Generates Poisson-distributed swap counts per block, weighted DEX/pair selection, market regime model (quiet/normal/burst), gas price sampling.
- `shared/core/src/simulation/price-simulator.ts` — Global price feed simulator.
- `shared/core/src/simulation/cross-chain-simulator.ts` — Cross-chain price differential simulator.
- `shared/core/src/simulation/throughput-profiles.ts` — Calibrated per-chain profiles (block time, swap frequency, DEX market share, gas economics) for all 15 chains.
- `shared/core/src/simulation/constants.ts` — Token prices, pair activity tiers, strategy weights, market regime configs.
- `services/unified-detector/src/simulation-initializer.ts` — Bridges ChainSimulator to detector chain instances.
- `services/execution-engine/src/strategies/simulation.strategy.ts` — Simulates execution results.

### What's Missing: The IDLE Streams

Two Redis Streams are defined but have **NO PRODUCER** in simulation mode:

```
stream:swap-events    [IDLE]  MAXLEN: 50,000   — DEX swap event ingestion
stream:whale-alerts   [IDLE]  MAXLEN: 5,000    — Large trade notifications
```

The **consumers** for these streams already exist and are fully wired:

| Consumer | Location | What It Does |
|----------|----------|-------------|
| `WhaleAnalyzer` | `services/cross-chain-detector/src/whale-analyzer.ts` | Records whale activity, triggers cross-chain detection for super whales |
| `StreamConsumer.consumeWhaleAlerts()` | `services/cross-chain-detector/src/stream-consumer.ts:495` | Reads from `stream:whale-alerts`, validates, emits `whaleTransaction` event |
| `WhaleActivityTracker` | `shared/core/src/analytics/whale-activity-tracker.ts` | Tracks wallet patterns (accumulator/distributor/swing/arb), generates signals |
| `WhaleAlertPublisher` | `services/unified-detector/src/publishers/whale-alert.publisher.ts` | Can publish to both streams but only triggered by live blockchain events |

### Bottleneck: Root Cause Analysis

```
Symptom: Can't test whale/swap pipeline without blockchain
  Why?  stream:swap-events and stream:whale-alerts have no producer in simulation mode
  Why?  ChainSimulator only emits 'syncEvent' (reserve changes), not SwapEvent objects
  Why?  ChainSimulator was designed for price matrix & opportunity detection testing
  Why?  Original simulation focused on detection accuracy, not end-to-end event flow
  ROOT: Simulation generates at wrong abstraction level — Sync events when pipeline
        also needs SwapEvents and WhaleAlerts for full coverage
```

**Impact**: The entire whale detection → signal generation → opportunity enhancement pipeline is untestable in simulation mode. This means:
- `WhaleActivityTracker` pattern analysis is never exercised
- Cross-chain detector's whale-triggered detection path is dead code in dev
- `WhaleAlertPublisher` is untested for event format compatibility
- No way to validate whale signal confidence scoring end-to-end

---

## 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **A. Enrich existing simulator** | Most trading simulators (QuantConnect, Backtrader) | Minimal new code, causally consistent, single source of truth | ChainSimulator grows larger, coupling | 2-3 days |
| **B. Event derivation middleware** | Stream processing (Kafka Streams, Flink) | Clean separation, doesn't modify core | Lossy reverse-engineering of amounts from reserves, can't reconstruct sender/recipient | 3-4 days |
| **C. Dedicated MarketEventSimulator** | Institutional sim platforms (Refinitiv, Bloomberg EMSX) | Maximum realism, proper causal chains, scenario testing | Most complex, duplicates logic, significant new code | 5-7 days |
| **D. Callback enrichment + auto-publish** | Event-driven architectures (Reactor pattern) | Uses existing patterns (callbacks), publisher reuse, minimal coupling | Requires new callback types | 2-3 days |
| **E. Replay from recorded events** | Backtesting systems (Zipline, Catalyst) | Most realistic data, regression testing | Requires data collection, stale data, large files | 4-5 days |

---

## 3. Recommended Solution

### Approach: D — Callback Enrichment + Auto-Publish (with elements of A)

**Confidence**: HIGH (85%)

**Justification**: This approach:
1. **Reuses the existing callback pattern** that SimulationInitializer already uses (onPriceUpdate, onOpportunity, onSyncEvent, onBlockUpdate)
2. **Leverages the existing WhaleAlertPublisher** which can already publish to both `stream:swap-events` and `stream:whale-alerts`
3. **Generates events causally** — the same simulated block that changes reserves also produces the SwapEvent and whale alert
4. **Minimal new code** — extends ChainSimulator's `executeSwap()` to emit richer data, adds 2 new callbacks
5. **No hot-path impact** — all new code runs in simulation mode only (gated by `isSimulationMode()`)

### Why NOT Each Alternative

| Alternative | Rejection Reason |
|-------------|-----------------|
| **A (Enrich simulator directly)** | Close runner-up. Rejected because it puts publishing logic inside ChainSimulator which should remain a pure event generator. Approach D keeps publishing in the callback layer. |
| **B (Event derivation middleware)** | Fundamental data loss — can't reconstruct `sender`, `recipient`, `to` addresses from reserve changes alone. SwapEvent requires 10+ fields that aren't derivable from Sync events. |
| **C (Dedicated MarketEventSimulator)** | Over-engineering for the current need. ChainSimulator already has Poisson swap counts, weighted DEX selection, trade size distributions, and market regimes. Building a parallel system would duplicate all of this. |
| **E (Replay from recorded events)** | Requires external data collection infrastructure that doesn't exist. Good complement to Approach D but not a standalone solution for "without blockchain contracts." |

### Architecture

```
ChainSimulator.executeSwap(pair)
  |
  |-- emits 'syncEvent' (existing — for reserve updates)
  |
  |-- [NEW] emits 'swapEvent' with full SwapEvent data
  |       {pairAddress, sender, recipient, amount0In, amount1In,
  |        amount0Out, amount1Out, to, blockNumber, txHash, dex, chain}
  |
  v
SimulationInitializer.createSimulationCallbacks()
  |
  |-- onSyncEvent (existing — updates pair reserves, triggers arb detection)
  |
  |-- [NEW] onSwapEvent → WhaleAlertPublisher.publishSwapEvent()
  |                        → publishes to stream:swap-events
  |
  |-- [NEW] onSwapEvent (if usdValue >= whaleThreshold)
  |           → WhaleAlertPublisher.publishWhaleAlert()
  |           → publishes to stream:whale-alerts
  |           → WhaleActivityTracker.recordTransaction()
  v
Cross-Chain Detector (existing consumer)
  |-- StreamConsumer.consumeWhaleAlerts() → reads from stream:whale-alerts
  |-- WhaleAnalyzer.analyzeWhaleTransaction() → triggers cross-chain detection
```

### Expected Impact

| Metric | Current | Target |
|--------|---------|--------|
| `stream:swap-events` messages/min (simulation) | 0 | ~200-800 (varies by chain throughput) |
| `stream:whale-alerts` messages/min (simulation) | 0 | ~2-10 (whale threshold dependent) |
| Whale pipeline test coverage | 0% (dead code path) | 100% (full end-to-end) |
| WhaleActivityTracker patterns tested | None | All 4 (accumulator, distributor, swing, arb) |
| Cross-chain whale-triggered detection tested | No | Yes |

### ADR Compatibility

| ADR | Impact | Compatible? |
|-----|--------|------------|
| ADR-002 (Redis Streams) | Activates two IDLE streams | YES — streams already defined with MAXLEN |
| ADR-003 (Partitioned Detectors) | Events published per-chain from partition's simulator | YES — follows existing per-chain pattern |
| ADR-022 (Hot Path Rules) | New code is simulation-only, never runs in production | YES — zero hot-path impact |

---

## 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | **Extend `ChainSimulator.executeSwap()` to build SwapEvent data** — Generate full SwapEvent fields (sender/recipient from wallet pool, amounts from reserve delta, txHash, blockNumber). Emit new `'swapEvent'` alongside existing `'syncEvent'`. | 0.5 day | 95% | None | Unit: verify SwapEvent shape matches `SwapEvent` interface. Verify amounts are consistent with reserve changes. |
| 2 | **Add simulated wallet address pool to ChainSimulator** — Pre-generate 50-100 deterministic wallet addresses. Track "whale wallets" (5-10 recurring addresses with >$50K cumulative volume). This enables `WhaleActivityTracker` to detect patterns. | 0.5 day | 90% | Task 1 | Unit: verify whale wallets appear repeatedly, normal wallets are distributed. |
| 3 | **Add whale detection threshold to `executeSwap()`** — Compare swap USD value against `WHALE_THRESHOLD_USD` (default $50K from WhaleTrackerConfig). Emit `'whaleAlert'` event when threshold exceeded. Include `WhaleAlert`-compatible data. | 0.5 day | 95% | Task 1 | Unit: verify whale alerts only fire for large swaps. Verify alert data matches `WhaleAlert` interface. |
| 4 | ✅ **Add `onSwapEvent` and `onWhaleAlert` callbacks to `SimulationCallbacks`** — Extend the callback interface in `simulation-initializer.ts`. Wire callbacks in `createSimulationCallbacks()` to publish via `WhaleAlertPublisher`. | 0.5 day | 90% | Tasks 1, 3 | Unit: mock publisher, verify callbacks invoke correct publish methods. Integration: verify events appear on Redis streams. |
| 5 | ✅ **Wire `WhaleActivityTracker` in simulation init** — Feed simulated whale transactions into `WhaleActivityTracker.recordTransaction()` from the `onWhaleAlert` callback. This enables pattern detection and signal generation in simulation. | 0.5 day | 90% | Task 4 | Unit: verify tracker receives transactions. Verify patterns emerge after 3+ trades from same wallet. |
| 6 | ✅ **Add `SIMULATION_WHALE_RATE` env var** — Controls what fraction of simulated swaps are whale-sized (default: 0.05 = 5%). In `executeSwap()`, when a swap is selected as whale-sized, use `tradeSizeRange[1] * 2-10x` for the amount. | 0.25 day | 95% | Task 3 | Unit: verify whale rate produces expected distribution. |
| 7 | ✅ **Update `SimulationCallbacks` type and `ChainSimulationHandler`** — The `ChainSimulationHandler` class in `services/unified-detector/src/simulation/` bridges the raw ChainSimulator events to the SimulationInitializer callbacks. Add swap/whale event forwarding. | 0.5 day | 85% | Tasks 1-4 | Unit: verify handler forwards new event types to callbacks. |
| 8 | **Integration test: full pipeline simulation** — Test that starting services in simulation mode produces events on `stream:swap-events` and `stream:whale-alerts`. Verify cross-chain detector processes whale alerts. | 0.75 day | 80% | Tasks 1-7 | Integration: start coordinator + P1 + cross-chain in simulation, assert stream lengths > 0 within 30s. |

**Total estimated effort**: 3.5-4 days

---

## 5. Detailed Design

### 5.1 SwapEvent Generation in `executeSwap()`

```typescript
// In chain-simulator.ts — executeSwap() extension
private executeSwap(pair: SimulatedPairConfig): void {
  const reserves = this.reserves.get(pair.address.toLowerCase());
  if (!reserves) return;

  // ... existing reserve change logic ...

  // [NEW] Generate SwapEvent data
  const isWhale = Math.random() < this.whaleRate;
  const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];
  const tradeSize = this.sampleTradeSize(profile, isWhale);

  const swapEvent = this.buildSwapEvent(pair, reserves, tradeSize, isWhale);
  this.emit('swapEvent', swapEvent);

  // [NEW] Whale alert for large trades
  if (swapEvent.usdValue >= this.whaleThresholdUsd) {
    this.emit('whaleAlert', {
      event: swapEvent,
      pairAddress: pair.address,
      dex: pair.dex,
      usdValue: swapEvent.usdValue,
      timestamp: Date.now(),
    });
  }

  // Existing: emit syncEvent for reserve update
  this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
}
```

### 5.2 Wallet Address Pool

```typescript
// Pre-generated deterministic addresses
private readonly walletPool: string[];
private readonly whaleWallets: string[];  // Subset that recurs

constructor(config) {
  // Generate 100 "normal" wallets + 10 "whale" wallets
  this.walletPool = Array.from({ length: 100 }, (_, i) =>
    '0x' + createHash('sha256').update(`sim-wallet-${config.chainId}-${i}`).digest('hex').slice(0, 40)
  );
  this.whaleWallets = this.walletPool.slice(0, 10);
}

private selectWallet(isWhale: boolean): string {
  if (isWhale) {
    return this.whaleWallets[Math.floor(Math.random() * this.whaleWallets.length)];
  }
  return this.walletPool[Math.floor(Math.random() * this.walletPool.length)];
}
```

### 5.3 Callback Extension

```typescript
// In simulation-initializer.ts — extend SimulationCallbacks
export interface SimulationCallbacks {
  onPriceUpdate: (update: PriceUpdate) => void;
  onOpportunity: (opportunity: ArbitrageOpportunity) => void;
  onBlockUpdate: (blockNumber: number) => void;
  onEventProcessed: () => void;
  onSyncEvent: (event: { address: string; reserve0: string; reserve1: string; blockNumber: number }) => void;

  // [NEW]
  onSwapEvent?: (event: SwapEvent) => void;
  onWhaleAlert?: (alert: WhaleAlert) => void;
}
```

### 5.4 Trade Size Sampling

Uses the existing `tradeSizeRange` from throughput profiles with log-normal distribution:

```typescript
private sampleTradeSize(profile: ChainThroughputProfile, isWhale: boolean): number {
  const [min, max] = profile.tradeSizeRange;
  // Log-normal distribution for realistic trade size distribution
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const logMean = (logMin + logMax) / 2;
  const logStd = (logMax - logMin) / 4;
  let size = Math.exp(gaussianRandom(logMean, logStd));

  if (isWhale) {
    // Whale trades: 2-10x the max normal trade size
    const whaleMultiplier = 2 + Math.random() * 8;
    size = max * whaleMultiplier;
  }

  return Math.max(min, size);
}
```

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Redis stream overflow in high-throughput simulation** | LOW | LOW | Both streams have MAXLEN caps (50K and 5K). `xaddWithLimit` already handles trimming. |
| **Simulated whale patterns don't match real-world patterns** | MEDIUM | LOW | Use deterministic whale wallet pool (10 wallets) to ensure enough repeat trades for pattern detection. Configurable via `SIMULATION_WHALE_RATE`. |
| **Performance regression from extra event emission** | LOW | LOW | All new code is simulation-only (gated by `isSimulationMode()`). Production hot path untouched. |
| **SwapEvent format mismatch with live events** | MEDIUM | MEDIUM | Task 8 integration test validates that cross-chain detector can parse simulated SwapEvents and WhaleAlerts without errors. Reuse existing `validateWhaleTransaction()` type guard. |
| **ChainSimulator file size grows too large** | LOW | LOW | SwapEvent building is ~30 lines, wallet pool is ~20 lines. Total addition ~80-100 lines to a 700-line file. Acceptable. |

---

## 7. Success Metrics

- [ ] `stream:swap-events` produces >0 messages within 10s of simulation start — Redis XLEN check
- [ ] `stream:whale-alerts` produces >0 messages within 60s of simulation start — Redis XLEN check
- [ ] `WhaleActivityTracker.getStats().totalTransactionsTracked > 0` after 60s — Health endpoint check
- [ ] `WhaleActivityTracker` detects at least 1 non-`unknown` wallet pattern after 5 min — Log check
- [ ] Cross-chain detector `handleWhaleTransaction()` is called in simulation mode — Log check
- [ ] Zero new errors in simulation mode startup — Log check
- [ ] No latency regression on production hot path — Benchmark (should be 0ms delta since simulation-only code)

---

## 8. ADR Recommendation

**New ADR Needed?**: No

This enhancement activates two existing IDLE streams without changing any architectural decisions. The streams, consumer groups, and MAXLEN caps are already defined in ADR-002. The implementation follows the existing simulation callback pattern established in the ChainSimulator rework (2026-03-01).

**Documentation updates needed:**
- `docs/architecture/CURRENT_STATE.md` — Change `stream:swap-events` and `stream:whale-alerts` lifecycle from `[IDLE]` to `[ACTIVE in simulation]`
- `docs/CONFIGURATION.md` — Add `SIMULATION_WHALE_RATE` env var
- `docs/local-development.md` — Add note about whale/swap event testing in simulation mode

---

## 9. Implementation Sequence

```
Phase 1 (Core): Tasks 1-3 (1.5 days)
  ChainSimulator generates SwapEvents + whale alerts
  Unit tests validate event shapes

Phase 2 (Wiring): Tasks 4-7 (1.5 days)
  Callbacks extended, WhaleAlertPublisher wired
  Events flow to Redis streams

Phase 3 (Validation): Task 8 (0.75 day)
  Integration test: full pipeline end-to-end
  Cross-chain detector processes simulated whale alerts
```

Tasks 1-3 are independent of tasks 4-7 at the code level (ChainSimulator vs SimulationInitializer), so Phase 1 and Phase 2 could be parallelized across two developers.

---

## 10. Verification Checklist

- [x] Current state analysis based on actual code read (not assumed)
- [x] Performance metrics marked as estimated (no measured production data for IDLE streams)
- [x] All 5 approaches include both pros AND cons
- [x] Effort estimates include testing and integration (3.5-4 days total)
- [x] Recommendation justified vs EACH alternative specifically
- [x] ADR compatibility explicitly checked (ADR-002, ADR-003, ADR-022)
- [x] Risks have practical mitigation (MAXLEN caps, type guards, gating)
- [x] Uncertainties stated (whale pattern realism marked MEDIUM confidence)
- [x] Impact not inflated (this is a dev/test enhancement, not a production feature)

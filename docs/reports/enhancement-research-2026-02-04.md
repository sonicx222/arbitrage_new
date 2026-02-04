# Enhancement Research Report (2026-02-04)

**Scope**: Unified detector hot path, execution engine hot path, WebSocket ingestion, and L1 price cache alignment.  
**Constraint**: Hot-path latency target <50ms (price update → detection → execution).  
**Rules**: Incremental changes only, ADR-compatible, no speculative tech, quantify latency impact (estimates unless measured).

## Files Reviewed
- `services/unified-detector/src/chain-instance.ts`
- `services/unified-detector/src/unified-detector.ts`
- `services/unified-detector/src/index.ts`
- `services/unified-detector/src/chain-instance-manager.ts`
- `services/unified-detector/src/detection/simple-arbitrage-detector.ts`
- `services/unified-detector/src/detection/snapshot-manager.ts`
- `services/unified-detector/src/publishers/opportunity.publisher.ts`
- `services/unified-detector/src/publishers/whale-alert.publisher.ts`
- `services/execution-engine/src/engine.ts`
- `services/execution-engine/src/consumers/opportunity.consumer.ts`
- `services/execution-engine/src/services/queue.service.ts`
- `shared/core/src/caching/price-matrix.ts`
- `shared/core/src/partitioned-detector.ts`
- `shared/core/src/websocket-manager.ts`
- `shared/core/src/caching/hierarchical-cache.ts`
- ADRs: `ADR-002`, `ADR-003`, `ADR-005`, `ADR-022`

## Data Flow (Observed)
1. **Event ingestion**: `WebSocketManager` receives WS messages and parses JSON (main thread or worker pool).
2. **Per-chain processing**: `ChainDetectorInstance.handleSyncEvent()` updates pair reserves and emits a `PriceUpdate`.
3. **Price update publishing**: `ChainDetectorInstance.publishPriceUpdate()` writes to Redis Streams (`stream:price-updates`).
4. **Opportunity detection**: `ChainDetectorInstance.checkArbitrageOpportunity()` emits opportunities locally.
5. **Opportunity publishing**: `OpportunityPublisher` writes to `stream:opportunities` (coordinator broker pattern per ADR-002).
6. **Execution**: Execution Engine consumes from `stream:execution-requests`, queues, and executes with lock protection.

## Hot-Path Findings and Incremental Optimizations

### 1) Per-event string allocations in `ChainDetectorInstance` hot path
**Observation**: `handleSyncEvent()` and `checkArbitrageOpportunity()` allocate strings on every event for:
- Activity tracking key: ```${chainId}:${pairAddress}```
- Pair key used in `PriceUpdate`: ```${dex}_${token0Symbol}_${token1Symbol}```

**Change** (implemented): Precompute `pairKey` and `activityKey` when pairs are created, store on the pair object, reuse in hot path.
- Files: `services/unified-detector/src/chain-instance.ts`
- **Latency impact**: Estimated improvement (not measured). Removes per-event string allocations; likely reduces GC pressure in sustained high-frequency Sync bursts. Expected impact well under 1ms per event (likely microseconds).
- **Trade-off**: Slightly higher memory per pair (two extra strings). Acceptable given bounded pair count.
- **ADR compatibility**: ADR-022 (hot-path memory optimization) aligns with reducing allocations.

### 2) Duplicate snapshot cache state in `ChainDetectorInstance`
**Observation**: Legacy snapshot cache fields (`snapshotCache`, `snapshotVersion`, `dexPoolCache`) coexisted with `SnapshotManager`, but were no longer used consistently. This creates confusion and risk of stale/incorrect cache coordination.

**Change** (implemented): Removed legacy cache fields and reset logic; rely solely on `SnapshotManager` for snapshot + DexPool caching.
- Files: `services/unified-detector/src/chain-instance.ts`
- **Latency impact**: Neutral (estimate). Simplifies hot path and removes dead state; no runtime regression expected.
- **Trade-off**: None; reduces surface area for regressions.
- **ADR compatibility**: ADR-022 prefers single source of truth for hot-path cache coordination.

### 3) Redis stream growth risks for swap/whale/price events
**Observation**: `WhaleAlertPublisher` and `ChainDetectorInstance.publishPriceUpdate()` used `xadd()` without `MAXLEN`. This can cause unbounded Redis stream growth, indirectly affecting latency (Redis memory pressure → increased latency / eviction risk).

**Change** (implemented): Use `xaddWithLimit()` for:
- Price updates (`stream:price-updates`)
- Swap events (`stream:swap-events`)
- Whale alerts (`stream:whale-alerts`)

- Files:
  - `services/unified-detector/src/chain-instance.ts`
  - `services/unified-detector/src/publishers/whale-alert.publisher.ts`
  - Tests updated: `services/unified-detector/src/__tests__/unit/whale-alert-publisher.test.ts`
- **Latency impact**: Small added Redis-side overhead for trimming (estimate, not measured). Expected sub-millisecond and off main hot path since publish is fire-and-forget. Prevents long-term latency regressions due to Redis memory pressure.
- **Trade-off**: Old stream entries are truncated (by design per ADR-002 STREAM_MAX_LENGTHS). If long history is needed, archival should be handled outside hot path.
- **ADR compatibility**: ADR-002 defines stream size limits; change aligns with those limits.

## Implemented Changes (Summary)

**Hot-path touches (flagged)**
- `services/unified-detector/src/chain-instance.ts` (event processing + price update publish)

**Edits applied**
1. **Precomputed hot-path identifiers**
   - Added `pairKey` and `activityKey` to `ExtendedPair`.
   - Set once at pair creation and reuse in Sync handling and price updates.

2. **Snapshot cache cleanup**
   - Removed unused local snapshot cache state to avoid divergence from `SnapshotManager`.

3. **Stream trimming for high-volume publishers**
   - `publishPriceUpdate()` now uses `xaddWithLimit()`.
   - `WhaleAlertPublisher` uses `xaddWithLimit()` for swap + whale streams.

4. **Tests updated**
   - `whale-alert-publisher.test.ts` now mocks `xaddWithLimit`.

## Latency Impact Assessment (Estimates)
- **Precomputed keys**: Reduces per-event allocations; expected microsecond-level savings and lower GC pressure. **Estimate only, not measured**.
- **Snapshot cache cleanup**: No runtime impact expected. **Estimate only**.
- **Stream trimming**: Slight Redis command overhead; async fire-and-forget minimizes hot-path impact. **Estimate only**.

## Recommendations (Not Implemented — require validation/benchmarking)
1. **Measure chain-instance hot-path latency**
   - Add a focused micro-benchmark (similar to `shared/core/__tests__/performance/hot-path.performance.test.ts`) for `handleSyncEvent` and `checkArbitrageOpportunity` under burst load.
   - Goal: verify <10ms per Sync event under typical load, P99 within target.

2. **PriceMatrix integration audit (ADR-005)**
   - `PriceMatrix` appears unused in unified-detector hot path (no runtime references found). If cross-chain detection needs sub-microsecond lookups, evaluate integrating PriceMatrix into the detection pipeline.
   - Requires inspecting cross-chain detector and price consumers before proposing changes.

3. **Worker JSON parsing threshold tuning**
   - `WebSocketManager` uses worker parsing for payloads >2KB in production. Consider sampling real message sizes and adjusting threshold to avoid overhead on smaller messages. Must measure before change.

## Risks and Regression Notes
- **Pair key correctness**: `pairKey` is now precomputed. If token symbols are unknown at creation, keys fall back to shortened addresses (current behavior). This is consistent with existing logic.
- **Stream trimming**: Ensures bounded memory but reduces historical depth. Verify retention expectations against monitoring/analytics usage.

## Next Steps (Optional)
1. Run targeted benchmarks (see Recommendations #1).
2. Review cross-chain detector data consumption before any PriceMatrix wiring.
3. Validate Redis stream retention requirements with ops/monitoring.


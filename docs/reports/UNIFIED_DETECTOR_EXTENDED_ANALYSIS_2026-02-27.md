# Extended Deep Analysis: services/unified-detector

**Date**: 2026-02-27
**Scope**: `services/unified-detector` (operational focus)
**Agents**: 6 (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Model**: Claude Opus 4.6

---

## Executive Summary

**Total Findings**: 48 raw → **38 unique** after deduplication (10 merged across agents)
**Severity Distribution**: 3 Critical (P0) | 11 High (P1) | 14 Medium (P2) | 10 Low (P3)

**Top 5 Highest-Impact Issues:**
1. **crypto.randomBytes() called on every price update** — adds ~0.3-0.5ms per event to hot path, 300-500ms/sec total CPU at 1000 events/sec (Latency + Observability)
2. **Blast/Scroll/Mantle/Mode missing from DETECTOR_CONFIG** — fall back to Ethereum settings with 2.5x gas estimate and 3-4x expiry window, filtering out profitable L2 opportunities (Cross-Chain + Config Drift)
3. **StreamBatcher has no maxQueueSize** — unbounded memory growth during Redis outage leads to OOM (Failure Mode + Data Integrity)
4. **No false-positive / opportunity outcome tracking** — cannot tune detection quality without execution feedback loop (Observability)
5. **No DLQ for permanently failed opportunity publishes** — profitable opportunities silently dropped after 3 retries (Failure Mode)

**Overall Health Grade: B-**
The hot-path synchronous code is well-optimized (~1-1.5ms) and comfortably within the <50ms target. Core architecture is sound with O(1) lookups, ring buffers, and throttled detection. However, operational resilience has significant gaps: no circuit breaker for Redis, unbounded queue growth during outages, missing observability for detection quality, and 4 newly operational chains not yet integrated into optimization configs. The system works well in happy-path conditions but has limited ability to detect, recover from, or signal degraded operation.

**Agent Agreement Map:**
- Blast/Scroll chain coverage gap: Cross-Chain #3 + Config Drift #2 (HIGH confidence)
- MAXLEN trimming risk: Data Integrity #1 + Failure Mode #7 (HIGH confidence)
- StreamBatcher unbounded growth: Failure Mode #3 + Data Integrity #3 (HIGH confidence)
- Price update fire-and-forget: Data Integrity #3 + Failure Mode #6 (HIGH confidence)
- Trace context + crypto overhead: Latency #1 + Observability #1 (COMPLEMENTARY — same root fix)
- Connection error handling: Observability #3 + Failure Mode #5 (HIGH confidence)

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| C1 | Latency + Tracing | chain-instance.ts:1567 | `crypto.randomBytes()` called 2x per price update (traceId + spanId). At 1000 events/sec = 0.3-0.5ms per call × 2 = 600-1000ms CPU/sec. Also, each price update and each opportunity creates an independent root trace (no parent-child), breaking end-to-end pipeline traceability. | latency-profiler, observability-auditor | HIGH | 4.1 |
| C2 | ConfigDrift | detector-config.ts:28-142 | Blast, Scroll, Mantle, Mode have NO entries in `DETECTOR_CONFIG`. Fallback to Ethereum: 250K gas estimate (2.5x too high for L2), 15s expiry (3-4x too long), $100K whale threshold (4x too high). Directly filters out profitable L2 opportunities. | cross-chain-analyst, config-drift-detector | HIGH | 4.0 |
| C3 | Metrics | unified-detector.ts:254, opportunity.publisher.ts | No tracking of opportunity outcomes — published vs executed vs expired vs failed. Cannot determine detection quality, false positive rate, or tune thresholds. The `activeOpportunities` map cleanup deletes expired entries without logging. | observability-auditor | HIGH | 3.8 |

**Suggested Fixes:**

**C1**: (a) Replace `createTraceContext()` with counter-based IDs for price updates: `${chainId}-${Date.now()}-${counter++}`. Reserve `crypto.randomBytes` for opportunities only (10-100x less frequent). (b) Create a single root trace at `handleWebSocketMessage()` and pass through the pipeline using `createChildContext()` at each stage. This fixes BOTH the crypto overhead and the broken trace propagation.

**C2**: Add entries to `DETECTOR_CONFIG` for blast, scroll, mantle, mode with L2-appropriate values (gasEstimate: 100K, expiryMs: 8-10s, whaleThreshold: 25K, confidence: 0.80).

**C3**: Track opportunity lifecycle: add counters for (published, executed, expired, failed). Have coordinator/execution engine publish outcome events. Expose success rate in `/stats`.

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| H1 | Backpressure | chain-instance.ts:695 | StreamBatcher created WITHOUT `maxQueueSize`. During Redis outage, 500 events/sec × 60s = 30K objects per chain, ~24MB/chain. Sustained outage → OOM crash. | failure-mode, data-integrity | HIGH | 3.9 |
| H2 | DLQ | opportunity.publisher.ts:162 | After 3 retry failures, opportunities are permanently lost — no DLQ write, no replay mechanism. Only `stats.failed` increments (no alert threshold). | failure-mode-analyst | HIGH | 3.8 |
| H3 | ConfigDrift | constants.ts:220-297 | Blast and Scroll missing from `FACTORY_SUBSCRIPTION_ENABLED_CHAINS` and `RESERVE_CACHE_ENABLED_CHAINS`. These operational chains don't get 40-50x RPC reduction from factory subscriptions or 20-80% from reserve cache. | cross-chain, config-drift | HIGH | 3.7 |
| H4 | GasModel | gas-price-cache.ts:844-861 | Scroll and Mantle in `L1_RPC_FEE_CHAINS` array but no refresh handler — silently skipped. When `useDynamicL1Fees` enabled, always uses static fallback ($0.35/$0.10). | cross-chain-analyst | HIGH | 3.6 |
| H5 | BlockTime | detector-config.ts vs thresholds.ts | `DETECTOR_CONFIG.expiryMs` diverges from `chainOpportunityTimeoutMs`. Arbitrum: 5s vs 2s, Fantom: 8s vs 2s. Opportunities published with 2-4x staler expiry than thresholds recommend. | cross-chain-analyst | HIGH | 3.5 |
| H6 | Tracing | chain-instance.ts:1568 | 3 object allocations per price update in `publishPriceUpdate()`: `{...update}`, `{...message}` in propagateContext, final merge. At 1000/sec = 3000 short-lived objects/sec adding GC pressure. | latency-profiler | HIGH | 3.5 |
| H7 | Delivery | streams.ts:370-400 | Approximate MAXLEN trimming can silently discard unread messages when consumer lag exceeds stream limit. `checkStreamLag()` exists but is monitoring-only, not integrated into trim decisions or alerting. | data-integrity, failure-mode | HIGH | 3.4 |
| H8 | Cascade | unified-detector.ts:228-233 | Redis down affects ALL services — publishing stops, health reporting stops, batcher queues grow unboundedly. But WebSocket and detection continue, accumulating stale data that flushes on recovery. No circuit breaker to coordinate the degraded state. | failure-mode-analyst | HIGH | 3.4 |
| H9 | Logging | chain-instance.ts:945-957 | `handleConnectionError()` discards the actual error — never logged. Only fires generic "Max reconnect attempts reached" after 5 failures. Operators cannot see WHY connections fail. | observability-auditor | HIGH | 3.3 |
| H10 | Metrics | index.ts:106-162 | No Prometheus/StatsD `/metrics` endpoint. `MetricsCollector` writes to Pino logs only. `PrometheusMetricsCollector` in warming-integration is NOT wired to health server. | observability-auditor | HIGH | 3.2 |
| H11 | PriceIntegrity | chain-instance.ts:1500-1503 | No NaN/Infinity validation after `calculatePriceFromBigIntReserves()` before publishing. Malformed Sync event → NaN price published → cascading incorrect detections. SimpleArbitrageDetector has this check, but the publish path does not. | data-integrity-auditor | MEDIUM | 3.2 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| M1 | CircuitBreaker | chain-instance.ts | No circuit breaker for Redis Streams publishing anywhere in unified-detector. ADR-018 CB only in execution-engine. Partial Redis failure → independent retry storm from all publishers. | failure-mode-analyst | HIGH | 3.1 |
| M2 | Backpressure | chain-instance.ts:1574 | `priceUpdateBatcher.add()` return value (false = dropped) never checked. Chain-instance has no visibility into batcher drops. Stale data used for detection without knowing updates were lost. | failure-mode, data-integrity | HIGH | 3.0 |
| M3 | HealthCheck | index.ts:114-133 | Health endpoint does not verify Redis connectivity. Service reports "healthy" while Redis unavailable — all detected opportunities silently lost. | observability-auditor | HIGH | 3.0 |
| M4 | Delivery | streams.ts:694-736 | Consumer group created with `startId: '$'` by default. Messages published before consumer group creation are permanently lost. Affects new deployments and group recreation. | data-integrity-auditor | HIGH | 2.9 |
| M5 | Shutdown | index.ts:248-256 | Health server closes before detector.stop(). Batcher flush on slow Redis can exceed 10s force-exit timer. Queued price updates lost. | failure-mode-analyst | MEDIUM | 2.8 |
| M6 | Backpressure | index.ts:172-194 | Opportunity EventEmitter handler fires-and-forgets async publish. No limit on concurrent in-flight publishes. Burst of 100 opps → 100 simultaneous Redis XADD. | failure-mode-analyst | HIGH | 2.8 |
| M7 | NullishCoalescing | constants.ts:308 | `parseInt(process.env.RESERVE_CACHE_ROLLOUT_PERCENT \|\| '100', 10)` — uses `\|\|` instead of `??`. Convention violation. | config-drift-detector | HIGH | 2.7 |
| M8 | Hardcoded | chain-instance.ts:304 | `MAX_STALENESS_MS = 30_000` hardcoded for all chains. Solana: 75 blocks stale, Arbitrum: 120 blocks stale. Should use per-chain `chainConfidenceMaxAgeMs` from thresholds.ts. | config-drift-detector | HIGH | 2.7 |
| M9 | Logging | simple-arbitrage-detector.ts:308-323 | Rejection stats only at `debug` level, throttled to every 60s after 1000 rejections. At production LOG_LEVEL=info, zero visibility into why detector stopped finding opportunities. | observability-auditor | HIGH | 2.6 |
| M10 | Delivery | opportunity.publisher.ts:210-239 | Fast lane publish is fire-and-forget. Failure logged but `publish()` returns true (standard path succeeded). High-confidence opps may miss fast lane without metric tracking. | data-integrity-auditor | HIGH | 2.5 |
| M11 | Metrics | index.ts:168-170 | Price update ingestion rate not exposed as any metric. Comment acknowledges events not logged, but no counter/gauge either. Cannot monitor ingestion rate drops. | observability-auditor | HIGH | 2.5 |
| M12 | BlindSpot | chain-instance.ts:691-698 | StreamBatcher flush errors invisible at chain-instance level. No error listener or callback. Redis rejecting writes → price updates fail silently. | observability-auditor | MEDIUM | 2.4 |
| M13 | TokenDecimal | tokens/index.ts:204 | Blast USDB uses 18 decimals (unusual for stablecoins). Not in `STABLECOIN_SYMBOLS` set. Generic stablecoin handlers assuming 6 decimals → 10^12 magnitude error. | cross-chain-analyst | MEDIUM | 2.4 |
| M14 | GasModel | thresholds.ts:33 | Global `estimatedGasCost` defaults to $15 — a 30-1500x overestimate for L2 chains. Fallback paths using this value filter out all L2 opportunities under $15 profit. | cross-chain-analyst | MEDIUM | 2.3 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| L1 | NullishCoalescing | index.ts:51, unified-detector.ts:181 | `regionId` uses `\|\|` chain instead of `??`. Empty string fallthrough. Convention violation. | config-drift-detector | MEDIUM | 2.2 |
| L2 | Hardcoded | chain-instance.ts:274,277 | `MAX_RECONNECT_ATTEMPTS=5` and `SLOW_RECOVERY_INTERVAL_MS=300000` not configurable via env vars or config. | config-drift-detector | MEDIUM | 2.1 |
| L3 | EnvVar | .env.example | `RESERVE_CACHE_ENABLED`, `RESERVE_CACHE_ROLLOUT_PERCENT`, `MULTI_LEG_TIMEOUT_MS` not documented in .env.example. | config-drift-detector | HIGH | 2.1 |
| L4 | Allocation | chain-instance.ts:1707 | Always constructs template string for `isHotPair()` instead of using cached `chainPairKey`. 1000 unnecessary allocations/sec. | latency-profiler | MEDIUM | 2.0 |
| L5 | SolanaGap | detector-config.ts:138 | `gasEstimate: 5000` for Solana is meaningless (EVM gas units, not Solana compute units). Low risk since P4 bypasses chain-instance. | cross-chain-analyst | MEDIUM | 2.0 |
| L6 | NullishCoalescing | chain-instance.ts:384 | `DETECTOR_CONFIG[chainId] \|\| DETECTOR_CONFIG.ethereum` — uses `\|\|` instead of `??`. Convention violation. | config-drift-detector | MEDIUM | 1.9 |
| L7 | Logging | whale-alert.publisher.ts:107,123 | Raw error object logged instead of `.message` — inconsistent with codebase pattern (30+ other sites use `.message`). | observability-auditor | HIGH | 1.8 |
| L8 | Schema | streams.ts:1296-1336 | Batch envelope `count` vs `messages.length` not validated in `unwrapBatchMessages()`. Corruption would go undetected. Low risk with HMAC. | data-integrity-auditor | MEDIUM | 1.7 |
| L9 | Logging | Multiple | Info-level logs on moderately frequent paths: chain status changes, whale alert publishing, new pair discovery. | observability-auditor | MEDIUM | 1.6 |
| L10 | BlockTime | thresholds.ts:201 | Solana `chainConfidenceMaxAgeMs=2000` aggressive vs 500-1500ms WebSocket delivery latency. Only 500-1000ms of "fresh" window. | cross-chain-analyst | LOW | 1.5 |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck? |
|-------|-----------|-----------|-------------------|-------------|
| 1. WS Receive | WebSocket message arrives | chain-instance.ts:1212 | ~0.1ms | No |
| 2. Parse & Route | handleWebSocketMessage topic routing | chain-instance.ts:1228-1258 | ~0.05ms | No |
| 3. Reserve Decode | BigInt hex parsing (2x BigInt, 1x parseInt) | chain-instance.ts:1293-1297 | ~0.1ms | No |
| 4. Activity Tracking | activityTracker.recordUpdate (O(1)) | chain-instance.ts:1302 | ~0.01ms | No |
| 5. Pair Update | Direct property assignment (6 fields) | chain-instance.ts:1341-1346 | ~0.01ms | No |
| 6. Price Calculation | calculatePriceFromBigIntReserves | chain-instance.ts:1502 | ~0.05ms | No |
| 7. **Trace Context** | **createTraceContext (2x crypto.randomBytes)** | **chain-instance.ts:1567** | **~0.3-0.5ms** | **YES** |
| 8. Object Spread | 3 allocations in publishPriceUpdate | chain-instance.ts:1568 | ~0.05ms | Indirect |
| 9. Batcher Add | StreamBatcher.add() O(1) push | chain-instance.ts:1574 | ~0.01ms | No |
| 10. Token Key Lookup | getTokenPairKey with LRU cache | chain-instance.ts:1646 | ~0.01ms | No |
| 11. Pair Comparison | SimpleArbitrageDetector.calculateArbitrage (2-5 pairs) | chain-instance.ts:1670 | ~0.1ms | No |
| **Sync Hot Path Total** | | | **~1-1.5ms** | |
| 12. Batcher Flush | JSON.stringify + HMAC + Redis XADD (async, 10ms timer) | streams.ts:259-268 | ~1-3ms (async) | Conditional |
| 13. Opportunity Publish | XADD + trace + spread (async) | opportunity.publisher.ts:102-149 | ~2-5ms (async) | Conditional |
| **End-to-End (WS → Redis)** | | | **~10-15ms typical** | **Under budget** |

**Assessment**: Pipeline comfortably meets <50ms target. With C1 fixed, sync path drops to ~0.5-1ms.

---

## Failure Mode Map

| Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|-------|-------------|-----------|----------|----------------|-----------|
| WebSocket Connect | Connection timeout | connectionTimeout timer | Exponential backoff + fallback URLs | NONE | websocket-manager.ts:440 |
| WebSocket Message | Parse error | try-catch | Logged, event skipped | LOW (single event) | chain-instance.ts:1260 |
| WebSocket Disconnect | All URLs exhausted | reconnectAttempts >= 5 | Slow recovery timer (5 min) | LOW (detection paused) | chain-instance.ts:948 |
| Price Batcher | Queue overflow | **NONE (no maxQueueSize)** | **NONE (unbounded → OOM)** | **HIGH** | chain-instance.ts:695 |
| Price Batcher | Redis XADD failure | Caught in flush() | Re-queue + retry | MEDIUM | streams.ts:279 |
| Opportunity Publish | Redis failure (3 retries) | stats.failed counter | **NONE (no DLQ)** | **HIGH** | opportunity.publisher.ts:162 |
| Redis Down | All streams unavailable | Connection error events | ioredis backoff | HIGH (cumulative) | streams.ts:431 |
| Redis Recovery | Stale data flush | NONE | Stale prices sent to coordinator | HIGH (false signals) | streams.ts:282 |
| MAXLEN Trim | Consumer lag > MAXLEN | checkStreamLag() (monitoring only) | NONE (messages permanently lost) | MEDIUM | streams.ts:859 |
| Shutdown | Batcher flush timeout | Force-exit timer (10s) | process.exit(1) | MEDIUM | service-bootstrap.ts:143 |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | Blast, Scroll, Mantle, Mode | No DETECTOR_CONFIG entries — Ethereum fallback | Filters profitable L2 opps | P0 | detector-config.ts:28-142 |
| 2 | Scroll, Mantle | L1 fee oracle refresh has no handler | Static $0.35/$0.10 during fee spikes | P1 | gas-price-cache.ts:844-861 |
| 3 | Blast, Scroll | Missing from factory/reserve cache chains | 40-50x more RPC calls | P1 | constants.ts:220-297 |
| 4 | Arbitrum, Fantom, Polygon | expiryMs 2-4x longer than chainOpportunityTimeoutMs | Stale opportunities executed | P1 | detector-config.ts vs thresholds.ts |
| 5 | Blast | USDB 18 decimals not in STABLECOIN_SYMBOLS | 10^12 error if treated as 6-decimal | P2 | tokens/index.ts:204 |
| 6 | All L2s | Global $15 gas fallback in ARBITRAGE_CONFIG | Filters all L2 opps under $15 | P2 | thresholds.ts:33 |
| 7 | Solana | gasEstimate: 5000 meaningless for compute units | Low risk (P4 bypasses) | P3 | detector-config.ts:138 |

---

## Observability Assessment

### Trace Propagation Map
```
WebSocket → handleWebSocketMessage → handleSyncEvent → checkArbitrageOpportunity
                                            ↓                        ↓
                                     emitPriceUpdate          emitOpportunity
                                            ↓                        ↓
                                   [NEW root trace C1]      [NEW root trace]
                                            ↓                        ↓
                                    StreamBatcher           OpportunityPublisher
                                            ↓                        ↓
                                     Redis XADD              Redis XADD
```
**Gap**: No parent-child relationship between traces. Each creates independent root context.

### Metrics Gaps
- No `/metrics` endpoint for Prometheus scraping
- No price update ingestion rate metric
- No opportunity outcome tracking (published → executed → expired → failed)
- No batcher drop rate metric at chain-instance level
- No Redis connectivity check in health endpoint

### Positive Observations
- Zero `.catch(() => {})` silent swallowing patterns
- All error paths have logger.error with context
- Trace infrastructure is well-designed (W3C compatible)
- OTEL transport properly implemented with batch/flush
- Health cache with TTL prevents hot-path overhead
- All fire-and-forget patterns have proper `.catch()` handlers

---

## Configuration Health

### Feature Flag Audit
All feature flags use correct patterns:
| Flag | Pattern | Status |
|------|---------|--------|
| `FEATURE_FLAGS.useMomentumTracking` | `=== 'true'` | CORRECT (opt-in) |
| `FEATURE_FLAGS.useMLSignalScoring` | `=== 'true'` | CORRECT (opt-in) |
| `FEATURE_FLAGS.useLiquidityDepthSizing` | `=== 'true'` | CORRECT (opt-in) |
| `FEATURE_FLAGS.useFastLane` | `=== 'true'` | CORRECT (opt-in) |
| `RESERVE_CACHE_ENABLED` | `!== 'false'` | CORRECT (safety-on) |

### || vs ?? Violations (5 found)
| Location | Pattern | Finding |
|----------|---------|---------|
| constants.ts:308 | `\|\| '100'` for parseInt default | M7 |
| index.ts:51 | `\|\| partitionConfig?.region` | L1 |
| chain-instance.ts:384 | `\|\| DETECTOR_CONFIG.ethereum` | L6 |
| opportunity.publisher.ts:73 | `\|\| 'unknown'` | L10 (minor) |
| whale-alert.publisher.ts:86 | `\|\| '0'` for BigInt | L10 (minor) |

### Undocumented Env Vars
`RESERVE_CACHE_ENABLED`, `RESERVE_CACHE_ROLLOUT_PERCENT`, `MULTI_LEG_TIMEOUT_MS` not in `.env.example`.

---

## Cross-Agent Insights

### Information Separation Results (Agents 2 + 3: Failure Mode vs Data Integrity)

**Agreements (HIGH confidence):**
- MAXLEN trimming is a real silent data loss vector (both flagged independently)
- StreamBatcher has no queue limits → unbounded memory growth (both flagged)
- Price update publishing is fire-and-forget with no visibility into drops (both flagged)
- Overall delivery semantic is at-most-once end-to-end (both concluded)

**Complementary findings:**
- Failure Mode uniquely found: no circuit breaker, cascading Redis failure pattern, EventEmitter backpressure
- Data Integrity uniquely found: consumer group '$' startup gap, XCLAIM routing all streams to DLQ uniformly, NaN price propagation risk

**Disagreement on MAXLEN severity:**
- Data Integrity rated P0 (silent data loss without any signal)
- Failure Mode rated P2 (only during sustained consumer lag)
- **Resolution**: Promoted to P1. The silent nature makes it high-impact when it occurs, but the trigger condition (consumer lag > MAXLEN) requires extended outage. Added to H7.

### Cross-Agent Complementary Findings
- Latency profiler's `crypto.randomBytes` finding (C1) and Observability auditor's broken trace propagation (C1) have the **same root fix**: pass trace context through the pipeline instead of creating new roots
- Config Drift's "blast/scroll missing" (H3) and Cross-Chain's same finding (H3) provide independent confirmation with different evidence bases
- Failure Mode's "no DLQ for opportunities" (H2) explains Observability's "no outcome tracking" (C3) — without DLQ, there's no recovery path and no visibility

---

## Conflict Resolutions

| Conflict | Agent A | Agent B | Resolution |
|----------|---------|---------|------------|
| MAXLEN severity | Data Integrity: P0 | Failure Mode: P2 | P1 — silent but requires extended outage to trigger |
| HMAC bypass in dev | Data Integrity: P2 | (No conflict) | Accepted as P2 — working as designed, document risk |
| Shutdown order | Failure Mode: P2 | (No conflict) | Accepted as P2 — current order is correct for K8s, real fix is timeout adequacy |

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)

- [ ] **C1**: Replace `createTraceContext()` with counter-based IDs for price updates; pass trace context through pipeline (latency-profiler, observability-auditor, Score: 4.1)
- [ ] **C2**: Add blast/scroll/mantle/mode to DETECTOR_CONFIG with L2-appropriate values (cross-chain-analyst, config-drift-detector, Score: 4.0)
- [ ] **C3**: Add opportunity outcome tracking (published/executed/expired/failed counters) (observability-auditor, Score: 3.8)

### Phase 2: Next Sprint (P1 — reliability and coverage)

- [ ] **H1**: Set `maxQueueSize: 10000` on price update batcher (failure-mode, data-integrity, Score: 3.9)
- [ ] **H2**: Write permanently failed opportunities to DLQ stream, add alerting threshold (failure-mode-analyst, Score: 3.8)
- [ ] **H3**: Add blast/scroll to FACTORY_SUBSCRIPTION_ENABLED_CHAINS and RESERVE_CACHE_ENABLED_CHAINS (cross-chain, config-drift, Score: 3.7)
- [ ] **H4**: Implement `refreshScrollL1Fee()` and `refreshMantleL1Fee()` handlers (cross-chain-analyst, Score: 3.6)
- [ ] **H5**: Unify expiry source — use `getOpportunityTimeoutMs()` from thresholds.ts as canonical source (cross-chain-analyst, Score: 3.5)
- [ ] **H6**: Eliminate object spreads in publishPriceUpdate — use direct mutation (latency-profiler, Score: 3.5)
- [ ] **H7**: Integrate `checkStreamLag()` into health monitoring, emit critical alerts at 80% lag (data-integrity, failure-mode, Score: 3.4)
- [ ] **H8**: Add Redis health circuit breaker — cap queues, pause detection during outage (failure-mode-analyst, Score: 3.4)
- [ ] **H9**: Log actual error in handleConnectionError at warn level per attempt (observability-auditor, Score: 3.3)
- [ ] **H10**: Add `/metrics` endpoint to health server with key counters in Prometheus format (observability-auditor, Score: 3.2)
- [ ] **H11**: Add `Number.isFinite(price)` check in emitPriceUpdate before publishing (data-integrity-auditor, Score: 3.2)

### Phase 3: Backlog (P2/P3 — hardening and optimization)

- [ ] **M1**: Add simple circuit breaker around Redis Streams publish operations (failure-mode-analyst, Score: 3.1)
- [ ] **M2**: Check batcher.add() return value; set backpressure flag to skip detection with stale data (failure-mode, data-integrity, Score: 3.0)
- [ ] **M3**: Add Redis PING in health check with timeout (observability-auditor, Score: 3.0)
- [ ] **M4**: Consider `startId: '0'` for critical streams; document deployment ordering (data-integrity-auditor, Score: 2.9)
- [ ] **M7-M8**: Fix || → ?? violations; use per-chain staleness from thresholds.ts (config-drift-detector, Score: 2.7)
- [ ] **M9**: Add periodic info-level rejection summary (every 5 min) (observability-auditor, Score: 2.6)
- [ ] **M13**: Add USDB to STABLECOIN_SYMBOLS; add Blast decimal override (cross-chain-analyst, Score: 2.4)
- [ ] **L1-L10**: Minor convention fixes, env var documentation, hardcoded value extraction

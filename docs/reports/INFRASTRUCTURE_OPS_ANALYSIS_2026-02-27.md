# Infrastructure Operational Analysis Report

**Date**: 2026-02-27
**Scope**: `/infrastructure` + operational pipeline (shared/core, services)
**Method**: 6 specialized agents (5 completed autonomously, 1 self-executed by team lead)
**Agents**: latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor (self-executed), config-drift-detector

---

## Executive Summary

- **Total findings by severity**: Critical: 4 / High: 8 / Medium: 14 / Low: 10 / Info: 3
- **Overall health grade**: **B+** — The pipeline is well-engineered with strong fundamentals (seqlock protocol, HMAC signing, deferred ACK, circuit breakers). Key gaps are in failure recovery (no backpressure signal, no worker retry after exhaustion) and operational observability (price pipeline untraced, trade log failures silently swallowed).

**Top 5 highest-impact issues:**
1. MAXLEN trimming can silently discard unread messages during consumer lag (data-integrity + failure-mode)
2. StreamBatcher drops messages without upstream backpressure signal during Redis outage (failure-mode)
3. Worker pool has no slow periodic retry after 5 failures — permanently degraded (failure-mode)
4. Price update pipeline has no trace context propagation (observability — self-executed)
5. Monolith shutdown has no force-exit timer — can hang indefinitely (failure-mode)

**Agent agreement map**: Agents 2 (failure-mode) and 3 (data-integrity) independently identified the same MAXLEN trimming risk and batcher queue data loss window, validating both findings at HIGH confidence.

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Data Loss | `streams.ts:360-382` | MAXLEN trimming can remove unread messages when consumer lags behind. PRICE_UPDATES MAXLEN=100K. No consumer-lag-aware trimming or backpressure. | data-integrity, failure-mode | HIGH | Implement consumer lag monitoring that pauses producers when PEL+unread approaches MAXLEN. Or use MINID-based trimming tied to oldest unACKed message. | 4.3 |
| 2 | Backpressure | `streams.ts:177-186` | StreamBatcher silently drops messages when `maxQueueSize` exceeded during Redis outage. No upstream signal to slow event processing. | failure-mode, data-integrity | HIGH | Add backpressure callback from `StreamBatcher.add()` so detectors can pause event emission when batcher is full. | 4.1 |
| 3 | Resilience | `worker-pool.ts:718-724` | Worker pool has NO slow periodic retry after 5 restart failures. Pool permanently degraded. | failure-mode | HIGH | Add 5-minute periodic retry for failed workers (similar to WS slow recovery pattern at `chain-instance.ts:276`). | 3.9 |
| 4 | Shutdown | `monolith/index.ts:297-318` | Monolith shutdown has no force-exit timer. If `workerManager.stop()` hangs, the entire monolith hangs indefinitely. | failure-mode | HIGH | Add force-exit timer consistent with `service-bootstrap.ts:142-147` (10s unref'd timer). | 3.8 |

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 5 | Data Integrity | `streams.ts:761-773` | HMAC-rejected messages are ACKed and silently discarded (OP-9). During key rotation, legitimate messages could be permanently lost. No DLQ for HMAC failures. | data-integrity | HIGH | Route HMAC-rejected messages to a dead-letter stream with raw data preserved. Add metric counter for rejections. | 3.7 |
| 6 | Observability | `chain-instance.ts` (price pipeline) | Price update pipeline has NO trace context propagation. Only opportunity pipeline has tracing wired (publisher->coordinator->execution). Price updates go through StreamBatcher without traceId. | observability (self) | HIGH | Add `createTraceContext()` + `propagateContext()` in the price update path, same pattern as `opportunity.publisher.ts:110-111`. | 3.6 |
| 7 | Observability | `engine.ts:1710` | Trade logging failure silently swallowed: `tradeLogger.logTrade().catch(() => {})`. Failed audit trail writes produce no alert. | observability (self) | HIGH | Replace with `.catch(e => logger.error('Trade log write failed', { error: e, opportunityId }))`. Add metric counter. | 3.5 |
| 8 | Resilience | Circuit breaker state | No CB state persists across restarts. Rapid crash-restart cycles get no protection — CB resets to CLOSED each time. | failure-mode | MEDIUM | Persist CB state in Redis with short TTL (5min). Check on startup before allowing operations. | 3.4 |
| 9 | Config | `thresholds.ts:33` | `ARBITRAGE_CONFIG.estimatedGasCost = 15` USD hardcoded. L2 gas costs are $0.01-$0.50 — this could cause false-positive opportunity detection. | config-drift | HIGH | Use per-chain gas cost estimates from `gas-price-cache.ts` or make configurable via env var. | 3.3 |
| 10 | Cross-Chain | `cross-chain-simulator.ts:244-256` | Emerging L2s (blast, scroll, mantle, mode) fallback to $5 gas cost estimate (10-50x too high for L2s). Suppresses valid cross-chain opportunities. | cross-chain | MEDIUM | Add `blast: 0.5, scroll: 0.5, mantle: 0.2, mode: 0.5` to `chainGasCosts` map. | 3.2 |
| 11 | Cross-Chain | `cross-chain-simulator.ts:297` | Default chain list excludes 8 chains: Fantom, zkSync, Linea, Blast, Scroll, Mantle, Mode, Solana. Cross-chain simulation never generates opportunities for them. | cross-chain | HIGH | Add all operational chains to `defaultConfig.chains`. | 3.1 |
| 12 | Config | Docker/Fly memory drift | Execution engine: Docker 256M vs Fly 384M. Cross-chain: Docker 384M vs Fly 256M. | config-drift | HIGH | Align: set execution-engine to 384M in Docker, cross-chain to 256M. | 3.0 |

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 13 | Data Integrity | `publishing-service.ts:280-287` | Redis SETNX dedup fails OPEN — if Redis unavailable, opportunity published without dedup. Intentional availability tradeoff but risky for high-value trades. | data-integrity | HIGH | Make behavior configurable. For high-value trades, fail-closed may be safer. Add feature flag. | 2.8 |
| 14 | Data Integrity | `shared-memory-cache.ts:183-202` | `compareAndSet()` is NOT atomic even when `enableAtomicOperations=true`. Falls back to non-atomic get/set. False sense of atomicity. | data-integrity | HIGH | Implement true CAS using Atomics or document as single-writer-only. | 2.7 |
| 15 | Resilience | `stream-consumer.ts:157-184` | StreamConsumer has `pause()/resume()` but no auto-pause on high PEL count. Requires external caller. | failure-mode | MEDIUM | Add `maxPendingMessages` config that auto-pauses when PEL exceeds threshold. | 2.6 |
| 16 | Resilience | Triple failure path | If handler fails + DLQ write fails + file write fails, message only exists in logs. Extremely unlikely but worst-case path. | failure-mode | MEDIUM | Consider secondary DLQ (e.g., SQLite WAL). | 2.4 |
| 17 | Latency | `streams.ts:496-533` | HMAC backward-compat verification tries up to 4 HMAC computations per consumed message (current/previous key, with/without stream name). ~0.2ms overhead per msg. | latency-profiler | MEDIUM | Add `legacySignatureCompatEnabled` flag. When false, single HMAC check. ~75% reduction per message. | 2.3 |
| 18 | Latency | `multi-leg-path-finder.ts:937-949` | Worker thread structured clone of entire `pools` DexPool[] array per call. ~0.5-2ms for large pool sets. | latency-profiler | MEDIUM | Cache pool data in worker, send only deltas. Or use SharedArrayBuffer for pool reserves. | 2.2 |
| 19 | Config | `.env.example` missing entries | `FEATURE_FAST_LANE`, `FAST_LANE_MIN_CONFIDENCE`, `FAST_LANE_MIN_PROFIT_USD`, `R2_ENABLED` + 5 R2 vars, `CONSTRAINED_MEMORY`, `AB_TESTING_ENABLED` — all undocumented. | config-drift | HIGH | Add all missing env vars to `.env.example` with descriptive comments. | 2.1 |
| 20 | Config | `mev-config.ts:63-155` | MEV priority fees hardcoded per chain. No env var overrides for runtime tuning. | config-drift | MEDIUM | Add env var overrides like `MEV_PRIORITY_FEE_ETHEREUM_GWEI`. | 2.0 |
| 21 | Config | Docker/Fly coordinator region | Docker sets `COORDINATOR_REGION:-us-east1`, Fly coordinator in `sjc` (us-west1). Cross-region health reports inconsistent. | config-drift | MEDIUM | Align coordinator region across deployment methods. | 1.9 |
| 22 | Cross-Chain | `constants.ts:235-257` | No bridge routes for emerging L2s in simulation. Missing blast, scroll, mantle, mode, zksync, linea, fantom. | cross-chain | MEDIUM | Add common bridge routes for L2-to-L2 and L1-to-L2 paths. | 1.9 |
| 23 | Observability | `bridge-recovery-manager.ts:446` | Bridge recovery state write failure silently swallowed: `redis.set(key, resigned).catch(() => {})`. | observability (self) | MEDIUM | Add error logging with bridge key context. | 1.8 |
| 24 | Config | `.env.example:713` | `FEATURE_DYNAMIC_L1_FEES=false` in .env.example but actual default is `true` (code uses `!== 'false'`). Misleading for developers. | config-drift | MEDIUM | Update to `FEATURE_DYNAMIC_L1_FEES=true  # Default: true. Set to false to disable.` | 1.8 |
| 25 | Config | Docker partition ports | All services in `docker-compose.partition.yml` use `HEALTH_CHECK_PORT=3001`. Functionally correct (container isolation) but diverges from code defaults. | config-drift | LOW | Document or align per-service ports for consistency. | 1.7 |
| 26 | Data Integrity | Message schema | No version field in stream messages. Rolling deployments with schema changes could cause consumer rejections. | data-integrity | LOW | Add optional `schemaVersion` field. Validators accept current + previous versions. | 1.6 |

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 27 | Latency | `chain-instance.ts:693` | StreamBatcher `maxWaitMs=3` flushes every 3ms even with 1 message. Redis XADD called ~333x/sec at moderate load. | latency-profiler | MEDIUM | Increase to 10-20ms for price updates. Better batching ratio at moderate loads. | 1.5 |
| 28 | Cross-Chain | `thresholds.ts:134-149` | Solana missing from `chainGasSpikeMultiplier`. Falls back to global 2.0x. Solana's priority fee model differs from EIP-1559. | cross-chain | LOW | Add solana-specific spike multiplier or document fallback is acceptable. | 1.4 |
| 29 | Cross-Chain | `tokens/index.ts:601-603` | Mantle `WRAPPED_NATIVE_TOKENS.weth` points to WMNT. Semantically misleading key name. | cross-chain | LOW | Use `nativeWrapper` alias as canonical key for non-ETH chains. | 1.3 |
| 30 | Data Integrity | In-memory dedup caches | SwapEventFilter and OpportunityPublisher dedup caches lost on restart. Brief duplicate window. | data-integrity | LOW | Acceptable — Redis SETNX layer provides cross-restart protection. Document tradeoff. | 1.2 |
| 31 | Cross-Chain | Block time constants | Block times defined in 3 places with minor inconsistencies (Arbitrum: 0.25s block / 1s execution). | cross-chain | LOW | Consider deriving `BASE_EXECUTION_TIMES` from `BLOCK_TIMES_MS` programmatically. | 1.1 |
| 32 | Config | Mantle/Mode stub thresholds | Thresholds defined for mantle/mode but chains are stubs (no DEX factories). | config-drift | LOW | Harmless but note in docs. | 1.0 |
| 33 | Config | `AB_TESTING_ENABLED`, `CONSTRAINED_MEMORY` | Minor operational flags missing from .env.example. | config-drift | LOW | Add to .env.example for discoverability. | 1.0 |
| 34 | Latency | `cross-dex-triangular-arbitrage.ts:307-356` | 3x `Array.from(neighbors)` per base token in quad path detection. | latency-profiler | LOW | Pre-allocate reusable scratch array for neighbor sorting. | 0.9 |
| 35 | Observability | Latency tracker | Downstream stages (coordinatorAt, executionReceivedAt) may not be populated. Full E2E latency visibility unclear. | latency-profiler, observability (self) | NEEDS VERIFICATION | Audit coordinator/execution services for pipeline timestamp stamps. | 0.8 |
| 36 | Data Integrity | `price-matrix.ts:572` | Sequence counter overflow at 2^31 writes. Theoretical only — protocol still works under overflow. | data-integrity | LOW | No action needed. | 0.5 |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck Notes |
|-------|-----------|-----------|-------------------|------------------|
| WS Receive | WebSocket message arrival | `chain-instance.ts:1208` | ~0.1-0.5ms | Date.now() cached. No JSON.parse. |
| Event Routing | topic0 switch | `chain-instance.ts:1224-1258` | ~0.01ms | O(1) string comparison |
| Reserve Decode | BigInt hex parsing | `chain-instance.ts:1289-1293` | ~0.05-0.2ms | Unavoidable CPU-bound |
| Pair Update | Direct property writes | `chain-instance.ts:1337-1342` | ~0.01ms | No spread/assign |
| Price Calculation | BigInt division | `chain-instance.ts:1498` | ~0.05ms | Once per event |
| Price Publish (sync) | Batcher queue push | `chain-instance.ts:1565` | ~0.01ms | O(1) push |
| **Hot Path Total** | **WS -> Batcher** | — | **~0.3-1.5ms** | **Well within 50ms** |
| Batcher Flush (async) | XADD to Redis | `streams.ts:215-286` | ~1-5ms | maxBatchSize:50, maxWaitMs:3ms |
| HMAC Signing | Per XADD | `streams.ts:469-473` | ~0.05-0.1ms | Cached KeyObject |
| Consumer Read | XREADGROUP | `streams.ts:715-780` | ~0-30000ms | Blocking read |
| HMAC Verify | Per message | `streams.ts:496-533` | ~0.1-0.3ms | Up to 4 checks (backward compat) |
| Message Parse | JSON.parse | `streams.ts:1103-1163` | ~0.1-0.5ms | Per message |
| Price Cache Write | Seqlock | `price-matrix.ts:569-584` | ~0.001ms | Sub-microsecond |
| Simple Arb Detection | O(k) loop | `chain-instance.ts:1628-1723` | ~0.1-1ms | k=2-5 pairs |
| Triangular Detection | O(T*R^2) | `chain-instance.ts:1815-1837` | ~5-50ms | Throttled to 500ms intervals |
| Multi-Leg Detection | DFS with timeout | `multi-leg-path-finder.ts:225-328` | ~5-5000ms | Throttled to 2000ms, timeout-protected |

**Summary**: Hot path is ~0.3-1.5ms. E2E for simple arbitrage: ~5-15ms. Triangular detection: ~50-100ms (throttled).

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | WebSocket | Connection drop | wsManager events | Exponential backoff, max 5 retries then 5-min slow recovery | LOW | `chain-instance.ts:273-276` |
| 2 | Batcher | Queue full (Redis outage) | `totalMessagesDropped` counter | **NONE — messages permanently lost** | **HIGH** | `streams.ts:177-186` |
| 3 | Batcher | Flush failure | Error logged | Re-queue to front of queue | LOW (crash = loss) | `streams.ts:269-273` |
| 4 | Batcher | Destroy fails on shutdown | Warning logged with lost count | None | MEDIUM | `streams.ts:322-330` |
| 5 | Consumer | XREADGROUP error | Error caught | Exponential backoff 100ms->30s | LOW | `stream-consumer.ts:242-255` |
| 6 | Handler | Processing throws | Caught in poll loop | Message stays in PEL for retry | LOW | `stream-consumer.ts:232-239` |
| 7 | Handler | Coordinator handler fails | DeferredAck wrapper | DLQ stream + ACK | LOW | `stream-consumer-manager.ts:201-217` |
| 8 | DLQ | Redis DLQ write fails | Error logged | JSONL file fallback (100MB daily) | LOW | `stream-consumer-manager.ts:483-493` |
| 9 | DLQ | File fallback also fails | Error logged | **NONE — message only in logs** | HIGH (rare) | `stream-consumer-manager.ts:546-553` |
| 10 | Execution | Queue full (backpressure) | queueRejects stat | Consumer paused, PEL preserved | LOW | `opportunity.consumer.ts:666-677` |
| 11 | Execution | Crash mid-trade | In-flight in PEL (W2-5 fix) | XCLAIM on restart | MEDIUM | `opportunity.consumer.ts:335-371` |
| 12 | Worker | Thread crash | Exit handler | Restart with backoff, max 5 retries | LOW → HIGH after exhaustion | `worker-pool.ts:713-778` |
| 13 | Shutdown | SIGTERM/SIGINT | Reentrancy guard | Force-exit 10s timer | MEDIUM (10s window) | `service-bootstrap.ts:128-161` |
| 14 | Shutdown | Unhandled rejections (5 in 60s) | Counter with sliding window | Graceful shutdown triggered | MEDIUM | `service-bootstrap.ts:177-198` |
| 15 | Partition | One partition crashes | Process handlers | Container orchestrator restart + XCLAIM | MEDIUM (chains blind until restart) | — |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | blast, scroll, mantle, mode | Missing from `CrossChainSimulator.estimateGasCost()` — $5 fallback (10-50x too high) | Suppresses valid cross-chain opportunities | MEDIUM | `cross-chain-simulator.ts:244-256` |
| 2 | blast, scroll, mantle, mode | Missing from `DEFAULT_BRIDGE_COSTS` | No simulated bridge routes | MEDIUM | `constants.ts:235-257` |
| 3 | 8 chains excluded | Default cross-chain simulator only includes 7 chains | No cross-chain simulation for Fantom, zkSync, Linea, Blast, Scroll, Mantle, Mode, Solana | MEDIUM | `cross-chain-simulator.ts:297` |
| 4 | All L2 rollups | Static L1 fees ($0.30-$0.50) when `useDynamicL1Fees` is OFF | 3-5x wrong during L1 gas spikes | HIGH (if not enabled) | `gas-price-cache.ts:722-736` |
| 5 | BSC | USDT/USDC = 18 decimals (not 6) | FIXED via `CHAIN_TOKEN_DECIMAL_OVERRIDES` | NONE (mitigated) | `tokens/index.ts:691` |
| 6 | solana | Missing from `chainGasSpikeMultiplier` | Falls back to 2.0x (acceptable) | LOW | `thresholds.ts:134-149` |

**Gas Model Assessment**: All 16 chains have correct L1 fee handling. L2 rollups use oracle-based refresh (behind feature flag) with static fallbacks. Static values are conservative. **RECOMMENDATION**: Enable `FEATURE_DYNAMIC_L1_FEES=true` in production.

---

## Observability Assessment (Self-Executed by Team Lead)

### Trace Propagation Map

| Stage | traceId Present? | Evidence |
|-------|-----------------|----------|
| WebSocket -> Detector | NO | `chain-instance.ts` does not create trace context for price events |
| Detector -> Price Stream (Batcher) | **NO** | StreamBatcher publishes without trace context |
| Detector -> Opportunity Publisher | YES | `opportunity.publisher.ts:110-111` creates + propagates |
| Coordinator | YES | `coordinator.ts:1084-1087` extracts parent, creates child |
| Execution Engine Consumer | YES | `opportunity.consumer.ts:487-490` extracts parent, creates child |
| Publishing Service (generic) | YES | `publishing-service.ts:224-253` creates + propagates |
| Solana Partition | YES | `arbitrage-detector.ts:788-806` creates + propagates |
| MEV Share Event Listener | YES (partial) | `mev-share-event-listener.ts:28` generates traceId |

**GAP**: The price update pipeline (the most frequent message type) has no trace propagation. Only opportunity messages are traced end-to-end.

### Blind Spot Inventory

| File:Line | Pattern | Risk | Assessment |
|-----------|---------|------|------------|
| `engine.ts:1710` | `tradeLogger.logTrade().catch(() => {})` | **HIGH** — Silent audit trail failure | Should log error + increment metric |
| `bridge-recovery-manager.ts:446` | `redis.set(key, resigned).catch(() => {})` | **MEDIUM** — Bridge state write lost | Should log with key context |
| `l2-sequencer-provider.ts:396` | `.catch(() => {})` | LOW — L2 sequencer check fire-and-forget | Acceptable but should log |
| `cross-region-health.ts:756` | `.catch(() => {})` | LOW — Health check fire-and-forget | Acceptable |
| `provider.service.ts:796` | `closeDefaultHttp2Pool().catch(() => {})` | LOW — Cleanup path | Acceptable |

**Empty catch blocks in source** (30+ occurrences across shared/core and services): Most are in cleanup/shutdown paths (acceptable) or parsing fallbacks (acceptable). No critical blind spots beyond the 2 flagged above.

### Metrics Assessment

**Coverage is good**: 20+ files with counter/gauge/histogram patterns across websocket-manager, swap-event-filter, price-matrix, multi-leg-path-finder, nonce-manager, health-server, arbitrage-detector, solana-detector, worker-pool, rpc-metrics, stream-health-monitor, provider-health-tracker.

**Alert rules are comprehensive**: `infrastructure/monitoring/alert-rules.yml` covers 15 alerts across 3 severity levels (critical, warning, info) including: ServiceDown, RPC rate limits, cache hit rate, Redis backpressure, DLQ growth, circuit breakers, execution win rate, gas prices, memory, detection latency, trading volume.

### Health Check Assessment

Both `/health` and `/ready` endpoints implemented in:
- `partition/health-server.ts:82-224` (partitions)
- `service-bootstrap.ts:237-299` (standalone services)

Health endpoints check: service status, Redis connectivity (via isRedisHealthy), WebSocket connection status. Readiness includes chain-level readiness assessment.

### Trade Audit Trail

`TradeLogEntry` in `trade-logger.ts` captures 20+ fields including: timestamp, opportunityId, type, chain, dex, tokenIn/Out, amountIn, expectedProfit, actualProfit, gasUsed, gasCost, transactionHash, success, error, latencyMs, usedMevProtection, **traceId**, route, slippage, strategyUsed, retryCount, blockNumber. **Comprehensive.**

---

## Configuration Health

### Feature Flag Audit
22 feature flags audited. All use correct `=== 'true'` opt-in pattern EXCEPT:
- `FEATURE_DYNAMIC_L1_FEES` uses `!== 'false'` (default ON) — **intentional** but `.env.example` is misleading
- Safety-default flags (risk management, circuit breakers, trade logging) correctly use `!== 'false'`

### || vs ?? Violations
**No actionable violations found.** The `||` patterns for URL defaults are intentionally safer (empty string = falsy = use default). `parseInt/Number` patterns handle NaN which `??` cannot.

### Env Var Coverage
9 undocumented env vars found (FEATURE_FAST_LANE + config, R2_ENABLED + config, CONSTRAINED_MEMORY, AB_TESTING_ENABLED, REDIS_MEMORY_MODE, DISABLE_PUBSUB_FALLBACK).

### Deployment Config Drift
- **Port drift**: Docker partition uses HEALTH_CHECK_PORT=3001 for all services; Fly uses per-service ports
- **Memory drift**: Execution engine Docker 256M vs Fly 384M; Cross-chain Docker 384M vs Fly 256M
- **Region drift**: Coordinator Docker us-east1 vs Fly sjc (us-west1)

---

## Cross-Agent Insights

### Agents 2 + 3 Agreement (Information Separation Validation)
The failure-mode-analyst and data-integrity-auditor **independently** identified:
- **MAXLEN trimming data loss risk** — Both traced the same code path (`streams.ts:360-382`) and concluded HIGH risk. Promoted to P0 with HIGH confidence.
- **Batcher queue data loss window** — Both identified `streams.ts:177-186` as the primary in-memory data loss point. Promoted to P0.
- **Batcher destroy() data loss** — Both independently traced shutdown behavior (`streams.ts:322-330`). Confirmed MEDIUM risk.

**No disagreements** between Agents 2 and 3 — full agreement on Redis Streams analysis.

### Cross-Agent Connections
- **Latency-profiler R5** (latency tracker integration gap) connects to **observability audit** finding that downstream pipeline timestamps may not be populated
- **Config-drift** finding on `estimatedGasCost=$15` hardcoded connects to **cross-chain-analyst** finding that L2 gas costs are $0.01-$0.50
- **Failure-mode** finding on no chain redistribution connects to **config-drift** finding on partition config consistency (P1-P4 consistent but static)

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)
- [ ] Fix #1: Implement consumer-lag-aware MAXLEN trimming or MINID-based trimming (data-integrity, failure-mode, Score: 4.3)
- [ ] Fix #2: Add backpressure signal from StreamBatcher to detector (failure-mode, Score: 4.1)
- [ ] Fix #3: Add slow periodic retry (5min) for permanently-failed workers (failure-mode, Score: 3.9)
- [ ] Fix #4: Add force-exit timer to monolith shutdown (failure-mode, Score: 3.8)

### Phase 2: Next Sprint (P1 — reliability and coverage)
- [ ] Fix #5: Route HMAC-rejected messages to dead-letter stream (data-integrity, Score: 3.7)
- [ ] Fix #6: Add trace context to price update pipeline (observability, Score: 3.6)
- [ ] Fix #7: Log trade logger failures instead of swallowing (observability, Score: 3.5)
- [ ] Fix #8: Persist circuit breaker state in Redis (failure-mode, Score: 3.4)
- [ ] Fix #9: Per-chain gas cost estimates instead of global $15 (config-drift, Score: 3.3)
- [ ] Fix #10-11: Add emerging L2s to cross-chain simulator gas/chains/routes (cross-chain, Score: 3.2-3.1)
- [ ] Fix #12: Align Docker/Fly memory limits (config-drift, Score: 3.0)

### Phase 3: Backlog (P2/P3 — hardening and optimization)
- [ ] Fix #13-14: Configurable SETNX dedup fail-open + atomic CAS (data-integrity)
- [ ] Fix #15: Auto-pause StreamConsumer on high PEL (failure-mode)
- [ ] Fix #17-18: HMAC legacy compat flag + worker pool delta caching (latency)
- [ ] Fix #19-20: Document missing env vars + MEV priority fee overrides (config-drift)
- [ ] Fix #24: Fix misleading FEATURE_DYNAMIC_L1_FEES in .env.example (config-drift)
- [ ] Fix #27: Increase StreamBatcher maxWaitMs to 10-20ms (latency)
- [ ] Enable `FEATURE_DYNAMIC_L1_FEES=true` in production (cross-chain R1)

---

## Methodology Notes

- **5 of 6 agents** completed autonomously. Observability-auditor was self-executed by team lead (agent unresponsive after 2 minutes).
- **Agent model**: All agents ran on Claude Opus 4.6 with `general-purpose` subagent type.
- **Information separation**: Agents 2 (failure-mode) and 3 (data-integrity) independently analyzed Redis Streams. Full agreement on all overlapping findings — no conflicts to resolve.
- **Known correct patterns verified**: Seqlock protocol, HMAC signing with timingSafeEqual, deferred ACK, exponential backoff, reentrancy guards, batcher flush-during-flush protection.

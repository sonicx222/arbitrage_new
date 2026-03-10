# Extended Deep Analysis: Coordinator Service (Operational)

**Date**: 2026-03-10
**Target**: `services/coordinator/src/` + shared infrastructure
**Scope**: Operational health -- latency, failure modes, data integrity, cross-chain, observability, config drift
**Complements**: `DEEP_ANALYSIS_COORDINATOR_2026-03-10.md` (code quality, 35 findings, grade A-)
**Method**: 6 specialized agents (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector) + Team Lead synthesis
**Grade**: **B+**

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 6 |
| Medium | 16 |
| Low | 14 |
| **Total** | **36** |

**Top 5 Highest-Impact Findings**:
1. **H-01**: Readiness probe (`/api/health/ready`) does not verify Redis connectivity -- coordinator reports "ready" even when Redis is down (Team Lead + Observability)
2. **H-05**: `Promise.all` in batch forwarding -- a single XADD failure leaves up to 200 messages unACKed, causing redelivery storm (Data Integrity)
3. **H-02**: Mantle and Mode missing from chain-specific TTL overrides -- opportunities use 60s global TTL instead of ~15s (Team Lead + Cross-Chain)
4. **H-06**: Duplicate Prometheus endpoints (`/metrics` vs `/api/metrics/prometheus`) serve different metric sets -- scraper using root endpoint misses runtime, provider, and admission metrics (Observability)
5. **H-03**: Trace context propagation limited to 2 of 9 stream handlers -- health, whale, swap, volume, price-update, DLQ handlers lack traceId (Team Lead + Observability)

**Overall Assessment**: The coordinator is well-hardened from extensive prior refactoring cycles. Clean `??` patterns (zero violations), proper DI, multi-layer security, dedicated Redis connection for hot path (ADR-037), batch handlers, backpressure detection, and CB persistence. The 6 agents confirmed architectural soundness while revealing important edge cases in batch error handling (H-05), observability coverage (H-06), and chain-specific awareness (H-02).

**Agent Agreement Map**: H-01 confirmed by 2 agents, H-02 by 2 agents, H-03 by 2 agents, M-01 by 2 agents, M-11 by 2 agents. Agents 2+3 independently agreed on delivery semantics, HMAC chain completeness, and intentional `startId: '$'` design.

---

## Critical Findings (P0)

*None.*

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| H-01 | Failure Mode | `health.routes.ts:102-114` | Readiness probe checks `isRunning && systemHealth > 0` but does NOT verify Redis connectivity. If Redis dies, coordinator reports "ready" from stale in-memory state. Load balancers continue routing traffic to a non-functional coordinator for up to 90s (stale heartbeat threshold) before `systemHealth` drops to 0. | Team Lead, Observability | HIGH (95%) | 4.0 |
| H-02 | Cross-Chain | `opportunity-router.ts:176-183` | `DEFAULT_CHAIN_TTL_OVERRIDES` includes arbitrum/optimism/base/zksync/linea/solana but NOT mantle or mode. These chains use 60s global TTL instead of ~15s appropriate for their 2s block times. Both chains added to `SUPPORTED_EXECUTION_CHAINS` on 2026-03-08. Additionally, 9 of 15 chains total lack coordinator-side TTL overrides (Blast, Scroll, Fantom, Polygon, Avalanche, BSC also missing). | Team Lead, Cross-Chain | HIGH (92%) | 3.8 |
| H-03 | Observability | `coordinator.ts:1336-1879` | TraceId/spanId propagation only exists in `handleOpportunityMessage`, `handleOpportunityBatch`, `handleExecutionResultMessage`, `handleExecutionResultBatch`, and `forwardToExecutionEngine`. The remaining handlers (health, whale, swap, volume, priceUpdate, DLQ) have no trace context. Price-update trace gap is MEDIUM impact (feeds into detection pipeline). | Team Lead, Observability | HIGH (95%) | 3.6 |
| H-04 | Latency | `sse.routes.ts:78-125` | Each SSE connection creates 6 `setInterval` timers (metrics 2s, services 5s, streams 10s, CB 5s, diagnostics 10s, keepalive 15s). With `MAX_SSE_CONNECTIONS = 50`, this means up to 300 active timers. No timer pooling -- each timer independently serializes JSON and writes to the response stream. | Team Lead, Config Drift | MEDIUM (80%) | 3.4 |
| H-05 | Data Integrity | `opportunity-router.ts:880` | `processOpportunityBatch()` uses `Promise.all` for forwarding admitted opportunities. If a single `processOpportunity()` XADD fails, the entire Promise.all rejects. The exception propagates to `StreamConsumer.poll()` which catches it (`stream-consumer.ts:396-409`), leaving ALL ~200 batch messages unACKed. These messages will be redelivered on next poll, causing a redelivery loop if the error is persistent (e.g., Redis connectivity issue during XADD). | Data Integrity | HIGH (90%) | 3.8 |
| H-06 | Observability | `metrics.routes.ts:188-240`, `index.ts:65` | Two Prometheus endpoints serve different metric sets. Root `/metrics` (unauthenticated, `index.ts:65`): stream health + 4 coordinator counters. Authenticated `/api/metrics/prometheus` (`metrics.routes.ts:188`): stream health + runtime + provider + 9 coordinator counters + admission metrics. A Prometheus scraper configured to use `/metrics` misses runtime, provider latency, admission, and pipeline event metrics. | Observability | HIGH (90%) | 3.6 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| M-01 | Cross-Chain | `opportunity-scoring.ts:42-71` | `scoreOpportunity()` uses `profit * confidence * (1/ttlRemainingMs)` with no per-chain gas cost factor. A $5 opportunity on Ethereum (gas $20+) scores identically to a $5 on Arbitrum (gas $0.10). Per-chain `chainEstimatedGasCostUsd` and `chainMinProfits` from thresholds.ts are never used in scoring. | Team Lead, Cross-Chain | MEDIUM (85%) | 3.4 |
| M-02 | Observability | `metrics.routes.ts:189-240` | Prometheus metrics are hand-crafted text strings, not using `prom-client`. No histogram/summary support, no default process metrics (GC, event loop, heap), no scrape endpoint compliance. | Team Lead | MEDIUM (80%) | 3.2 |
| M-03 | Data Integrity | `opportunity-router.ts:200-201` | Duplicate detection window is fixed at 5000ms regardless of chain. Solana (400ms blocks): 5s = ~12 blocks. Ethereum (12s blocks): 5s < 1 block. Fast chains may see legitimate distinct opportunities filtered as duplicates. | Team Lead | MEDIUM (75%) | 3.0 |
| M-04 | Failure Mode | `stream-consumer-manager.ts:524-525` | DLQ fallback file has 100MB daily limit (`MAX_DLQ_FILE_BYTES`). After limit, messages silently dropped with only a warn log. No alerting, no metric counter for dropped DLQ messages. Triple-fallback chain (Redis DLQ -> local file -> app logs) is well-designed but the file limit is a silent data loss path. | Team Lead, Failure Mode | MEDIUM (85%) | 3.0 |
| M-05 | Config Drift | `sse.routes.ts:17` | `MAX_SSE_CONNECTIONS = 50` hardcoded, not configurable via env var. In production with multiple dashboard consumers, 50 may be silently hit with 503 response. | Team Lead, Config Drift | MEDIUM (80%) | 2.8 |
| M-06 | Config Drift | `sse.routes.ts:78-125` | All SSE push intervals hardcoded: metrics=2s, services=5s, streams=10s, CB=5s, diagnostics=10s, keepalive=15s. None configurable via env vars. | Team Lead | MEDIUM (75%) | 2.8 |
| M-07 | Failure Mode | `coordinator.ts:946-947` | Shutdown calls `opportunityRouter.shutdown()` then immediately proceeds to `clearAllIntervals()`. No await/drain for in-flight forwarding operations. Additionally, overall 15s shutdown timeout may be tight: sequential disconnects (HTTP 5s + opportunity Redis 5s + main Redis 5s + legacy Redis 5s) total 20s worst case. Force-exit timer correctly fires `process.exit(1)`. | Team Lead, Failure Mode | MEDIUM (70%) | 2.6 |
| M-08 | Latency | `coordinator.ts:1586-1592` | Opportunity batch handler creates `TraceContext` per message via `extractContext` + `createChildContext` / `createTraceContext`. For 200 messages/batch, this creates 200+ objects with 200 `crypto.randomBytes` calls (~0.5-1ms per batch). Consider batch-level trace with per-message indexed span IDs, or non-crypto PRNG for tracing span IDs. | Team Lead, Latency Profiler | MEDIUM (70%) | 2.6 |
| M-09 | Observability | `coordinator.ts:2160-2168` | DLQ error classification uses string matching (`includes('EXPIRED')`, `startsWith('[VAL_')`). Fragile -- upstream error message changes silently misclassify errors. DLQ messages may carry `_trace_*` fields from original message, but `handleDlqMessage` never extracts trace context for correlation. | Team Lead, Observability | MEDIUM (75%) | 2.4 |
| M-10 | Failure Mode | `coordinator.ts:2262-2271` | Circuit breaker persistence is fire-and-forget: `.catch(() => { /* non-critical */ })`. Silent catch also at CB restore (`coordinator.ts:637`). If Redis unavailable during CB state change, persisted state diverges from runtime. On crash-restart, stale Redis state may reopen a recovered CB. TTL 5min mitigates. | Team Lead, Failure Mode, Observability | MEDIUM (70%) | 2.4 |
| M-11 | Data Integrity | `coordinator.ts:510-581` | All streams except DLQ use `startId: '$'` with `resetToStartIdOnExistingGroup: true`. On restart, messages produced during downtime intentionally skipped. Documented design decision (stale trading data is dangerous). However, EXECUTION_RESULTS also uses this pattern -- missed results mean dashboard metrics underreport after restart. No metric tracks "messages skipped on restart". | Team Lead, Data Integrity | MEDIUM (70%) | 2.2 |
| M-12 | Latency | `coordinator.ts:1243-1244` | Opportunities stream uses 10ms blocking read, but price-updates uses 200ms. Price updates have up to 200ms additional latency before coordinator processes them. While not on critical execution path, delayed price awareness may affect opportunity scoring accuracy. | Team Lead | MEDIUM (65%) | 2.0 |
| M-13 | Observability | `metrics.routes.ts:245`, `metrics.routes.ts:124-125` | Catch blocks in `/api/metrics/prometheus` and `/api/diagnostics` endpoints return error responses but never log the actual error. If Prometheus scraping or diagnostics collection fails, operators see 500 response but have no server-side log to diagnose. | Observability | HIGH (90%) | 2.8 |
| M-14 | Data Integrity | `opportunity-router.ts:246` | In-memory dedup state (`opportunities: Map<string, ArbitrageOpportunity>`) lost on restart. Within the 5s dedup window, same opportunity can be forwarded twice to execution engine. Mitigated by EE's `setNx`-based dedup, but adds unnecessary load to execution stream. | Data Integrity | HIGH (85%) | 2.2 |
| M-15 | Config Drift | `metrics.routes.ts:29-30` | `METRICS_REDIS_TIMEOUT_MS` (default 5000, min 1000) and `METRICS_STREAM_HEALTH_TIMEOUT_MS` (default 3000, min 500) are read from `process.env` but NOT documented in `.env.example`. Operators cannot discover these tuning knobs without reading source. | Config Drift | HIGH (90%) | 2.4 |
| M-16 | Failure Mode | `coordinator.ts:2308-2318` | Legacy `forwardToExecutionEngine()` path drops opportunities on backpressure without writing to DLQ, unlike `OpportunityRouter` which writes to DLQ (`opportunity-router.ts:952-957`). This path only active when OpportunityRouter is not initialized (test scenarios), so production risk is low. | Failure Mode | HIGH (85%) | 2.0 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| L-01 | Config Drift | `coordinator.ts:374` | `process.env.HOSTNAME \|\| 'local'` uses `\|\|` not `??`. Correct -- empty hostname is semantically invalid. | Team Lead | LOW (60%) | 1.6 |
| L-02 | Observability | `coordinator.ts:1741-1748` | Whale alert handler logs at `warn` for every alert. At high activity, significant log volume. Consider `info` with `warn` only for critical threshold. | Team Lead | LOW (65%) | 1.6 |
| L-03 | Config Drift | `opportunity-router.ts:281` | `CONSECUTIVE_EXPIRED_WARN_THRESHOLD = 5` is private static readonly, not configurable. Auto-skip threshold IS configurable, creating inconsistency. | Team Lead | LOW (60%) | 1.4 |
| L-04 | Latency | `sse.routes.ts:64` | SSE `send()` calls `JSON.stringify(data)` per event per connection. With 50 connections, same data serialized 50 times. Consider caching serialized string and broadcasting. | Team Lead | LOW (55%) | 1.4 |
| L-05 | Observability | `health.routes.ts:102-114` | Readiness probe does not log when transitioning between ready and not_ready. Operators must poll endpoint to discover state changes. | Team Lead | LOW (55%) | 1.2 |
| L-06 | Data Integrity | `coordinator.ts:2003` | Execution result success check: `rawResult.success === true \|\| rawResult.success === 'true'`. Doesn't handle `'TRUE'` or `'1'` -- unlikely from EE but fragile. | Team Lead | LOW (50%) | 1.0 |
| L-07 | Config Drift | `opportunity-router.ts:220` | `executionStreamMaxLen: 5000` default may be low for high-throughput scenarios. Execution-requests MAXLEN in types is 100,000 but router uses separate 5,000 limit. | Team Lead | NEEDS VERIFICATION | 1.0 |
| L-08 | Observability | `sse.routes.ts:101-103` | Stream health check in SSE interval has empty catch. Silent failure means dashboard shows stale stream data with no indication. | Team Lead, Observability | LOW (55%) | 1.0 |
| L-09 | Failure Mode | `coordinator.ts:818-823` | StreamHealthMonitor `start(30_000)` fires-and-forgets with `.catch()` logging warn. Permanent failure means stream health never monitored. | Team Lead | LOW (50%) | 0.8 |
| L-10 | Cross-Chain | `coordinator.ts:685` | Chain group routing uses `=== 'true'` opt-in. Verified correct per convention. | Team Lead | N/A | N/A |
| L-11 | Latency | `stream-serialization.ts:94-106` | 4 conditional spread operators (`...(X ? {field: Y} : {})`) create temporary objects per forwarded opportunity. ~300-400 small allocations/s at peak. Replace with `if` guards. | Latency Profiler | HIGH (90%) | 1.4 |
| L-12 | Observability | `sse.routes.ts:17` | `activeSSEConnections` module-level variable used for connection limiting but never exposed as a Prometheus gauge. Operators cannot see how many dashboard clients are connected. | Observability | HIGH (85%) | 1.2 |
| L-13 | Data Integrity | `type-guards.ts:48-51` | `getBoolean()` only accepts native `boolean` type, not string `"true"`/`"false"`. Redis Streams serialize as strings. Not used in hot-path handlers (opportunity/health use string/number guards). OpportunityRouter has its own `parseBooleanField()` that handles strings correctly. | Data Integrity | HIGH (80%) | 0.8 |
| L-14 | Failure Mode | `coordinator.ts:1076-1083` | If 1 of 9 consumer groups fails to create at startup, that stream is not consumed but a StreamConsumer is still created. Consumer repeatedly fails with NOGROUP errors, triggering error alerts -- wasteful but detectable. | Failure Mode | MEDIUM (70%) | 0.8 |

---

## Latency Budget Table

| Stage | Component | File:Line | Est. Latency | Bottleneck | Agent |
|-------|-----------|-----------|-------------|------------|-------|
| Stream read | XREADGROUP (opportunities, dedicated conn) | `coordinator.ts:1243` | 0-10ms (blocking) | Network RTT to Redis | Latency Profiler |
| HMAC verify | `verifySignature()` with legacy compat | `streams.ts:662-699` | **0.05-0.2ms/msg** (up to 4 HMACs with legacy compat) | CPU-bound crypto | Latency Profiler |
| JSON parse | `parseFieldsToMessage` / `JSON.parse` | `streams.ts:1667` | ~0.01-0.05ms/msg | CPU | Latency Profiler |
| Trace extract | `extractContext` + `createChildContext` | `coordinator.ts:1588-1592` | ~0.01ms/msg (+0.005ms crypto.randomBytes) | Object allocation + CSPRNG | Latency Profiler |
| ALS binding | `withLogContext` / `AsyncLocalStorage.run` | `log-context.ts:63-65` | ~0.002ms | Negligible | Latency Profiler |
| Opp parse | String comparisons + `parseNumericField` | `opportunity-router.ts:748-808` | ~0.02ms/msg | CPU | Latency Profiler |
| Batch dedup | Grouping + Map operations | `opportunity-router.ts:810-850` | ~0.05ms/batch | CPU | Latency Profiler |
| Scoring | `scoreOpportunity()` pure arithmetic | `opportunity-scoring.ts:42-71` | ~0.001ms/opp | Negligible | Latency Profiler |
| Admission | `findKSmallest` heap-based selection | `opportunity-router.ts:850-920` | ~0.1ms/batch | CPU | Latency Profiler |
| Serialize | `serializeOpportunityForStream` | `stream-serialization.ts:42-122` | ~0.03ms/opp | String concat + spreads | Latency Profiler |
| Stream publish | XADD to execution stream (+ HMAC sign) | `opportunity-router.ts:986-988` | **0.5-2ms/opp** | Network I/O + crypto | Latency Profiler |
| Batch XACK | Pipelined `batchXack` | `streams.ts:1051-1081` | ~0.5ms/batch | Network I/O | Latency Profiler |
| SSE fan-out | `JSON.stringify` + `res.write` | `sse.routes.ts:64` | ~0.1ms per client | Serialization | Latency Profiler |
| **Total (200-msg batch)** | XREADGROUP -> process -> XADD(s) -> XACK | | **~15-60ms** | **HMAC verify dominates** | |

**Assessment**: Hot path is within <50ms target for most scenarios. HMAC verification with legacy compat (`STREAM_LEGACY_HMAC_COMPAT=true`, default) is the dominant CPU cost: 200 messages × up to 4 HMACs = 800 ops = ~40-80ms worst case. Setting `STREAM_LEGACY_HMAC_COMPAT=false` (already tracked as tech debt M-05 in MEMORY.md) reduces to 1-2 HMACs/msg (2-4x improvement). The dedicated Redis connection (ADR-037), 10ms blocking read, pipelined XACK, and batch processing are all correctly optimized.

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line | Agent |
|---|-------|-------------|-----------|----------|----------------|-----------|-------|
| 1 | Redis connection | Redis down | Stream consumer errors + alert after 10 errors | Auto: `onReady` recreates consumer groups; ioredis exponential backoff | Messages during outage lost (`startId: '$'`). In-flight PEL recovered via XCLAIM on restart. | `coordinator.ts:733-739` | Failure Mode |
| 2 | Stream consumption | XREADGROUP timeout | StreamConsumer internal retry | Automatic retry with backoff | None (blocking read retries) | shared/core StreamConsumer | Failure Mode |
| 3 | Message parsing | Invalid message data | Error thrown, caught by `withDeferredAck` wrapper | Message moved to DLQ, ACK'd. If DLQ fails, local JSONL fallback (100MB/day). | None (DLQ preserves) | `stream-consumer-manager.ts:197-217` | Failure Mode |
| 4 | DLQ write | Redis DLQ + local file both fail | Error logged, message ACK'd anyway | Message details only in application logs (line 569) | LOW: Triple-fallback chain has silent drop at 100MB limit | `stream-consumer-manager.ts:502-575` | Failure Mode, Data Integrity |
| 5 | Batch forwarding | Single XADD fails in Promise.all | Exception propagates to StreamConsumer catch | ALL batch messages left unACKed, redelivered next poll | MEDIUM: Redelivery storm if error persistent | `opportunity-router.ts:880`, `stream-consumer.ts:396-409` | Data Integrity |
| 6 | Execution forwarding | CB opens after 5 failures | CB state change alert, `forwardingMetrics` counters | Auto half-open after 60s cooldown. During OPEN: opportunities → DLQ. | LOW: Preserved in DLQ | `opportunity-router.ts:944-958` | Failure Mode |
| 7 | Leadership loss | Lock expired/stolen or 3 consecutive heartbeat failures | `onLeadershipChange` callback, heartbeat failure counter | Self-demotion, heartbeat continues re-acquisition attempts | MEDIUM: No forwarding while leaderless | `leadership-election-service.ts:346-406` | Failure Mode |
| 8 | Consumer group fail | 1 of 9 groups fails at startup | Error logged per group | Consumer still created, repeatedly fails with NOGROUP errors | MEDIUM: That stream unprocessed | `coordinator.ts:1076-1083` | Failure Mode |
| 9 | Graceful shutdown | SIGTERM received (15s timeout) | `setupServiceShutdown` handler | Ordered: stop consumers → release leadership → close HTTP → disconnect Redis. Force exit at 15s. | LOW: In-flight retries dropped (M-07) | `index.ts:191-205`, `coordinator.ts:933-1006` | Failure Mode |

### Cascading Failure Scenarios (Failure Mode Analyst)

| Scenario | Impact | Detection Time | Data Loss |
|----------|--------|---------------|-----------|
| **Redis completely down** | All 9 consumers fail, leadership lost, health reporting fails. Coordinator stays alive but non-functional. | ~10s (stream errors) to 30s (leadership self-demotion) | Messages during outage skipped on restart |
| **All partition detectors crash** | No new opportunities. Coordinator continues processing execution results and DLQ. | 90s stale heartbeat + 3 consecutive checks = ~120s | None |
| **Execution engine crash** | Pending opportunities in stream persist until MAXLEN trim. New opportunities forwarded → stream fills → backpressure at 70% → drops to DLQ. | 5min (pipeline starvation detection) | LOW (DLQ preserves) |
| **Coordinator crash mid-batch** | In-flight messages in PEL. XCLAIM on restart → DLQ (stale data dangerous to reprocess). | Immediate (process exit) | Trading opportunity missed, data preserved in DLQ |
| **Leadership split-brain** | Not possible with correct Redis operation (SETNX atomic). Redis partition could theoretically cause both sides to think they're leader. Lock TTL 30s ensures stale leaders lose lock. | 30s max | N/A |

---

## Chain-Specific Edge Cases (Cross-Chain Analyst)

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| CC-01 | All (scoring) | `scoreOpportunity()` chain-agnostic -- no gas cost factor | L1 opportunities score equally to L2 despite 300x gas cost | MEDIUM | `opportunity-scoring.ts:42-71` |
| CC-02 | Mantle, Mode | Missing from `DEFAULT_CHAIN_TTL_OVERRIDES` | Get 60s TTL instead of ~15s for 2s block times | MEDIUM | `opportunity-router.ts:176-183` |
| CC-03 | Blast, Scroll, Fantom, Polygon, Avalanche, BSC | Also missing from coordinator-side TTL overrides | Get 60s TTL, appropriate for some (Ethereum 12s) but not all | LOW | `opportunity-router.ts:176-183` |
| CC-04 | Cross-chain | ADR-038 uses buyChain for EE group routing | Correct: buy-side initiates flash loan | INFO | `opportunity-router.ts:971-975` |
| CC-05 | Blast, Linea | No flash loan provider configured | Direct execution only, flash loan required opps fail | LOW | `service-config.ts:483-496` |
| CC-06 | Solana vs Ethereum | TTL-urgency bias: shorter TTL = higher urgency score | May starve slower-profit Ethereum opportunities | LOW | `opportunity-scoring.ts:42-71` |

**ADR-038 Routing**: CORRECT. All 15 chains mapped, O(1) `CHAIN_TO_GROUP` lookup, correct fallback to legacy stream. Mantle/Mode correctly in l2-turbo partition and l2 execution group. Cross-chain routing uses `buyChain ?? chain` (buy-side initiates flash loan).

**Token Decimals**: CLEAN. Coordinator treats token addresses as opaque strings, profit values as pre-computed numbers. No token-amount arithmetic.

**Solana Handling**: CORRECT. Field name fallbacks (`tokenIn ?? token0`), dedicated execution group stream, shortest TTL override (10s). No gaps found.

---

## Observability Assessment (Observability Auditor)

### Trace Propagation Map

| Handler | Trace Context | Impact |
|---------|--------------|--------|
| `handleOpportunityMessage` (single) | YES -- extract parent, create child, `withLogContext` | Hot path ✓ |
| `handleOpportunityBatch` | YES -- batch-level + per-message contexts | Hot path ✓ |
| `handleExecutionResultMessage` | YES -- extract trace from EE result | Hot path ✓ |
| `handleExecutionResultBatch` | YES -- per-result trace IDs in summary | Hot path ✓ |
| `forwardToExecutionEngine` / serialize | YES -- `_trace_traceId/spanId/parentSpanId` serialized | Hot path ✓ |
| `handleHealthMessage` | NO | Low impact (monitoring) |
| `handleWhaleAlertMessage` | NO | Low impact (informational) |
| `handleSwapEventMessage` | NO | Low impact (analytics) |
| `handleVolumeAggregateMessage` | NO | Low impact (analytics) |
| `handlePriceUpdateMessage/Batch` | NO | **MEDIUM impact** (feeds detection) |
| `handleDlqMessage` | NO | **MEDIUM impact** (DLQ carries `_trace_*` fields) |

### Blind Spot Inventory

| Location | Pattern | Impact |
|----------|---------|--------|
| `coordinator.ts:637` | Silent catch on CB state restore | LOW (fresh state acceptable) |
| `coordinator.ts:2270` | Fire-and-forget CB persist `.catch(() => {})` | LOW (recovery-resilient by design) |
| `coordinator.ts:2890` | Silent catch on SSE listener | LOW-MEDIUM (phantom client count) |
| `sse.routes.ts:101,117` | Empty catch on stream health / diagnostics in SSE | LOW (transient startup) |
| `metrics.routes.ts:245` | No logging in Prometheus endpoint catch | **MEDIUM** (invisible scraping failures) |
| `metrics.routes.ts:124-125` | Error captured but not logged in diagnostics | **MEDIUM** (invisible failures) |

### Metrics Gaps

| Gap | Impact |
|-----|--------|
| Duplicate Prometheus endpoints with different metric sets (H-06) | HIGH -- scraper confusion |
| `activeSSEConnections` not exposed as Prometheus gauge | MEDIUM -- invisible capacity |
| No per-stream consumer lag metric from coordinator's perspective | LOW -- StreamHealthMonitor covers |
| No opportunity processing latency histogram | LOW -- pipeline timestamps cover E2E |
| No alert delivery success/failure rate in Prometheus format | LOW -- `getDroppedAlerts()` in health |

### Health Check Assessment

| Endpoint | Auth | Purpose | Redis Check | Assessment |
|----------|------|---------|-------------|------------|
| `/api/health` | validateHealthRequest | Load balancer | NO (uses cached state) | Adequate for deep health |
| `/api/health/live` | None | Liveness | NO (process running) | Correct |
| `/api/health/ready` | None | Readiness | **NO -- GAP (H-01)** | Needs Redis PING |
| `/health/*` | Mixed | Root aliases | Same as above | Clean |
| `/ready` | None | GCP probe alias | Same as ready | Clean |

---

## Configuration Health (Config Drift Detector)

### Feature Flags
| Flag | Pattern | Correct |
|------|---------|---------|
| `COORDINATOR_CHAIN_GROUP_ROUTING` | `=== 'true'` | Yes (opt-in) |
| `CAN_BECOME_LEADER` | `!== 'false'` | Yes (safety default: true) |
| `IS_STANDBY` | parsed by `parseStandbyConfig` | Yes |

No `FEATURE_*` flags in coordinator source. **Grade: A+**

### `||` vs `??` Violations
**Zero violations found.** All numeric env vars use `safeParseInt`/`safeParseFloat` with `??`. The `||` usages (HOSTNAME, port, role, lockKey) are all correct for string values where empty string is invalid. **Grade: A+**

### Environment Variable Coverage

| Variable | In .env.example | Default | Validated |
|----------|----------------|---------|-----------|
| `COORDINATOR_PORT` / `PORT` | YES | 3000 | `parseEnvInt` bounds 1-65535 |
| `MAX_OPPORTUNITIES` | YES | 1000 | `safeParseInt` |
| `OPPORTUNITY_TTL_MS` | YES | 60000 | `safeParseInt` |
| `OPPORTUNITY_CLEANUP_INTERVAL_MS` | YES | 10000 | `safeParseInt` |
| `PAIR_TTL_MS` | YES | 300000 | `safeParseInt` |
| `MAX_ACTIVE_PAIRS` | YES | 10000 | `safeParseInt` |
| `ALERT_COOLDOWN_MS` | YES | 300000/30000 | `safeParseInt`, env-aware |
| `EXECUTION_CB_THRESHOLD` | YES | 5 | `safeParseInt` |
| `EXECUTION_CB_RESET_MS` | YES | 60000 | `safeParseInt` |
| `CONSECUTIVE_EXPIRED_THRESHOLD` | YES | 10 | `safeParseInt` |
| `EXECUTION_STREAM_BACKPRESSURE_RATIO` | YES | 0.7 | `safeParseFloat` |
| `SIMULATION_OPPORTUNITY_TTL_MULTIPLIER` | YES | 1 | `safeParseInt` |
| `COORDINATOR_MIN_PROFIT_PERCENTAGE` | YES | undefined | `parseFloat` + `isFinite` |
| `COORDINATOR_CHAIN_GROUP_ROUTING` | YES | false | `=== 'true'` |
| `DASHBOARD_AUTH_TOKEN` | YES | None (req. prod) | Startup throw |
| `ALLOWED_ORIGINS` | YES | localhost | Startup throw in prod |
| `DISCORD_WEBHOOK_URL` | YES | None (optional) | None needed |
| `SLACK_WEBHOOK_URL` | YES | None (optional) | None needed |
| `EXECUTION_ENGINE_PORT` | YES | 3005 | `parseEnvIntSafe` + NaN check |
| `EXECUTION_ENGINE_HOST` | YES | localhost | No validation |
| `API_RATE_LIMIT_WINDOW_MS` | YES | 900000 | `parseEnvIntSafe` min=1000 |
| `API_RATE_LIMIT_MAX` | YES | 100 | `parseEnvIntSafe` min=1 |
| `METRICS_REDIS_TIMEOUT_MS` | **NO** | 5000 | `parseEnvIntSafe` min=1000 |
| `METRICS_STREAM_HEALTH_TIMEOUT_MS` | **NO** | 3000 | `parseEnvIntSafe` min=500 |

**2 env vars missing from `.env.example`** (M-15). All stream names use shared `RedisStreams` constants (zero hardcoded strings). **Grade: A-**

---

## Data Integrity Assessment (Data Integrity Auditor)

### Delivery Guarantees

| Stream Type | Semantic | ACK Pattern | Risk |
|-------------|----------|-------------|------|
| Non-batch (health, whale, swap, volume, DLQ) | **At-least-once** | Deferred ACK: process → XACK on success, or DLQ → XACK on failure | XACK failure leaves msg in PEL for redelivery |
| Batch (opportunities, price-updates, exec-results) | **At-least-once** | Batch handler returns processed IDs → `batchXack()` | Exception in handler leaves ALL batch msgs unACKed (H-05) |
| Orphaned PEL | DLQ'd (not reprocessed) | XCLAIM at startup → DLQ → ACK | Correct for trading data |

### HMAC Chain Integrity: COMPLETE

- **Sign**: `JSON.stringify(message)` → `signMessage(serialized, streamName)` → `sig` field in XADD
- **Verify**: `verifySignature()` with `crypto.timingSafeEqual`, up to 4 attempts with legacy compat
- **XCLAIM**: Also verifies HMAC (no bypass path)
- **Coverage**: HMAC covers JSON-serialized `data` field + stream name prefix. Redis message ID NOT covered (known limitation).
- **Production**: Constructor throws if `signingKey` is null AND `NODE_ENV === 'production'`

### Dedup Layers

| Layer | Scope | Key | Window | Restart-Safe |
|-------|-------|-----|--------|-------------|
| Opportunity by ID + timestamp | Per-opportunity | `opportunities.get(id)` | 5000ms | **NO** (in-memory Map, M-14) |
| Batch by pair key | Within batch | `chain:buyDex:sellDex:tokenIn:tokenOut` | Single batch | N/A (per-batch) |
| Consumer group | Per-group | Redis internal | Stream lifetime | YES |
| EE downstream | Per-execution | `setNx` Redis key | Configurable | YES |

---

## Cross-Agent Insights

### Information Separation Results (Agents 2 + 3)

The failure-mode-analyst and data-integrity-auditor independently analyzed Redis Streams, shutdown, and delivery guarantees:

| Area | Agent 2 (Failure Mode) | Agent 3 (Data Integrity) | Agreement |
|------|----------------------|-------------------------|-----------|
| Delivery semantics | At-least-once for non-batch | At-least-once for non-batch | **AGREE** (HIGH confidence) |
| PEL recovery | XCLAIM → DLQ → ACK at startup | XCLAIM → DLQ → ACK at startup | **AGREE** (HIGH confidence) |
| `startId: '$'` | Intentional for trading safety | Intentional, but exec-results gap | **AGREE on intent, DI adds nuance** |
| DLQ retry | No automatic retry (FM-01) | No automatic retry (DI confirms) | **AGREE** (HIGH confidence) |
| HMAC chain | Complete (FM perspective) | Complete with full trace (DI perspective) | **AGREE** (HIGH confidence) |
| Batch error handling | Not highlighted specifically | **DI-H-01: Promise.all redelivery storm** | **DI UNIQUE** (promoted to H-05) |
| Legacy path drops | **FM-02: drops without DLQ** | Not covered | **FM UNIQUE** (added as M-16) |

### Multi-Agent Convergence

- **H-01 (Readiness probe)**: Team Lead + Observability auditor independently flagged → HIGH confidence
- **H-02 (Chain TTLs)**: Team Lead + Cross-chain analyst independently flagged → HIGH confidence
- **H-03 (Trace context)**: Team Lead identified gap, Observability auditor provided detailed handler-by-handler trace map → ENRICHED
- **M-01 (Chain-agnostic scoring)**: Team Lead + Cross-chain analyst both identified, CC provided `chainEstimatedGasCostUsd` as the missing input → ENRICHED
- **M-10 (CB persistence)**: Team Lead + Failure Mode + Observability all noted the fire-and-forget pattern → 3-agent agreement

### Latency + Failure Mode Insight
The 10ms blocking read on opportunities (latency optimization) means during Redis reconnection, the consumer rapidly retries XREADGROUP, generating connection errors at high frequency. No circuit breaker wraps Redis read operations (FM-03 from failure-mode-analyst).

### Data Integrity + Observability Insight
DLQ entries carry `_trace_*` fields from original messages (DI perspective), but `handleDlqMessage` never extracts them (O-06 from observability auditor). Correlation between original message failure and DLQ classification requires manual timestamp matching.

---

## Conflict Resolutions

No direct conflicts between agents. All overlapping findings were complementary (different perspectives on the same code). The Promise.all redelivery storm (DI-H-01/H-05) was the most significant unique finding from a single agent, validated by reading the actual code path in `stream-consumer.ts:396-409`.

---

## Recommended Action Plan

### Phase 1: Immediate (P1 -- fix before deployment) ✅ COMPLETE

- [x] **H-01**: Add Redis PING with 2s timeout to readiness probe. Return 503 if unreachable. (Team Lead + Observability, Score: 4.0)
- [x] **H-05**: Replace `Promise.all` with `Promise.allSettled` in `processOpportunityBatch` so partial successes are ACKed and only failures remain pending. (Data Integrity, Score: 3.8)
- [x] **H-02**: Add Mantle and Mode to `DEFAULT_CHAIN_TTL_OVERRIDES` in `opportunity-router.ts:176-183`. Both are L2-class; use 15000ms. Also added Blast, Scroll. (Team Lead + Cross-Chain, Score: 3.8)
- [x] **H-06**: Merged root `/metrics` to match `/api/metrics/prometheus` (runtime, provider, admission, pipeline metrics). (Observability, Score: 3.6)
- [x] **H-03**: Added trace context to `handlePriceUpdateBatch` and `handleDlqMessage`. (Team Lead + Observability, Score: 3.6)

### Phase 2: Next Sprint (P2 -- reliability and coverage) ✅ COMPLETE

- [x] **M-01**: Added `estimatedGasCostUsd` to `ScorableOpportunity`, subtracted from profit before scoring. +7 tests. (Team Lead + Cross-Chain, Score: 3.4)
- [x] **H-04**: SSE timer pooling — shared timers broadcast to all connections, JSON serialized once per interval. `getActiveSSEConnections()` exported for L-12. (Team Lead + Config Drift, Score: 3.4)
- [x] **M-02**: Already resolved by H-06 fix — `RuntimeMonitor.getPrometheusMetrics()` provides event loop, heap, GC. Root `/metrics` now includes these. (Team Lead, Score: 3.2)
- [x] **M-03**: Dedup window now chain-aware: `chainTtl / 4` (min 500ms) for chains with TTL overrides, else default 5s. (Team Lead, Score: 3.0)
- [x] **M-04**: Added `_dlqFileDrops` counter to `StreamConsumerManager` with `dlqFileDrops` getter. Counter included in warn log on drop. (Team Lead + Failure Mode, Score: 3.0)
- [x] **M-13**: Added `logger.error()` in catch blocks of `/api/metrics/prometheus` and `/api/diagnostics`. (Observability, Score: 2.8) — done in Phase 1
- [x] **M-05**: `MAX_SSE_CONNECTIONS` configurable via `SSE_MAX_CONNECTIONS` env var (default 50, min 1). (Team Lead + Config Drift, Score: 2.8)
- [x] **M-15**: Documented `METRICS_REDIS_TIMEOUT_MS`, `METRICS_STREAM_HEALTH_TIMEOUT_MS`, `SSE_MAX_CONNECTIONS` in `.env.example`. (Config Drift, Score: 2.4)

### Phase 3: Backlog (P3 -- hardening and optimization)

- [ ] **M-07**: Add drain period in shutdown for in-flight forwarding retries. Consider parallelizing Redis disconnects. (Team Lead + Failure Mode, Score: 2.6)
- [ ] **M-08**: Batch-level trace context with indexed span IDs, or non-crypto PRNG for trace span generation. (Team Lead + Latency Profiler, Score: 2.6)
- [ ] **M-06**: Make SSE push intervals configurable via env vars. (Team Lead, Score: 2.8)
- [ ] **M-09**: Replace string-matching DLQ classification with structured error codes. Extract trace context from DLQ entries. (Team Lead + Observability, Score: 2.4)
- [ ] **M-10**: Add `logger.debug` in CB state restore/persist catch blocks. (Team Lead + Failure Mode + Observability, Score: 2.4)
- [ ] **M-11**: Add metric for "messages skipped on restart". Consider `startId: '0'` for EXECUTION_RESULTS. (Team Lead + Data Integrity, Score: 2.2)
- [ ] **M-14**: Document in-memory dedup restart risk as accepted (EE has `setNx` backstop). (Data Integrity, Score: 2.2)
- [ ] **L-11**: Replace spread operators with `if` guards in `serializeOpportunityForStream`. (Latency Profiler, Score: 1.4)
- [x] **L-12**: Exposed `getActiveSSEConnections()` from `sse.routes.ts` (done with H-04 timer pool). (Observability, Score: 1.2)
- [x] Document remaining undocumented env vars in `.env.example` (done with M-15).

---

## Appendix: Known Correct Patterns Verified

| Pattern | Location | Verified By |
|---------|----------|------------|
| `??` for all numeric env vars | `coordinator.ts:384-422` | Config Drift (zero violations) |
| `=== 'true'` for chain group routing | `coordinator.ts:685,1136` | Config Drift |
| `!== 'false'` for `CAN_BECOME_LEADER` | `index.ts:52` | Config Drift (safety default) |
| Dedicated Redis connection for opportunities | `coordinator.ts:649` (ADR-037) | Latency Profiler |
| Batch handlers for high-throughput streams | `coordinator.ts:1250-1267` | Latency Profiler |
| Deferred ACK with DLQ | `stream-consumer-manager.ts:197-217` | Failure Mode, Data Integrity |
| Circuit breaker with persistence | `coordinator.ts:2259-2271` | Failure Mode |
| Backpressure detection (70% threshold) | `coordinator.ts:2443-2458` | Failure Mode |
| Consumer lag auto-skip | `coordinator.ts:1457-1481` | Data Integrity (intentional) |
| `Promise.allSettled` for consumer shutdown | `coordinator.ts:1026` | Failure Mode |
| Pipelined batch XACK | `streams.ts:1051-1081` | Latency Profiler |
| HMAC chain with XCLAIM verification | `streams.ts:662-699,1443-1471` | Data Integrity |
| ADR-038 chain routing with fallback | `execution-chain-groups.ts:64-102` | Cross-Chain |
| Solana field name fallbacks | `opportunity-router.ts:560` | Cross-Chain |
| Stream names from shared constants | All 10 streams | Config Drift |
| `xack after processing` pattern | `stream-consumer-manager.ts:197-217` | Data Integrity |

## Appendix: Stream Consumer Polling Configuration

| Stream | Block Time | Batch Size | Inter-Poll | Connection | Idle Poll Rate |
|--------|-----------|------------|------------|------------|----------------|
| **opportunities** | 10ms | 200 | 0ms | **Dedicated** | ~100/s |
| **price-updates** | 200ms | 200 | 10ms | Shared | ~5/s |
| **execution-results** | 200ms | 200 | 10ms | Shared | ~5/s |
| health | 100ms | 10 | 10ms | Shared | ~10/s |
| whale-alerts | 100ms | 10 | 10ms | Shared | ~10/s |
| swap-events | 100ms | 10 | 10ms | Shared | ~10/s |
| volume-aggregates | 100ms | 10 | 10ms | Shared | ~10/s |
| dead-letter-queue | 100ms | 10 | 10ms | Shared | ~10/s |
| forwarding-dlq | 100ms | 10 | 10ms | Shared | ~10/s |

---

*Generated by 6-agent team + Team Lead synthesis. All findings have exact file:line evidence and are checked against Known Correct Patterns and ADR decisions.*

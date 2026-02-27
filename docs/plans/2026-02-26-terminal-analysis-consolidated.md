# Consolidated Terminal Analysis — Implementation Plan

**Date:** 2026-02-26
**Sources:** `reports/terminal-output-deep-dive-2026-02-26.md` (Report A), `reports/terminal-services-deep-dive-2026-02-26.md` (Report B)
**Validation:** All findings cross-verified against source code before acceptance.

---

## 1. Cross-Report Analysis

### Methodology

Both reports analyze the same ~6-minute test run (22:12:37 → 22:18:15) of 5 services: Coordinator, Partition P1 (asia-fast), Partition P2 (l2-turbo), Cross-Chain Detector, and Execution Engine.

- **Report A** focused on per-service analysis with specific config recommendations and memory optimization.
- **Report B** focused on cross-service failure propagation, timeline correlation, and operational KPIs.

I validated every finding against the actual codebase to distinguish accurate findings from speculative recommendations.

### Agreement Matrix (Both reports agree, code confirms)

| # | Finding | Report A | Report B | Code Confirmation |
|---|---------|----------|----------|-------------------|
| 1 | Coordinator health flapping (9 transitions in ~5 min) | Section 2.1 | Section 1 | `health-monitor.ts:173-231` — hysteresis exists (3 consecutive failures required) but 5s evaluation interval + 30s stale threshold still allows rapid oscillation during startup |
| 2 | Stale heartbeat warning storm (15-22 events) | Section 2.2 | Section 1 | `health-monitor.ts:282-313` — logs WARN for every stale service on every 5s evaluation cycle |
| 3 | Redis cascade failure (EPIPE → ECONNREFUSED) | Section 1.2 | Section 2 | `streams.ts:405-414` — hard 3-retry cap then gives up permanently; `client.ts:206-215` — no retry strategy defined (ioredis default retries forever) |
| 4 | Ankr 401 auth failure wastes reconnection time | Section 3.1 | Section 3 | **No 401 handling exists** in `websocket-manager.ts` or `provider-rotation-strategy.ts` — confirmed zero special handling for auth errors |
| 5 | MaxListenersExceeded warning on all services | Section 1.1 | Section 5 | `service-bootstrap.ts:180` and `handlers.ts:245` both use `Math.max(getMaxListeners(), 15)` — but with 5+ modules registering `process.on('exit')`, 15 is still too low |
| 6 | Execution engine starved (0 simulations) | Section 6.1 | Section 4 | Confirmed — no opportunity→execution pipeline activity during run |
| 7 | SharedArrayBuffer over-allocation (~563MB per partition) | Section 3.4 | Section 5 | **CONTRADICTED BY CODE** — see below |

### Contradictions and Corrections

#### 1. SharedArrayBuffer Memory: 563MB claim is WRONG

Both reports cite `bufferSize: 590557956 (~563MB)` from terminal output. However, code validation reveals:

- `price-matrix.ts:257-274` — Default `maxPairs: 1000`, `reserveSlots: 100` = **~86 KB** per PriceMatrix
- `shared-key-registry.ts:76` — Dynamic: `headerSize + (maxKeys * 64)` bytes

The 563MB figure (590,557,956 bytes / 64 bytes per slot = **9,227,468 slots**) means the partition is being configured with `maxPairs: 8,388,608` (8M) at runtime — **not** from code defaults. This must be an environment variable or partition config override.

**Action required:** Find and reduce the `maxPairs` config to a sensible value (e.g., `actualPairCount * 4`). The code supports dynamic sizing — the issue is configuration, not code architecture.

#### 2. Redis Streams Retry: "3 retries with no visible backoff" — PARTIALLY WRONG

Report A says "Current retry limit is 3 with no visible backoff." Code shows:
- `streams.ts:410-413` — Backoff IS present: `Math.min(times * 100, 3000)` = 100ms, 200ms, 300ms
- But the hard 3-retry cap means it gives up after 600ms total — far too aggressive
- `client.ts` has NO retry strategy (ioredis default = infinite retries with `min(times * 50, 2000)` backoff)

**Actual problem:** Asymmetric retry behavior between the two Redis clients, not "no backoff."

#### 3. CPU Usage: "Always 0%" — PARTIALLY FIXED

Report A Section 5.2 says CPU is always 0%. Code validation shows:
- `enhanced-health-monitor.ts:604-634` and `unified-detector.ts:489-510` — **FIXED** with proper delta-based measurement
- But `coordinator.ts:1759`, `cross-chain-detector/detector.ts:1847`, `execution-engine/health-monitoring-manager.ts:199` — **STILL HARDCODED `cpuUsage: 0`**

The terminal output showing `cpuUsage: 0` across all services is correct because the 3 services running during this test (coordinator, cross-chain, execution) all have the hardcoded version.

#### 4. Alert Duplication: "Logged twice" — ALREADY PARTIALLY FIXED

Report A Section 2.3 describes dual logging. Code shows:
- `health-monitor.ts:371-381` contains a P0 FIX comment explaining the prior double-cooldown bug has been fixed
- However, the dual log pattern ("Alert triggered" in `coordinator.ts:1844` + "Alert triggered (no notification channels)" in `notifier.ts:363`) still exists because these are two different code paths — the fix addressed cooldown logic, not log deduplication

### Unique Findings (only in one report)

| Finding | Source | Validated? |
|---------|--------|-----------|
| PriceMatrix dynamic sizing recommendation | Report A §3.4 | Yes — code supports it, config is the issue |
| Blast/Scroll legacy subscription mode | Report A §4.2 | Not validated (lower priority) |
| Health check interval inconsistency (P1=15s, P2=10s) | Report A §4.3 | Not validated (configuration issue) |
| TensorFlow.js orthogonal init slowness | Report A §5.1 / Report B §5 | Yes — confirmed as startup-only cost |
| DLQ test pollution (222 entries, 77% test garbage) | Report A §7 | Not validated against files (data-plane issue) |
| Trade log profit erosion (10-18% below expected) | Report A §8 | Not validated (simulation mode) |
| Pipeline starvation metrics recommendation | Report B §P1-4 | Yes — no stream lag/depth tracking exists |
| Feature flag gating for optional subsystems | Report B §P1-6 | Yes — commit-reveal warning fires from `feature-flags.ts:559-567` on ALL services via auto-validation |
| Connectivity chaos tests recommendation | Report B §P2-10 | Yes — no provider 401 fallback test exists |

### Gap Analysis (Neither report caught)

| Gap | Evidence |
|------|----------|
| **No data gap backfill implementation** | `websocket-manager.ts` detects gaps and emits `'dataGap'` events, but NO code subscribes to perform `eth_getLogs` backfill. Both reports recommend backfill but neither noticed it's a fully missing feature, not a partial implementation. |
| **Asymmetric Redis client retry behavior** | `RedisClient` retries infinitely (ioredis default). `RedisStreamsClient` gives up after 3 retries (600ms). Neither report identified this divergence as the root cause of the cascade — Streams die first, then control plane follows. |
| **Duplicate DegradationLevel enum** | `health-monitor.ts:32-38` defines its own `DegradationLevel`. `shared/core/src/monitoring/cross-region-health.ts` and `shared/core/src/resilience/graceful-degradation.ts` define parallel enums. These could drift. |
| **Health evaluation interval (5s) not mentioned** | `coordinator.ts:1709` runs `evaluateDegradationLevel()` every 5 seconds. With `staleHeartbeatThresholdMs: 30000`, this means 6 checks per threshold period — amplifying the stale-heartbeat log volume by 6x vs. once-per-threshold. |

---

## 2. Consolidated Findings (Severity-Ranked)

### CRITICAL (Production blockers)

| ID | Finding | Root Cause Location | Impact |
|----|---------|---------------------|--------|
| C1 | **No WebSocket 401 auth error handling** | `websocket-manager.ts` — zero handling for HTTP 401; `provider-rotation-strategy.ts:359-395` only handles 429 | 6-12s wasted per reconnection cycle; Ankr URLs stay in rotation pool permanently |
| C2 | **Redis Streams gives up after 3 retries (600ms)** | `streams.ts:405-414` — `retryStrategy` returns `null` after 3 attempts | Streams die permanently on any transient Redis hiccup; requires service restart |
| C3 | **No data gap backfill after WebSocket reconnection** | `websocket-manager.ts:986-1005` detects gaps but no subscriber performs `eth_getLogs` | Missed blocks = missed arbitrage opportunities during every reconnection |
| C4 | **Coordinator startup flapping (60s grace too short)** | `coordinator.ts:275` — `STARTUP_GRACE_PERIOD_MS = 60000`; partitions take 59-80s to register | False COMPLETE_OUTAGE alerts during every deploy |
| C5 | **PriceMatrix over-allocation (563MB)** | Runtime config passes `maxPairs: 8388608` — 3000x larger than actual pair count | ~1.1GB wasted RAM across 2 partitions |

### HIGH (Reliability/observability)

| ID | Finding | Root Cause Location | Impact |
|----|---------|---------------------|--------|
| H1 | **Stale heartbeat log storm** | `health-monitor.ts:282-313` logs WARN on every 5s cycle | 15-22 redundant warnings per 5 minutes; alert fatigue |
| H2 | **CPU metric hardcoded to 0 in 4 services** | `coordinator.ts:1759`, `detector.ts:1847`, `health-monitoring-manager.ts:199`, `solana-detector.ts:1425` | Monitoring blind spot — CPU load invisible |
| H3 | **Commit-Reveal warning on all 7 services** | `feature-flags.ts:559-567` auto-validates on import; every service imports `@arbitrage/config` | 7 identical warnings at every startup; only execution-engine is relevant |
| H4 | **Empty error strings in Redis Streams errors** | `streams.ts` error serialization drops error message for certain error types | Diagnostic blind spot during Redis outages |
| H5 | **Alert dual-logging** | `coordinator.ts:1844` + `notifier.ts:363` both log when no channels configured | 2x log volume for every alert; confusing in investigation |

### MEDIUM (Performance/ops quality)

| ID | Finding | Root Cause Location | Impact |
|----|---------|---------------------|--------|
| M1 | **MaxListenersExceeded warning** | `service-bootstrap.ts:180` sets max to 15, but 5+ modules register exit handlers | Noisy startup; masks genuine memory leak warnings |
| M2 | **Execution engine dual health check** | Health monitor reports `not_configured` + `healthy` from different probes | Confusing health status for operators |
| M3 | **Execution engine zero-activity metrics spam** | Metrics loop runs every 30s even with all-zero counters in simulation mode | Log noise in dev; 2880 useless entries/day |
| M4 | **No pipeline starvation detection** | No metrics tracking `price_updates → opportunities → execution_requests` flow | Starved execution plane invisible to monitoring |
| M5 | **DLQ test pollution** | Tests write to same Redis instance/namespace as runtime | 77% of DLQ entries are test fixtures; real failures hidden |

---

## 3. Implementation Plan

### Batch 0: Immediate Config Fixes (< 30 minutes total)

These require no code changes — environment/config only.

| Task | File(s) | Change | Time |
|------|---------|--------|------|
| 0.1 Rotate/remove expired Ankr API key | `.env` / `.env.local` | Replace `fd86c2f5d5ff...` with valid key or remove Ankr URLs | 5 min |
| 0.2 Reduce PriceMatrix `maxPairs` | Partition config / env vars | Set `maxPairs` to `actualPairCount * 4` (~12,000) or add `MAX_PAIRS` env var | 10 min |
| 0.3 Increase coordinator grace period | `services/coordinator/src/coordinator.ts:275` | `STARTUP_GRACE_PERIOD_MS = 120000` | 2 min |
| 0.4 Increase `process.setMaxListeners` | `shared/core/src/service-lifecycle/service-bootstrap.ts:180` and `shared/core/src/partition/handlers.ts:245` | Change `15` to `25` | 2 min |

### Batch 1: WebSocket Auth-Failure Handling (C1) — ~3 hours

**Goal:** Treat HTTP 401/403 as permanent auth failures; skip immediately to next provider; quarantine broken URL+key combos.

**Files to modify:**

1. `shared/core/src/rpc/provider-rotation-strategy.ts`
   - Add `isAuthError(error)` method (check for 401, 403, "unauthorized", "forbidden")
   - Add `handleAuthFailure(url)` — quarantine URL for 1 hour (vs. 30s-5min for rate limits)
   - Modify `selectBestFallbackUrl()` to exclude auth-quarantined URLs

2. `shared/core/src/websocket-manager.ts`
   - In WebSocket error handler, detect auth errors before falling through to generic reconnect
   - On auth error: call `rotationStrategy.handleAuthFailure(url)`, log single ERROR with masked URL/key, immediately try next provider (no backoff)

3. `shared/core/src/monitoring/provider-health-scorer.ts`
   - Add `AUTH_FAILED` state to provider health tracking
   - Score auth-failed providers at 0 until quarantine expires

**Tests:** Add unit tests for auth error detection and quarantine behavior.

### Batch 2: Redis Streams Resilience (C2, H4) — ~2 hours

**Goal:** Fix the hard 3-retry cap and empty error serialization.

**Files to modify:**

1. `shared/core/src/redis/streams.ts:405-414`
   - Replace hard cap with exponential backoff: `Math.min(times * 200, 30000)` (200ms → 400ms → ... → 30s)
   - Add `maxRetries: 20` config option (gives up after ~5 minutes of backoff, not 600ms)
   - Fix empty error string: ensure `error.message || error.code || String(error)` in all error log paths

2. `shared/core/src/redis/client.ts:206-215`
   - Add explicit `retryStrategy` matching the Streams client's pattern (align behavior)
   - Add `reconnectOnError: (err) => err.message?.includes('READONLY')` for failover handling

**Tests:** Unit tests for retry progression and error serialization.

### Batch 3: Coordinator Health Stabilization (C4, H1, H5) — ~3 hours

**Goal:** Eliminate startup flapping, reduce stale-heartbeat log noise, fix alert dual-logging.

**Files to modify:**

1. `services/coordinator/src/health/health-monitor.ts`

   **Stale heartbeat log aggregation (H1):**
   - Lines 282-313: Track `lastStaleLogTime` per service. Only log WARN on first detection and when age crosses escalation thresholds (30s, 60s, 120s). Log at DEBUG for intermediate checks.
   - Add method `getStaleServicesSummary()` that returns aggregate: `"3 services stale (executor: 45s, detector-p1: 120s, detector-p2: 90s)"`

   **Startup grace period awareness (C4):**
   - Lines 173-231: During grace period, skip `COMPLETE_OUTAGE` transitions entirely. Distinguish "never heartbeated" (startup) from "heartbeat went stale" (runtime failure).
   - Add `firstHeartbeatReceived: Map<string, boolean>` — services that have never heartbeated during grace period are `STARTING`, not `FAILED`.

2. `services/coordinator/src/alerts/notifier.ts:363`

   **Alert dual-logging fix (H5):**
   - Remove the standalone `logger.warn('Alert triggered (no notification channels)')` log
   - Instead, return a result object from `notify()` indicating delivery status
   - Let `coordinator.ts:1844` log once: `'Alert triggered (delivery: skipped, reason: no channels configured)'`

3. `services/coordinator/src/coordinator.ts:275`
   - Change `STARTUP_GRACE_PERIOD_MS` to `120000` (already in Batch 0, but document here for traceability)

### Batch 4: Data Gap Backfill (C3) — ~4 hours

**Goal:** After WebSocket reconnection, fetch missed swap events via `eth_getLogs`.

**Files to create/modify:**

1. **New:** `shared/core/src/feeds/data-gap-backfiller.ts`
   - Subscribe to `'dataGap'` events from `WebSocketManager`
   - On gap: call `eth_getLogs` for blocks `[fromBlock, toBlock]` with relevant swap event topic filters
   - Emit recovered events through the normal event processing pipeline
   - Rate-limit backfill requests (max 1 per chain per 10s) to avoid RPC overload
   - Cap maximum backfill range (e.g., 100 blocks) to prevent unbounded queries

2. `shared/core/src/websocket-manager.ts`
   - After successful reconnection, call `detectDataGaps()` proactively
   - Pass gap info to backfiller

3. `shared/core/src/partition/runner.ts` (or equivalent service init)
   - Wire up `DataGapBackfiller` to the partition's WebSocket manager

**Tests:** Unit tests with mocked `eth_getLogs` responses; integration test for gap detection → backfill → event emission pipeline.

### Batch 5: CPU Metrics + Feature Flag Gating (H2, H3) — ~1.5 hours

**Files to modify:**

1. **CPU metrics (H2):**
   - `services/coordinator/src/coordinator.ts:1759` — Replace `cpuUsage: 0` with delta-based calculation (copy pattern from `enhanced-health-monitor.ts:604-634`)
   - `services/cross-chain-detector/src/detector.ts:1847` — Same fix
   - `services/execution-engine/src/services/health-monitoring-manager.ts:199` — Same fix
   - `shared/core/src/solana/solana-detector.ts:1425` — Same fix

   Extract to shared utility:
   - **New:** `shared/core/src/monitoring/cpu-usage-tracker.ts` — Single class with `getUsagePercent()` method using the delta pattern. All services import from here.

2. **Feature flag gating (H3):**
   - `shared/config/src/feature-flags.ts:559-567` — Guard the commit-reveal warning:
     ```typescript
     if (options?.serviceRole === 'execution-engine' || process.env.SERVICE_ROLE === 'execution-engine') {
       logger.warn('Commit-Reveal MEV Protection DISABLED...');
     }
     ```
   - Or: move validation to execution-engine's own startup, remove from global auto-validation path

### Batch 6: Operational Observability (M2, M3, M4, M5) — ~3 hours

1. **Execution engine dual health (M2):**
   - `services/execution-engine/src/services/health-monitoring-manager.ts` — Consolidate the two health probes into a single check with sub-statuses

2. **Zero-activity metrics suppression (M3):**
   - Same file — Skip metrics logging when all counters are 0 in simulation mode, or reduce interval to 120s

3. **Pipeline starvation detection (M4):**
   - `services/coordinator/src/coordinator.ts` — Add stream depth check for `stream:opportunities` and `stream:execution-requests`
   - Alert when detectors are healthy but `execution_requests == 0` for 5+ minutes

4. **DLQ test isolation (M5):**
   - Test configuration — Use `SELECT 1` or `test:` key prefix for test Redis operations
   - `shared/test-utils/src/redis-test-helper.ts` — Ensure test Redis uses isolated namespace

---

## 4. Execution Sequence and Dependencies

```
Batch 0 (config) ─────────────────────────────────► Done (no code review needed)
     │
     ├── Batch 1 (WebSocket 401) ──────────────────► Tests ──► Review
     │
     ├── Batch 2 (Redis resilience) ───────────────► Tests ──► Review
     │
     └── Batch 3 (Coordinator health) ─────────────► Tests ──► Review
              │
              └── Batch 4 (Data gap backfill) ─────► Tests ──► Review
                                                        │
              Batch 5 (CPU + flags) ───────────────► Tests ──┤
                                                        │    │
              Batch 6 (Observability) ─────────────► Tests ──┘
                                                        │
                                                    Final integration test run
```

- Batches 1, 2, 3, 5 are **independent** and can be parallelized
- Batch 4 depends on Batch 1 (WebSocket changes) and Batch 3 (health infrastructure)
- Batch 6 can run in parallel with any batch

---

## 5. Verification Criteria

Each batch must pass:

1. `npm run typecheck` — no new type errors
2. `npm run test:unit` — no regressions
3. `npm run test:integration` — Redis and WebSocket integration tests pass
4. Manual dev run (`npm run dev:minimal`) confirms:
   - No MaxListenersExceeded warning (Batch 0)
   - No 401-related reconnection delays (Batch 1)
   - Redis disconnect/reconnect cycle recovers cleanly (Batch 2)
   - Coordinator shows stable degradation level during startup (Batch 3)
   - CPU metrics show non-zero values (Batch 5)
   - No commit-reveal warning from non-execution services (Batch 5)

---

## 6. Risk Assessment

| Batch | Risk | Mitigation |
|-------|------|------------|
| 1 (WebSocket 401) | Quarantine logic could incorrectly quarantine working providers | Use strict auth-error detection (only 401/403 HTTP codes); 1-hour TTL with manual override |
| 2 (Redis retry) | Longer retry window could delay service crash detection | Add Redis health state reporting to coordinator; alert on "reconnecting" state |
| 3 (Coordinator health) | Suppressing startup alerts could mask real failures | Distinguish "never heartbeated" from "heartbeat expired"; escalate after grace period |
| 4 (Backfill) | Large block ranges could overload RPC providers | Cap at 100 blocks; rate-limit to 1 backfill per chain per 10s |

---

## 7. Estimated Total Effort

| Batch | Effort | Parallelizable |
|-------|--------|----------------|
| 0 - Config fixes | 30 min | Standalone |
| 1 - WebSocket auth | 3 hours | Yes (with 2, 3, 5) |
| 2 - Redis resilience | 2 hours | Yes (with 1, 3, 5) |
| 3 - Coordinator health | 3 hours | Yes (with 1, 2, 5) |
| 4 - Data gap backfill | 4 hours | After 1 + 3 |
| 5 - CPU + flags | 1.5 hours | Yes (with 1, 2, 3) |
| 6 - Observability | 3 hours | Yes (with all) |
| **Total (serial)** | **17 hours** | |
| **Total (parallel)** | **~9 hours** | Batches 1-3-5 parallel, then 4, then 6 |

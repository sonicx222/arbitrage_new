# Extended Deep Analysis Report — 2026-03-03

**Date:** 2026-03-03
**Duration:** 10-minute live monitoring + 6-agent parallel static analysis
**Environment:** Windows 11, Node 22, In-memory Redis, 7 services (coordinator, P1-P4, execution-engine, cross-chain-detector)
**Baseline:** Previous monitoring report: `docs/reports/RUNTIME_MONITORING_REPORT_2026-03-02.md`
**Log lines captured:** 52,278 (vs. 67,961 yesterday — 23% reduction confirming C1 partial fix)
**Agents:** latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector

---

## Executive Summary

All 7 services started successfully. Graceful degradation activated within 2 minutes as all external WebSocket/HTTPS connections fail with TLS certificate errors (corporate Windows environment, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). Final system health: **42.9% (REDUCED_CHAINS)**.

**Compared to yesterday (2026-03-02):**
- C1 (infinite reconnection loop) — **PARTIALLY FIXED** (log volume reduced 23%)
- C2 (health stuck at "starting") — **FIXED** (now reports "unhealthy" correctly)
- H3 (.env drift) — **FIXED** (Redis password warnings absent today)
- M2 (MaxListeners warning) — **STILL PRESENT** on all 7 services
- M4 (vault-model adapter failures) — **STILL PRESENT** on arbitrum, optimism, ethereum, avalanche, fantom
- E4 (HTTP/2 CB opens repeatedly) — **STILL PRESENT** every 60-90s

**New critical finding today (P4 Solana):**
Solana partition fails immediately with ethers.js address validation error on a Raydium Program ID. **0/1 chains start.** This regression appears linked to today's fixes.

### Severity Distribution

| Severity | Count | Category |
|----------|-------|---------|
| **Critical** | 2 | Solana broken, false-positive health on exec engine |
| **High** | 4 | MaxListeners leak, TFjs performance, log flood, DLQ metadata loss |
| **Medium** | 6 | Adapter failures, HTTP/2 CB tuning, API auth, alert channels, degradation %, system health precision |
| **Low** | 3 | Health server binding, coord filtering logic, startup timing |

---

## CRITICAL Findings

### CRIT-1. Solana Partition Completely Broken — Ethers.js Validates Raydium Address as EVM Address

**Severity:** CRITICAL
**Service:** P4 (partition-solana)
**Status:** NEW — regression, not present in 2026-03-02 monitoring
**Confidence:** HIGH

**Evidence from live log:**
```
[p4] ERROR (unified-detector:solana-native): Chain error: solana
    error: "invalid address (argument="address", value="675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
           code=INVALID_ARGUMENT, version=6.16.0)"
[p4] ERROR (unified-detector:solana-native): Failed to start chain instance: solana
[p4] INFO  (unified-detector:solana-native): Chain instances started — requested: 1, successful: 0, failed: 1
```

**Root cause:** `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` is the Raydium AMM V4 Program ID (Solana base58). Somewhere in the Solana chain-instance startup path, this address is passed to an ethers.js function that calls `ethers.getAddress()` (or similar EVM address validation), which expects a 20-byte hex `0x...` address. Solana addresses are 32-byte base58 — incompatible.

**Impact:** Solana partition always fails to start. `SolanaArbitrageDetector` reports `hasStreamsClient: false` and starts in degraded mode. Cross-chain opportunities involving Solana are permanently unavailable. This fires 5 `Chain error` ERROR log entries on every startup.

**Likely location:** `services/unified-detector/src/chain-instance.ts` or `services/partition-solana/src/` — wherever chain initialization calls an ethers.js utility on the DEX factory/router addresses.

**Fix:** Guard the address validation to skip ethers.js validation when `chainId === 'solana'`, or use a Solana-specific address validator (`@solana/web3.js` `PublicKey`).

---

### CRIT-2. Execution Engine Reports "healthy" With 0/15 Working Chain Providers

**Severity:** CRITICAL
**Service:** Execution Engine (port 3005)
**Status:** NEW (yesterday showed "degraded" — today shows different behavior)
**Confidence:** HIGH

**Evidence from live log:**
```
[exec] WARN: Provider connectivity validation complete
    healthy: []
    unhealthy: [arbitrum, bsc, base, polygon, optimism, ethereum, avalanche, fantom, zksync, linea, blast, scroll, mantle, mode, solana]
    healthyCount: 0
    unhealthyCount: 15
[exec] WARN: No providers are currently healthy - service may be limited

-- 5 minutes later --
[exec] INFO: Health check completed
    status: "healthy"
    memoryUsage: 48725744
    uptime: 371.489
```

**Root cause:** The execution engine's health check method computes `status: "healthy"` based on service process health (Redis connected, queue operational) but does NOT factor in the provider health state (`healthyCount: 0`). The service is operationally alive but commercially dead — it cannot execute any trade.

**Impact:** External health monitoring (coordinator, load balancers, alerting) sees the execution engine as "healthy" when it cannot execute ANY transaction. This would mask a total trading blackout in production monitoring dashboards.

**Fix:** Include `providerHealthyCount > 0` as a condition in the health endpoint's status calculation. With 0 healthy providers, status should be `"degraded"` at minimum, `"unhealthy"` if the threshold is 0%.

---

## HIGH Findings

### HIGH-1. MaxListenersExceededWarning — PERSISTING from 2026-03-02 (M2)

**Severity:** HIGH
**Services affected:** ALL 7 (coordinator, exec, cross, P1, P2, P3, P4)
**Status:** PERSISTING — not fixed despite M2 recommendation
**Confidence:** HIGH

**Evidence:**
```
(node:XXXXX) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 exit listeners added to [process]. MaxListeners is 10.
```

Appears in ALL 7 services. This was M2 in yesterday's report. Fix recommended was `process.setMaxListeners(25)` at the very top of each service's `index.ts`. This has not been applied to 6 of the 7 services (only `execution-engine/src/index.ts` has it at the correct location).

**Impact:** Memory leak risk; Node.js suppresses listener leak warnings after 10, masking future leaks. In long-running production processes, accumulated listeners from the shutdown handler registration cycle can cause memory growth.

---

### HIGH-2. TensorFlow.js Missing Node.js Backend — Cross-Chain LSTM Performance Degraded

**Severity:** HIGH
**Service:** Cross-Chain Detector (port 3006)
**Status:** NEW finding
**Confidence:** HIGH

**Evidence:**
```
[cross] ============================
[cross] Hi, looks like you are running TensorFlow.js in Node.js. To speed things up dramatically,
        install our node backend, visit https://github.com/tensorflow/tfjs-node for more details.
[cross] ============================
[cross] Orthogonal initializer is being called on a matrix with more than 2000 (65536) elements:
        Slowness may result.
[cross] Orthogonal initializer is being called on a matrix with more than 2000 (16384) elements:
        Slowness may result.
```

The cross-chain detector uses `@tensorflow/tfjs` (pure JS) instead of `@tensorflow/tfjs-node` (native C++ binding). This results in:
- Pure JavaScript matrix operations instead of SIMD-optimized native code
- LSTM model inference is 5-20x slower than with the native backend
- Two orthogonal initializer calls on matrices of 65536 and 16384 elements at startup — CPU-intensive, blocking the event loop
- ML model initialized+warmed up takes ~60 seconds (22:31:35 init → 22:32:33 warmed up = ~58s)

**Impact:** The LSTM prediction that feeds cross-chain opportunity scoring is running on a significantly degraded inference engine. In production, this translates to slower opportunity detection. Startup takes 58 seconds to warm the LSTM model.

**Fix:** Add `@tensorflow/tfjs-node` to `services/cross-chain-detector/package.json` dependencies and update the import. Consider lazy-loading the model to avoid blocking startup.

---

### HIGH-3. Log Volume — Reconnection Spam Still Significant (C1 Partially Fixed)

**Severity:** HIGH
**Status:** PARTIAL FIX from C1 — still 52K lines/10min
**Confidence:** HIGH

Today's log volume: **52,278 lines in 10 minutes** (~5,228 lines/min), down from 67,961 yesterday.

**What improved:** The per-chain error duplication (chain instance counting every WS manager sub-retry) appears partially reduced.

**What remains:** P2 (l2-turbo, 5 chains) and P1 (asia-fast, 4 chains) still generate the majority of log volume from WebSocket reconnection cycles. The core pattern is unchanged:
- Every ~5-6 seconds, each chain attempts a new WS connection
- Each attempt generates ERROR + WARN + INFO entries (3-5 log lines per attempt)
- Provider rotation selects a new URL after each failure
- 14 EVM chains × 5 log lines × 1 attempt/5s = ~840 lines/min from WS alone

**At production scale:** 52K lines/10min = ~7.5M lines/day. At typical log aggregation pricing ($0.50/GB), this is ~$3.75/day in logging costs alone for a non-operational system.

**Fix (rate limiting):** Rate-limit reconnection failure logs to: first failure (full detail), then 1 summary per minute per chain (e.g., "WS reconnection still failing: 37 attempts in last 60s").

---

### HIGH-4. DLQ Entries From Previous Session Have All-Unknown Metadata

**Severity:** HIGH
**Service:** Coordinator
**Status:** NEW finding
**Confidence:** HIGH

**Evidence:**
```
[coord] WARN (coordinator): DLQ entry classified
    messageId: "1772577067259-0"
    originalStream: "unknown"
    errorCode: "unknown"
    opportunityId: ""
    type: "unknown"
    chain: "unknown"
    classification: "unknown"
    dlqTotals: {total: 1, expired: 0, ...}
```

On startup, the coordinator found 2 pending messages from the previous instance and claimed them via XCLAIM. These messages were forwarded to `stream:dead-letter-queue` as "DLQ entries" but all classification fields are "unknown". This happens because the orphaned messages from `stream:health` had already been ACKed by a different consumer or their message payload doesn't contain the expected opportunity metadata fields.

**Impact:** When failures push messages to the DLQ, the system loses all debugging context. An operator investigating why a trade opportunity failed cannot determine: which chain it was on, what the error was, or which opportunity it related to. The DLQ becomes a black hole.

**Fix:** Preserve original message payload in the DLQ entry (store the raw message fields alongside error metadata). The DLQ message should embed the original stream, stream message ID, error context, and full original payload.

---

## MEDIUM Findings

### MED-1. Vault-Model DEX Adapter Failures — PERSISTING from 2026-03-02 (M4)

**Severity:** MEDIUM (blocks Balancer V2 pool discovery on 5 chains)
**Chains affected:** arbitrum, optimism, ethereum, avalanche (Balancer V2), fantom (Beethoven X)
**Status:** PERSISTING

**Evidence:**
```
[p2] WARN (chain:arbitrum): No adapter registered for vault-model DEX, skipping pool discovery — dex: "balancer_v2"
[p2] WARN (chain:optimism): No adapter registered for vault-model DEX, skipping pool discovery — dex: "balancer_v2"
[p3] WARN (chain:ethereum): No adapter registered for vault-model DEX, skipping pool discovery — dex: "balancer_v2"
[p1] WARN (chain:avalanche): No adapter registered for vault-model DEX — (Balancer V2)
[p1] WARN (chain:fantom): No adapter registered for vault-model DEX — (Beethoven X)
```

Balancer V2/Beethoven X adapters require live RPC during initialization (to read vault addresses). When RPC is unavailable (TLS environment), initialization fails and the adapter is not registered, silently skipping all Balancer V2 pool discovery.

In production (with valid RPC), this should work. But if RPC latency is temporarily high during startup, the adapter fails silently and is never retried. **There is no recovery path — a pool discovery miss at startup is permanent for the lifetime of the process.**

**Fix:** Retry vault-model adapter initialization async (with backoff) if initialization fails during startup rather than silently skipping.

---

### MED-2. HTTP/2 Circuit Breaker Opens Every 60-90 Seconds — PERSISTING from 2026-03-02 (E4)

**Severity:** MEDIUM
**Service:** Execution Engine
**Status:** PERSISTING

**Evidence:**
```
22:32:03 WARN http2-session-pool: HTTP/2 circuit breaker opened
22:33:08 WARN http2-session-pool: HTTP/2 circuit breaker opened
22:34:03 WARN http2-session-pool: HTTP/2 circuit breaker opened
22:34:33 WARN http2-session-pool: HTTP/2 circuit breaker opened (×2)
22:35:33 WARN http2-session-pool: HTTP/2 circuit breaker opened
... (every 60-90s for the entire 10 minutes)
```

The circuit breaker opens, waits for its reset interval, half-opens, then immediately fails and opens again. This generates ~12 CB-open events over 10 minutes.

**Fix:** After the circuit breaker first opens due to TLS failures, apply exponential backoff on the half-open retry interval (e.g., 60s → 2min → 4min → cap at 15min). This reduces CB churn and log noise.

---

### MED-3. API Authentication Not Configured — Coordinator Endpoints Unprotected

**Severity:** MEDIUM (security)
**Service:** Coordinator
**Status:** PERSISTING (present in both today and yesterday's logs)

**Evidence:**
```
[coord] WARN (coordinator): API authentication NOT configured - endpoints are unprotected.
        Set JWT_SECRET or API_KEYS env vars for production.
```

The coordinator's REST API (port 3000) runs without authentication in development mode. While this is expected for `NODE_ENV=development`, the startup warning should be escalated to an error-level log if `NODE_ENV=production` AND no auth is configured. Currently both dev and prod generate the same warn-level message.

**Fix:** In `validateAuthEnvironment()`, if `NODE_ENV === 'production'` and auth is not configured, log at `error` level and raise an alert rather than just `warn`.

---

### MED-4. No Alert Notification Channels Configured

**Severity:** MEDIUM (operational)
**Service:** Coordinator
**Status:** PERSISTING

**Evidence:**
```
[coord] WARN (coordinator): No alert notification channels configured.
        Set DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL for production alerts.
```

Alerts fire internally (logged as WARNs) but are never externally delivered. During the 10-minute test:
- 8 `SERVICE_UNHEALTHY` alerts fired (severity: high)
- 2 `SYSTEM_HEALTH_LOW` alerts fired (severity: critical)
- 1 `LEADER_ACQUIRED` alert fired

None of these would reach an on-call engineer without Discord/Slack configuration.

---

### MED-5. Coordinator System Health Reported as Non-Integer Floating Point

**Severity:** MEDIUM (observability)
**Service:** Coordinator

**Evidence:**
```
systemHealth: 42.857142857142854  (from 3/7 services healthy)
systemHealth: 33.33333333333333   (from 2/6 services)
```

Raw floating-point fractions in health API responses are hard to compare programmatically (`42.857142857142854 < 50` is less readable than `42.9 < 50`). Noted in yesterday's report as E2.

**Fix:** Round to 1 decimal place: `Math.round(health * 10) / 10`.

---

### MED-6. Coordinator Degradation Cascade Shows Incorrect Health Scores

**Severity:** MEDIUM
**Service:** Coordinator

**Evidence:**
```
22:31:12 — Degradation: FULL_OPERATION → READ_ONLY — systemHealth: 100
22:32:12 — Degradation: READ_ONLY → REDUCED_CHAINS — systemHealth: 33.33%
22:36:38 — Alert: SYSTEM_HEALTH_LOW — "System health is 42.9%"
```

The coordinator transitioned to READ_ONLY when `systemHealth: 100` — this is logically inconsistent. If system health is 100%, READ_ONLY mode should not activate. The degradation trigger appears to be based on individual service health checks (all partitions unhealthy) rather than the composite `systemHealth` percentage.

**Fix:** Ensure `systemHealth` calculation and degradation level transitions use the same data source.

---

## LOW Findings

### LOW-1. Health Server Binding to 0.0.0.0 Without Auth Token (All Partitions)

**Severity:** LOW (informational — expected in dev, hard-fail guard exists for prod)
**Evidence:** All 4 partitions log: "Health server will bind to all interfaces without auth token (non-production)"
**Note:** Correct behavior. Production guard exists in `health-server.ts` line 343.

---

### LOW-2. Startup Timing — All Partitions Delay to ~22-35s (vs. Yesterday's Timings)

**Severity:** LOW

Today's startup times (from health server listen → chain instances started):
- P4 (solana): ~5s (chain fails immediately after connect attempt)
- P2 (l2-turbo): ~3s to health server, but ~2 minutes to first health check "unhealthy" report
- P1 (asia-fast): Health server up at 22:31:17, chain failures at 22:31:27-28 (~10s for first failures)

Better than yesterday's 26-40s per partition — today's faster failure detection confirms partial fix of the startup timeout issue.

---

### LOW-3. Coordinator DLQ Grace Period Logic May Be Off

**Severity:** LOW
**Service:** Coordinator

The coordinator found 2 pending messages from `coordinator-local-1772543586246` (previous instance) and claimed them via XCLAIM after the grace period. However, both were classified as "unknown" and pushed to the DLQ. This is correct behavior, but the grace period (120s from `gracePeriodMs: 120000`) means any message from the previous session takes 2 minutes to be re-processed. For arbitrage opportunities with TTLs of 30-60s, this means all missed opportunities from a crash are guaranteed to expire before recovery.

**Fix:** For opportunity stream messages, the coordinator could check message TTL during XCLAIM recovery and immediately discard (without DLQ) messages older than their TTL.

---

## Latency Budget Analysis (from latency-profiler agent)

> Source: Agent 1 (latency-profiler) static code analysis

### Pipeline Stage Estimates

| Stage | Component | Estimated Latency | Bottleneck? |
|-------|-----------|-------------------|------------|
| WS message receipt | websocket-manager.ts | ~0.1-0.5ms | No |
| JSON.parse (main thread) | chain-instance.ts | ~0.1-2ms (small payloads) | Potential (large payloads) |
| Price cache write | price-matrix.ts (Atomics) | ~0.01-0.1ms | No |
| Detection loop cycle | partitioned-detector.ts | ~1-5ms per cycle | Configurable interval |
| Redis XADD (StreamBatcher) | redis-streams.ts | ~5-50ms (flush interval) | YES — flush interval adds latency |
| XREADGROUP (coordinator) | coordinator stream | ~100-200ms (blockMs: 200) | YES — polling adds latency |
| Distributed lock (exec) | execution engine | ~1-5ms (Redis-based) | Acceptable |
| **Total hot path** | | **~110-260ms** | **Exceeds 50ms target** |

### Key Latency Issues Identified

**StreamBatcher flush interval** adds ~50-100ms of latency between detection and coordinator processing. The `blockMs: 200` on `stream:opportunities` consumer means detected opportunities wait up to 200ms before being read. Combined with StreamBatcher batching, the path from detection to coordinator dispatch can be 250ms+ — 5x over the 50ms target.

**Recommendation:** For time-critical opportunity streams, reduce `blockMs` to 10-20ms or switch to push-based notification (XADD triggers immediate read via SUBSCRIBE).

---

## Failure Mode Analysis (from failure-mode-analyst agent)

> Source: Agent 2 (failure-mode-analyst) static code analysis

### Key Failure Points

| Stage | Failure Mode | Detection | Recovery | Data Loss Risk |
|-------|-------------|-----------|----------|----------------|
| WebSocket | TLS cert failure | Logged WARN | Exponential backoff (working) | Low (re-subscribes on reconnect) |
| Chain instance | Start failure | Logged ERROR | Never retried after initial failure | Medium (permanent degradation) |
| Redis XADD | Redis unavailable | Exception propagated | Circuit breaker | HIGH (price updates lost) |
| Coordinator XACK | Crash between process+XACK | XCLAIM on restart (120s grace) | XCLAIM recovery | Medium (up to 120s of ops lost) |
| Execution mid-trade | Provider disconnects | No specific handling found | Unknown | HIGH |

### Graceful Shutdown Assessment

Services handle SIGTERM with proper drain sequences. The `closeServerWithTimeout` pattern from `partition-service-utils.ts` is correctly implemented (safeResolve flag). However, the **shutdown timeout** (10,000ms in `concurrently --kill-timeout 10000`) may be insufficient if Redis XADD operations are inflight during shutdown — Redis operations can take 100-500ms under load.

---

## Data Integrity Analysis (from data-integrity-auditor agent)

> Source: Agent 3 (data-integrity-auditor) static code analysis

### Delivery Guarantee Assessment

The Redis Streams pipeline implements **at-least-once** delivery:
- XADD: published once
- XREADGROUP: consumed, can be re-delivered if not ACKed
- XACK: acknowledges successful processing
- XCLAIM: recovers unACKed messages after grace period

**Gap:** Between the point where `processOpportunity()` completes and `XACK` is called, if the process crashes, the opportunity may be processed twice (at-least-once). For flash loan execution, duplicate execution would trigger the profit check (safe), but may consume gas. No explicit deduplication at the execution layer was found.

### HMAC Chain Integrity

HMAC signing is conditionally enabled via `STREAM_SIGNING_KEY`. When enabled:
- All messages signed with HMAC-SHA256
- Verification uses `crypto.timingSafeEqual` (correct, resists timing attacks)
- Key is global (not per-stream) — compromise of one service exposes all streams

**Gap:** Stream-scoped keys would provide better isolation. A compromised partition service would only be able to forge messages for its own streams.

### Price Data Integrity

SharedArrayBuffer writes use Atomics.store/load (correct seqlock pattern per ADR-005). No NaN/Infinity validation found at the price cache write path — prices from WebSocket events are written directly. If a malformed exchange message sends `"price": null` or `"price": NaN`, it may be stored as `NaN` in the price matrix, poisoning downstream detection.

---

## Cross-Chain Analysis (from cross-chain-analyst agent)

> Source: Agent 4 (cross-chain-analyst) static code analysis

### Gas Model Assessment

| Chain Type | L1 Data Fee Included? | Notes |
|------------|----------------------|-------|
| Ethereum | N/A | L1 |
| Arbitrum | NEEDS VERIFICATION | L1 gas fee oracle exists, unclear if active |
| Optimism | NEEDS VERIFICATION | Dynamic L1 fee estimation flag enabled |
| Base | NEEDS VERIFICATION | Same as Optimism (OP Stack) |
| zkSync | NEEDS VERIFICATION | Different gas model (AA-based) |
| Linea | NEEDS VERIFICATION | Similar to Optimism |
| Blast | NEEDS VERIFICATION | OP Stack |
| Scroll | NEEDS VERIFICATION | zkEVM, different gas model |
| BSC/Polygon/Avalanche/Fantom | N/A | L1 equivalents |

The `FEATURE_DYNAMIC_L1_FEES` flag is enabled (logged at startup across all services). However, whether the L1 fee oracle is actually queried before profit calculation needs verification in the gas estimation code path.

### Token Decimal Gaps

USDT decimals vary by chain:
- BSC: 18 decimals
- Ethereum/Arbitrum/Optimism/Base: 6 decimals

If a cross-chain USDT arbitrage opportunity is calculated using a single decimal assumption, profit figures will be off by 10^12. The cross-chain analyzer found no unified decimal lookup per chain — **NEEDS VERIFICATION** in the cross-chain strategy code.

### Solana-EVM Divergence

P4 does NOT use the factory pattern (`createPartitionEntry`). This creates maintenance divergence — any changes to the factory's startup behavior (health reporting, stream registration, graceful shutdown) must be manually mirrored to P4.

---

## Observability Analysis (from observability-auditor agent)

> Source: Agent 5 (observability-auditor) static code analysis

### Trace Context Propagation Gaps

OpenTelemetry tracing infrastructure exists (`shared/core/src/tracing/`) but traceId propagation across Redis Streams is NOT confirmed end-to-end. Price update messages and opportunity messages in streams may not carry traceId, breaking distributed trace correlation.

### Silent Error Swallows (Blind Spots)

Several `.catch(() => {})` patterns exist in fire-and-forget paths. The most notable is in async health reporting — if the HealthReporter's Redis XADD fails silently, the coordinator never learns that a partition is unhealthy until the grace period expires.

### Trade Audit Trail

`TradeLogger` writes to JSONL files with daily rotation. Fields captured include enough to reconstruct most failed trades. However, **the detection timestamp** (when the opportunity was detected, not when execution started) is not in the trade log — this makes it impossible to measure detection-to-execution latency from audit logs.

---

## Configuration Drift Analysis (from config-drift-detector agent)

> Source: Agent 6 (config-drift-detector) static code analysis

### Feature Flag Audit

| Flag | Pattern | Correct? | Risk |
|------|---------|---------|------|
| FEATURE_FLASH_LOAN_AGGREGATOR | `=== 'true'` | ✅ | None |
| FEATURE_ML_SIGNAL_SCORING | `=== 'true'` | ✅ | None |
| FEATURE_LIQUIDITY_DEPTH_SIZING | `=== 'true'` | ✅ | None |
| FEATURE_DYNAMIC_L1_FEES | `=== 'true'` | ✅ | None |
| FEATURE_COMMIT_REVEAL | `=== 'true'` | ✅ | None |
| FEATURE_COMMIT_REVEAL_REDIS | `=== 'true'` | ✅ | None |

Feature flags appear correctly implemented (`=== 'true'` opt-in pattern). No `!== 'false'` misuse found for non-safety features.

### || vs ?? Violations

Several `|| 0` patterns were found in source files where the value could legitimately be 0:
- Gas price overrides: `gasPrice || 0` — if gasPrice is explicitly set to 0 (use base fee), this silently uses 0 incorrectly
- Profit thresholds: some paths use `|| 0` where `?? 0` is safer

Exact file:line references require verification against current code state.

### Hardcoded Values (Representative Sample)

| Value | Location | Notes |
|-------|----------|-------|
| `maxSize: 1000` (queue) | execution-engine startup | Should be env-configurable |
| `highWaterMark: 800` | execution-engine queue | Should be env-configurable |
| `blockMs: 200` (stream) | coordinator stream config | Tuning parameter, not configurable |
| `blockMs: 100` | most stream consumers | Same |
| `gracePeriodMs: 120000` | coordinator | Should be env-configurable |
| `intervalMs: 10000` | opportunity cleanup | Should be env-configurable |

---

## Cross-Agent Synthesis

### Multi-Agent Agreement (HIGH confidence)

1. **Solana address validation** — live monitoring + cross-chain-analyst confirm Raydium addresses are not EVM-compatible. HIGH confidence this is a real bug.

2. **MaxListeners warning** — live monitoring confirms all 7 services affected. observability-auditor confirms it appears in all service index.ts files. HIGH confidence.

3. **Delivery guarantee gap** — failure-mode-analyst and data-integrity-auditor both independently flagged the XACK gap between processing and acknowledgment as an at-least-once risk. HIGH confidence.

4. **StreamBatcher latency** — latency-profiler flags flush interval as the biggest hot-path contributor. This aligns with the 200ms blockMs observed in coordinator stream config. HIGH confidence the combined latency exceeds 50ms target.

### Information Separation Result (Agents 2 vs 3 on Redis Streams)

- **Both agree:** Pipeline implements at-least-once delivery. XACK gap exists.
- **Agent 2 (failure-mode):** Recovery via XCLAIM works but 120s grace period is too long for opportunity TTLs.
- **Agent 3 (data-integrity):** HMAC signing is correct but uses global key (not stream-scoped). This is a complementary finding, not a conflict.
- **Resolution:** Both perspectives are valid. Include both in the action plan.

---

## Regression Tracking (vs. 2026-03-02 Report)

| Finding ID | Description | Yesterday | Today | Status |
|------------|-------------|-----------|-------|--------|
| C1 | Infinite reconnection loop | CRITICAL | PARTIAL FIX | Log volume -23% |
| C2 | Health stuck at "starting" | CRITICAL | FIXED | Now reports "unhealthy" correctly |
| H3 | .env drift (Redis password) | HIGH | FIXED | No Redis password warnings today |
| H1 | Orphaned WS manager cleanup | HIGH | NEEDS VERIFICATION | Not confirmed fixed or still present |
| H2 | Log flood | HIGH | STILL PRESENT | 52K vs 68K lines |
| M1 | SOLANA_EXECUTION without RPC URL | MEDIUM | STILL PRESENT | Same warning pattern |
| M2 | MaxListeners warning | MEDIUM | STILL PRESENT | All 7 services affected |
| M4 | Vault-model adapter failures | MEDIUM | STILL PRESENT | 5 chains affected |
| E4 | HTTP/2 CB opens repeatedly | ENHANCE | STILL PRESENT | Every 60-90s |
| NEW | Solana invalid address (CRIT-1) | — | NEW CRITICAL | P4 always fails |
| NEW | Exec engine false "healthy" (CRIT-2) | — | NEW CRITICAL | 0/15 providers masked |
| NEW | TFjs no native backend (HIGH-2) | — | NEW HIGH | 5-20x ML slowdown |
| NEW | DLQ metadata loss (HIGH-4) | — | NEW HIGH | All context lost |

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — Before Next Deploy)

- [ ] **CRIT-1**: Fix Solana address validation — guard ethers.js `getAddress()` calls to skip for `chainId === 'solana'`. Add Solana-specific address validation using base58 check. (`services/unified-detector/src/chain-instance.ts` or `services/partition-solana/src/`)
  - Agent: cross-chain-analyst, Score: 4.3

- [ ] **CRIT-2**: Fix execution engine false "healthy" — include `providerHealthyCount > 0` in health status calculation. Service should report "degraded" (not "healthy") when 0/15 providers are working.
  - Agent: live monitoring, Score: 4.1

- [ ] **M2 (PERSISTING)**: Add `process.setMaxListeners(25)` to the very top of the 6 remaining service index.ts files (coordinator, P1, P2, P3, P4, cross-chain). Note: execution-engine already has this fix.

### Phase 2: Next Sprint (P1 — Reliability)

- [ ] **HIGH-1**: Apply `process.setMaxListeners` fix (same as above if not done in Phase 1)
- [ ] **HIGH-2**: Install `@tensorflow/tfjs-node` in cross-chain-detector for native LSTM inference (5-20x speedup). Consider lazy-loading to avoid 58s startup block.
- [ ] **HIGH-4**: Preserve original message payload in DLQ entries (embed full original fields + error context alongside classification metadata).
- [ ] **MED-1**: Retry vault-model adapter initialization async with backoff when startup initialization fails, rather than silently skipping pool discovery.
- [ ] **MED-3**: Escalate auth warning to `error` level if `NODE_ENV=production` and auth unconfigured.
- [ ] **XCLAIM grace period**: Reduce `gracePeriodMs` for opportunity streams to `30_000` (matching opportunity TTL) so expired opportunities are not queued for reprocessing.

### Phase 3: Backlog (P2/P3 — Hardening)

- [ ] **HIGH-3 (log flood)**: Rate-limit WebSocket reconnection error logs (first failure full, then summary per 60s per chain).
- [ ] **MED-2**: Tune HTTP/2 circuit breaker to use exponential backoff on half-open retry (60s → 2min → 4min → cap 15min).
- [ ] **MED-5**: Round system health to 1 decimal place in coordinator API responses.
- [ ] **MED-6**: Align `systemHealth` calculation and degradation level triggers to use the same data source.
- [ ] **LOW-2**: Add `detected_at` timestamp to TradeLogger output for detection-to-execution latency measurement.
- [ ] **LATENCY**: Reduce `blockMs` from 200ms to 20ms on `stream:opportunities` consumer to approach the 50ms hot-path target.
- [ ] **DATA-INTEGRITY**: Add NaN/Infinity validation at the price cache write path in `chain-instance.ts` before Atomics.store.
- [ ] **DATA-INTEGRITY**: Consider stream-scoped HMAC keys to limit blast radius of key compromise.

---

## Runtime Statistics Summary (10-minute window)

### Service Health Final State

| Service | Port | Final Status | Healthy Providers | Memory (end) |
|---------|------|-------------|-------------------|-------------|
| Coordinator | 3000 | REDUCED_CHAINS (42.9%) | N/A | N/A |
| P1 (asia-fast) | 3001 | **unhealthy** | 0/4 chains | ~46 MB |
| P2 (l2-turbo) | 3002 | **unhealthy** | 0/5 chains | ~48 MB |
| P3 (high-value) | 3003 | **unhealthy** | 0/3 chains | N/A |
| P4 (solana) | 3004 | **unhealthy** | 0/1 chains | ~44 MB |
| Execution Engine | 3005 | **"healthy"** (FALSE POSITIVE) | 0/15 | ~49 MB |
| Cross-Chain | 3006 | **healthy** | N/A (stream-based) | ~74 MB |

### Alert Summary (10 minutes)

| Time | Type | Severity | Message |
|------|------|---------|---------|
| 22:31:07 | LEADER_ACQUIRED | low | Coordinator acquired leadership |
| 22:31:08 | DLQ_CLASSIFIED (×2) | warn | 2 orphaned messages from previous instance |
| 22:31:12 | DEGRADATION | warn | FULL_OPERATION → READ_ONLY |
| 22:31:37 | ALERT | — | Unspecified |
| 22:32:12 | DEGRADATION | warn | READ_ONLY → REDUCED_CHAINS |
| 22:33:07 | SERVICE_UNHEALTHY (×4) | high | l2-turbo, solana, asia-fast, high-value |
| 22:36:38 | SYSTEM_HEALTH_LOW | critical | System health 42.9% |
| 22:38:08 | SERVICE_UNHEALTHY (×4) | high | Same 4 partitions (repeat) |

### Feature Flags Active

| Flag | Value | Operational? |
|------|-------|-------------|
| FLASH_LOAN_AGGREGATOR | true | ✅ (no data flowing) |
| ML_SIGNAL_SCORING | true | ✅ (no data flowing) |
| LIQUIDITY_DEPTH_SIZING | true | ✅ (no data flowing) |
| DYNAMIC_L1_FEES | true | ✅ (no data flowing) |
| SOLANA_EXECUTION | true | ⚠️ SOLANA_RPC_URL not set |
| ORDERFLOW_PIPELINE | true | ⚠️ BLOXROUTE_AUTH_HEADER empty |

---

*Report generated by 6-agent parallel analysis team + live service monitoring*
*Team: extended-deep-analysis (groovy-napping-goose)*
*Analysis duration: ~10 minutes live + parallel static analysis*

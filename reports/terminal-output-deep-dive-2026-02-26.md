# Terminal Output Deep-Dive Analysis Report

**Date:** 2026-02-26  
**Scope:** All services under `data/terminal/` — Coordinator, Partition P1 (asia-fast), Partition P2 (l2-turbo), Cross-Chain Detector, Execution Engine  
**Supplementary data:** `data/dlq-fallback-*.jsonl`, `data/dlq-forwarding-fallback-*.jsonl`, `data/trades/trades-*.jsonl`

---

## Executive Summary

A ~6-minute local dev test run (22:12:37 → 22:18:15) revealed **18 distinct actionable issues** across the 5-service stack. The most impactful fall into three categories:

| Category | Count | Severity |
|---|---|---|
| **Reliability & Resilience** | 7 | 🔴 Critical / High |
| **Performance & Resource** | 5 | 🟡 Medium |
| **Observability & Ops** | 6 | 🟢 Low–Medium |

The system successfully bootstraps, connects WebSockets to 9 chains, discovers new DEX pairs, and maintains simulated trade execution — but **Redis connection brittleness**, **WebSocket provider auth failures**, and **coordinator health oscillation** each represent real production risks that need addressing.

---

## 1. Cross-Cutting Issues (All Services)

### 1.1 🔴 EventEmitter Memory Leak Warning

**Evidence:** Every single service prints:
```
MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 exit listeners added to [process]. MaxListeners is 10.
```

**Root Cause:** Multiple modules (dotenv, tsconfig-paths, redis, ws, etc.) each register `process.on('exit')` handlers. With 5+ modules loaded via `-r`, the default limit of 10 is exceeded.

**Impact:** In a long-running production process, genuine memory leaks may go unnoticed because this warning is already noisy.

**Enhancement:**
```typescript
// services/shared/bootstrap.ts (or each index.ts entry point)
process.setMaxListeners(20); // Set before any module registration
```
Alternatively, audit which modules register exit handlers and consolidate shutdown logic into a single handler.

---

### 1.2 🔴 Redis Shutdown Cascade — EPIPE + ECONNREFUSED

**Evidence (identical across all 5 services at 22:18:14–22:18:15):**
```
Redis main client closed → connected → ERROR write EPIPE → closed
→ connected → closed → ERROR ECONNREFUSED 127.0.0.1:6379
Redis Streams client connected → ERROR (empty) → connection failed after 3 retries
```

**Root Cause:** Redis was killed (docker-compose down?) while services were still running. The ioredis client tries to reconnect, gets EPIPE (pipe broken mid-write), then ECONNREFUSED (server gone). The error messages for Redis Streams are empty strings — a bug in error serialization.

**Impact:** All 5 services crash-loop or hang when Redis goes down. The shutdown is not graceful — only the Coordinator and Execution Engine log a `SIGTERM` receipt.

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Graceful shutdown propagation** — All services should handle SIGTERM/SIGINT and drain connections before Redis teardown | 🔴 Critical |
| 2 | **Redis reconnection backoff** — Current retry limit is 3 with no visible backoff. Implement exponential backoff with jitter (e.g., 1s, 2s, 4s, 8s, max 30s) | 🔴 Critical |
| 3 | **Fix empty error string serialization** — `error: ""` in Redis Streams errors loses diagnostic info | 🟡 Medium |
| 4 | **Redis health check probe** — Add a `PING` probe before attempting writes to detect dead connections early | 🟡 Medium |

---

### 1.3 🟡 Commit-Reveal MEV Protection Disabled

**Evidence (all services):**
```
⚠️ WARNING: Commit-Reveal MEV Protection DISABLED
```

**Assessment:** This is by design for dev (no deployed contracts), but the warning is printed by **every** service, including partitions and cross-chain detector which don't directly execute transactions.

**Enhancement:** Only emit this warning from the Execution Engine service, or guard it behind a check:
```typescript
if (serviceRole === 'execution-engine') {
  logger.warn('Commit-Reveal MEV Protection DISABLED...');
}
```

---

## 2. Coordinator Service Analysis

### 2.1 🔴 Health Degradation Oscillation (State Machine Thrashing)

**Evidence — 8 degradation level changes in ~6 minutes:**

| Time | From | To | System Health |
|---|---|---|---|
| 22:12:42 | FULL_OPERATION | COMPLETE_OUTAGE | 0% |
| 22:12:57 | COMPLETE_OUTAGE | READ_ONLY | 100% |
| 22:13:17 | READ_ONLY | COMPLETE_OUTAGE | 0% |
| 22:15:52 | COMPLETE_OUTAGE | DETECTION_ONLY | 50% |
| 22:16:27 | DETECTION_ONLY | COMPLETE_OUTAGE | 0% |
| 22:16:57 | COMPLETE_OUTAGE | DETECTION_ONLY | 33% |
| 22:17:37 | DETECTION_ONLY | READ_ONLY | 33% |
| 22:17:42 | READ_ONLY | COMPLETE_OUTAGE | 0% |
| 22:17:47 | COMPLETE_OUTAGE | DETECTION_ONLY | 33% |

**Analysis:** The coordinator is flapping between states because:
1. Partitions P1 and P2 take 59s–80s to start and register health
2. The coordinator's 30s heartbeat threshold (`thresholdMs: 30000`) is too aggressive for startup
3. Health goes to 100% momentarily (one heartbeat), then back to 0% as the heartbeat goes stale again
4. Neither executor nor detectors are registered during the initial period

**Impact:** In production, this would trigger a flood of Pager/Discord alerts and potentially disable execution during the critical first minutes after deploy.

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Increase startup grace period** — Current `gracePeriodMs: 60000` is too short. Set to `120000` (2min) or detect "first heartbeat received" per-service | 🔴 Critical |
| 2 | **Add state transition hysteresis** — Require that a degraded state persists for ≥2 consecutive checks (30s) before transitioning, to prevent flapping | 🔴 Critical |
| 3 | **Distinguish "not yet started" from "crashed"** — A service that has never heartbeated is different from one whose heartbeat went stale | 🟡 Medium |
| 4 | **Suppress alerts during grace period** — `SYSTEM_HEALTH_LOW` (critical) fires at 22:13:37, barely 60s after startup | 🟡 Medium |

---

### 2.2 🟡 Repetitive Stale Heartbeat Warnings

**Evidence:** 15 separate "Service heartbeat stale" warnings, each with `ageMs` growing linearly (30s, 35s, 40s, 50s, 60s … 230s).

**Analysis:** These are emitted every 5-10 seconds for the **same** stale service — a polling loop that should instead escalate or aggregate.

**Enhancement:**
- Log the first stale heartbeat as WARN
- Subsequent stale checks for the same service: log at DEBUG only
- Escalate to ERROR if `ageMs > 120000` (2min)
- Aggregate: "Service X heartbeat stale for 230s (was 30s threshold)" instead of 15 separate lines

---

### 2.3 🟡 Alert Duplication — "Alert triggered" + "Alert triggered (no notification channels)"

**Evidence:**
```
WARN (coordinator): Alert triggered
    type: "LEADER_ACQUIRED"
WARN (coordinator): Alert triggered (no notification channels)
    type: "LEADER_ACQUIRED"
```

Every alert is logged **twice** — once when it fires and once when delivery fails. This doubles log volume unnecessarily.

**Enhancement:** Merge into a single log line:
```
WARN: Alert triggered: LEADER_ACQUIRED (delivery skipped: no notification channels configured)
```

---

### 2.4 🟡 Security Warnings — No Auth on API & Alerts

**Evidence:**
```
WARN: No alert notification channels configured
WARN: API authentication NOT configured - endpoints are unprotected
```

**Assessment:** Expected for dev, but these should be `ERROR` level in production. Add an environment check:
```typescript
if (process.env.NODE_ENV === 'production' && !config.jwtSecret) {
  logger.error('API authentication NOT configured - REFUSING TO START in production');
  process.exit(1);
}
```

---

## 3. Partition P1 (asia-fast) Analysis

### 3.1 🔴 WebSocket Provider Auth Failure — Ankr 401

**Evidence:**
```
[22:16:43] WebSocket closed (polygon, code 1006)
→ Fallback to Ankr: wss://rpc.ankr.com/polygon/fd86c2...
[22:16:49] ERROR: Unexpected server response: 401
→ Fallback to DRPC: wss://lb.drpc.org/ogws?network=polygon
[22:16:54] WebSocket connected (168ms)
```

**Analysis:**
- The **Ankr WebSocket URL** includes an API key (`fd86c2f5d5ff...`) that returns **401 Unauthorized**
- This wastes ~6 seconds per reconnection attempt (5.7s backoff + connection attempt)
- The provider-rotation system correctly falls back to DRPC, but the broken Ankr URL remains in the candidate pool
- **The same Ankr 401 issue occurs on P2 for Scroll** — this is a systemic credential problem

**Impact:** Every WebSocket disconnect adds 6s of unnecessary reconnection time before a working provider is reached.

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Validate Ankr API key** — The key `fd86c2f5d5ff...` is expired/invalid. Rotate or remove from `.env` | 🔴 Critical |
| 2 | **Provider health circuit breaker** — After 2 consecutive 401s, mark provider as "auth_failed" and skip it for 1 hour | 🔴 Critical |
| 3 | **Pre-flight validation** — At startup, test each WebSocket URL with a 5s timeout. Log broken URLs as ERROR and exclude from rotation pool | 🟡 Medium |
| 4 | **Reduce initial backoff for known-auth-error** — 401 errors should not use exponential backoff (they won't heal); skip immediately to next provider | 🟡 Medium |

---

### 3.2 🟡 Data Gap Detection — 5 Missed Blocks (Polygon)

**Evidence:**
```
[22:16:55] WARN: Data gap detected (polygon)
    lastKnownBlock: 83512087
    newBlockNumber: 83512093
    missedBlocks: 5
```

**Analysis:** During the ~12s WebSocket reconnection cycle (disconnect → Ankr 401 → DRPC reconnect), 5 Polygon blocks were missed. At Polygon's ~2s block time, this is expected.

**Enhancement:**
- After reconnection, **backfill missed blocks** by fetching `eth_getLogs` for blocks `lastKnownBlock+1` to `newBlockNumber`
- This ensures no swap events (and therefore no arbitrage opportunities) are lost during reconnections

---

### 3.3 🟢 Health Bind Address Warning

**Evidence:**
```
WARN: Health server bound to all interfaces without auth token (non-production)
    bindAddress: "0.0.0.0"
    hint: "Set HEALTH_AUTH_TOKEN or HEALTH_BIND_ADDRESS=127.0.0.1 for production"
```

**Assessment:** Good that this is already warned. For production, ensure the health endpoint is either authenticated or bound to localhost.

---

### 3.4 ℹ️ Shared Memory Allocation — 563MB per Partition

**Evidence:**
```
SharedKeyRegistry created: bufferSize: 590557956 (~563MB)
PriceMatrix initialized: maxPairs: 8388608, totalSlots: 9227468
```

**Analysis:** Each partition allocates ~563MB of SharedArrayBuffer for the PriceMatrix. With 2 partitions, that's **1.1GB** just for price storage. The actual pair count is only 1,350 (P1) + 1,489 (P2) = **2,839 pairs** — using **0.03%** of the 8.3M allocated capacity.

**Optimization:**
```typescript
// Dynamic sizing based on actual pair count + growth headroom
const maxPairs = Math.max(actualPairCount * 4, 16384); // 4x headroom, min 16K
```
This would reduce memory from 563MB to ~4MB per partition, saving **>1GB of RAM** system-wide.

---

## 4. Partition P2 (l2-turbo) Analysis

### 4.1 🔴 Scroll WebSocket Chronic Instability

**Evidence — 3 disconnections in 2 minutes:**

| Time | Event | Provider | Outcome |
|---|---|---|---|
| 22:14:19 | WS closed (1006) | DRPC | → Ankr (401 fail) → DRPC reconnect |
| 22:14:31 | Connected | DRPC | 7 missed blocks |
| 22:15:02 | WS closed (1006) | DRPC | → PublicNode |
| 22:15:08 | Connected | PublicNode | 10 missed blocks |

**Analysis:** Scroll chain has the least redundancy (4 URLs) and disconnects more frequently than any other chain. The provider-rotation system works but the **repeated cycling** suggests:
1. Free-tier rate limits are being hit
2. The Scroll WebSocket subscription volume is too high for free RPC providers

**Impact:** 17 blocks missed in 2 minutes = potential missed arbitrage opportunities on Scroll.

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Add dedicated Scroll RPC provider** — Upgrade to a paid Scroll-specific endpoint (Alchemy, Quicknode) | 🔴 Critical |
| 2 | **Implement missed-block backfill** — After reconnection, replay swap events from missed blocks | 🔴 Critical |
| 3 | **Add WebSocket keep-alive** — Send periodic `eth_chainId` pings to prevent idle disconnections | 🟡 Medium |

---

### 4.2 🟡 Blast & Scroll Using Legacy Subscription Mode

**Evidence:**
```
(chain:blast): Subscribed via legacy mode — pairs: 40
(chain:scroll): Subscribed via legacy mode — pairs: 84
```

While other chains use **factory event subscriptions** (reducing RPC calls by 45x–105x), Blast and Scroll use `legacy mode` which polls for swap events directly.

**Enhancement:** Implement factory event subscriptions for Blast and Scroll DEXes:
- Blast: Thruster, BladeSwap
- Scroll: Ambient, SkyDrome

---

### 4.3 ℹ️ Health Check Interval Inconsistency

| Partition | Health Check Interval |
|---|---|
| P1 (asia-fast) | 15,000ms |
| P2 (l2-turbo) | 10,000ms |

**Enhancement:** Standardize to `15000ms` or make configurable via `HEALTH_CHECK_INTERVAL_MS` env var.

---

## 5. Cross-Chain Detector Analysis

### 5.1 🟡 TensorFlow.js Performance Warning

**Evidence:**
```
Orthogonal initializer is being called on a matrix with more than 2000 (65536) elements: Slowness may result.
```
This appears **twice** — once for the tracker (65536 elements) and once for the ML predictor (16384 elements).

**Analysis:** The LSTM model uses orthogonal weight initialization with very large matrices. This is a one-time startup cost (~19 seconds from init to "warmed up") but indicates the model architecture may be oversized.

**Enhancement:**
- Reduce LSTM hidden dimensions if predictive accuracy allows
- Consider switching to `glorot_uniform` initialization which is O(n) instead of O(n²) for orthogonal
- Or install `@tensorflow/tfjs-node` native backend (the TF.js banner suggests this):
  ```
  npm install @tensorflow/tfjs-node
  ```
  This would speed up initialization by 10-50x.

---

### 5.2 🟡 CPU Usage Always 0%

**Evidence (all health checks):**
```
cpuUsage: 0
```

**Analysis:** The `cpuUsage` metric likely measures the _previous_ interval's usage via `process.cpuUsage()` but is not being properly delta-calculated. A service running TensorFlow certainly uses >0% CPU.

**Enhancement:** Fix the CPU measurement:
```typescript
let lastCpuUsage = process.cpuUsage();
let lastTime = Date.now();

function getCpuPercent(): number {
  const now = Date.now();
  const current = process.cpuUsage(lastCpuUsage);
  const elapsed = (now - lastTime) * 1000; // microseconds
  const percent = ((current.user + current.system) / elapsed) * 100;
  lastCpuUsage = process.cpuUsage();
  lastTime = now;
  return Math.round(percent * 100) / 100;
}
```

---

### 5.3 🟢 Memory Stable but High (368MB)

**Evidence:**
```
memoryUsage: 385,898,120 → 386,657,784 → 386,497,832 (steady ~368MB)
```

**Assessment:** Memory is stable (no leak) but the ~368MB baseline for a service that primarily receives price updates and runs ML inference is high. The TF.js model and whale tracker account for most of this.

---

## 6. Execution Engine Analysis

### 6.1 🟡 Simulation Mode — Zero Activity Loop

**Evidence (repeated 8 times every 30 seconds):**
```
Performance metrics: simulationsPerformed: 0, simulationsSkipped: 0
Health check: status: "not_configured"
Health check: status: "healthy"
```

**Analysis:**
- The execution engine is in **SIMULATION MODE** (`simulationMode: true`) — expected for dev
- It runs an idle metrics collection loop every 30s, producing all-zero metrics
- The **dual health check** (`not_configured` + `healthy`) is confusing — two different health probes running

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Suppress zero-activity metrics** — Skip logging when all counters are 0, or reduce interval to 60s in simulation mode | 🟡 Medium |
| 2 | **Fix dual health check** — The `not_configured` check appears to be the simulation service health (which doesn't exist), while `healthy` is the execution engine itself. Consolidate into one check | 🟡 Medium |

---

### 6.2 🟢 Capital Configuration Summary

| Parameter | Value | Assessment |
|---|---|---|
| Total Capital | 10 ETH | Reasonable for simulation |
| Kelly Multiplier | 0.5 (half-Kelly) | Conservative, good |
| Max Single Trade | 2% | Appropriate |
| Min EV Threshold | 0.005 ETH | ~$15 at current prices |
| Max Daily Loss | 5% | Standard |
| Caution Threshold | 3% | Good tiered approach |
| Circuit Breaker Failures | 5 | Before 5min cooldown |
| Execution Probability Default | 50% | Conservative starting point |

No changes recommended — these defaults are well-calibrated.

---

## 7. DLQ (Dead Letter Queue) Analysis

### 7.1 🔴 Persistent Orphaned PEL Messages

**File:** `dlq-fallback-2026-02-26.jsonl` — **43 entries**

All entries are identical:
```json
{
  "originalMessageId": "400-0",
  "originalStream": "stream:opportunities",
  "originalData": {"id": "opp-orphan"},
  "error": "Orphaned PEL message recovered via XCLAIM",
  "service": "coordinator",
  "instanceId": "test-coordinator"
}
```

**Analysis:** 
- A single orphaned message (`400-0` in `stream:opportunities`) is being repeatedly XCLAIMed across test runs
- The `instanceId: "test-coordinator"` indicates these come from **automated tests** that leave orphaned messages in Redis
- 43 entries in one day means the PEL recovery runs ~every 20 minutes and finds the same message each time

**Enhancement:**
- **Test cleanup** — Tests that write to Redis Streams must clean up consumer groups and pending entries in teardown
- **Dedup in DLQ** — If the same `originalMessageId` is already in the DLQ, skip re-adding it
- **Max attempts** — After 3 XCLAIM attempts for the same message, acknowledge and remove it

---

### 7.2 🔴 DLQ Forwarding Fallback — Massive Test Pollution

**File:** `dlq-forwarding-fallback-2026-02-26.jsonl` — **222 entries, 81KB**

Pattern analysis:

| Opportunity ID | Error | Frequency | Source |
|---|---|---|---|
| `opp-retry-exhaust` | Persistent failure | 43 entries | Test fixtures |
| `opp-dlq-1` | Network error | 43 entries | Test fixtures |
| `opp-dlq-fail` | Total failure | 43 entries | Test fixtures |
| `opp-no-alert` | fail | 43 entries | Test fixtures |
| `retry-fail` | Redis down | 50 entries | Production coordinator |

**Critical Finding:** 172/222 entries (77%) are generated by **test fixtures** (`instanceId: "test-coordinator"`) that persist in Redis between runs. Only the `retry-fail` entries from `instanceId: "coordinator"` are from actual runtime.

**Impact:** The DLQ files grow by ~81KB/day with test garbage, making it impossible to distinguish real failures from test artifacts.

**Enhancements:**

| # | Enhancement | Priority |
|---|---|---|
| 1 | **Isolate test Redis** — Tests should use a separate Redis database (e.g., `SELECT 1`) or prefix (`test:stream:`) | 🔴 Critical |
| 2 | **DLQ file rotation** — Implement max file size (10MB) with rotation to prevent unbounded growth | 🟡 Medium |
| 3 | **DLQ deduplication** — Don't write duplicate `opportunityId` entries within the same run | 🟡 Medium |
| 4 | **DLQ metrics** — Add a counter for DLQ entries per hour and alert if rate exceeds threshold | 🟢 Low |

---

## 8. Trade Log Analysis

**File:** `data/trades/trades-2026-02-26.jsonl` — **271KB**

All trades are simulated (`success: true`) with:
- **Strategy:** All `cross-dex` (uniswap_v3 → sushiswap)
- **Chain:** All Ethereum
- **Token pair:** WETH → USDC
- **Expected profit range:** 20–35 units
- **Actual profit range:** 18.8–28.8 units
- **Slippage:** 0.5% to 17.8%

**Key Observation:** Actual profit is consistently **10–18% below expected** profit. The simulation's `profitVariance: 0.2` (20%) accounts for this, but in production, this delta should be tracked as a calibration metric.

**Enhancement:**
- Track `(expectedProfit - actualProfit) / expectedProfit` as a rolling metric
- If this "profit erosion" exceeds 15% consistently, the price oracle data may be stale

---

## 9. Optimization Recommendations Summary

### Immediate Actions (Before Next Test Run)

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | Fix Ankr WebSocket API key (expired/invalid 401 on polygon, scroll) | 10 min | 🔴 Eliminates 6s reconnect penalty |
| 2 | Set `process.setMaxListeners(20)` in bootstrap | 5 min | 🟢 Cleans up noisy startup |
| 3 | Increase coordinator grace period to 120s | 5 min | 🔴 Eliminates startup flapping |

### Short-Term (1–2 Days)

| # | Action | Effort | Impact |
|---|---|---|---|
| 4 | Add state transition hysteresis to coordinator | 2h | 🔴 Prevents alert storms |
| 5 | Implement 401-aware provider circuit breaker | 3h | 🔴 Faster WebSocket recovery |
| 6 | Fix CPU usage metric (always reads 0%) | 1h | 🟡 Accurate monitoring |
| 7 | Reduce PriceMatrix allocation (563MB → 4MB) | 2h | 🟡 Saves >1GB RAM |
| 8 | Isolate test Redis namespace from production | 2h | 🔴 Clean DLQ data |

### Medium-Term (1–2 Weeks)

| # | Action | Effort | Impact |
|---|---|---|---|
| 9 | Add missed-block backfill after WebSocket reconnection | 4h | 🔴 No missed opportunities |
| 10 | Install `@tensorflow/tfjs-node` native backend | 1h | 🟡 10x faster ML model init |
| 11 | Implement factory subscriptions for Blast/Scroll | 8h | 🟡 45x RPC reduction |
| 12 | Add Redis PING health probe before writes | 2h | 🟡 Prevent EPIPE errors |
| 13 | Consolidate duplicate health checks in execution engine | 2h | 🟢 Cleaner logs |
| 14 | Aggregate heartbeat-stale warnings | 1h | 🟢 Reduces log noise 15x |

---

## 10. Architecture Observations

### What's Working Well ✅

1. **Provider rotation** — Budget-aware scoring correctly selects fallback WebSocket URLs
2. **Factory event subscriptions** — 45x–105x RPC reduction on supported chains
3. **Graceful degradation** — Chain capabilities registered correctly, per-chain status tracking works
4. **Capital risk management** — Kelly criterion, drawdown circuit breakers, position sizing — all well-configured
5. **Redis Streams architecture** — Consumer groups, stream health monitoring, distributed locks — solid design
6. **New pair discovery** — Factory events correctly detect new DEX pairs in real-time (4 discovered in 6 min)

### What Needs Attention ⚠️

1. **Coordinator is the single point of failure** — No standby coordinator was active during this run
2. **No execution happened** — Despite detector services running and discovering pairs, no opportunities reached the execution engine. The pipeline `detector → coordinator → execution` may have a gap.
3. **Memory allocation is extreme** — 563MB × 2 partitions + 368MB cross-chain + 414MB execution = **~1.9GB** for a dev test
4. **Log verbosity** — The 6-minute run produced 1,860 lines across 5 services. In production (24h), this would be ~450K lines/day without any actual trades.

---

## Appendix A: Service Startup Timeline

```
22:12:37  Coordinator started (port 3000)
22:13:36  Partition P1 (asia-fast) starting (4 chains, port 3001)
22:13:37  P1 fully connected — bsc(360), polygon(180), avalanche(630), fantom(180) = 1,350 pairs
22:13:54  Partition P2 (l2-turbo) starting (5 chains, port 3002)
22:13:56  P2 fully connected — arbitrum(780), optimism(225), base(360), blast(40), scroll(84) = 1,489 pairs
22:14:16  Cross-Chain Detector started (port 3006)
22:14:24  Execution Engine started (port 3005, simulation mode)
22:14:35  ML predictor (LSTM) warmed up
22:18:14  Redis connection lost — all services enter error state
22:18:15  Stack shutdown
```

**Total startup time:** ~2 minutes (coordinator first, all services healthy by 22:14:35)
**Total monitored pairs:** 2,839 across 9 chains

## Appendix B: Chain Coverage Matrix

| Chain | Partition | Pairs | DEXes | Mode | WebSocket URLs |
|---|---|---|---|---|---|
| BSC | P1 (asia-fast) | 360 | PancakeSwap V2/V3, ThenaFi, Curve | Factory | 5 |
| Polygon | P1 (asia-fast) | 180 | QuickSwap V3, UniSwap V3, SushiSwap | Factory | 7 |
| Avalanche | P1 (asia-fast) | 630 | TraderJoe LB, Pangolin, UniSwap V3 | Factory | 7 |
| Fantom | P1 (asia-fast) | 180 | SpookySwap, SpiritSwap, Beethoven X | Factory | 6 |
| Arbitrum | P2 (l2-turbo) | 780 | UniSwap V2/V3, Camelot, SushiSwap, Curve, Ramses, Balancer | Factory | 7 |
| Optimism | P2 (l2-turbo) | 225 | UniSwap V3, Velodrome, Curve | Factory | 7 |
| Base | P2 (l2-turbo) | 360 | UniSwap V3, Aerodrome, BaseSwap | Factory | 6 |
| Scroll | P2 (l2-turbo) | 84 | — | Legacy | 4 |
| Blast | P2 (l2-turbo) | 40 | — | Legacy | 4 |

---

*Report generated from terminal output captured during dev test run on 2026-02-26 at 22:12–22:18 UTC+1*

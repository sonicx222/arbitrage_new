# Runtime Monitoring Deep-Dive Report

**Date:** 2026-03-02
**Duration:** ~10 minutes full-stack monitoring
**Environment:** Windows 11, Node 22, In-memory Redis, 7 services (coordinator, P1-P4, execution-engine, cross-chain-detector)
**Total log lines captured:** 67,961

---

## Executive Summary

All 7 services started successfully but **0 of 14 EVM chains connected** due to TLS certificate issues in the corporate environment. The system's graceful degradation worked as designed, but several critical bugs were uncovered in the reconnection logic, health reporting, and configuration management. The system generated **~68K log lines in ~10 minutes** (~6,800 lines/min), with 95% being repetitive error/retry spam from the WebSocket reconnection loop bug.

### Severity Distribution

| Severity | Count | Description |
|----------|-------|-------------|
| **CRITICAL** | 2 | Infinite reconnection loop, health status permanently stuck |
| **HIGH** | 3 | Resource leak from orphaned WS managers, log flood, config drift |
| **MEDIUM** | 4 | Feature flag mismatches, MaxListeners warning, provider config gaps |
| **LOW** | 3 | Redis password warning, punycode deprecation, cosmetic issues |
| **Enhancement** | 5 | Startup optimization, observability, degradation improvements |

---

## CRITICAL Findings

### C1. Infinite WebSocket Reconnection Loop (Double Reconnection System)

**Severity:** CRITICAL
**Services affected:** P1 (asia-fast), P2 (l2-turbo), P3 (high-value)
**Evidence:** `attempt: 58, maxAttempts: 5` in chain-level logs

**Root cause:** Two independent reconnection systems operate at different layers without coordination:

1. **WebSocketManager** (`shared/core/src/websocket-manager.ts`): Has its own counter (`reconnectAttempts`), max=10, with 60-second slow recovery that resets the counter and switches URLs.
2. **ChainDetectorInstance** (`services/unified-detector/src/chain-instance.ts`): Has its own counter (`reconnectAttempts`), max=5, with 5-minute slow recovery.

The chain-level `handleConnectionError()` (line 1019) increments on **every error callback** from the WebSocket manager — including each of its 10 reconnect attempts + the "max reached" error. This means:
- Per WS manager cycle: chain counter receives ~11 error callbacks
- WS manager resets every 60 seconds and fires another 11 errors
- Chain counter reaches 58+ in ~5 minutes

**Impact:**
- ~6,200 lines/min of error log spam (95% of all output)
- CPU/memory waste from continuous failed TLS handshakes
- Obscures real issues in log noise
- P2 (l2-turbo, 7 chains) generated 17,858 lines — nearly half the total output

**Key files:**
- `shared/core/src/websocket-manager.ts` lines 1499-1599 (scheduleReconnection)
- `services/unified-detector/src/chain-instance.ts` lines 1018-1037 (handleConnectionError)
- `services/unified-detector/src/subscription/subscription-manager.ts` lines 253-256 (error wiring)

**Fix approach:** The chain-level error handler should not re-count errors from the WS manager's internal retries. Either:
- (A) Deduplicate: only increment chain counter on "Max reconnect attempts reached" errors (not every individual attempt)
- (B) Consolidate: remove the chain-level reconnection system entirely and let the WS manager handle all reconnection logic
- (C) Coordinate: share a reconnection state object between the two layers

---

### C2. Health Status Permanently Stuck at "starting" After All Chains Fail

**Severity:** CRITICAL
**Services affected:** All 4 partitions (P1-P4)
**Evidence:** Health endpoint showed `"status": "starting"` after 10+ minutes of uptime

**Root cause:** When chains fail to start, `chainInstances.delete(chainId)` is called (chain-instance-manager.ts lines 265 and 272), removing the failed chain from the map. The `getChains()` method (line 388) returns `Array.from(chainInstances.keys())`, which becomes empty.

In `unified-detector.ts` line 547-549:
```typescript
if (totalChains === 0) {
  status = 'starting';  // Permanently stuck here when all chains fail
```

The health endpoint reports:
```json
{"status": "starting", "chains": [], "healthyChains": [], "uptime": 664}
```

This is misleading — 10+ minutes of uptime with "starting" status masks a total chain failure. The partition attempted 4 chains, all failed, but the health endpoint says 0 chains exist.

**Impact:**
- Health monitoring systems cannot distinguish "still starting up" from "all chains failed"
- Automated alerting based on "starting" → "healthy" transitions will never fire
- Manual operators see "starting" and assume the service needs more time

**Fix approach:** Do not delete failed chain instances from the map. Instead, keep them with an `error` status so health reports show `"0/4 chains healthy"` rather than `"0/0 (starting)"`.

---

## HIGH Findings

### H1. Resource Leak from Orphaned WebSocketManager Instances

**Severity:** HIGH
**File:** `services/unified-detector/src/chain-instance.ts` lines 1110-1112

When the chain instance's slow recovery creates a new WebSocketManager, the old one is only `removeAllListeners()`-ed, but `disconnect()` is never called. This means:
- The old WebSocketManager's `recoveryTimer` (60s setTimeout) may still fire
- Old WebSocket objects are not properly closed
- Event handler closures retain references, preventing GC
- Each recovery cycle creates a new WebSocketManager, accumulating orphans

**Evidence:** Memory growth of ~10% in P2 (l2-turbo) over 10 minutes (44→49 MB). While modest in absolute terms, this will accumulate over hours/days of operation.

---

### H2. Excessive Log Volume from Reconnection Spam

**Severity:** HIGH
**Impact:** 67,961 lines in ~10 minutes = ~6,800 lines/min

| Service | Lines | % of Total | Errors |
|---------|-------|------------|--------|
| P2 (l2-turbo) | 17,858 | 26% | 1,402 |
| P3 (high-value) | 11,096 | 16% | 869 |
| P1 (asia-fast) | 5,931 | 9% | 459 |
| exec | 1,275 | 2% | 136 |
| P4 (solana) | 325 | 0.5% | 5 |
| coord | 232 | 0.3% | 0 |
| cross | 126 | 0.2% | 0 |

The log volume is proportional to chain count: P2 has 7 chains, P3 has 3, P1 has 4. Each chain generates ~10 error log entries per WebSocket reconnection cycle.

**Impact in production:** At this rate, disk-based logging would consume ~10 GB/day. Log aggregation services (Datadog, CloudWatch) would incur significant cost.

**Fix approach:** Rate-limit reconnection error logging (e.g., log first failure, then summary every 60s). Also fix C1 to reduce the reconnection attempts themselves.

---

### H3. `.env` Configuration Drift from `.env.example`

**Severity:** HIGH
**File:** `.env` line 24 vs `.env.example` lines 29-33

The `.env` file uses `REDIS_URL=redis://:localdev@localhost:6379` (with password), but the `.env.example` was updated to `REDIS_URL=redis://localhost:6379` (without password) as part of a P2-3 fix. The in-memory Redis server has no `--requirepass` flag.

**Evidence:** "This Redis server's `default` user does not require a password, but a password was supplied" appears in logs for all 7 services (2-3 times each = ~18 warnings).

**Additional drifts found:**
- `FEATURE_SOLANA_EXECUTION=true` but `SOLANA_RPC_URL` is commented out
- `FEATURE_ORDERFLOW_PIPELINE=true` but `BLOXROUTE_AUTH_HEADER` is empty
- `NODE_OPTIONS=--disable-warning=DEP0040` is documented in `.env.example` but not active in `.env`

---

## MEDIUM Findings

### M1. Feature Flag Mismatch: SOLANA_EXECUTION Enabled Without RPC URL

**Severity:** MEDIUM
**Evidence:** All 7 services log "FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set"

`validateFeatureFlags()` in `shared/config/src/feature-flags.ts` line 744-758 only warns, but does NOT hard-fail in production. This is inconsistent with the KMS signing validation (line 733) which throws. The Solana execution strategy silently degrades.

---

### M2. MaxListenersExceededWarning in All 7 Services

**Severity:** MEDIUM
**Evidence:** `Possible EventEmitter memory leak detected. 11 exit listeners added to [process]`

The `process.setMaxListeners(25)` fix exists in the code but is called too late in the bootstrap sequence (inside `setupProcessHandlers()` or `setupServiceShutdown()`). By that point, Pino loggers have already added `process.on('exit')` handlers during module initialization. Only `execution-engine/src/index.ts` has the fix at the right location (line 17-20, before imports).

**Fix:** Add `process.setMaxListeners(25)` at the very top of each service's `index.ts`, before any imports. The other 6 services (coordinator, P1-P4, cross-chain) need this fix.

---

### M3. Unregistered Providers in Execution Engine Priority List

**Severity:** MEDIUM
**Evidence:** `Provider 'local' in priority but not registered` and `Provider 'tenderly' in priority but not registered`

The execution engine's provider priority configuration references providers (`local`, `tenderly`) that are not registered. This suggests a configuration drift between the provider priority list and the actual provider registration code.

---

### M4. Vault-Model Adapter Initialization Failures (Expected but Noisy)

**Severity:** MEDIUM (in dev), LOW (in production with valid RPC)
**Evidence:** beethoven_x, gmx, platypus, balancer_v2 adapters all fail to connect to provider

These adapters require live RPC calls to blockchain contracts (Balancer Vault, GMX Vault, Platypus Pool) during initialization. In the corporate environment with TLS issues, all fail. The fallback behavior is correct (non-fatal, other DEXes continue), but the error logging is noisy.

---

## LOW Findings

### L1. Redis Password Warning Spam

**Severity:** LOW
**Impact:** ~18 warning lines (2-3 per service)
**Fix:** Update `.env` to match `.env.example` (remove password for local dev)

---

### L2. punycode Deprecation Warning (DEP0040)

**Severity:** LOW (cosmetic)
**Evidence:** All 7 services show `The punycode module is deprecated`
**Fix:** Uncomment `NODE_OPTIONS=--disable-warning=DEP0040` in `.env`

---

### L3. Health Server Binding Without Auth Token

**Severity:** LOW (informational, correct behavior)
**Evidence:** "Health server will bind to all interfaces without auth token (non-production)"
**Note:** Production has a hard-fail guard at `health-server.ts` line 343. This warning is expected and correct in development.

---

## Enhancement Opportunities

### E1. Slow Partition Startup Times

| Partition | Chains | Startup Time |
|-----------|--------|-------------|
| P4 (solana) | 1 | 3.1s |
| P3 (high-value) | 3 | 26.1s |
| P1 (asia-fast) | 4 | 35.0s |
| P2 (l2-turbo) | 7 | 39.9s |

Startup time scales roughly linearly with chain count. The per-chain start timeout (`CHAIN_START_TIMEOUT_MS`) appears to be the bottleneck — chains that fail due to TLS errors wait for the full timeout before being marked as failed. Consider:
- Faster TLS failure detection (fail on first `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` instead of waiting for timeout)
- Parallel chain initialization with shorter initial timeout for known-bad endpoints

---

### E2. Coordinator Health Calculation Shows Non-Integer Percentages

**Evidence:** `"systemHealth": 42.857142857142854` and `"systemHealth": 33.33333333333333`

These raw floating-point numbers in the health API response look unprofessional and are hard to parse programmatically. Round to 1 decimal place.

---

### E3. Stream Health Monitor Reports "Redis Streams connection unavailable" Despite Redis Being Connected

**Evidence:** At 20:06:32, the coordinator logs:
```
Stream alert triggered — type: "stream_unavailable", stream: "all", message: "Redis Streams connection unavailable"
```
But all services' health endpoints show `"redisConnected": true`. This suggests the stream health monitor uses a separate connection or check that disagrees with the main Redis client's status.

---

### E4. HTTP/2 Circuit Breaker Opens Repeatedly in Execution Engine

**Evidence:** Circuit breaker opens approximately every 30-60 seconds:
```
20:05:02, 20:06:02, 20:06:34, 20:07:32, 20:08:03, 20:09:03, 20:09:33
```

The circuit breaker opens (due to TLS failures), then half-opens, then opens again. This is correct behavior but represents wasted resources. When the circuit breaker first opens, subsequent health checks should be suppressed longer before retrying.

---

### E5. Cross-Chain Detector Memory Anomaly

**Evidence:** Cross-chain detector memory dropped from 80 MB to 70 MB (-12%) during the monitoring period. While this could indicate effective garbage collection, it could also indicate a large allocation during startup (ML model loading?) that gets released.

Worth investigating whether the initial 80 MB spike is from the TensorFlow.js LSTM model initialization (`ML predictor initialized via MLPredictionManager (TensorFlow.js LSTM)`) and whether the model retains useful state when no data is flowing.

---

## Runtime Statistics Summary

### Service Health Endpoints (Final Snapshot at ~10 min)

| Service | Port | Status | Healthy Providers | Memory |
|---------|------|--------|-------------------|--------|
| Coordinator | 3000 | degraded | N/A | N/A |
| P1 (asia-fast) | 3001 | **starting** | 0/0 | 46 MB |
| P2 (l2-turbo) | 3002 | **starting** | 0/0 | 50 MB |
| P3 (high-value) | 3003 | **starting** | 0/0 | 47 MB |
| P4 (solana) | 3004 | **starting** | 0/0 | 42 MB |
| Execution Engine | 3005 | degraded | 0/15 | 81 MB |
| Cross-Chain | 3006 | degraded | 0 monitored | 71 MB |

### Error Distribution by Source

| Error Source | Count | % of Total |
|-------------|-------|------------|
| websocket-manager | 2,076 | 38% |
| chain instances (all) | 1,736 | 32% |
| partition main loops (all) | 1,029 | 19% |
| execution-engine | 286 | 5% |
| chain-specific (ETH, Linea, etc.) | 320 | 6% |

### Feature Flags Active at Runtime

| Flag | Value | Status |
|------|-------|--------|
| FLASH_LOAN_AGGREGATOR | true | Working |
| ML_SIGNAL_SCORING | true | Working (no data) |
| LIQUIDITY_DEPTH_SIZING | true | Working (no data) |
| DYNAMIC_L1_FEES | true | Working (no data) |
| ORDERFLOW_PIPELINE | true | **Missing BLOXROUTE_AUTH_HEADER** |
| SOLANA_EXECUTION | true | **Missing SOLANA_RPC_URL** |
| MEV_SHARE | true | Working |
| STATISTICAL_ARB | true | Working |
| COW_BACKRUN | true | Working |

---

## Recommended Fix Priority

### Immediate (Before Next Deploy)
1. **C1:** Fix infinite reconnection loop (coordinate WS manager and chain-level counters)
2. **C2:** Fix health status stuck at "starting" (keep failed chains in map with error status)
3. **H3:** Sync `.env` with `.env.example` (Redis password, NODE_OPTIONS)

### Short-Term (Next Sprint)
4. **H1:** Fix orphaned WebSocketManager cleanup (call `disconnect()` before creating new)
5. **H2:** Add rate-limiting to reconnection error logs
6. **M2:** Move `process.setMaxListeners(25)` to top of each service `index.ts`
7. **M1:** Add production hard-fail for SOLANA_EXECUTION without RPC URL

### Medium-Term
8. **E1:** Optimize partition startup with faster TLS failure detection
9. **E3:** Investigate stream health monitor false "unavailable" alert
10. **E4:** Tune HTTP/2 circuit breaker half-open retry interval
11. **M3:** Clean up execution engine provider priority configuration

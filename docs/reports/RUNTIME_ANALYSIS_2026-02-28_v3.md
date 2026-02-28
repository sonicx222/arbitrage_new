# Runtime Analysis Report — 2026-02-28 (Rev 3)

**Duration:** ~6.5 minutes (21:13:03 – 21:19:40)
**Services:** 7 (coordinator, P1-P4, cross-chain, execution-engine)
**Log size:** 119,363 lines / 8.5 MB (~283 lines/sec, ~1.3 MB/min)
**Environment:** Windows 11 Enterprise, Node.js 22, local Redis (in-memory)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total ERRORs | 2,278 |
| Total WARNs | 14,597 |
| System Health (final) | 42.9% |
| Chains healthy at startup | 0 / 15 |
| JsonRpcProvider failures | 14,920 (~38/sec) |
| HTTP/2 session errors | 13,819 |
| Max reconnect reached events | 836 |
| Fallback URL switches | 462 |
| DLQ accumulated messages | 150 |
| API keys leaked in logs | 118 lines |

The system starts all 7 services but enters a degraded state immediately due to TLS certificate failures (corporate proxy). **Beyond the expected TLS issues, the analysis uncovered 19 distinct findings** ranging from security vulnerabilities to infinite retry loops and configuration drift.

---

## Findings

### P0 — Critical / Security

#### F1: API Keys Leaked in Logs (SECURITY)
**Severity:** P0 — Security
**Service:** All partitions (P1-P3)
**File:** `shared/core/src/rpc/provider-rotation-strategy.ts`
**Lines:** 218, 232, 253, 271, 327

Full API keys for OnFinality, DRPC, and partial Infura project IDs are logged in plaintext:
```
selectedUrl: "wss://bsc.api.onfinality.io/ws?apikey=2fc8aa19-23da-4f89-8faf-2c2d09286a9b"
wss://lb.drpc.org/ogws?network=optimism&dkey=ApbqqpPXq0jBhzKj6zDCDhesoAG7_pkR8LFpehXRfUMv"
```

A `maskUrlApiKeys()` utility exists at `shared/core/src/utils/url-utils.ts` and is already used in `websocket-manager.ts`, but **not** in `provider-rotation-strategy.ts`. This is a direct omission — 5 logging call sites need the mask applied.

**Fix:** Wrap `this.getCurrentUrl()` and `selectedUrl` with `maskUrlApiKeys()` at lines 218, 232, 253, 271, 327.

---

#### F2: WebSocket Reconnection Infinite Loop (BUG)
**Severity:** P0 — Resource leak / infinite retry
**Service:** P1, P2, P3
**Files:**
- `shared/core/src/websocket-manager.ts` (lines 1512-1589)
- `services/unified-detector/src/chain-instance.ts` (lines 275, 986-1005)
- `shared/core/src/rpc/provider-rotation-strategy.ts` (lines 244-280)

Two independent reconnection counters operate at different layers with different semantics:

| Layer | Counter | Increments on | Max |
|-------|---------|--------------|-----|
| WebSocketManager | `reconnectAttempts` | Full URL cycle exhausted | 10 |
| ChainInstance | `reconnectAttempts` | Every single error | 5 |

**Observed:** `attempt: 21` with `maxAttempts: 5`. The log shows 836 "Max reconnect attempts reached" events followed by continued reconnection.

**Root cause chain:**
1. WebSocketManager counter only increments once per full URL rotation (e.g., 4 URLs = 4 failures per increment)
2. ChainInstance hits max after 5 errors, enters slow recovery (300s), resets counter
3. WebSocketManager slow recovery (60s) also resets its counter to 0 (line 1544)
4. Both counters restart, creating an infinite cycle
5. `switchToNextUrl()` returns `true` on each URL in the cycle, so `reconnectAttempts` rarely increments

**Impact:** Unbounded reconnection generates ~283 log lines/sec, wastes CPU, and can exhaust RPC provider rate limits. In 6.5 minutes, produced 836 "max reached" events that were all ignored.

---

#### F3: JsonRpcProvider Infinite Retry Without Backoff (BUG)
**Severity:** P0 — Resource exhaustion
**Service:** Execution engine

```
JsonRpcProvider failed to detect network and cannot start up; retry in 1s (perhaps the URL is wrong or the node is not started)
```

14,920 occurrences in 6.5 minutes (38/sec). This is ethers v6's built-in retry with a fixed 1-second interval and **no circuit breaker or upper bound**. The execution engine's HTTP/2 session pool generates 13,819 parallel errors to `https://lb.drpc.org` and `https://mainnet.helius-rpc.com`.

**Impact:** CPU waste, potential provider banning, log flood (~96% of execution engine WARN output is this single pattern).

---

### P1 — High

#### F4: Solana Partition Degradation Name Mismatch (BUG)
**Severity:** P1 — Graceful degradation broken for Solana
**File:** `shared/core/src/resilience/graceful-degradation.ts` (line 361)

Default degradation levels register key `unified-detector-solana:1` but the runtime partition ID is `solana-native`, creating key `unified-detector-solana-native:1`. Lookup fails with:

```
ERROR (graceful-degradation): Degradation level REDUCED_CHAINS not found for unified-detector-solana-native
```

P1-P3 work because their names match: `unified-detector-asia-fast`, `unified-detector-l2-turbo`, `unified-detector-high-value`.

**Fix:** Change line 361 from `'unified-detector-solana'` to `'unified-detector-solana-native'`.

---

#### F5: Solana Address Validation Error — ethers v6 vs Native Addresses (BUG)
**Severity:** P1 — Solana partition non-functional
**Service:** P4 (partition-solana)

```
error: "invalid address (argument=\"address\", value=\"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8\", code=INVALID_ARGUMENT, version=6.16.0)"
```

This is the Raydium AMM program ID (base58 Solana address). ethers v6 validates it as an EVM address (expects 0x-prefixed hex). The Solana partition chain instance fails with 0/1 chains healthy, `failed: 1`. Even in a non-corporate environment, Solana would still fail.

---

#### F6: Execution Engine Runs in Non-Simulation Mode Locally (CONFIG)
**Severity:** P1 — Safety concern
**Service:** Execution engine

```
simulationMode: false
```

The execution engine starts with `simulationMode: false` in the local development environment. If wallets had funds and providers were reachable, it would attempt real trades. `.env.example` should default to `SIMULATION_MODE=true` for local dev safety.

---

#### F7: DLQ Accumulation — 150 Stale Messages Never Cleaned (OPERATIONAL)
**Severity:** P1 — Data integrity
**Service:** Execution engine

```
WARN (execution-engine): DLQ stream has accumulated failed messages
    dlqLength: 150
    threshold: 100
```

DLQ has 150 messages from previous sessions. The warning fires every ~10 seconds (29 times in 6.5 min) but no automated action is taken. The `dlqLength` remains constant at 150, indicating no processing or cleanup occurs.

---

#### F8: No Graceful Shutdown on SIGTERM (BUG)
**Severity:** P1 — Resource leak on restart
**Service:** All 7 services

All services exit with code `4294967295` (unsigned -1 / SIGTERM kill):
```
[p1] npm run dev:partition:asia:fast exited with code 4294967295
--> Sending SIGTERM to other processes..
```

No graceful shutdown messages appear (no "Shutting down", "Cleanup", "Disconnecting"). Redis connections, WebSocket connections, timers, and health servers are abandoned. This is likely a `tsx watch` issue where the SIGTERM handler isn't propagated to the child process.

---

### P2 — Medium

#### F9: MaxListenersExceededWarning on All Services (BUG)
**Severity:** P2
**Service:** All 7 services

```
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 exit listeners added to [process]
```

Every service exceeds the default 10-listener limit on `process.exit`. Multiple subsystems (Redis clients, health servers, WebSocket managers, stream consumers) each attach exit handlers. In long-running production services, this warning could indicate genuine memory leaks if listeners accumulate.

---

#### F10: Coordinator Marks Itself Unhealthy (BUG)
**Severity:** P2
**Service:** Coordinator

```
[21:15:37] WARN: Service coordinator heartbeat stale, marking unhealthy
[21:16:02] Alert triggered: "coordinator is unhealthy"
```

The coordinator monitors service heartbeats but includes itself in the check. Its own heartbeat goes stale, causing it to mark itself unhealthy. This triggers a cascade where system health drops to 0 despite the coordinator being fully operational.

---

#### F11: Health Server Bound to 0.0.0.0 Without Auth (SECURITY)
**Severity:** P2
**Service:** All 4 partitions (P1-P4)

```
WARN: Health server bound to all interfaces without auth token (non-production)
    bindAddress: "0.0.0.0"
```

Health endpoints are network-accessible without authentication. Should default to `127.0.0.1` in dev mode.

---

#### F12: FEATURE_ORDERFLOW_PIPELINE Enabled Without BLOXROUTE_AUTH_HEADER (CONFIG)
**Severity:** P2
**Service:** All 7 services

```
WARNING: FEATURE_ORDERFLOW_PIPELINE is enabled but BLOXROUTE_AUTH_HEADER is not set
```

Feature flag enabled but required dependency missing. The orderflow consumer starts, polls `stream:pending-opportunities`, and processes no data — wasted resources.

---

#### F13: FEATURE_SOLANA_EXECUTION Enabled Without SOLANA_RPC_URL (CONFIG)
**Severity:** P2
**Service:** Execution engine

```
ERROR: FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set — skipping Solana strategy registration
```

Feature flag / env var mismatch. Feature enabled but required RPC URL not configured.

---

#### F14: Simulation Provider Priority Stale (CONFIG)
**Severity:** P2
**Service:** Execution engine

```
WARN: Provider 'tenderly' in priority but not registered
WARN: Provider 'local' in priority but not registered
    registeredProviders: ["alchemy"]
    configuredPriority: ["tenderly", "alchemy", "local"]
```

Simulation provider priority includes `tenderly` and `local` but only `alchemy` is registered. Stale config.

---

#### F15: Redis Password Supplied to Passwordless Server (CONFIG)
**Severity:** P2 — 17 occurrences

```
[WARN] This Redis server's default user does not require a password, but a password was supplied
```

`.env` has a Redis password but in-memory Redis doesn't require one. Harmless but noisy.

---

### P3 — Low

#### F16: TensorFlow.js Running Without Native Backend (PERFORMANCE)
**Severity:** P3
**Service:** Execution engine, Cross-chain detector

ML inference (LSTM predictor, orderflow predictor) runs on pure JS backend instead of native. Performance penalty for ML-intensive paths.

---

#### F17: punycode Deprecation Warning (DEPRECATION)
**Severity:** P3
**Service:** All 7 services

```
[DEP0040] DeprecationWarning: The `punycode` module is deprecated
```

From a transitive dependency. Will break in a future Node.js version.

---

#### F18: Log Growth Rate Unsustainable (OPERATIONAL)
**Severity:** P3

At ~1.3 MB/min (283 lines/sec), logs would reach:
- 1 hour: ~78 MB
- 24 hours: ~1.9 GB
- 1 week: ~13 GB

96% of volume comes from JsonRpcProvider retries and HTTP/2 errors. These should be rate-limited after a threshold.

---

#### F19: Orthogonal Initializer Slowness Warning (PERFORMANCE)
**Severity:** P3
**Service:** Cross-chain detector

```
Orthogonal initializer is being called on a matrix with more than 2000 (65536) elements: Slowness may result.
```

TensorFlow LSTM initialization with 65,536-element matrices causes startup delay.

---

## Configuration Drift Summary

| Config | Current Value | Expected for Local Dev | Issue |
|--------|-------------|----------------------|-------|
| `SIMULATION_MODE` | `false` (or unset) | `true` | Real execution in dev |
| `FEATURE_ORDERFLOW_PIPELINE` | `true` | `false` (or with BLOXROUTE_AUTH_HEADER) | Missing dependency |
| `FEATURE_SOLANA_EXECUTION` | `true` | `false` (or with SOLANA_RPC_URL) | Missing dependency |
| `REDIS_PASSWORD` | Set | Unset for in-memory Redis | Noisy warnings |
| `SIMULATION_PROVIDER_PRIORITY` | `tenderly,alchemy,local` | `alchemy` (only registered) | Stale config |
| Degradation service name | `unified-detector-solana` | `unified-detector-solana-native` | Name mismatch (code) |

---

## Service Health Timeline

| Time | Event |
|------|-------|
| 21:13:49-52 | All 7 services begin starting |
| 21:13:52 | Coordinator acquires leadership, system health = 0 |
| 21:13:52 | Coordinator recovers 2 orphaned pending messages from previous instance |
| 21:13:53-55 | All TLS/WebSocket errors begin, all chains fail to connect |
| 21:13:57 | Coordinator degrades from FULL_OPERATION → READ_ONLY (health = 0) |
| 21:13:58 | P4 Solana address validation fails, 0/1 chains |
| 21:13:58-59 | All partitions report "0/0 chains healthy" |
| 21:13:59 | Execution engine → "running" (0/15 providers healthy, simulationMode=false) |
| 21:14:03 | First DLQ warning (150 stale messages from previous sessions) |
| 21:14:37 | Coordinator alert: SYSTEM_HEALTH_LOW |
| 21:15:37 | Coordinator heartbeat stale → marks itself unhealthy |
| 21:17:28 | Health partially recovers to 33.3% (1 detector reports healthy) |
| 21:17:38 | Health at 42.9% (executor + 1 detector healthy) |
| 21:18:58 | Cross-chain and execution-engine heartbeats stale again |
| 21:19:40 | SIGTERM → all services killed (exit code 4294967295, no graceful shutdown) |

---

## Error Distribution by Service

| Service | ERRORs | WARNs | Top Error Pattern |
|---------|--------|-------|-------------------|
| coord | 0 | 16 | Self-heartbeat stale, degradation alerts |
| P1 (asia-fast) | 374 | 239 | TLS cert errors, WebSocket reconnection |
| P2 (l2-turbo) | 1,142 | 720 | TLS cert errors, WebSocket reconnection (most chains) |
| P3 (high-value) | 684 | 433 | TLS cert errors, WebSocket reconnection |
| P4 (solana) | 7 | 5 | Solana address validation, degradation not found |
| cross-chain | 0 | 3 | Minimal (no chain connections) |
| exec | 106 | 13,944 | HTTP/2 errors (13,819), JsonRpcProvider retries (14,920) |

---

## Recommendations (Priority Order)

1. **F1** — Apply `maskUrlApiKeys()` to `provider-rotation-strategy.ts` at 5 call sites
2. **F2** — Unify reconnection counters or add absolute upper bound with exponential backoff ceiling
3. **F3** — Add circuit breaker to JsonRpcProvider retry loop in execution engine HTTP/2 pool
4. **F4** — Fix degradation service name `unified-detector-solana` → `unified-detector-solana-native`
5. **F5** — Use Solana-native address validation (ed25519/base58) instead of ethers v6 for Solana chain
6. **F6** — Default `SIMULATION_MODE=true` in `.env.example` for local dev safety
7. **F7** — Add DLQ auto-cleanup or age-out mechanism with configurable retention
8. **F8** — Implement SIGTERM handlers for graceful shutdown across all services
9. **F9** — Coordinate exit listeners or set `process.setMaxListeners()` with documented reasoning
10. **F10** — Exclude coordinator from its own heartbeat monitoring

---

*Report generated from runtime-analysis-20260228-221303.log (119,363 lines)*
*Analysis date: 2026-02-28*

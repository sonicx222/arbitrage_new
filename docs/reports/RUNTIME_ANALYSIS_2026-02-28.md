# Runtime Deep-Dive Analysis Report

**Date:** 2026-02-28
**Duration:** ~10 minutes of live service monitoring
**Environment:** Windows 11, Node.js 22, Redis 7.4.7, SIMULATION_MODE=true
**Services:** 7 (coordinator, P1-P4 partitions, execution engine, cross-chain detector)
**Log Volume:** 2.4M lines in ~10 minutes (~4,000 lines/sec)

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **P0 - Critical** | 4 | Pipeline-breaking bugs preventing trade execution |
| **P1 - High** | 5 | Service health failures, data quality, and operational issues |
| **P2 - Medium** | 6 | Configuration drift, performance bottlenecks, observability gaps |
| **P3 - Low** | 4 | Cosmetic, deprecation warnings, minor improvements |

**Overall System Health Grade: D+**

The pipeline is fundamentally broken in simulation mode: zero opportunities reach execution successfully. All forwarded messages fail validation (100% DLQ rate). Two of four partition health servers fail to bind ports. The coordinator marks its own heartbeat stale. Simulated profit values are astronomically unrealistic (up to 159 billion percent).

---

## P0 - Critical Findings

### P0-1: Execution Pipeline Completely Broken — 100% DLQ Rate

**Impact:** Zero trades executed. All forwarded opportunities fail with `VAL_MISSING_TOKEN_IN`.
**Evidence:** DLQ grew from 205 to 261 during the 10-minute run. `executionAttempts: 0`, `successRate: "N/A"`.

**Root Cause — Triple Schema Mismatch:**

1. **Coordinator drops critical fields during forwarding**
   `services/coordinator/src/opportunities/opportunity-router.ts:276-286`
   The `processOpportunity()` method constructs a new object with a hardcoded whitelist of 9 fields, dropping `tokenIn`, `tokenOut`, `amountIn`, `type`, and 10+ other fields.

2. **Serializer produces empty strings from missing fields**
   `services/coordinator/src/utils/stream-serialization.ts:52-54`
   Uses `opportunity.tokenIn ?? ''` which produces empty string `''` when field is `undefined`.

3. **Solana partition uses different field names**
   `services/partition-solana/src/opportunity-factory.ts:118-146`
   Publishes `token0`/`token1` (symbol names) instead of `tokenIn`/`tokenOut` (addresses). No `amountIn` field at all.

4. **Execution engine rejects empty tokenIn**
   `services/execution-engine/src/consumers/validation.ts:232-234`
   `!data.tokenIn` evaluates `''` as falsy → `VAL_MISSING_TOKEN_IN`.

**Additional:** `intra-solana` type not in `VALID_OPPORTUNITY_TYPES` set (validation.ts:149-162), but this is masked because the coordinator also drops `type` and it defaults to `'simple'`.

**Fix:** The coordinator's `processOpportunity()` must pass through ALL fields from the raw data object. The Solana partition must emit standard field names (`tokenIn`/`tokenOut`/`amountIn`). Add `intra-solana` to the execution engine's valid types.

---

### P0-2: P1 (asia-fast) and P2 (l2-turbo) Health Servers Not Listening

**Impact:** Ports 3001/3002 are not bound. These partitions are invisible to any health monitoring system, yet appear to be "running" from their log output.
**Evidence:** `curl -v localhost:3001/health` → "Connection refused". Confirmed via PowerShell port scan — only 3000, 3003, 3004, 3005, 3006 are listening.

**Root Cause — Fire-and-Forget `server.listen()` + Misleading Log:**

- `shared/core/src/partition/health-server.ts:248-253`: Logs "Health server bound to all interfaces" **BEFORE** `server.listen()` is called (line 255). This message is not confirmation of binding — it's premature.
- `shared/core/src/partition/health-server.ts:255-257`: `server.listen()` is fire-and-forget. The actual bind confirmation is a `debug`-level log inside the callback, invisible at default `info` level.
- `shared/core/src/partition/runner.ts:182`: `await detector.start()` begins heavy async work. If chain startup exceeds the 60-second state transition timeout (`shared/core/src/service-lifecycle/service-state.ts:335-341`), the catch block at `runner.ts:207-251` calls `closeServerWithTimeout()` and `process.exit(1)`.
- P1 (4 chains, 2 classified as UNSTABLE_WEBSOCKET_CHAINS) and P2 (5 chains including newer Blast/Scroll) take longer to start than P3 (3 chains) and P4 (1 chain).
- `shared/core/src/partition/health-server.ts:281-287`: Non-EADDRINUSE/EACCES errors are logged but NOT fatal — the service continues with a dead health server.

**Fix:** Make `server.listen()` awaitable (wrap in Promise). Move the "bound" log to the listen callback. Make all listen errors fatal. Consider making the state transition timeout proportional to chain count.

---

### P0-3: Simulated Profit Values Are Astronomically Unrealistic

**Impact:** Data quality is completely broken for EVM simulation. Downstream consumers (ML models, strategy selectors, risk management) are trained/calibrated on nonsensical values.
**Evidence:**
- P1 max: 8,230,298% (8.2M%)
- P2 max: 159,371,939,452% (159B%)
- P3 max: 99,999,898% (100M%)
- P4 (Solana): 0.99-1.00% (realistic)

**Root Cause — Three Compounding Bugs:**

1. **Reserve ratio clamp distorts cross-decimal pairs**
   `shared/core/src/simulation/chain-simulator.ts:149-151`
   When the 2:1 ratio clamp triggers, it sets `reserve1 = reserve0`. For a WETH(18)/USDC(6) pair, this sets USDC reserve to 10^18 magnitude instead of 10^6 — a 10^12 distortion.

2. **Price calculation ignores token decimals**
   `shared/core/src/simulation/chain-simulator.ts:213`
   `price = Number(reserves.reserve1) / Number(reserves.reserve0)` — raw division without decimal normalization.

3. **ChainSimulator's direct `opportunity` events bypass profit filters**
   `services/unified-detector/src/simulation/chain.simulator.ts:144-146`
   These opportunities are emitted directly to the pipeline without going through `SimpleArbitrageDetector`'s 20% cap (`simple-arbitrage-detector.ts:230`). The only cap is 50% gross profit (`chain-simulator.ts:246`), but after the reserve distortion bug, raw values can be billions of percent.

4. **Coordinator's profit sanity check is far too permissive**
   `services/coordinator/src/opportunities/opportunity-router.ts:129` — `maxProfitPercentage` default is 10,000%
   `services/coordinator/src/coordinator.ts:1144` — also allows up to 10,000%

**Why Solana is fine:** `services/unified-detector/src/simulation/chain.simulator.ts:228-263` uses direct price generation with hardcoded 0.3-1.0% profit range, no reserve-based math.

**Fix:** Normalize reserve ratio clamp for token decimals. Add decimal normalization to price calculation. Route all ChainSimulator opportunities through the profit filter. Lower coordinator's `maxProfitPercentage` to 50%.

---

### P0-4: Coordinator Marks Its Own Heartbeat as Stale

**Impact:** System health oscillates between 50-100%, triggering false degradation level changes (FULL_OPERATION ↔ DETECTION_ONLY ↔ REDUCED_CHAINS). This affects execution routing decisions.
**Evidence:** 11 occurrences of "Service coordinator heartbeat stale, marking unhealthy". System health trajectory: 100 → 80 → 50 → 66 → 83 → 66 → 66 → 83.

**Root Cause — Wrong Operation Ordering + Startup Contamination:**

- `services/coordinator/src/coordinator.ts:1732`: `updateSystemMetrics()` (which runs stale detection) is called BEFORE the local heartbeat update (F3 FIX at line 1743-1750).
- `services/coordinator/src/coordinator.ts:621-629`: `recoverPendingMessages()` at startup loads OLD health entries from previous runs into `serviceHealth` map with ancient timestamps.
- `services/coordinator/src/coordinator.ts:1063`: `handleHealthMessage()` can overwrite the F3 FIX value with older Redis data.
- `services/coordinator/src/health/health-monitor.ts:312-383`: `detectStaleServices()` checks age > 90s threshold and marks entries unhealthy.

**Fix:** Seed the coordinator's own `serviceHealth` entry at startup before starting the health monitor. Move the F3 FIX to BEFORE `updateSystemMetrics()`. Skip the coordinator's own name in `handleHealthMessage()` from Redis.

---

## P1 - High Findings

### P1-1: Multi-Leg Path Finder Worker Tasks Timeout and Fall Back to Sync

**Impact:** All multi-leg path finding tasks on P2 timeout after 30s and fall back to synchronous execution, blocking the event loop.
**Evidence:** 16+ timeout errors, all on P2 (l2-turbo): base, arbitrum, optimism, blast, scroll chains. Sync fallback processing times: 1,740-3,595ms.
**Location:** `shared/core/src/async/worker-pool.ts:452`
**Root Cause:** Worker pools with 4 workers are overwhelmed when 5 chains each submit multi-leg tasks simultaneously. The 30s timeout is insufficient for complex path finding on chains with 700+ pairs (Arbitrum).

### P1-2: Event Processor Workers Lose Price Context

**Impact:** Workers cannot perform price lookups, degrading detection quality.
**Evidence:** Multiple occurrences of "Worker N: No SharedArrayBuffer provided, price lookups disabled" across P1 and P2.
**Root Cause:** SharedArrayBuffer is not transferred to worker threads during event processor initialization. Workers fall back to detection without price data.

### P1-3: Gas Price Cache Goes Stale

**Impact:** Profit calculations use outdated gas prices, leading to incorrect P&L estimates.
**Evidence:** `Gas price for optimism is stale (143665ms old)`, `Gas price for base is stale (142763ms old)` — over 2.3 minutes stale.
**Root Cause:** Gas price refresh mechanism fails or is outpaced by the number of chains. With 5 chains on P2, the refresh cycle may not complete before prices expire.

### P1-4: Cross-Chain Detector Slow to Produce Opportunities

**Impact:** Cross-chain opportunities only appear ~5 minutes after startup. During the first 5 minutes, only intra-chain simple arbitrage is detected.
**Evidence:** First cross-chain opportunity detected at 22:22:47, services started at 22:16:51.
**Root Cause:** The ML predictor initialization (TensorFlow.js) and price accumulation require warmup. The 64k-element orthogonal initializer warning suggests the model is larger than necessary.

### P1-5: DLQ Accumulating Without Alerting or Recovery

**Impact:** DLQ grew from 205 (legacy from previous runs) to 261 during this session. No automated recovery or alarm escalation observed.
**Evidence:** DLQ fallback files show entries from multiple previous sessions (Feb 20-28). `dlqAlert: true` in health endpoint but no actual notification sent (no alert channels configured).
**DLQ files growing daily:** dlq-fallback files from 2.4KB (Feb 20) to 12.2KB (Feb 26) to 5.3KB (Feb 28). dlq-forwarding-fallback from 22.5KB to 98.9KB to 48.6KB.

---

## P2 - Medium Findings

### P2-1: Log Volume Is Excessive — 4,000 Lines/Second

**Impact:** Disk I/O pressure, log storage costs, makes manual analysis impractical.
**Evidence:** 2.4M lines in ~10 minutes. Each opportunity detection generates 6-8 lines of structured output.
**Root Cause:** Every single arbitrage opportunity (18,811 in ~10 min) is logged at INFO level with full details (id, type, profit, confidence, buyDex, sellDex). Partition-level summaries also log each detection.
**Fix:** Log opportunity detections at DEBUG level. Keep partition-level summaries (aggregated counts per interval) at INFO.

### P2-2: Concurrent Publish Limit Drops 26% of Opportunities

**Impact:** 14,640 of ~55,000 detected opportunities (26.4%) are silently dropped.
**Evidence:** P1: 4,608 dropped, P2: 7,705 dropped, P3: 4,697 dropped, P4: 0.
**Location:** `shared/core/src/partition/runner.ts:491` — `MAX_CONCURRENT_PUBLISHES = 10`
**Root Cause:** Hardcoded limit of 10 concurrent publishes is far too low for the detection rate. The unified-detector uses 50 (`services/unified-detector/src/index.ts:48`), creating an inconsistency.
**Fix:** Increase to 100 and make configurable via environment variable.

### P2-3: Redis Password Mismatch Warning

**Impact:** Cosmetic but indicates configuration drift between .env and Redis server.
**Evidence:** Every service logs `[WARN] This Redis server's default user does not require a password, but a password was supplied` (14 occurrences across all services, some with 2 Redis connections).
**Root Cause:** `.env` has `REDIS_PASSWORD=localdev` but the local Redis instance has no password configured.
**Fix:** Remove or comment out `REDIS_PASSWORD` in `.env` for local development, or configure the Redis server with a password.

### P2-4: TLS Certificate Errors Block Vault-Model DEX Adapters

**Impact:** Balancer V2, GMX, Beethoven X, and Platypus adapters cannot initialize on 5 chains (Ethereum, Arbitrum, Optimism, Avalanche, Fantom). This reduces the available DEX coverage for arbitrage detection.
**Evidence:** 11 ERROR logs with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` across P1 and P2.
**Location:** `shared/core/src/dex-adapters/balancer-v2-adapter.ts:181`, `gmx-adapter.ts:88`
**Root Cause:** Node.js `fetch()` does not have corporate proxy CA certificates. No `NODE_EXTRA_CA_CERTS` or custom agent configured.
**Fix:** Set `NODE_EXTRA_CA_CERTS` environment variable for corporate environments, or add fallback to direct RPC pool queries.

### P2-5: FEATURE_ORDERFLOW_PIPELINE Enabled Without BLOXROUTE_AUTH_HEADER

**Impact:** Every service warns about this on startup. Feature is active but non-functional without the auth header.
**Evidence:** 7 identical warnings (one per service).
**Location:** `.env` — `FEATURE_ORDERFLOW_PIPELINE=true`, `BLOXROUTE_AUTH_HEADER=` (empty).
**Fix:** Either disable `FEATURE_ORDERFLOW_PIPELINE=false` or set `BLOXROUTE_AUTH_HEADER`.

### P2-6: P4 Solana RPC Provider Mismatch — Claims "helius" but Uses PublicNode

**Impact:** Misleading operational metadata. Dashboards/alerts would show "helius" but actual performance is PublicNode (rate-limited).
**Evidence:** `solanaRpcProvider: "helius"` in P4 startup log, but earlier: `SOLANA_RPC_URL not set — using PublicNode fallback`.
**Root Cause:** The `solanaRpcProvider` field is likely hardcoded or derived from config defaults rather than actual provider resolution.
**Fix:** Derive `solanaRpcProvider` from the actual resolved RPC URL, not from config defaults.

---

## P3 - Low Findings

### P3-1: MaxListenersExceededWarning on All 7 Services

**Evidence:** All services log "Possible EventEmitter memory leak detected. 11 exit listeners added to [process]."
**Root Cause:** Pino transports add `process.on('exit')` listeners per unique logger name. `process.setMaxListeners(25)` is called in `setupServiceShutdown()` but AFTER imports trigger logger creation.
**Fix:** Add `process.setMaxListeners(25)` as the first line in every service entry point, before imports.

### P3-2: punycode Deprecation Warning on All 7 Services

**Evidence:** `[DEP0040] DeprecationWarning: The punycode module is deprecated.`
**Root Cause:** Some dependency uses Node.js built-in `punycode` module (deprecated since Node 22+). Likely from `ethers` or `ws` library.
**Fix:** Low priority. Suppress with `--no-deprecation` flag or wait for upstream fix.

### P3-3: Stale TypeScript Build Cache Warning

**Evidence:** Build reports 9 `.tsbuildinfo` cache files and 1 stale `.d.ts` file.
**Fix:** Run `npm run clean:cache` and delete `services/execution-engine/src/strategies/flash-loan-providers/types.d.ts`.

### P3-4: TensorFlow.js Backend Warning

**Evidence:** "Hi, looks like you are running TensorFlow.js in Node.js. To speed things up dramatically, install our node backend" — appears on cross-chain and execution services.
**Fix:** Install `@tensorflow/tfjs-node` for better performance, or suppress the warning.

---

## Configuration & Documentation Drift

| Item | Config/Doc Says | Runtime Shows | Impact |
|------|----------------|---------------|--------|
| REDIS_PASSWORD | `localdev` in .env | Redis has no password | Warning spam (14x) |
| FEATURE_ORDERFLOW_PIPELINE | `true` | BLOXROUTE_AUTH_HEADER empty | Feature non-functional, 7 warnings |
| FEATURE_SOLANA_EXECUTION | `true` | SOLANA_RPC_URL not set | Execution engine ERROR, skips Solana |
| P4 solanaRpcProvider | Reports "helius" | Actually uses PublicNode | Misleading operational data |
| Health server logging | Says "bound to all interfaces" | P1/P2 never actually bound | Misleading — suggests success when failed |
| MAX_CONCURRENT_PUBLISHES | 10 (partition) vs 50 (unified-detector) | 26.4% drop rate | Inconsistent limits across codepaths |
| Coordinator maxProfitPercentage | 10,000% | Profits up to 159B% pass through | No effective sanity filtering |
| CLAUDE.md chain count | "15 chains" | P1: 4, P2: 5, P3: 3, P4: 1 = 13 chains running | 2 chains (Mantle, Mode) are stubs |

---

## Runtime Statistics Summary

| Metric | Value |
|--------|-------|
| **Total log lines** | 2,377,757 |
| **Opportunities detected** | P1: 3,352 / P2: 8,919 / P3: 6,490 / P4: 50 / Cross: ~30 |
| **Opportunities dropped (publish limit)** | 17,010 (P1: 4,608 / P2: 7,705 / P3: 4,697) |
| **Opportunities forwarded to execution** | ~30 (coordinator only forwards Solana sim opportunities) |
| **Execution success rate** | 0% (all fail validation) |
| **DLQ growth** | 205 → 261 (+56 new failures) |
| **System health range** | 50% - 100% (oscillating) |
| **Degradation events** | 7 level changes in 10 minutes |
| **Worker task timeouts** | 16+ (all on P2, multi-leg path finding) |
| **TLS adapter failures** | 5 chains × 2-3 adapters = ~11 failures |
| **Memory (final)** | Exec: 84MB, Cross: 98MB, P3: 52MB, P4: 47MB |

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — Fix before any deployment)

- [ ] **P0-1:** Fix coordinator `opportunity-router.ts:276-286` to pass through all fields. Add `tokenIn`/`tokenOut`/`amountIn` mapping for Solana partition. Add `intra-solana` to valid types.
- [ ] **P0-2:** Make health server `listen()` awaitable. Fix misleading log. Make listen errors fatal.
- [ ] **P0-3:** Fix reserve ratio clamp decimal normalization. Add decimal-aware price calculation. Lower `maxProfitPercentage` to 50%.
- [ ] **P0-4:** Seed coordinator's own health entry at startup. Reorder F3 FIX before `updateSystemMetrics()`.

### Phase 2: Next Sprint (P1 — Reliability and data quality)

- [ ] **P1-1:** Increase worker pool size or task timeout for P2. Consider proportional allocation based on chain count.
- [ ] **P1-2:** Pass SharedArrayBuffer to event processor workers during initialization.
- [ ] **P1-3:** Fix gas price refresh mechanism to handle multi-chain parallel updates.
- [ ] **P1-4:** Investigate TF.js model warmup time. Consider pre-warming with cached model weights.
- [ ] **P1-5:** Add DLQ recovery cron job. Configure Discord/Slack webhook for alerts.

### Phase 3: Backlog (P2/P3 — Performance, observability, cleanup)

- [ ] **P2-1:** Change opportunity detection logs to DEBUG level.
- [ ] **P2-2:** Increase `MAX_CONCURRENT_PUBLISHES` to 100, make configurable.
- [ ] **P2-3:** Fix Redis password mismatch in `.env`.
- [ ] **P2-4:** Configure `NODE_EXTRA_CA_CERTS` or add TLS fallback logic.
- [ ] **P2-5:** Disable FEATURE_ORDERFLOW_PIPELINE or set BLOXROUTE_AUTH_HEADER.
- [ ] **P2-6:** Derive solanaRpcProvider from actual resolved URL.
- [ ] **P3-1:** Add early `process.setMaxListeners(25)` to all service entry points.
- [ ] **P3-2:** Suppress punycode deprecation or update dependency.
- [ ] **P3-3:** Clean stale build cache and types.d.ts.
- [ ] **P3-4:** Install `@tensorflow/tfjs-node`.

# Runtime Analysis Report — 2026-02-28 (Rev 2)

**Method:** Started all 7 services via `npm run dev:all` with in-memory Redis, monitored for 10 minutes, analyzed 8.14 million log lines.

**Services:** Coordinator (coord), P1 asia-fast, P2 l2-turbo, P3 high-value, P4 solana-native, Cross-Chain Detector, Execution Engine

**Mode:** `SIMULATION_MODE=true`, `EXECUTION_SIMULATION_MODE=true` — synthetic prices from ChainSimulator, SimulationStrategy for fake trade results. No real blockchain or RPC connections.

---

## Simulation Mode Architecture (Context for All Findings)

Two independent flags control simulation behavior:

| Flag | Scope | Effect |
|------|-------|--------|
| `SIMULATION_MODE=true` | Detectors (P1-P4) | `ChainSimulator` generates synthetic Sync events and reserve updates on 1-5s intervals instead of real WebSocket/RPC connections. The **same** detection code (SimpleArbitrageDetector, CrossDexTriangularArbitrage, MultiLegPathFinder) runs on this synthetic data. |
| `EXECUTION_SIMULATION_MODE=true` | Execution Engine | `SimulationStrategy` replaces real blockchain transactions. It **still processes** opportunities from `stream:execution-requests`: validates, enqueues, simulates latency (~500ms), returns mock tx hashes with 85% success rate. Risk management (drawdown, EV, Kelly sizing) is skipped. |

**Key architectural fact:** In Docker/production, P1-P3 partitions use `services/unified-detector/Dockerfile` which runs `services/unified-detector/src/index.ts` — the entry point that includes `OpportunityPublisher` with Redis Streams wiring. In local dev (`dev:all`), P1-P3 use `services/partition-*/src/index.ts` which calls `createPartitionEntry()` — a different code path that lacks the publisher.

---

## Executive Summary

| Metric | Value | Context |
|--------|-------|---------|
| Total log lines | 8,144,755 | ~13,500/sec, mostly opportunity detection logs |
| Opportunities detected (partitions) | 1,169,239 | Synthetic data from ChainSimulator |
| Opportunities seen by coordinator | 23 (0.002%) | Only cross-chain detector publishes to streams |
| Opportunities forwarded to execution | 21 | Coordinator forwards cross-chain opps |
| **Trades executed** | **0** | Serialization bug causes silent validation rejection |

**Two P0 bugs** affect ALL modes (simulation and production). One additional bug is **dev-mode-only**. Several findings are reclassified as simulation artifacts.

---

## P0 — Critical Findings (Affect Production)

### F1. Coordinator Stream Serialization Drops Critical Fields — Silent Execution Rejection

**Severity:** P0 — All forwarded opportunities silently rejected by execution engine
**Affects:** All modes (simulation AND production)
**Simulation-independent:** YES — Coordinator has zero simulation-mode awareness

`services/coordinator/src/utils/stream-serialization.ts` (lines 41-62) serializes opportunities for `stream:execution-requests` but omits critical fields:

| Missing Field | Required By | Consequence |
|---------------|-------------|-------------|
| `expectedProfit` | `validateBusinessRules()` line 385 | Always `undefined` → resolves to `0` → fails `LOW_PROFIT` check |
| `buyChain` / `sellChain` | `validateCrossChainFields()` line 262 | `MISSING_BUY_CHAIN` / `MISSING_SELL_CHAIN` for cross-chain opps |
| `estimatedProfit` | Profitability checks | Lost in transit |
| `gasEstimate` | Cost analysis | Lost in transit |

The execution engine's `SimulationStrategy` DOES process valid opportunities (confirmed: it reads from stream, validates, simulates latency, returns mock results at 85% success rate). But **no opportunity ever reaches the strategy** because `expectedProfit` is always `undefined` → `0` → fails the `minProfitPercentage` business rule.

**The rejection is logged at DEBUG level** (`opportunity.consumer.ts` line 664: `this.logger.debug('Opportunity rejected by business rules', ...)`), making it completely invisible at default log levels.

Additionally, `tokenIn`, `tokenOut`, and `amountIn` use `?? ''` (empty string) fallback, which fails truthy validation checks.

**Files:**
- `services/coordinator/src/utils/stream-serialization.ts:41-62` — Incomplete field list
- `services/execution-engine/src/consumers/validation.ts:262-266,385` — Validates missing fields
- `services/execution-engine/src/consumers/opportunity.consumer.ts:664` — Debug-level rejection log

**Fix:** Add all fields required by execution validation to `serializeOpportunityForStream()`. At minimum: `expectedProfit`, `buyChain`, `sellChain`. Change empty-string fallbacks to omit fields instead.

---

### F2. Profit Unit Inconsistency Across Detectors

**Severity:** P0 — Cross-detector profit comparison is meaningless
**Affects:** All modes (simulation AND production)
**Simulation-independent:** YES for the core inconsistency; the extreme values (870K, 999K) are simulation-specific

The `expectedProfit` and `profitPercentage` fields have incompatible units across detectors:

| Detector | `expectedProfit` Unit | `profitPercentage` Unit | Production? |
|---|---|---|---|
| **Simple** (SimpleArbitrageDetector) | `Number(wei) * ratio` (raw wei-scale) | `ratio * 100` (correct %) | YES |
| **Triangular/Quad** (CrossDexTriangularArbitrage) | Decimal ratio (0-1) | Decimal ratio (**NOT** * 100) | YES |
| **Multi-Leg** (MultiLegPathFinder) | Decimal ratio (0-1) | Decimal ratio (**NOT** * 100) | YES |
| **Solana** (SolanaArbitrageDetector) | Decimal ratio (0-1) | `ratio * 100` (correct %) | YES |
| **Chain Simulator** (simulation only) | USD absolute value | `ratio * 100` (correct %) | NO |

**Two production sub-bugs:**

1. **Simple detector `expectedProfit` is raw wei** (`simple-arbitrage-detector.ts:262`): `Number(amountIn_in_wei) * netProfitPct` produces values like `5.3e+20`. This is `Number(BigInt)` of a raw token amount multiplied by a ratio — not ETH, not USD, not any normalized unit. In production with real reserves, this would produce similarly meaningless large numbers.

2. **Triangular/Multi-leg `profitPercentage` missing `* 100`** (`cross-dex-triangular-arbitrage.ts:747`, `multi-leg-path-finder.ts:557`): Set to `netProfit` (a ratio like 0.003) without the `* 100` multiplication that Simple and Solana detectors correctly apply. A 0.3% profit shows as `0.003` instead of `0.3`.

**Simulation-specific artifact:** The Chain Simulator's `expectedProfit = estimatedProfitUsd - estimatedGasCost` (with `positionSize` up to $50K and profit up to 50% after clamping) produces the extreme values like `870676` and `999998` seen in P3 logs. This code path only runs when `SIMULATION_MODE=true`.

**Downstream impact (all modes):** The coordinator's opportunity routing, the execution engine's profitability validation, and any cross-detector ranking are broken. A Simple opportunity with `expectedProfit = 5.3e+20` would always "outrank" a Triangular with `expectedProfit = 0.003`, regardless of actual profitability.

**Files:**
- `services/unified-detector/src/detection/simple-arbitrage-detector.ts:262`
- `shared/core/src/path-finding/cross-dex-triangular-arbitrage.ts:747`
- `shared/core/src/path-finding/multi-leg-path-finder.ts:557`
- `shared/core/src/simulation/chain-simulator.ts:305` (simulation only)

**Fix:** Normalize `expectedProfit` to a single unit (suggested: decimal ratio, matching Triangular/MultiLeg/Solana). Multiply Triangular/MultiLeg `profitPercentage` by 100.

---

## P1 — Significant Bugs

### F3. Coordinator Marks Its Own Heartbeat as Stale

**Severity:** P1 — Causes degradation oscillations and false SERVICE_UNHEALTHY alerts
**Affects:** All modes
**Simulation-independent:** YES

The coordinator publishes health to the HEALTH Redis stream every 5s but does NOT directly update its own `serviceHealth['coordinator']` entry. It depends on a round-trip: `xadd(HEALTH)` → Redis → `xreadgroup(HEALTH)` → `handleHealthMessage()` → `serviceHealth.set()`.

The 5s health check interval runs:
1. `updateSystemMetrics()` → `detectStaleServices()` — marks entries with `age > 90s` as unhealthy
2. `checkForAlerts()` — fires alerts
3. `reportHealth()` — publishes heartbeat

Step 1 checks staleness BEFORE step 3 publishes. If the stream consumer's round-trip takes >90s (e.g., exponential backoff on errors), the coordinator marks itself unhealthy.

**Observed:** Coordinator heartbeat consistently stale from 19:57:34 onwards, `ageMs` reaching 201-373 seconds.

**Degradation oscillation timeline:**
```
19:55:35  FULL_OPERATION (startup)
19:55:40  READ_ONLY (systemHealth: 0, no services registered yet)
19:56:21  DETECTION_ONLY (executorHealthy: false)
19:57:29  FULL_OPERATION (all services registered)
~19:58+   Oscillation: REDUCED_CHAINS ↔ FULL_OPERATION (every ~10-30s)
```

**Additional sub-issues:**
- `detectStaleServices()` mutates entries to `status: 'unhealthy'` BEFORE hysteresis check — even if `consecutiveStaleCount < threshold`, entries are already marked unhealthy
- Entries older than 5 minutes are purged from `serviceHealth`, causing the coordinator to disappear from its own registry
- Field name inconsistency: coordinator publishes `timestamp`, cross-chain detector publishes `lastHeartbeat`, unified-detector publishes neither. `handleHealthMessage()` reads `timestamp` with `Date.now()` fallback

**Fix:** After `reportHealth()`, directly update `serviceHealth.set('coordinator', { ..., lastHeartbeat: Date.now() })`.

---

### F4. Dev-Mode Pipeline Gap: Partitions Never Publish Opportunities

**Severity:** P1 — Breaks `dev:all` / `dev:start` / `dev:minimal` workflows
**Affects:** Local development only (`npm run dev:*`)
**Does NOT affect Docker/production** — Docker uses `services/unified-detector/Dockerfile` which includes `OpportunityPublisher`
**Simulation-independent:** YES — Publishing gap is in entry point wiring, not simulation mode

`npm run dev:all` runs `services/partition-*/src/index.ts` which calls `createPartitionEntry()` from `shared/core/src/partition/runner.ts`. This factory:
- Creates detector ✓
- Starts health server ✓
- Registers event handlers (logging only) ✓
- **Creates OpportunityPublisher: ✗ MISSING**

The `setupDetectorEventHandlers()` in `handlers.ts:65-82` only calls `logger.info('Arbitrage opportunity detected', ...)`. No Redis Streams client, no publisher, no forwarding.

**Entry point comparison:**

| Entry Point | Used By | Has OpportunityPublisher? |
|---|---|---|
| `services/unified-detector/src/index.ts` | Docker P1-P3, `dev:detector:fast` | YES (lines 300-334, with retry, DLQ, fast-lane) |
| `services/partition-*/src/index.ts` via `createPartitionEntry()` | `dev:all`, `dev:start`, `dev:minimal` | NO |
| `services/partition-solana/src/index.ts` | Both Docker and dev | YES (custom wiring in `onStarted` hook, lines 93-104) |

**Result:** In `dev:all`, 1,169,239 opportunities are detected, logged to console, and discarded. Only P4 (Solana) and the cross-chain detector publish to Redis Streams.

**Fix:** Either:
- (A) Add `OpportunityPublisher` wiring to `createPartitionEntry()` in `runner.ts`
- (B) Change `dev:all` to use `services/unified-detector/src/index.ts` with `PARTITION_ID` env var, matching Docker behavior

---

## P2 — Moderate Issues

### F5. TLS Certificate Errors for Vault-Model DEX Adapters

**Severity:** P2
**Affects:** All modes (adapters attempt initialization even in simulation mode)
**Simulation impact:** Low in simulation (ChainSimulator provides synthetic data regardless), but prevents production adapter initialization

All vault-model DEX adapters fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`:
- P2: Balancer V2 on arbitrum, optimism (2 errors)
- P1: Beethoven X, GMX, Platypus on avalanche/fantom (3 errors)
- P3: Balancer V2 on ethereum (1 error)

In simulation mode, these errors are cosmetic — the ChainSimulator generates data independently. **In production, these adapters would fail to start**, reducing DEX coverage for vault-model protocols.

**Fix:** Set `NODE_EXTRA_CA_CERTS` env var or skip adapter initialization when `SIMULATION_MODE=true`.

---

### F6. TensorFlow.js Running Without Native Backend

**Severity:** P2
**Affects:** All modes
**Simulation-independent:** YES

Cross-chain detector logs:
```
Hi, looks like you are running TensorFlow.js in Node.js.
Orthogonal initializer is being called on a matrix with more than 2000 (65536) elements: Slowness may result.
```

The LSTM model initializes with a 65536-element orthogonal matrix using pure JavaScript. The `@tensorflow/tfjs-node` native backend would provide 10-100x speedup.

**Fix:** Add `@tensorflow/tfjs-node` to dependencies.

---

### F7. MaxListenersExceeded Warning on All 7 Processes

**Severity:** P2
**Affects:** All modes
**Simulation-independent:** YES

Every process emits: `MaxListenersExceededWarning: 11 exit listeners added to [process]. MaxListeners is 10.`

**Fix:** Consolidate exit handlers or increase `process.setMaxListeners()`.

---

### F8. SharedArrayBuffer Over-Allocation (1.18 GB Total)

**Severity:** P2
**Affects:** All modes
**Simulation-independent:** YES

Each partition allocates 295MB `SharedKeyRegistry` buffer (`maxKeys: 4613734`, `slotSize: 64`). With 4 partitions: **1.18 GB** total, regardless of actual pair count.

P4 (Solana, 1 chain, ~7 DEXs) allocates the same 295MB as P2 (5 chains, ~30 DEXs).

**Fix:** Scale allocation based on actual chain/pair count per partition.

---

## P3 — Minor Issues & Config Drift

### F9. Redis Password Mismatch (Dev-Only)

All services warn: `This Redis server's 'default' user does not require a password, but a password was supplied`. The `.env` file has a Redis password but in-memory Redis doesn't require one. Cosmetic in dev.

### F10. Health Servers Bound to 0.0.0.0 Without Auth (Expected in Dev)

All 4 partitions bind to `0.0.0.0` without `HEALTH_AUTH_TOKEN`. Expected for local dev. Production validation (`validate:deployment`) should catch this.

### F11. Deprecated `punycode` Module Warning

All 7 processes emit `[DEP0040]`. Transitive dependency (ethers, ioredis, or similar). No functional impact.

### F12. Orphaned Pending Messages from Previous Sessions

Coordinator recovers 3+6 stale pending messages from previous consumer instances. Recovery works correctly, but indicates previous sessions didn't cleanly shut down.

### F13. Coordinator Sees 3 Detectors, Not 4

`detectorCount: 3` despite 4 partitions running. P4 (Solana) likely registers under a naming convention not matched by the health monitor pattern.

---

## Simulation-Specific Observations (NOT Bugs)

These behaviors are **expected artifacts** of `SIMULATION_MODE=true` and should not be treated as bugs:

### S1. Unrealistic Profit Values from Chain Simulator

Profit ranges like `"64627.639%"`, `"912250.009%"`, `"3360.054%"` and raw profit values like `870676`, `999998` come from the ChainSimulator's `positionSize * netProfit` calculation with:
- Position sizes: $1K-$50K (log-normal distribution)
- Net profit: up to 50% (clamped by reserve ratio bounds)
- Result: `expectedProfit` in USD, range $0-$25K per opportunity

In production, the SimpleArbitrageDetector works with real reserve ratios and the raw-wei bug (F2) would produce different (but still incorrectly scaled) values.

### S2. 1.17M Opportunities in 10 Minutes (High Detection Volume)

The ChainSimulator updates reserves every 1-5s for all pairs. With hundreds of configured pairs across 13 chains, the combinatorial cross-DEX detection produces massive volumes. In production with real WebSocket feeds, opportunity volume would be order(s) of magnitude lower and driven by actual market movements.

### S3. Log Flood (~13,500 lines/sec)

Directly caused by S2. The `handlers.ts` logs every detected opportunity at INFO level. In production this would be lower volume, but **log sampling should still be added** to prevent I/O saturation during volatile markets.

### S4. Confidence Value Clustering

75% of opportunities cluster at 0.80, 0.85, 0.75. The confidence calculation uses reserve-ratio-derived heuristics that produce narrow ranges when ChainSimulator generates tightly bounded random walk prices. In production with real volatility, confidence values would have wider distribution.

### S5. Execution Engine "Idle" (No Trade Results)

Expected consequence of F1 (serialization bug) — not a simulation issue. The `SimulationStrategy` IS ready and functional (confirmed: reads stream, validates, simulates latency, returns mock results). Zero trades = zero valid opportunities reaching the strategy, not the strategy being inactive.

### S6. Cross-Chain Detector Limited Activity

The cross-chain detector consumes from `stream:price-updates` and `stream:pending-opportunities`. In simulation mode, price updates ARE published (by partitions that have stream clients), but the cross-chain detector's internal opportunity generation produces only ~23 opportunities in 10 minutes. This is expected — cross-chain arbitrage requires specific cross-chain price divergence patterns that synthetic data rarely triggers.

---

## Findings Classification Matrix

| # | Finding | Severity | Simulation Artifact? | Affects Production? |
|---|---------|----------|---------------------|---------------------|
| F1 | Stream serialization drops fields | **P0** | No | **YES** — all modes |
| F2 | Profit unit inconsistency | **P0** | Partially (extreme values sim-only, core inconsistency is real) | **YES** — all modes |
| F3 | Coordinator self-heartbeat stale | **P1** | No | **YES** — all modes |
| F4 | Dev-mode partition publishing gap | **P1** | No | **No** — Docker uses different entry point |
| F5 | TLS certificate errors | **P2** | No (adapters init in both modes) | **YES** — adapter failure in production |
| F6 | TF.js no native backend | **P2** | No | **YES** — all modes |
| F7 | MaxListenersExceeded | **P2** | No | **YES** — all modes |
| F8 | SharedArrayBuffer over-allocation | **P2** | No | **YES** — all modes |
| S1 | Unrealistic profit ranges | Info | **YES** | No |
| S2 | 1.17M detections in 10 min | Info | **YES** | No (lower volume) |
| S3 | Log flood 13.5K lines/sec | Info | **YES** (but sampling still needed) | Partially |
| S4 | Confidence clustering | Info | **YES** | No |
| S5 | Execution engine idle | Info | Consequence of F1 | N/A |
| S6 | Cross-chain low activity | Info | **YES** | No |

---

## Recommended Fix Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **P0-1** | F1: Fix stream serialization field coverage | Small | Unblocks execution pipeline in ALL modes |
| **P0-2** | F2: Normalize profit units across detectors | Large | Correct opportunity comparison and routing |
| **P1-1** | F3: Coordinator self-heartbeat direct update | Small | Eliminates degradation oscillations |
| **P1-2** | F4: Add OpportunityPublisher to `createPartitionEntry()` | Medium | Enables local dev pipeline |
| **P2** | F5: TLS CA certificate or skip in sim mode | Small | Enables vault-model DEX adapters |
| **P2** | F6: Install tfjs-node backend | Small | 10-100x ML performance improvement |
| **P2** | F7: Consolidate process exit handlers | Small | Eliminates memory leak warning |
| **P2** | F8: Scale SharedArrayBuffer per partition | Medium | Saves ~800MB RAM |

---

## Appendix: Runtime Environment

- **Platform:** Windows 11 Enterprise (Cygwin/MSYS2)
- **Node.js:** v22.x
- **Redis:** In-memory (scripts/start-redis-memory.js), PID 346248
- **Duration:** ~10 minutes (19:55:35 — 20:06:23)
- **Mode:** `SIMULATION_MODE=true`, `EXECUTION_SIMULATION_MODE=true`
- **Launch:** `npm run dev:all` (concurrently, 7 services)

## Appendix: Simulation Mode Architecture

```
SIMULATION_MODE=true
├── Effect: ChainSimulator generates synthetic reserve updates (1-5s interval)
│   └── Same detection code runs (Simple, Triangular, MultiLeg)
├── Does NOT affect: publishing, routing, serialization, validation
└── Consumers: chain-instance.ts (SimulationInitializer), chain-simulator.ts

EXECUTION_SIMULATION_MODE=true
├── Effect: SimulationStrategy replaces real blockchain transactions
│   └── Still processes stream:execution-requests normally
│   └── Simulates 500ms latency, 85% success, mock tx hashes
├── Skips: blockchain providers, nonce manager, risk management, bridge recovery
└── Consumers: execution-engine index.ts, strategy-factory.ts

Pipeline in dev:all (both flags true):
  P1-P3: detect(synthetic) → log(opportunity) → DEAD END (no publisher)
  P4:    detect(synthetic) → publish(stream:opportunities) → coordinator
  Cross: detect(internal)  → publish(stream:opportunities) → coordinator
  Coord: read(stream:opportunities) → serialize(DROPS fields) → write(stream:execution-requests)
  Exec:  read(stream:execution-requests) → validate(expectedProfit=0) → REJECT (debug log)

Pipeline in Docker (both flags true):
  P1-P3: detect(synthetic) → OpportunityPublisher → write(stream:opportunities)
  P4:    detect(synthetic) → publish(stream:opportunities)
  Cross: detect(internal)  → publish(stream:opportunities)
  Coord: read(stream:opportunities) → serialize(DROPS fields) → write(stream:execution-requests)
  Exec:  read(stream:execution-requests) → validate(expectedProfit=0) → REJECT (debug log)
  ↑ F1 serialization bug still blocks execution even in Docker
```

---

## Remediation (2026-02-28)

All P0 and P1 findings have been fixed. Fixes verified via typecheck and 1,161 passing tests.

### F1 (P0) — FIXED: Stream Serialization

**File:** `services/coordinator/src/utils/stream-serialization.ts`

- Added `expectedProfit`, `estimatedProfit`, `gasEstimate` to serialized field set
- Changed `expiresAt` from always-present `?? ''` (empty string fails NUMERIC_PATTERN) to conditional inclusion: only serialized when the value is non-null
- Added conditional `buyChain`/`sellChain` serialization for cross-chain opportunities
- Total serialized fields: 14 → 17 (plus conditional buyChain, sellChain, expiresAt)

**Pipeline impact:** Execution engine validation now receives `expectedProfit` as a string number, passing the `LOW_PROFIT` business rule check. Cross-chain opportunities include the required chain fields.

### F2 (P0) — FIXED: Profit Unit Inconsistency

**Files:**
- `shared/core/src/path-finding/cross-dex-triangular-arbitrage.ts:747` — triangular: `netProfit` → `netProfit * 100`
- `shared/core/src/path-finding/cross-dex-triangular-arbitrage.ts:548` — quadrilateral: `netProfit` → `netProfit * 100`
- `shared/core/src/path-finding/multi-leg-path-finder.ts:557` — multi-leg: `netProfit` → `netProfit * 100`

All detectors now use consistent `ratio * 100` for `profitPercentage`, matching Simple and Solana detectors.

### F3 (P1) — FIXED: Coordinator Self-Heartbeat Stale

**File:** `services/coordinator/src/coordinator.ts:1738`

After `reportHealth()` publishes to the HEALTH stream, the coordinator now directly updates its own `serviceHealth` map entry with `lastHeartbeat: Date.now()`. This eliminates the race condition where `detectStaleServices()` could mark the coordinator unhealthy before its own heartbeat round-tripped through Redis.

### F4 (P1) — FIXED: Dev-Mode Partition Publishing Gap

**Files:**
- Created `shared/core/src/publishers/opportunity-publisher.ts` — OpportunityPublisher moved from unified-detector to shared/core for reuse by all partition services
- Created `shared/core/src/publishers/index.ts` — barrel export
- Updated `shared/core/package.json` — added `./publishers` export path
- Updated `shared/core/src/partition/runner.ts` — `createPartitionEntry()` now auto-wires Redis + OpportunityPublisher via a composed `onStarted` hook
- Updated `services/unified-detector/src/publishers/opportunity.publisher.ts` — re-exports from shared/core for backward compatibility

**Pipeline after fix (dev:all):**
```
P1-P3: detect → OpportunityPublisher (auto-wired) → write(stream:opportunities) → coordinator
P4:    detect → publish(stream:opportunities) → coordinator
Cross: detect → publish(stream:opportunities) → coordinator
Coord: read(stream:opportunities) → serialize(ALL fields) → write(stream:execution-requests)
Exec:  read(stream:execution-requests) → validate(expectedProfit=OK) → execute
```

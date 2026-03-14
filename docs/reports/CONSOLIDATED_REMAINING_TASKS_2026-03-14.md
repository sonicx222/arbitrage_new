# Consolidated Remaining Tasks

**Date:** 2026-03-14
**Source:** Reconciliation of 8 analysis reports against current codebase
**Method:** Parallel agent verification of every finding against actual code

---

## Runtime Analysis (2026-03-12) Reconciliation

The Runtime Analysis report had no resolution markers. Cross-verification against the codebase shows **28 of 31 findings + all 7 enhancements are FIXED** (commit `2b2986d0` and others).

| Finding | Description | Status |
|---------|-------------|--------|
| C-01 | `dev:all` ignores `.env.local` | FIXED (`--env-file-if-exists=.env.local`) |
| C-02 | `stream:service-degradation` orphaned | FIXED (consumer group + handler in coordinator) |
| C-03 | Health stream lag grows unboundedly | FIXED (MAXLEN 5000) |
| C-04 | 696ms event loop spike (TF.js) | FIXED (lazy init, OPT-5) |
| C-05 | docker-compose path wrong in stop-redis | FIXED (`infrastructure/docker/`) |
| H-01 | MaxListenersExceededWarning | FIXED (early `setMaxListeners` in all entry points) |
| H-02 | Feature flag log format inconsistency | **PARTIAL** (3 `console.warn` lines missing emoji) |
| H-03 | Cross-chain health Redis vs HTTP mismatch | FIXED (aligned status logic) |
| H-04 | `tradingAllowed: true` with 0 providers | FIXED (added `canExecute` field) |
| H-05 | Stale init message in execution stream | FIXED (MAXLEN + skip on consume) |
| H-06 | Alert duplicates accumulate | FIXED (dedup in `getAlertHistory()`) |
| H-07 | CRITICAL alert never clears | FIXED (`stream_recovered` alert) |
| H-08 | `memoryUsagePercent` unclear | FIXED (renamed `heapUsagePercent`) |
| M-01 | `.env.local` missing flags | FIXED (flags in `.env`) |
| M-02 | Partition regions hardcoded | FIXED (REGION_ID override) |
| M-03 | Health 100% during early startup | FIXED (registration scaling) |
| M-04 | 4.6M PriceMatrix slots for Solana | FIXED (`PRICE_MATRIX_MAX_PAIRS` env) |
| M-05 | Uptime field 0 for partitions | FIXED (reads both field names) |
| M-06 | Empty streams show "unknown" | FIXED (now "idle") |
| M-07 | TF.js without native backend | **OPEN** (design decision — native deps hard on Alpine/ARM) |
| M-08 | HTTP/2 CB doesn't recover | FIXED (health re-check loop) |
| M-09 | `dev:all` missing TLS bypass | FIXED (`NODE_TLS_REJECT_UNAUTHORIZED=0`) |
| M-10 | DLQ test data in prod directory | **PARTIAL** (OpportunityRouter fixed, StreamConsumerManager still uses `data/`) |
| L-01 | Health binds 0.0.0.0 no auth | FIXED (debug log + EE binds 127.0.0.1) |
| L-02 | EE logs "Starting" twice | FIXED (distinct messages) |
| L-03 | No MAXLEN on health stream | FIXED (5000) |
| L-04 | 445MB trade logs, no compression | FIXED (LogFileManager) |
| L-05 | Misleading depth ratio | FIXED (<=1 entry = ratio 0) |
| L-06 | Solana hasStreamsClient: false log | FIXED (clarified message) |
| L-07 | Dual DLQ fallback paths | **PARTIAL** (consistent in prod, dev diverges) |
| L-08 | Prometheus only seeds ethereum | FIXED (seeds all chains) |
| E-01 | `dev:all:sim` command | IMPLEMENTED |
| E-02 | Configurable MAXLEN per stream | IMPLEMENTED (`STREAM_MAXLEN_*` env vars) |
| E-03 | Alert dedup with cooldown | IMPLEMENTED (AlertCooldownManager) |
| E-04 | "idle" vs "unknown" stream status | IMPLEMENTED |
| E-05 | Lazy ML initialization | IMPLEMENTED |
| E-06 | Per-partition PriceMatrix sizing | IMPLEMENTED |
| E-07 | Provider health re-check loop | IMPLEMENTED |

**Residual from Runtime Analysis:** 1 open (M-07, design decision), 3 partially fixed (H-02/M-10/L-07 — trivial).

---

## Consolidated Implementation List

All items below are deduplicated across 8 reports. Items that overlap are merged and the strongest severity is used. Items requiring mainnet deployment with real funds, or new backend APIs that don't exist, are excluded.

### ~~Tier 1: Critical Bugs (3 items)~~ — ALL FIXED (commit `358917a8`)

These were already fixed but the Services report's action plan checkboxes were stale.

| ID | Source | Description | Status |
|----|--------|-------------|--------|
| ~~T1-1~~ | Services BUG-P0-2 | `estimatePriceImpact` reserve direction | FIXED `358917a8` |
| ~~T1-2~~ | Services BUG-P0-3 | `estimatedProfit` total profit calculation | FIXED `358917a8` |
| ~~T1-3~~ | Services BUG-P1-2 | `netProfit` dimensional mismatch (USD-based now) | FIXED `358917a8` |

### Tier 2: Data Loss / Resilience (5 items)

These can cause permanent loss of opportunities or bypass safety mechanisms.

| ID | Source | Description | Status |
|----|--------|-------------|--------|
| ~~T2-1~~ | ExtSvc #2 | Backpressure-rejected messages — already has DLQ write (`P1-DLQ FIX`) | **ALREADY FIXED** |
| T2-2 | ExtSvc #3 | Approximate MAXLEN trimming silently discards unread messages when consumers lag | **Mitigated** (80% lag monitoring) |
| ~~T2-3~~ | ExtSvc #7 | CB state not persisted — `restoreState()` on startup + persist on state change | **FIXED** (this session) |
| ~~T2-4~~ | ExtSvc #12 | Batch handler throw lost all processedIds — now uses outer-scope `let` + unified ACK | **FIXED** (this session) |
| T2-5 | ExtSvc #5 | No per-chain finality confirmation for cross-chain arb — reorg/double-spend risk | Open (needs design) |

### Tier 3: Config Drift / Correctness (10 items)

Misaligned configs that silently degrade functionality.

| ID | Source | Description | Status |
|----|--------|-------------|--------|
| ~~T3-1~~ | CC H-03 | `minimumProfit` default 1e14 blocks all 6-decimal token trades (USDC/USDT) — smoke test should flag | **FIXED** (smoke test warns when >1e12) |
| ~~T3-2~~ | CC M-01 | Aave V3 provider descriptor missing 'mantle' in chains array | **ALREADY FIXED** |
| ~~T3-3~~ | CC M-02 | Avalanche: SushiSwap in APPROVED_ROUTERS but missing from DEX_ROUTERS config | **ALREADY FIXED** (present in both) |
| ~~T3-4~~ | CC M-03+M-13 | Mantle missing WETH + low token count (3 tokens) | **ALREADY FIXED** (4 tokens incl WETH) |
| ~~T3-5~~ | CC M-04 | `V3_APPROVED_ROUTERS` only covers 6 chains — 8 chains with V3 DEXs have no entries | **FIXED** (added optimism, linea, blast, scroll) |
| ~~T3-6~~ | CC M-05 | Batch deployment manifest gaps — PCS V3 missing linea, ethereum, zksync | **ALREADY FIXED** |
| ~~T3-7~~ | CC M-09 | Hardhat ethereum network config commented out — `deploy-batch.ts` targets it | **ALREADY FIXED** |
| ~~T3-8~~ | CC M-14 | Balancer V2 provider `chains` lists 7 chains but `status='deferred'` — consumers see available chains | **NON-ISSUE** (deferred correctly filtered) |
| ~~T3-9~~ | ExtSvc #18 | `docker-compose.partitions.yml` L2-Turbo chain list missing scroll,blast,mantle,mode | **ALREADY FIXED** |
| ~~T3-10~~ | ExtSvc #19 | Dev Redis `maxmemory-policy allkeys-lru` silently evicts stream data (prod uses `noeviction`) | **ALREADY FIXED** |

### Tier 4: Security Hardening (4 items)

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| T4-1 | Services SEC-S-004 + Dashboard F-SEC-01/02 | SSE auth token in URL query param — needs two-step POST→nonce auth | `services/coordinator/src/api/routes/sse.routes.ts:189` |
| T4-2 | Services SEC-S-006 | EE proxy endpoints `/ee/health`, `/circuit-breaker` have no auth middleware | `services/coordinator/src/api/routes/index.ts:143-196` |
| T4-3 | ExtSvc #10 + Caching SEC-H-002 | Execution engine doesn't check `isFallback` flag on gas prices from GasPriceCache | `services/execution-engine/src/` (GasPriceOptimizer) |
| T4-4 | CC M-06 | No runtime guard prevents flash loan attempt on zero-provider chains (Blast/Mode) | `services/execution-engine/src/` |

### Tier 5: Operational Quality (14 items)

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| T5-1 | ExtSvc #9 | `SWAP_DEADLINE_SECONDS` is global 300s — excessive MEV exposure on fast L2s | `shared/core/src/strategies/base.strategy.ts:147` |
| T5-2 | ExtSvc #11 | Partition `/ready` doesn't check Redis connectivity — reports "ready" when Redis down | `shared/core/src/partition/health-server.ts:350-363` |
| T5-3 | ExtSvc #14 | No publish-side schema validation for opportunities | `shared/core/src/redis/opportunity-publisher.ts:106` |
| T5-4 | ExtSvc #16 | No chain coverage health alert when partition failure leaves chains unmonitored | `services/coordinator/src/` |
| T5-5 | ExtSvc #22 | Bridge-latency-adjusted timeout for cross-chain opportunities | `shared/config/src/thresholds.ts:84-105` |
| T5-6 | ExtSvc #23 | StreamBatcher `maxWaitMs=10ms` is global — fast L2s need 3ms | `shared/core/src/redis/streams.ts:259-263` |
| T5-7 | Services BUG-P2-4 | `cbReenqueueCounts` FIFO eviction deletes 20% — may reset active counts | `services/execution-engine/src/execution-pipeline.ts:233-240` |
| T5-8 | Services REF-02 | Consumer lag detection logic copy-pasted (23 lines) between single/batch handlers | `services/coordinator/src/coordinator.ts:1555,1723` |
| T5-9 | Profitability | PnL/drawdown tracker uses raw native wei — no USD normalization via `getNativeTokenPrice()` | `shared/core/src/risk/drawdown-tracker.ts` |
| T5-10 | Profitability | Alertmanager routing commented out — no live alerting in any mode | `infrastructure/monitoring/alert-rules.yml:327-364` |
| T5-11 | Profitability | Grafana dashboards exist but not auto-provisioned | `infrastructure/monitoring/grafana/` |
| T5-12 | Profitability | Slippage metric not split into estimation error vs execution slippage | `services/execution-engine/src/` |
| T5-13 | CC M-10 | 8+ env vars missing from `.env.example` (LOG_*, FLASH_LOAN_CONTRACT_*) | `.env.example` |
| T5-14 | Profitability | Linea flash loans blocked — no SyncSwap vault address configured | `shared/config/src/flash-loan-providers/` |

### Tier 6: Architecture / Refactoring (4 items)

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| T6-1 | Services ARCH-M-02 | Extract `UnifiedChainDetector` from service into `shared/core` (service-to-service import dep) | `services/unified-detector/src/` → `shared/core/` |
| T6-2 | Services ARCH-M-04 | Monolith allocates SharedArrayBuffer for partitions but workers don't consume it | `services/monolith/src/index.ts:265` |
| T6-3 | ExtSvc #15 | Manual numeric field restoration in deserialization — fragile, adding fields requires dual update | `shared/core/src/redis/` |
| T6-4 | CC M-15 | Batch deployment script has no cross-deployment nonce management | `contracts/scripts/deploy-batch.ts:254-279` |

### Tier 7: Test Quality (6 items)

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| T7-1 | Dashboard | No smoke render tests for Tab components + no SSE→reducer integration test | `dashboard/src/` |
| T7-2 | Services MF-M-02 | Polygon CORE_TOKENS mocked as empty — skips pair initialization in test | `**/chain-instance-websocket.test.ts:162` |
| T7-3 | Services MF-M-05 | Nonce mock always returns 42 — race conditions untested | `**/cross-chain.strategy.test.ts:115` |
| T7-4 | Services MF-M-07 | Batch handler uses plain `noop` not `jest.fn()` — loses assertion power | `**/batch-handlers.test.ts:35` |
| T7-5 | CC M-08 | Schema validators skip in test mode — regressions only surface in staging | `shared/config/src/schemas/index.ts:463-506` |
| T7-6 | CC M-30 | Deploy script tx hash logging missing for `approveRouters()` / `setMinimumProfit()` | `contracts/scripts/deployment-utils.ts:704-705` |

### Tier 8: Low-Priority Polish (12 items)

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| T8-1 | RT H-02 | 3 `console.warn` lines in feature-flags.ts missing emoji prefix | `shared/config/src/feature-flags.ts:764,805,819` |
| T8-2 | RT M-10 | StreamConsumerManager DLQ writes to `data/` in all environments | `services/coordinator/src/streaming/stream-consumer-manager.ts:554` |
| T8-3 | Services BUG-P2-1 | `extractTokenFromPair` splits by `_` — could mismatch | `detector.ts:1640` |
| T8-4 | Services BUG-P2-2 | `getCexPriceFeedService()` called without options on startup race | `opportunity-router.ts:786` |
| T8-5 | Services BUG-P3-2 | Detection path doesn't set `tradeSizeUsd` on opportunities | `detector.ts:1593` |
| T8-6 | ExtSvc #25 | EE swallows Redis health check error silently | `services/execution-engine/src/index.ts:256` |
| T8-7 | ExtSvc #26 | TradeLogEntry missing `flashLoanProvider` + `usedV3Adapter` fields | `shared/core/src/persistence/trade-logger.ts:36-89` |
| T8-8 | ExtSvc #31 | WebSocket life-support mode has no alert escalation | `shared/core/src/ws/websocket-manager.ts:1591-1607` |
| T8-9 | ExtSvc #33 | Dev Redis has no auth — masks auth bugs | `infrastructure/docker/docker-compose.partitions.yml:35` |
| T8-10 | ExtSvc #35 | Polygon opportunity timeout 6s may be too tight (variance 2-10s) | `shared/config/src/thresholds.ts` |
| T8-11 | CC L-09 | `toLowerCase()` creates new string on every hot-path call in 6 threshold getters | threshold getter functions |
| T8-12 | CC L-10 | CORE_TOKENS header comment says 135, actual 137 | `shared/config/src/tokens/index.ts` |

### Dashboard Feature Enhancements (5 items, frontend-only)

These can be implemented without backend changes using existing SSE data.

| ID | Source | Description | Files |
|----|--------|-------------|-------|
| D-1 | Dashboard | Fullscreen chart mode | `dashboard/src/components/Chart.tsx` |
| D-2 | Dashboard | Auto-refresh pause button | `dashboard/src/contexts/ConnectionContext.tsx` |
| D-3 | Dashboard | Multi-select chain filter | `dashboard/src/components/` |
| D-4 | Dashboard | Slippage tracking display (expected vs actual from execution results) | `dashboard/src/tabs/ExecutionTab.tsx` |
| D-5 | Dashboard | False positive rate (opportunities detected vs executed successfully) | `dashboard/src/tabs/OverviewTab.tsx` |

---

## Summary

| Tier | Count | Theme |
|------|-------|-------|
| ~~T1: Critical Bugs~~ | ~~3~~ | ~~ALREADY FIXED in `358917a8`~~ |
| T2: Data Loss / Resilience | 5 | Message loss, CB persistence, finality |
| T3: Config Drift | 10 | Chain configs, manifests, provider registries |
| T4: Security | 4 | Auth, gas validation, runtime guards |
| T5: Operational Quality | 14 | Timeouts, monitoring, alerting, env docs |
| T6: Architecture | 4 | Extraction, nonce mgmt, deserialization |
| T7: Test Quality | 6 | Mock fidelity, schema validation, coverage |
| T8: Low-Priority Polish | 12 | Logging, minor bugs, comments |
| Dashboard Features | 5 | Frontend-only enhancements |
| **Total** | **63** | |

### Recommended Implementation Order

1. ~~**T1 (Critical Bugs)**~~ — Already fixed in `358917a8`.
2. **T2-1 through T2-4 (Data Loss)** — Prevent permanent message loss and CB bypass. T2-5 (finality) is important but requires design work.
3. **T3 (Config Drift)** — Batch fix: most are 1-3 line config changes that unlock functionality on new chains.
4. **T4-3, T4-4 (Runtime Guards)** — Quick safety checks in execution engine.
5. **T5-2, T5-10, T5-13 (Quick Operational Wins)** — Redis readiness, alerting, env documentation.
6. Everything else by priority within tier.

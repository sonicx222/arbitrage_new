# Extended Deep Analysis Report (Operational Focus)

> **Date:** 2026-02-23
> **Analysis Method:** 6-agent multi-role operational analysis (Latency Profiler, Failure Mode Analyst, Data Integrity Auditor, Cross-Chain Analyst, Observability Auditor, Config Drift Detector)
> **Scope:** Git diff (32 files, 896 insertions, 146 deletions) + Phase 1 affected code from DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md
> **Model:** Claude Opus 4.6
> **Grade:** B+ (Strong fundamentals with targeted operational gaps before mainnet)

---

## Executive Summary

Six specialized operational analysis agents independently examined the arbitrage system's git diff changes and Phase 1 affected code. The analysis covered latency profiling, failure modes, data integrity, cross-chain correctness, observability, and configuration drift.

### Findings by Severity

| Severity | Count | Categories |
|----------|-------|------------|
| **Critical (P0)** | 4 | Latency regression, gas model gap, bridge TTL, shutdown data loss |
| **High (P1)** | 8 | Depth cache thrashing, stream DLQ, trace gaps, health checks, dedup restart gap |
| **Medium (P2)** | 10 | Schema versioning, consumer lag, metrics exposure, config drift, allocations |
| **Low (P3)** | 8 | Feature flag docs, fallback prices, convention consistency |

### Top 5 Highest-Impact Issues

1. **L1 fee estimation disabled by default on 5 L2 rollups** — gas underestimated by 2-10x, executing unprofitable trades (cross-chain-analyst, Score: 4.1)
2. **LiquidityDepthAnalyzer wired into O(n^2) detection loop** — adds 2-25ms to hot path, threatens <50ms target (latency-profiler, Score: 3.7)
3. **Bridge recovery 72h TTL insufficient for 7-day rollup bridges** — funds at risk on Arbitrum/Optimism native bridges (cross-chain + failure-mode, Score: 3.7)
4. **Probability tracker not destroyed on engine shutdown** — up to 10 outcomes lost per restart, stale Kelly criterion sizing (failure-mode-analyst, Score: 3.6)
5. **Solana partition and cross-chain-detector lack trace context** — impossible to debug end-to-end for these services (observability-auditor, Score: 3.4)

### Agent Agreement Map

| Finding Area | Agents Agreeing | Confidence |
|-------------|----------------|------------|
| At-least-once delivery semantics | failure-mode + data-integrity | HIGH (both independently confirmed) |
| Bridge recovery TTL insufficient | cross-chain + failure-mode | HIGH (both flagged from different angles) |
| PEL-based backpressure is correct | failure-mode + data-integrity | HIGH (no disagreement) |
| Shutdown ACK safety well-implemented | failure-mode + data-integrity | HIGH (both verified) |
| New persistence code is well-implemented | failure-mode + data-integrity + config-drift | HIGH (all 3 found appropriate patterns) |

### Overall Health Assessment: **B+**

**Strengths:** At-least-once delivery with deferred ACK, HMAC-signed streams with key rotation, per-chain circuit breakers with persistence, hysteresis-based backpressure, two-level LST normalization correctly designed, new probability tracker persistence is well-architected.

**Gaps:** L1 fee estimation off by default on L2s (direct financial risk), hot-path latency regression from liquidity enrichment, bridge TTL mismatch with rollup finality, observability gaps in Solana/cross-chain services, trade audit trail has empty fields.

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Gas Model | `shared/config/src/feature-flags.ts:203` | `FEATURE_DYNAMIC_L1_FEES` defaults to OFF. On 5 L2 rollups (Arbitrum, Optimism, Base, zkSync, Linea), L1 data/calldata fees are 50-90% of total gas cost. Without this, gas estimates are 2-10x too low, causing unprofitable trade execution. | cross-chain | HIGH (90%) | Enable by default for L2 chains, or make the default chain-aware. Verify L1 fee estimation logic works correctly before enabling. | 4.1 |
| 2 | Latency | `shared/core/src/components/arbitrage-detector.ts:316-322` | New `enrichWithLiquidityData()` call is inside O(n^2) pair comparison loop. Per-opportunity cost: 0.5-5ms (StableSwap Newton's method up to 5ms). With 5 opportunities and cache misses, adds 5-25ms to the <50ms hot path. | latency-profiler | HIGH (90%) | Move enrichment AFTER sorting by profit. Only enrich top-K candidates. Cache hit rate is critical — ensure depth cache isn't thrashed by frequent pool updates. | 3.7 |
| 3 | Funds Safety | `services/execution-engine/src/types.ts:1178` | `BRIDGE_RECOVERY_MAX_AGE_MS = 72h`. Arbitrum and Optimism native bridges have 7-day challenge periods. Recovery abandoned while funds still locked. Bridge recovery Redis keys also lack explicit TTL — keys persist indefinitely if recovery manager is disabled. | cross-chain + failure-mode | HIGH (95%) | Make TTL configurable per bridge type. Native rollup bridges: 8+ days. Add Redis key TTL = maxAgeMs + buffer to prevent unbounded key accumulation. | 3.7 |
| 4 | Data Loss | `services/execution-engine/src/engine.ts:817` | `this.probabilityTracker = null` — nullifies reference without calling `destroy()`. The `destroy()` method persists final batch to Redis before clearing. Up to 10 outcomes lost per shutdown. On restart, `loadFromRedis()` restores stale aggregates, causing incorrect Kelly criterion sizing. | failure-mode | HIGH (95%) | Replace `this.probabilityTracker = null` with `await this.probabilityTracker?.destroy()` followed by nullification. | 3.6 |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 5 | Latency | `shared/core/src/analytics/liquidity-depth-analyzer.ts:248` | `updatePoolLiquidity()` invalidates depth cache on every call. If pool data updates with each price event (hundreds/sec), cache is perpetually thrashed, making enrichment pay full computation cost every time. | latency-profiler | HIGH (90%) | Only invalidate cache when reserves change >1% (significance threshold). | 3.5 |
| 6 | Failure Mode | `shared/core/src/redis-streams.ts` (DLQ stream) | Stream-based DLQ (`stream:dead-letter-queue`) is write-only. OpportunityConsumer writes failed messages but no consumer reads/replays/alerts. Failed execution requests silently accumulate. | failure-mode | HIGH (95%) | Add DLQ consumer service or at minimum a monitoring job that alerts when DLQ stream length exceeds threshold. | 3.4 |
| 7 | Observability | `services/partition-solana/src/arbitrage-detector.ts` | No trace context propagation in Solana partition (P4) or cross-chain-detector service. Impossible to trace opportunities end-to-end for these services. | observability | HIGH (95%) | Add `createTraceContext()` + `propagateContext()` calls matching P1-P3 pattern. | 3.4 |
| 8 | Observability | `trade-logger.ts:270-271` | Trade logger has `slippage`, `retryCount`, `blockNumber`, `route` fields defined in interface but hardcoded to `undefined`. Cannot reconstruct failed trades for post-mortem analysis. | observability | HIGH (95%) | Populate these fields from execution result data in the caller (`engine.ts`). | 3.3 |
| 9 | Health Check | `services/execution-engine/src/index.ts:140` | Execution engine `/ready` endpoint only checks `engine.isRunning()`. Does not verify Redis connectivity or provider health. Reports "ready" when unable to process work. | observability | HIGH (85%) | Add Redis ping and provider health count to readiness check. | 3.2 |
| 10 | Data Integrity | All dedup layers | Dedup layers 2-4 are in-memory (lost on restart). Layer 1 uses Redis with 30s TTL. After restart, PEL recovery (XCLAIM) may deliver messages past the 30s dedup window, causing duplicate opportunity processing. | data-integrity | MEDIUM (78%) | Extend Redis dedup TTL to at least match XCLAIM `minIdleMs` threshold. | 3.1 |
| 11 | Chain Config | `shared/config/src/chains/index.ts:97,229` | Opportunity TTL is not chain-aware. Arbitrum (0.25s blocks) uses same TTL as Ethereum (12s blocks). Stale opportunities on fast chains, missed opportunities on slow chains. | cross-chain | HIGH (90%) | Scale opportunity TTL using `BLOCK_TIMES_MS` per chain (data already exists in config). | 3.0 |
| 12 | Failure Mode | Redis dependency | No circuit breaker for Redis itself. If Redis becomes slow (not down), operations hang until timeout. Rate limiter fails CLOSED (correct for security) but Redis slowness cascades to all consumers. | failure-mode | MEDIUM (75%) | Add Redis operation timeout with fast-fail behavior. Consider Redis-specific circuit breaker with latency threshold. | 2.9 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 13 | Data Integrity | `publishing-service.ts:403-410` | No schema version field in stream messages. During rolling deployments, message validation failures cause temporary opportunity loss. DLQ captures but mass DLQ entries during deploys. | data-integrity | MEDIUM (75%) | Add `schemaVersion` field to message envelope. Consumers handle version mismatches gracefully before DLQ routing. | 2.8 |
| 14 | Data Integrity | `redis-streams.ts:536` | No centralized consumer lag alerting before MAXLEN trimming. Per-consumer lag monitoring exists but no centralized alarm. Sustained consumer downtime on high-volume streams risks message loss. | data-integrity | HIGH (88%) | Add centralized consumer lag monitoring job. Alert when `pendingCount` approaches MAXLEN threshold. | 2.7 |
| 15 | Observability | `bridge-recovery-manager.ts:288` | Bridge recovery `RecoveryMetrics` struct exists in-memory but not exposed via HTTP endpoint. Cannot monitor recovery operations from Grafana/external alerts. | observability | HIGH (90%) | Expose metrics via `/api/bridge-recovery/metrics` endpoint. | 2.6 |
| 16 | Observability | `arbitrage-detector.ts:316-322` | `enrichWithLiquidityData()` modifies `expectedProfit` and `confidence` with NO logging of the adjustment. Debugging slippage adjustments is opaque. | observability | HIGH (90%) | Add `logger.debug` with original vs adjusted profit, slippage estimate, and pool addresses. | 2.5 |
| 17 | Config Drift | `services/execution-engine/src/services/provider.service.ts:267` | Health check interval hardcoded to 30000ms. `.env.example` defines `HEALTH_CHECK_INTERVAL_MS=10000` but provider service doesn't consume it. Config drift between engine and provider health checks. | config-drift | HIGH (95%) | Replace hardcoded value with `HEALTH_CHECK_INTERVAL_MS ?? 30000` or new `PROVIDER_HEALTH_CHECK_INTERVAL_MS`. | 2.5 |
| 18 | Config Drift | `services/execution-engine/src/services/provider.service.ts:331` | Reconnection threshold hardcoded `>= 3`. `.env.example` defines `FAILOVER_THRESHOLD=3` but provider service doesn't consume it. Should reference engine config. | config-drift | HIGH (90%) | Read `FAILOVER_THRESHOLD` from env or pass via constructor injection. | 2.4 |
| 19 | Latency | `shared/core/src/components/arbitrage-detector.ts:618` | `[...chainPrices].sort()` spread+sort creates new array on every cross-chain check in hot path. | latency-profiler | HIGH (90%) | Replace sort with min/max scan (O(n) with no allocation). | 2.3 |
| 20 | Observability | `shared/core/src/risk/execution-probability-tracker.ts` | `ExecutionProbabilityTracker.getStats()` available programmatically but not exposed via HTTP endpoint. Cannot externally monitor risk model calibration. | observability | MEDIUM (75%) | Expose via `/api/risk/probability-stats` endpoint. | 2.2 |
| 21 | Latency | `shared/core/src/analytics/liquidity-depth-analyzer.ts:39-43` | `floatToBigInt18()` uses `toFixed(18).split('.')` creating 3+ string allocations per depth level (up to 10 per analysis). | latency-profiler | HIGH (90%) | Replace with `BigInt(Math.round(value * 1e18))` for trade-size USD values. | 2.1 |
| 22 | Chain Config | `shared/config/src/dex-factories.ts:655` | Curve factory address is StableSwap Factory only. Legacy high-TVL Curve pools (3pool, etc.) deployed directly won't be discovered. Main Registry `0x90E00ACe...` not included. | cross-chain | MEDIUM (70%) | Add Curve main Registry address for legacy pool discovery. | 2.0 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 23 | Config Drift | feature-flags.ts | 5 feature flags missing from `.env.example`: `FEATURE_DEST_CHAIN_FLASH_LOAN`, `FEATURE_MOMENTUM_TRACKING`, `FEATURE_ML_SIGNAL_SCORING`, `FEATURE_SIGNAL_CACHE_READ`, `FEATURE_LIQUIDITY_DEPTH_SIZING`. | config-drift | HIGH (95%) | Document in `.env.example` with descriptions and defaults. | 1.9 |
| 24 | Chain Config | `shared/config/src/tokens/index.ts:230` | Fallback token prices last updated 2026-02-15 (8 days ago). Beyond 7-day staleness threshold. Gas cost estimation using fallback prices is inaccurate. | cross-chain | HIGH (95%) | Update fallback prices to current values. | 1.8 |
| 25 | Chain Config | `services/partition-solana/src/arbitrage-detector.ts:25` | Solana P4 hardcodes `MIN_PROFIT_USD = 0.50`. Not aligned with configurable EVM partition thresholds. | cross-chain | HIGH (95%) | Make configurable via env var or thresholds config. | 1.7 |
| 26 | Config Drift | Fly.io toml vs code | Execution engine port: code default 3005, Fly.io 8080. Intentional but undocumented. | config-drift | HIGH (95%) | Add comment in `.env.example` or CONFIGURATION.md. | 1.6 |
| 27 | Data Integrity | `hmac-utils.ts:52` | Hash HMAC does not include hash key in input (unlike Streams which include stream name). Theoretical data relocation without detection. | data-integrity | HIGH (90%) | Include Redis hash key in HMAC input. | 1.5 |
| 28 | Observability | `performance-utils.ts:165`, `cross-chain-detector/detector.ts:797` | Silent `.catch(() => {})` on fire-and-forget promises with no logging. | observability | MEDIUM (80%) | Add `logger.debug` in catch blocks. | 1.4 |
| 29 | Latency | `shared/core/src/risk/execution-probability-tracker.ts:729` | Key cache eviction creates `Array.from(keys).slice()` — up to 500 keys. Not hot path but unnecessary allocation. | latency-profiler | HIGH (90%) | Iterate with `for..of` and break at count. | 1.3 |
| 30 | Data Integrity | `price-matrix.ts:570` | `dataView.setFloat64` is not atomic. Seqlock protocol handles this correctly (torn reads detected and retried). Theoretical concern only. | data-integrity | HIGH (93%) | No fix needed — seqlock is correct. Documented for awareness. | N/A |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck? |
|-------|-----------|-----------|-------------------|-------------|
| 1 | WebSocket JSON.parse | Main thread, inline | 0.1-0.5ms | No |
| 2 | L1 PriceMatrix write (setPrice) | `price-matrix.ts:513` | 2-10us | No |
| 3 | Sequence counter protocol (Atomics) | `price-matrix.ts:566-573` | 0.5-2us | No |
| 4 | StreamBatcher queue + timer | `redis-streams.ts:158-198` | <0.01ms | No |
| 5 | **StreamBatcher flush wait** | `publishing-service.ts:72-73` | **5ms max** + Redis RTT | **YES** |
| 6 | XADD to Redis (price update batch) | `redis-streams.ts:509-567` | 1-5ms (network) | Potential |
| 7 | HMAC-SHA256 signing per batch | `redis-streams.ts:439-443` | 0.02-0.05ms | No |
| 8 | Blocking XREADGROUP | `redis-streams.ts:1339-1343` | <1ms | No |
| 9 | HMAC verification on read | `redis-streams.ts:1074-1089` | 0.05-0.15ms | No |
| 10 | Detection: detectArbitrage() | `arbitrage-detector.ts:175-278` | 0.01-0.1ms per pair | No |
| 11 | Detection: batch O(n^2) comparison | `arbitrage-detector.ts:301-327` | 0.1-5ms | Potential |
| 12 | **NEW: Liquidity enrichment** | `arbitrage-detector.ts:316-322` | **0.5-25ms** | **YES (P0)** |
| 13 | Opportunity publish (direct XADD) | Publishing service | 1-5ms (Redis RTT) | Potential |
| 14 | Execution engine XREADGROUP | Consumer, blockMs=200 | <1ms | No |
| 15 | Distributed lock acquisition | Lock manager Redis SETNX | 1-5ms | Potential |
| **TOTAL** | | | **10-50ms typical** | **Margin thin** |

**Impact of git diff on latency budget:** The new LiquidityDepthAnalyzer enrichment (stage 12) is the only change that materially affects the hot path. The probability tracker persistence and LST normalization operate asynchronously or with O(1) cached lookups — negligible impact.

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| F1 | Redis XADD | Redis unavailable | xadd throws | Retry with backoff | Messages dropped if retries exhausted | `redis-streams.ts:526` |
| F2 | Stream consumer | XREADGROUP timeout | Empty return | Re-enters poll loop | None (PEL preserves) | `opportunity.consumer.ts` |
| F3 | Message validation | Malformed message | validateMessageStructure | ACK + move to DLQ | None (DLQ preserves) | `opportunity.consumer.ts:436-548` |
| F4 | Queue backpressure | Queue full (HWM) | canEnqueue() false | Do NOT ACK → PEL redelivery | None | `queue.service.ts:92-98` |
| F5 | Execution | Circuit breaker OPEN | cbManager.canExecute() | Auto-recovery (cooldown → HALF_OPEN → CLOSED) | Opportunity skipped | `circuit-breaker.ts:334-372` |
| F6 | RPC provider | Provider unhealthy | Health check 30s, failures counter | Auto-reconnection | None (replaced) | `provider.service.ts:226-267` |
| F7 | Bridge operation | Service restart mid-bridge | Redis `bridge:recovery:*` scan | BridgeRecoveryManager periodic (60s) | Low (persisted to Redis) | `bridge-recovery-manager.ts:155-188` |
| F8 | Bridge operation | Bridge timeout (>72h) | maxAgeMs check | Marked abandoned | **Funds at risk** | `bridge-recovery-manager.ts:222-301` |
| F9 | Probability tracker | Redis persist failure | catch + warn log | Fire-and-forget retry | 10 outcomes lost | `execution-probability-tracker.ts:504-537` |
| F10 | Publishing | Batcher queue full | maxQueueSize check | Warning logged, message dropped | **Price updates lost** | `redis-streams.ts:164-172` |
| F11 | Shutdown | Timeout exceeded (10s) | Force-exit timer | process.exit(1) | In-flight executions may not ACK | `service-bootstrap.ts:141-144` |
| F12 | Shutdown | Probability tracker | Nullified without destroy() | None | **Up to 10 outcomes lost** | `engine.ts:817` |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| CC-1 | Arbitrum, Optimism, Base, zkSync, Linea | L1 data fee not modeled (feature flag OFF by default) | Gas underestimated 2-10x | **P0** | `feature-flags.ts:203` |
| CC-2 | Arbitrum, Optimism | 72h bridge TTL < 7-day challenge period | Funds at risk | **P0** | `types.ts:1178` |
| CC-3 | All chains | Opportunity TTL not chain-aware | Stale opps on fast chains | P1 | `chains/index.ts:97,229` |
| CC-4 | Solana | Hardcoded MIN_PROFIT_USD = 0.50 | Threshold inconsistency | P3 | `arbitrage-detector.ts:25` |
| CC-5 | zkSync | No AA-specific gas model | Inaccurate gas estimation | P2 | No explicit handling found |
| CC-6 | Ethereum | Curve factory only (no main Registry) | Legacy pools not discovered | P2 | `dex-factories.ts:655` |
| CC-7 | All | Fallback prices 8 days stale | Inaccurate gas cost estimation | P3 | `tokens/index.ts:230` |
| CC-8 | Solana | COMMON_TOKEN_DECIMALS lacks SOL tokens | 10^9 magnitude error for unknown SPL tokens | P2 | `tokens/index.ts:582` |

---

## Observability Assessment

### Trace Propagation Map

```
WebSocket → Partition Detector → Publishing Service → Redis Stream → Coordinator → Execution Consumer → Execution Pipeline → Trade Logger
    ✅            ✅ (P1-P3)            ✅                 ✅              ✅              ✅                    ✅                ✅
                   ❌ (P4 Solana)
                   ❌ (Cross-Chain Detector)
```

**Gap**: Solana partition and cross-chain-detector do not propagate trace context. End-to-end debugging impossible for these services.

### Log Coverage Summary

- **Excellent**: Execution pipeline, bridge recovery, coordinator
- **Good**: WebSocket events, opportunity publishing, risk management init
- **Gap**: Detection functions (pure, no logger by design), liquidity enrichment adjustments (silent profit modification)

### Blind Spots (MEDIUM severity)

- `performance-utils.ts:165` — silent `.catch(() => {})` on fire-and-forget
- `cross-chain-detector/detector.ts:797` — `scheduleRefresh().catch(() => {})` silently ignored

### Trade Audit Trail Gaps

4 fields defined but never populated: `slippage`, `retryCount`, `blockNumber`, `route`. These prevent post-mortem trade reconstruction.

### Metrics Gaps

- Bridge recovery metrics: in-memory only, not HTTP-exposed
- Probability tracker stats: in-memory only, not HTTP-exposed
- Detection rate per chain/DEX pair: not measured
- False positive rate: not measured
- WebSocket reconnection rate per chain: not measured

### Health Check Gaps

- Execution engine `/ready`: does not check Redis or provider health
- Partition `/ready`: does not check WebSocket connections
- Cross-chain-detector: no health endpoint found

---

## Configuration Health

### Feature Flag Audit

**All 13 `FEATURE_*` flags use correct `=== 'true'` opt-in pattern.** No violations.
**All 11 `!== 'false'` safety-default patterns are intentional and correct.**

5 feature flags undocumented in `.env.example`:
- `FEATURE_DEST_CHAIN_FLASH_LOAN`
- `FEATURE_MOMENTUM_TRACKING`
- `FEATURE_ML_SIGNAL_SCORING`
- `FEATURE_SIGNAL_CACHE_READ`
- `FEATURE_LIQUIDITY_DEPTH_SIZING`

### || vs ?? Violations

**Only 1 genuine source-code violation found**: `circuit-breaker-manager.ts:288` (`parseInt(state.timestamp, 10) || 0`). Cosmetic — `parseInt` returns NaN not 0, so `??` would not catch it either. The existing pattern is technically correct but inconsistent with project convention.

**All `|| ''` and `|| false` patterns verified as appropriate.**

### Config Drift

| Drift | Source | Target | Severity |
|-------|--------|--------|----------|
| Provider health interval | Code: 30000ms | `.env.example`: 10000ms | MEDIUM |
| Reconnection threshold | Code: 3 | `.env.example`: `FAILOVER_THRESHOLD=3` | MEDIUM |
| Execution engine port | Code: 3005 | Fly.io: 8080 | LOW (intentional) |

### Threshold Assessment

All per-chain gas price thresholds verified as appropriate for current market conditions.

---

## Cross-Agent Insights

### Information Separation Results (Agent 2 vs Agent 3)

The failure-mode-analyst and data-integrity-auditor independently analyzed Redis Streams behavior:

| Area | Agent 2 (Failure Mode) | Agent 3 (Data Integrity) | Agreement |
|------|----------------------|-------------------------|-----------|
| Delivery semantics | At-least-once | At-least-once | **AGREE** |
| PEL backpressure | Correct (leave unacked) | Correct (PEL preserves) | **AGREE** |
| Shutdown ACK safety | Well-implemented (W2-5 fix) | Well-implemented (in-flight separated) | **AGREE** |
| Stream DLQ | Write-only, no consumer | N/A (different focus) | **Complementary** |
| Dedup restart gap | N/A (different focus) | 30s TTL may not cover XCLAIM window | **Complementary** |
| Probability tracker persistence | Not destroyed on shutdown | Positive for integrity (HMAC signed) | **Complementary** |

**No contradictions found.** The two agents' findings are complementary rather than conflicting, which increases confidence in both sets of findings.

### Multi-Agent Cross-References

1. **Bridge recovery TTL**: Cross-chain-analyst identified the 7-day Arbitrum/Optimism mismatch. Failure-mode-analyst independently found bridge recovery keys lack Redis TTL. Combined finding is stronger than either alone.

2. **Liquidity enrichment**: Latency-profiler found the hot-path cost. Observability-auditor found no logging of profit adjustments. These are related — the enrichment both adds latency AND is opaque to operators.

3. **Provider health check**: Config-drift-detector found the hardcoded 30s interval. Observability-auditor found the `/ready` endpoint doesn't check provider health. Both point to provider health monitoring gaps.

---

## Conflict Resolutions

No conflicts between agents were identified. All findings are either in agreement (Redis Streams analysis) or address non-overlapping concerns.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)

- [ ] **Fix #1**: Enable `FEATURE_DYNAMIC_L1_FEES` by default for L2 rollups (cross-chain, Score: 4.1)
- [ ] **Fix #2**: Gate `enrichWithLiquidityData()` to top-K candidates only, after sorting by profit (latency-profiler, Score: 3.7)
- [ ] **Fix #3**: Make `BRIDGE_RECOVERY_MAX_AGE_MS` configurable per bridge type; add Redis key TTL (cross-chain + failure-mode, Score: 3.7)
- [ ] **Fix #4**: Call `probabilityTracker.destroy()` in `engine.stop()` instead of nullifying (failure-mode, Score: 3.6)

### Phase 2: Next Sprint (P1 — reliability and coverage)

- [ ] **Fix #5**: Prevent depth cache thrashing — only invalidate on >1% reserve change (latency-profiler, Score: 3.5)
- [ ] **Fix #6**: Add consumer or alerting for stream-based DLQ (failure-mode, Score: 3.4)
- [ ] **Fix #7**: Add trace context to Solana partition and cross-chain-detector (observability, Score: 3.4)
- [ ] **Fix #8**: Populate `slippage`, `retryCount`, `blockNumber`, `route` in trade logger (observability, Score: 3.3)
- [ ] **Fix #9**: Enhance execution engine `/ready` to check Redis and provider health (observability, Score: 3.2)
- [ ] **Fix #10**: Extend Redis dedup TTL to match XCLAIM minIdleMs threshold (data-integrity, Score: 3.1)
- [ ] **Fix #11**: Make opportunity TTL chain-aware using BLOCK_TIMES_MS (cross-chain, Score: 3.0)
- [ ] **Fix #12**: Add Redis operation timeout / fast-fail for slow Redis (failure-mode, Score: 2.9)

### Phase 3: Backlog (P2/P3 — hardening and optimization)

- [ ] **Fix #13**: Add schema version field to stream messages (data-integrity, Score: 2.8)
- [ ] **Fix #14**: Add centralized consumer lag alerting (data-integrity, Score: 2.7)
- [ ] **Fix #15**: Expose bridge recovery metrics via HTTP (observability, Score: 2.6)
- [ ] **Fix #16**: Add logging to `enrichWithLiquidityData()` for profit adjustments (observability, Score: 2.5)
- [ ] **Fix #17**: Make provider health check interval configurable (config-drift, Score: 2.5)
- [ ] **Fix #18**: Make provider reconnection threshold configurable (config-drift, Score: 2.4)
- [ ] **Fix #19**: Replace spread+sort with min/max scan in cross-chain detection (latency-profiler, Score: 2.3)
- [ ] **Fix #20**: Expose probability tracker stats via HTTP (observability, Score: 2.2)
- [ ] **Fix #21**: Replace `floatToBigInt18` string ops with math (latency-profiler, Score: 2.1)
- [ ] **Fix #22**: Add Curve main Registry for legacy pool discovery (cross-chain, Score: 2.0)
- [ ] **Fix #23**: Document 5 missing feature flags in `.env.example` (config-drift, Score: 1.9)
- [ ] **Fix #24**: Update stale fallback token prices (cross-chain, Score: 1.8)
- [ ] **Fix #25**: Make Solana MIN_PROFIT_USD configurable (cross-chain, Score: 1.7)

---

## Appendix A: LST Normalization Review (Verified Correct)

The two-level normalization system added in the git diff is **correctly designed and implemented**:

- **Level 1** (`normalizeTokenForCrossChain`): Maps LSTs to underlying (mSOL→SOL). Correct for bridge routing.
- **Level 2** (`normalizeTokenForPricing`): Preserves LST identity (mSOL→MSOL). Correct for arbitrage detection.
- Both functions use separate FIFO-eviction caches with 1000-entry limit.
- 21 LST symbols in `LIQUID_STAKING_TOKENS` set.
- Cross-chain test coverage added (81 lines in `cross-chain.test.ts`).

## Appendix B: New Ethereum DEX Review (Mostly Correct)

| DEX | Address | Init Code Hash | Status |
|-----|---------|---------------|--------|
| Uniswap V2 | `0x5C69...A6f` | `0x96e8ac...` | Correct |
| SushiSwap | `0xC0AE...f2Ac` | `0xe18a34...` | Correct |
| Curve | `0xB9fC...90d4` | N/A | Partial (factory only, not main registry) |
| Balancer V2 | `0xBA12...BF2C8` | N/A | Correct (Vault address) |

## Appendix C: Methodology

Six specialized agents analyzed the codebase independently:

1. **Latency Profiler** — 8 files read in full, traced 17-stage pipeline, 10 hidden allocations, 5 recommendations
2. **Failure Mode Analyst** — 15+ files analyzed, 12 failure modes mapped, 6 cascading scenarios, 8 recommendations
3. **Data Integrity Auditor** — 7 files read in full, full HMAC chain traced, 4 dedup layers analyzed, 5 findings
4. **Cross-Chain Analyst** — 9 files read in full, 11 chains audited, gas model per chain, 12 findings
5. **Observability Auditor** — Grep-heavy scanning (7 patterns), trace propagation mapped, 9 blind spots, 8 recommendations
6. **Config Drift Detector** — Exhaustive grep for || 0 (24 test + 1 source), 13 feature flags verified, 8 recommendations

**Cross-verification**: Agents 2+3 independently analyzed Redis Streams with no contradictions. Agent findings on bridge recovery TTL cross-validated between agents 4+2. All P0/P1 findings verified against ADRs and known correct patterns.

---

*This report represents the synthesized findings of 6 specialized operational analysis agents. All recommendations include specific file:line references, quantified impact estimates, priority scores, and confidence levels. The analysis complements the code-quality focused `/deep-analysis` report.*

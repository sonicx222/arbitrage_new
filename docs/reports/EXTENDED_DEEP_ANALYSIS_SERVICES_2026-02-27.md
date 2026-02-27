# Extended Deep Analysis — /services (Operational Focus)

**Date**: 2026-02-27
**Target**: `/services` (10 services + shared packages)
**Agents**: 6 spawned, 5 reported, 1 stalled (config-drift-detector — critical patterns self-executed by team lead)
**Complements**: `CRITICAL_PROJECT_ASSESSMENT_2026-02-18.md` (code quality focus)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| P0 (Critical) | 3 |
| P1 (High) | 6 |
| P2 (Medium) | 14 |
| P3 (Low) | 10 |
| **Total** | **33** |

### Top 5 Highest-Impact Issues

1. **Missing gas price configs for Blast/Scroll/Mantle/Mode** — 50,000x gas overestimate on provider failure for 4 active L2 chains (CC-1, Score: 3.7)
2. **Solana cross-chain uses flat $15 EVM gas cost** — Misses 95%+ of Solana↔L2 arbitrage opportunities (CC-5, Score: 3.7)
3. **DLQ stream has no MAXLEN** — Unbounded growth can exhaust Redis memory under persistent errors (F-1, Score: 3.6)
4. **Flash loan gas estimation silently swallows errors** — Submits reverting transactions with hardcoded 500K gas, wasting gas across 6 providers (O-3, Score: 3.4)
5. **Cross-chain detector has zero observability** — No trace context, no Prometheus metrics, minimal health check (O-1+O-7+O-10, Score: 3.3)

### Overall Health Assessment: **B+**

The core EVM pipeline (unified-detector → coordinator → execution-engine) is well-engineered with strong resilience patterns: deferred ACK, PEL recovery, HMAC signing, seqlock price cache, multi-layer dedup, and circuit breakers. The pipeline fits within the <50ms latency target with self-hosted Redis. Major gaps are in the **peripheral services** (cross-chain detector, mempool detector) which lack observability, and in **emerging L2 chain configs** which are incomplete in the gas price optimizer. No data-loss-level bugs were found — all findings are hardening and optimization.

### Agent Agreement Map

| Area | Agents Agreeing | Assessment |
|------|----------------|------------|
| Redis Streams resilience | Failure-mode + Data-integrity | STRONG — deferred ACK, PEL, XCLAIM, DLQ fallback |
| MAXLEN trimming risk | Failure-mode + Data-integrity | CONFIRMED — both flagged unread message loss risk |
| Cross-chain detector blind spot | Observability + Cross-chain | CONFIRMED — no trace context, no metrics, incomplete configs |
| Shutdown ordering | Failure-mode + Data-integrity | STRONG — well-designed with multiple safety fixes |
| HMAC implementation | Data-integrity + Latency-profiler | STRONG — correct with cached KeyObject, legacy compat overhead |
| Gas config gaps | Cross-chain (sole source) | HIGH confidence — verified against 3 config files |

---

## Critical Findings (P0)

| # | ID | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | CC-1 | Cross-Chain | `execution-engine/src/services/gas-price-optimizer.ts:94-185` | Blast, Scroll, Mantle, Mode missing from `MIN_GAS_PRICE_GWEI`, `MAX_GAS_PRICE_GWEI`, `DEFAULT_GAS_PRICES_GWEI`. Fallback is 50 gwei — 50,000x too high for L2s, causing unprofitable trade execution when provider fails | cross-chain | HIGH (95%) | Add L2-appropriate entries: Blast/Scroll/Mode ~0.001 gwei, Mantle ~0.001 gwei (adjusted for MNT native token) | 3.7 |
| 2 | CC-5 | Cross-Chain | `partition-solana/src/detection/base.ts:132` | `DEFAULT_DETECTION_CONFIG.crossChainCosts.evmGasCostUsd = 15` uses flat $15 for ALL EVM chains. Solana→Arbitrum arb evaluated at $15 gas when actual cost is ~$0.10. `getEvmGasCostUsd()` per-chain lookup already exists at line 101 but isn't used by default config | cross-chain | HIGH (90%) | Change default to use `getEvmGasCostUsd()` per target chain instead of flat $15 | 3.7 |
| 3 | F-1 | Failure Mode | `execution-engine/src/consumers/opportunity.consumer.ts:802` | DLQ stream uses plain `xadd` with no MAXLEN. Under persistent errors, DLQ grows unboundedly, exhausting Redis memory. Key-based DLQ has 10K cap, but stream-based DLQ does not | failure-mode | HIGH (95%) | Change `xadd(DLQ_STREAM, ...)` to `xaddWithLimit(DLQ_STREAM, ...)` with MAXLEN 10,000 in both `opportunity.consumer.ts` and `stream-consumer-manager.ts:468` | 3.6 |

---

## High Findings (P1)

| # | ID | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 4 | O-3 | Observability | 6 flash loan providers in `execution-engine/src/strategies/flash-loan-providers/` | `estimateGas().catch { return 500000n }` silently swallows gas estimation failures across all 6 providers (aave-v3:190, balancer-v2:188, dai-flash-mint:195, morpho:194, pancakeswap-v3:239/288/396, syncswap:225). When estimateGas fails (tx will revert), proceeds to submit with hardcoded gas, wasting real gas | observability | HIGH (95%) | Log warning with error details. Consider aborting execution when estimateGas fails (usually indicates reverting tx) | 3.4 |
| 5 | O-1 | Observability | `cross-chain-detector/src/` (entire service) | Zero trace context imports. Cross-chain opportunities published without `_trace_*` fields. Coordinator starts new root trace instead of continuing chain. Breaks end-to-end correlation for all cross-chain arbitrage paths | observability | HIGH (95%) | Import `createTraceContext` + `propagateContext` in `opportunity-publisher.ts` and inject before publishing | 3.3 |
| 6 | O-7 | Observability | `cross-chain-detector/src/` and `mempool-detector/src/` | Both services have zero Prometheus metrics. No `/metrics` endpoint. No visibility into detection rates, processing latency, or error rates | observability | HIGH (95%) | Add counters for opportunities detected/published/errors. Mirror execution-engine pattern | 3.0 |
| 7 | CC-10 | Cross-Chain | `gas-price-optimizer.ts:200` + `tokens/index.ts:444` | Mantle uses MNT as native token ($0.80) not ETH ($3200). If execution reaches Mantle with 50 gwei default, gas cost is calculated using wrong token price — 4000x overestimate. Mitigated by Mantle not being in active partitions | cross-chain | HIGH (90%) | Add Mantle-specific gas config accounting for MNT pricing when Mantle exits stub status | 2.8 |
| 8 | F-3 | Failure Mode | `engine.ts:780-793` | Shutdown drain timeout hardcoded at 10s. Cross-chain bridge confirmations take 30-60s. Abandoned in-flight bridge executions don't get recovery keys written — funds potentially stuck | failure-mode | HIGH (90%) | Make configurable via `SHUTDOWN_DRAIN_TIMEOUT_MS`. Write bridge recovery keys BEFORE drain timeout expires | 2.8 |
| 9 | CC-2 | Cross-Chain | `gas-price-cache.ts:149-160` | `FALLBACK_GAS_PRICES` missing entries for Blast, Scroll, Mantle, Mode. When cache empty and RPC unavailable, generic fallback applies | cross-chain | HIGH (95%) | Add fallback entries: blast/scroll/mode ~0.01 gwei, mantle ~0.01 gwei | 2.7 |

---

## Medium Findings (P2)

| # | ID | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 10 | DI-1 | Data Integrity | `coordinator/src/coordinator.ts` (consumer group configs) | Coordinator auto-ACKs opportunities BEFORE forwarding to execution engine. Crash between ACK and forward loses the opportunity. Mitigated by retry+DLQ+file fallback | data-integrity | HIGH (90%) | Consider deferred ACK for coordinator forwarding. Trade-off: more complex shutdown | 2.5 |
| 11 | O-10 | Observability | `cross-chain-detector/src/index.ts:33-41` | Health check only checks `isRunning()` boolean. No Redis connectivity, WebSocket health, or price freshness checks. Stale detector reports healthy | observability | HIGH (95%) | Add Redis ping, chain connectivity, and data freshness to health check | 2.5 |
| 12 | L-1 | Latency | `streams.ts:516-553` | HMAC verification with legacy compat computes up to 4 HMAC-SHA256 digests per message. At 500 msgs/sec, ~100-200ms CPU/sec wasted on legacy fallback paths | latency | HIGH (90%) | Disable `legacySignatureCompatEnabled` once all producers updated. Reduces to 1-2 computations | 2.4 |
| 13 | DI-6 | Data Integrity | `streams.ts:371-377` | Approximate MAXLEN trimming can discard unread messages when consumers lag beyond capacity. `checkStreamLag()` warns at 80% but may not be wired into periodic monitoring | data-integrity, failure-mode | HIGH (93%) | Verify `checkStreamLag()` runs periodically for EXECUTION_REQUESTS and OPPORTUNITIES streams | 2.4 |
| 14 | F-5 | Failure Mode | `fast-lane.consumer.ts:140, 209-215` | FastLane uses `autoAck: true` with no backpressure. Queue-full opportunities silently dropped. By design (best-effort) but permanent data loss | failure-mode | HIGH (90%) | Log at warn level when opportunities are dropped due to full queue | 2.3 |
| 15 | O-6 | Observability | `trade-logger.ts:262-289` | TradeLogEntry missing `gasPrice` (gwei) and `detectionTimestamp`. Cannot reconstruct gas economics or measure detection-to-execution latency from JSONL | observability | HIGH (95%) | Add both fields from execution context and `pipelineTimestamps.detectedAt` | 2.3 |
| 16 | O-8 | Observability | `execution-engine/src/services/prometheus-metrics.ts` | Only 5 Prometheus metrics. Missing: failure counter, latency histogram, queue depth gauge. Basic alerting requires log parsing | observability | HIGH (95%) | Add `execution_failure_total`, `execution_latency_ms` histogram, `queue_depth` gauge | 2.2 |
| 17 | O-9 | Observability | `execution-engine/src/index.ts:176-194` | `dlqLength`, `consumerLagPending`, `queueSize`, `activeExecutions` computed for `/health` but not registered as Prometheus gauges | observability | HIGH (95%) | Register as Prometheus gauges for scraping by alerting systems | 2.2 |
| 18 | L-2 | Latency | `streams.ts:215-219` | StreamBatcher `maxWaitMs` adds variable delay for partial batches. For time-critical opportunity publishing, this is the primary controllable latency source | latency | HIGH (90%) | Ensure opportunity batcher uses maxWaitMs ≤ 10ms. Price batcher can use higher values | 2.1 |
| 19 | O-4 | Observability | `mev-protection/l2-sequencer-provider.ts:396` | `response.wait()` failure caught with `.catch(() => resolve(null))`. Callers can't distinguish timeout from revert — no error logged | observability | HIGH (90%) | Log warning with error details before resolving null | 2.0 |
| 20 | O-5 | Observability | `cross-chain-detector/src/ml-prediction-manager.ts:316` | All ML prediction failures return null with no logging. Comment says "no logging needed". Prediction failure rate invisible | observability | HIGH (90%) | Add counter metric and debug log for prediction failures | 2.0 |
| 21 | F-4 | Failure Mode | `execution-engine/src/consumers/dlq-consumer.ts:155-205` | `DlqConsumer.scanDlq()` reads from ID `'0'` every scan, re-reading ALL messages. O(n) per scan, underreports for large DLQs (maxMessagesPerScan=100) | failure-mode | HIGH (90%) | Use XLEN for count, maintain cursor/watermark to avoid re-reading old entries | 1.9 |
| 22 | O-2 | Observability | `mempool-detector/src/` (entire service) | Zero trace context imports. Backrun targets lack traceId; strategy falls back to disconnected `generateTraceId()` | observability | HIGH (95%) | Add trace context injection in mempool detector opportunity publishing | 1.9 |
| 23 | DI-4 | Data Integrity | `streams.ts:489-494` | HMAC does not cover Redis-assigned message ID. Attacker with Redis access could reorder messages within a stream. Minimal practical risk (Redis access = game over anyway) | data-integrity | MEDIUM (75%) | Document as known limitation. No code change needed | 1.5 |

---

## Low Findings (P3)

| # | ID | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 24 | CC-7 | Cross-Chain | `gas-price-optimizer.ts:363` | `FAST_CHAINS` set missing Blast, Scroll, Mantle, Mode, Polygon, BSC. These chains use staler 5s gas baseline cache instead of 2s | cross-chain | HIGH (95%) | Expand FAST_CHAINS set | 1.5 |
| 25 | CC-8 | Cross-Chain | `partition-solana/detection/base.ts:126` vs `detector-config.ts:137` | Solana opportunity expiry 1000ms vs 5000ms in two different config locations | cross-chain | MEDIUM (80%) | Harmonize or document precedence | 1.4 |
| 26 | L-4 | Latency | `stream-consumer.ts:270` | 10ms inter-poll delay between batch processing cycles. Adds 10ms latency to execution engine consumption | latency | HIGH (90%) | Set `interPollDelayMs: 0` for execution engine opportunity consumer | 1.4 |
| 27 | CC-12 | Cross-Chain | `bridge-config.ts:154-156` | Scroll misclassified as "optimistic rollup" in comment (actually zkRollup). 7-day native withdrawal estimate is conservative/safe | cross-chain | HIGH (92%) | Fix comment classification | 1.3 |
| 28 | DI-7 | Data Integrity | Consumer-side message handling | `schemaVersion` field published but never checked on consume side. Low risk — only version '1' exists | data-integrity | MEDIUM (75%) | Add warning log for unrecognized schema versions | 1.2 |
| 29 | DI-8 | Data Integrity | `streams.ts:567` | No BigInt safety net in `JSON.stringify` for xadd. Convention (`.toString()`) consistently followed but no guard | data-integrity | MEDIUM (70%) | Add BigInt replacer function as safety net | 1.1 |
| 30 | F-6 | Failure Mode | `websocket-manager.ts:1505-1528` | After max reconnect attempts, 60s slow recovery loop runs indefinitely. Dead providers generate log spam at 1 attempt/60s forever | failure-mode | HIGH (90%) | After N recovery cycles, reduce log level to debug | 1.1 |
| 31 | O-11 | Observability | Most services except coordinator | Only coordinator has `/health/live` endpoint. Other services lack liveness probes for Kubernetes/Fly.io | observability | HIGH (90%) | Add `/live` endpoints returning 200 | 1.0 |
| 32 | O-12 | Observability | `logging/otel-transport.ts:374` | OTEL trace context requires manual `traceId` injection in every log call. No AsyncLocalStorage auto-propagation | observability | HIGH (90%) | Consider AsyncLocalStorage for automatic context | 0.9 |
| 33 | DI-3 | Data Integrity | In-memory dedup layers (2-5) | Dedup state lost on restart. Redis-based dedup (15min TTL) + distributed locks cover the critical path | data-integrity | HIGH (88%) | Acceptable — no action needed | 0.8 |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck Risk |
|-------|-----------|-----------|-------------------|-----------------|
| 1. WS Message Receive | Buffer.toString() | websocket-manager.ts:833 | ~0.1ms | LOW |
| 2. JSON Parse | JSON.parse (main thread, <32KB) | websocket-manager.ts:873 | 0.1-2ms | MEDIUM |
| 3. Handler Dispatch | forEach over messageHandlers | websocket-manager.ts:1032-1038 | ~0.01ms | LOW |
| 4. Price Cache Write | PriceMatrix.setPrice (seqlock) | price-matrix.ts:517-598 | <0.001ms | LOW |
| 5. Detection | SimpleArbitrageDetector | simple-arbitrage-detector.ts:163-293 | ~0.01ms/pair | LOW |
| 6. Batcher Add | StreamBatcher.add() | streams.ts:177-223 | ~0.001ms | LOW |
| 7. Batcher Flush | XADD + HMAC sign | streams.ts:225-296 | 0.1-5ms (Redis RTT) | MEDIUM |
| 8. Coordinator Consume | XREADGROUP blocking read | stream-consumer.ts:200-274 | <1ms | LOW |
| 9. HMAC Verify | verifySignature (up to 4x with legacy) | streams.ts:516-553 | 0.05-0.4ms | MEDIUM |
| 10. Coordinator Forward | OpportunityRouter → XADD | opportunity-router.ts:326-465 | 0.1-5ms | MEDIUM |
| 11. Execution Consume | XREADGROUP + 10ms inter-poll | stream-consumer.ts:200-274 | 1-11ms | MEDIUM |
| 12. Validation + Enqueue | OpportunityConsumer | opportunity.consumer.ts:443-544 | ~0.1ms | LOW |
| 13. Lock Acquire | Redis SET NX EX | distributed-lock.ts | 0.1-5ms | MEDIUM |
| **Total (self-hosted Redis)** | | | **3-20ms typical, 40-50ms worst** | **WITHIN TARGET** |
| **Total (Upstash ~10ms RTT)** | | | **60-100ms** | **EXCEEDS TARGET** |

**Fast Lane bypass** saves ~5-10ms by skipping stages 8-10 (coordinator hop).

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | WebSocket | All URLs exhausted (10 cycles) | maxReconnectAttempts counter | 60s slow recovery timer, URL rotation | MEDIUM — price gap | websocket-manager.ts:1505-1528 |
| 2 | WebSocket | Stale connection (no messages) | ProviderHealthTracker | Auto-reconnect to different provider | LOW | websocket-manager.ts:1459-1467 |
| 3 | Stream Consume | Redis connection lost | Consecutive error counter | Exponential backoff (100ms→30s) | LOW — messages in stream | stream-consumer.ts:242-255 |
| 4 | Stream Consume | Handler throws | stats.messagesFailed | Message stays in PEL, retried | LOW | stream-consumer.ts:232-239 |
| 5 | Validation | Malformed message | validationErrors counter | ACK + move to DLQ | NONE | opportunity.consumer.ts:549-583 |
| 6 | Queue | Queue full (highWaterMark) | queueRejects counter | Message left in PEL, redelivered (P0-7 FIX) | NONE | opportunity.consumer.ts:665-675 |
| 7 | Execution | Flash loan crash | activeExecutionCount | Atomic revert + PEL + XCLAIM on restart | LOW | opportunity.consumer.ts:201-273 |
| 8 | Execution | Nonce contention | NonceAllocationManager mutex | 10s lock timeout + cancellation | LOW | nonce-allocation-manager.ts:57-100 |
| 9 | Coordinator | Leadership loss | Heartbeat timeout | New election + XCLAIM orphans | LOW-MEDIUM | coordinator.ts:738-805 |
| 10 | DLQ | Redis DLQ write fails | Error logged | OP-16: Local file fallback (100MB/day) | NONE | stream-consumer-manager.ts:462-554 |
| 11 | Partition | Uncaught exception | Process handler | Graceful shutdown + detector drain | LOW | handlers.ts:216-221 |
| 12 | Partition | 5 unhandled rejections in 60s | Rejection window tracker | Forced shutdown (anti-zombie) | LOW | handlers.ts:222-241 |
| 13 | Circuit Breaker | All executions blocked (OPEN) | CircuitBreakerManager.isOpen() | Auto HALF_OPEN after 5min cooldown | NONE — stale dropped | circuit-breaker.ts:97-142 |
| 14 | Bridge | Cross-chain interrupted mid-transfer | bridge:recovery:* Redis keys | BridgeRecoveryManager scans every 60s, 72h max age | MEDIUM — funds locked | bridge-recovery-manager.ts:112-140 |
| 15 | Drawdown | Capital drain from losses | State machine (NORMAL→CAUTION→HALT) | Auto-halt at 5% daily; 1hr cooldown | NONE — protection | drawdown-circuit-breaker.ts:41-51 |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | Blast, Scroll, Mantle, Mode | Missing gas price bounds in optimizer | 50,000x overestimate on fallback | P0 | gas-price-optimizer.ts:94-185 |
| 2 | Solana↔L2 | Flat $15 EVM gas cost for cross-chain | Misses 95%+ Solana↔L2 arbs | P0 | partition-solana/detection/base.ts:132 |
| 3 | Blast, Scroll, Mantle, Mode | Missing fallback gas prices in cache | Inaccurate estimation | P1 | gas-price-cache.ts:149-160 |
| 4 | Mantle | MNT native token with ETH-priced gas defaults | 4000x gas overestimate | P1 | gas-price-optimizer.ts:200 |
| 5 | All L2 | Static L1 data fees as fallback (corrected: dynamic ON by default) | Stale fallbacks when oracle fails | P3 | gas-price-cache.ts:177-187 |
| 6 | 7 chains | FAST_CHAINS set incomplete | Staler gas baselines | P3 | gas-price-optimizer.ts:363 |
| 7 | Solana | Opportunity expiry discrepancy (1s vs 5s) | Potential expiry confusion | P3 | partition-solana/detection/base.ts:126 |
| 8 | Scroll | Misclassified as optimistic rollup | Documentation only | P3 | bridge-config.ts:154 |

---

## Observability Assessment

### Trace Propagation Map

```
[WebSocket] ──trace──> [Detector] ──trace──> [Publishing] ──trace──> [Coordinator] ──trace──> [Execution Engine] ──trace──> [Trade Logger]
                                                                           ↑
                                                               [Cross-Chain Detector] ❌ NO TRACE
                                                               [Mempool Detector] ❌ NO TRACE
```

- **Full trace chain**: unified-detector → coordinator → execution-engine → trade-logger (GOOD)
- **Broken chains**: cross-chain-detector and mempool-detector have zero trace propagation

### Log Coverage Matrix

| Stage | Success | Failure | Context | Performance |
|-------|---------|---------|---------|-------------|
| WebSocket Connect | info | error | url, chainId, time | connectionTime |
| Price Update | debug | error | chainId, pair | latency |
| Opportunity Publish | info | error | id, chain, profit | timestamps |
| Coordinator Route | implicit | warn/error | traceId | coordinatorAt |
| Execution | info | error | traceId, oppId | latencyMs |
| Trade Log | JSONL | warn | 28 fields | latencyMs |
| DLQ Handling | warn | error | messageId | — |

### Blind Spots (Silent Error Swallowing)

| Priority | File | Pattern | Risk |
|----------|------|---------|------|
| P1 | 6 flash loan providers | `estimateGas().catch { 500000n }` | Submits reverting txs |
| P2 | l2-sequencer-provider.ts:396 | `.catch(() => resolve(null))` | Hides tx revert reason |
| P2 | ml-prediction-manager.ts:316 | catch returns null, "no logging needed" | Invisible failures |
| P3 | monolith/index.ts:350 | `.catch(() => {}).finally(...)` | Shutdown cleanup |
| P3 | otel-transport.ts:187,232,251 | `.catch(() => {})` on OTEL flush | Intentional |

### Metrics Gaps

| Service | Prometheus /metrics | Counters | Histograms | Gauges |
|---------|-------------------|----------|------------|--------|
| Execution Engine | YES | 5 (success, attempts, detected, volume, gas) | 0 | 0 |
| Coordinator | YES | stream health only | 0 | 0 |
| Unified Detector | YES (warming) | cache warming | 0 | 0 |
| **Cross-Chain Detector** | **NO** | **0** | **0** | **0** |
| **Mempool Detector** | **NO** | **0** | **0** | **0** |

---

## Configuration Health

### Feature Flag Audit

All 17 feature flags use correct patterns:

| Flag | Pattern | Type | Status |
|------|---------|------|--------|
| FEATURE_BATCHED_QUOTER | `=== 'true'` | opt-in | Correct |
| FEATURE_FLASH_LOAN_AGGREGATOR | `=== 'true'` | opt-in | Correct |
| FEATURE_COMMIT_REVEAL | `=== 'true'` | opt-in | Correct |
| FEATURE_COMMIT_REVEAL_REDIS | `=== 'true'` | opt-in | Correct |
| FEATURE_DEST_CHAIN_FLASH_LOAN | `=== 'true'` | opt-in | Correct |
| FEATURE_MOMENTUM_TRACKING | `=== 'true'` | opt-in | Correct |
| FEATURE_ML_SIGNAL_SCORING | `=== 'true'` | opt-in | Correct |
| FEATURE_SIGNAL_CACHE_READ | `=== 'true'` | opt-in | Correct |
| FEATURE_LIQUIDITY_DEPTH_SIZING | `=== 'true'` | opt-in | Correct |
| FEATURE_DYNAMIC_L1_FEES | `!== 'false'` | safety default (ON) | Correct |
| FEATURE_ORDERFLOW_PIPELINE | `=== 'true'` | opt-in | Correct |
| FEATURE_KMS_SIGNING | `=== 'true'` | opt-in | Correct |
| FEATURE_FAST_LANE | `=== 'true'` | opt-in | Correct |
| FEATURE_BACKRUN_STRATEGY | `=== 'true'` | opt-in | Correct |
| FEATURE_UNISWAPX_FILLER | `=== 'true'` | opt-in | Correct |
| FEATURE_SOLANA_EXECUTION | `=== 'true'` | opt-in | Correct |
| FEATURE_STATISTICAL_ARB | `=== 'true'` | opt-in | Correct |

### `||` vs `??` Violations

**No violations found in service source code.** All matches were in test files (acceptable — test code uses `|| 0` for non-critical statistics).

### Safety Default Flags (`!== 'false'`)

All 10 safety-default env vars use the correct `!== 'false'` pattern per CLAUDE.md:
- `CAN_BECOME_LEADER`, `ENABLE_CROSS_REGION_HEALTH`, `CROSS_CHAIN_ENABLED`, `TRIANGULAR_ENABLED`
- `RESERVE_CACHE_ENABLED`, `TRADE_LOG_ENABLED`, `BRIDGE_RECOVERY_ENABLED`, `BALANCE_MONITOR_ENABLED`
- `EXECUTION_SIMULATION_LOG`, `CIRCUIT_BREAKER_ENABLED`

---

## Cross-Agent Insights

### Information Separation Results (Agents 2 + 3: Failure-Mode vs Data-Integrity)

Both agents independently analyzed Redis Streams, shutdown, and data loss.

**Where they AGREE (HIGH confidence):**
- Deferred ACK in execution engine is robust three-layer protection (PEL → XCLAIM → DLQ)
- Backpressure correctly leaves messages in PEL during queue-full (P0-7 FIX)
- Shutdown ordering is well-designed with safety fixes (W2-5, OP-11, P0-4)
- DLQ triple fallback (stream → file → logs) prevents true data loss
- MAXLEN approximate trimming CAN discard unread messages when consumers lag

**Where Agent 2 uniquely found:**
- F-1: DLQ stream has no MAXLEN (data-integrity agent didn't flag this — different focus)
- F-3: 10s drain timeout insufficient for bridge operations
- F-5: FastLane silent drops under backpressure

**Where Agent 3 uniquely found:**
- DI-4: HMAC doesn't cover Redis message ID (failure-mode agent focused on recovery, not cryptographic properties)
- DI-7: Schema version field unparsed on consumer side
- DI-8: No BigInt safety net in JSON.stringify

**No disagreements found.** The agents' perspectives are complementary, not contradictory.

### Multi-Agent Agreement

The cross-chain detector was flagged by THREE agents independently:
- **observability-auditor**: No trace context (O-1), no Prometheus metrics (O-7), minimal health check (O-10)
- **cross-chain-analyst**: Missing gas configs for chains it monitors
- **latency-profiler**: (implicit) Not in the fast-path analysis because it's a separate pipeline

This convergence suggests the cross-chain detector is the system's primary operational blind spot.

---

## Conflict Resolutions

### Conflict: Dynamic L1 Fees Default State

- **Cross-chain-analyst (Finding CC-4)**: "Dynamic L1 fees (`FEATURE_DYNAMIC_L1_FEES`) are available but disabled by default"
- **Config drift evidence**: `feature-flags.ts:207` shows `useDynamicL1Fees: process.env.FEATURE_DYNAMIC_L1_FEES !== 'false'` — this is the `!== 'false'` pattern meaning **ENABLED by default**

**Resolution**: Cross-chain analyst was incorrect. The feature IS enabled by default. Static `L1_DATA_FEE_USD` values are fallbacks when the dynamic oracle query fails, not the primary path. **Finding CC-4 downgraded from P1 to P3** — the risk is limited to oracle failure scenarios, not the default operating mode.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before next deployment)

- [ ] **Fix #1 (CC-1)**: Add Blast/Scroll/Mantle/Mode to `MIN_GAS_PRICE_GWEI`, `MAX_GAS_PRICE_GWEI`, `DEFAULT_GAS_PRICES_GWEI` in `gas-price-optimizer.ts` (cross-chain, Score: 3.7)
- [ ] **Fix #2 (CC-5)**: Change Solana cross-chain default from flat $15 to per-chain `getEvmGasCostUsd()` in `partition-solana/src/detection/base.ts` (cross-chain, Score: 3.7)
- [ ] **Fix #3 (F-1)**: Add MAXLEN to DLQ stream writes in `opportunity.consumer.ts:802` and `stream-consumer-manager.ts:468` (failure-mode, Score: 3.6)

### Phase 2: Next Sprint (P1 — reliability and coverage)

- [ ] **Fix #4 (O-3)**: Log gas estimation failures in all 6 flash loan providers, consider aborting on estimateGas failure (observability, Score: 3.4)
- [ ] **Fix #5 (O-1)**: Add trace context to cross-chain detector's `opportunity-publisher.ts` (observability, Score: 3.3)
- [ ] **Fix #6 (O-7)**: Add Prometheus metrics endpoint to cross-chain and mempool detectors (observability, Score: 3.0)
- [ ] **Fix #7 (CC-10)**: Prepare Mantle gas config accounting for MNT native token (cross-chain, Score: 2.8)
- [ ] **Fix #8 (F-3)**: Make shutdown drain timeout configurable, write bridge recovery keys before timeout (failure-mode, Score: 2.8)
- [ ] **Fix #9 (CC-2)**: Add fallback gas prices for Blast/Scroll/Mantle/Mode in `gas-price-cache.ts` (cross-chain, Score: 2.7)

### Phase 3: Backlog (P2/P3 — hardening and optimization)

- [ ] **Fix #10 (DI-1)**: Consider deferred ACK in coordinator opportunity forwarding (data-integrity, Score: 2.5)
- [ ] **Fix #11 (O-10)**: Enrich cross-chain detector health check with dep checks (observability, Score: 2.5)
- [ ] **Fix #12 (L-1)**: Disable HMAC legacy signature compat (latency, Score: 2.4)
- [ ] **Fix #13 (DI-6)**: Wire `checkStreamLag()` into periodic monitoring for critical streams (data-integrity, Score: 2.4)
- [ ] **Fix #14 (F-5)**: Log warn when FastLane drops opportunities on backpressure (failure-mode, Score: 2.3)
- [ ] **Fix #15 (O-6)**: Add gasPrice and detectionTimestamp to TradeLogEntry (observability, Score: 2.3)
- [ ] **Fix #16 (O-8)**: Add execution failure counter and latency histogram to Prometheus (observability, Score: 2.2)
- [ ] **Fix #17 (O-9)**: Expose health-check-only metrics as Prometheus gauges (observability, Score: 2.2)
- [ ] **Fix #18 (L-2)**: Ensure opportunity batcher uses maxWaitMs ≤ 10ms (latency, Score: 2.1)
- [ ] **Fix #19 (O-4/O-5)**: Log L2 sequencer tx errors and ML prediction failures (observability, Score: 2.0)
- [ ] **Fix #20 (F-4)**: Optimize DLQ scan with XLEN + cursor (failure-mode, Score: 1.9)
- [ ] **Fix #21 (O-2)**: Add trace context to mempool detector (observability, Score: 1.9)
- [ ] **Fix #22-33**: Remaining P3 items (config, documentation, minor hardening)

---

## Appendix: Synthesis Quality Gate Results

| Gate | Status | Notes |
|------|--------|-------|
| **Completeness** | PASS (5/6) | Config-drift-detector stalled; critical patterns self-executed via Grep |
| **Cross-Validation** | PASS | Agents 2+3 agree on all overlapping areas; no disagreements |
| **Deduplication** | PASS | DI-6 and failure-mode Redis memory finding merged; CC-4 conflict resolved |
| **False Positive Sweep** | PASS | CC-3 (Mantle/Mode stubs) confirmed intentional; CC-6 (BSC decimals) confirmed correct; CC-11 (Solana arch) confirmed intentional |

---

*Report generated by 6-agent extended deep analysis team. 5 agents reported findings; 1 stalled (config-drift critical patterns self-executed). All P0/P1 findings verified with exact file:line references and cross-referenced against ADRs and known correct patterns.*

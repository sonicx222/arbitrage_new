# Phase 4 — Pipeline Smoke Test
# 12 steps, ~90 seconds. Validates full data flow end-to-end.
# Reads inventory from `./monitor-session/config/inventory.json`
# Reads thresholds from `.claude/commands/monitoring/config.json`

Record findings to `./monitor-session/findings/smoke-test.jsonl`:
```json
{"phase":"SMOKE_TEST","findingId":"SM-NNN","category":"PIPELINE_FLOW|PIPELINE_STALL|TRACE_INCOMPLETE|DLQ_GROWTH|DETECTION_RATE|RISK_STATE|BACKPRESSURE|PARTITION_FLOW|CROSS_CHAIN_DETECTOR|BUSINESS_INTELLIGENCE|RUNTIME_DEGRADATION","severity":"...","stream":"...","evidence":"..."}
```

---

## Step 4A — Capture initial stream lengths

```bash
echo "=== SMOKE TEST BASELINE ===" > ./monitor-session/streams/smoke-baseline.txt
for stream in stream:price-updates stream:opportunities \
  stream:execution-requests stream:execution-results \
  stream:exec-requests-fast stream:exec-requests-l2 \
  stream:exec-requests-premium stream:exec-requests-solana \
  stream:fast-lane stream:dead-letter-queue stream:forwarding-dlq; do
  LEN=$(redis-cli XLEN $stream)
  echo "$stream: $LEN" >> ./monitor-session/streams/smoke-baseline.txt
  echo "$stream: $LEN"
done
```

Also capture per-partition event counts for Step 4I:
```bash
for port in 3001 3002 3003 3004; do
  curl -sf --max-time 10 http://localhost:$port/health | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('P'+($port-3000)+' events:', d.eventsProcessed??0)"
done > ./monitor-session/streams/partition-baseline.txt
```

The 4 `exec-requests-*` streams are ADR-038 chain-grouped routing streams.
When `FEATURE_CHAIN_GROUPED_EXECUTION` is enabled, at least one should grow;
otherwise the legacy `stream:execution-requests` should grow.

---

## Step 4B — Wait for pipeline flow (60s timeout, poll every 10s)

Read `MONITOR_DATA_MODE=$(cat ./monitor-session/DATA_MODE)`.

Poll 4 critical streams every `config.json`.smokeTestPollIntervalSec for up to
`config.json`.smokeTestTimeoutSec:

```bash
for i in 1 2 3 4 5 6; do
  sleep 10
  echo "=== Poll $i ($(($i * 10))s) ==="
  redis-cli XLEN stream:price-updates
  redis-cli XLEN stream:opportunities
  redis-cli XLEN stream:execution-requests
  redis-cli XLEN stream:execution-results
done
```

**Expected cascade:**
1. `stream:price-updates` grows first (partitions publishing)
2. `stream:opportunities` grows next (detectors finding arb)
3. `stream:execution-requests` grows (coordinator forwarding)
4. `stream:execution-results` grows (EE completing)

**Mode-conditional flags:**

`[SIM]` All 4 streams MUST grow:
- price-updates not growing after 30s → C:PIPELINE_STALL (partitions not publishing)
- opportunities not growing after 45s → H:PIPELINE_STALL (detectors not finding — may be expected)

`[LIVE/TESTNET]` Only price-updates MUST grow:
- price-updates not growing after 30s → C:PIPELINE_STALL (no real data — check WS connections, Windows TLS)
- opportunities not growing after 60s → I:PIPELINE_FLOW annotated `[LIVE-EXPECTED]`
- opportunities growing → I:PIPELINE_FLOW annotated `[LIVE-SIGNAL]` (real arb detected)

`[ALL]` Infrastructure flags:
- execution-requests not growing but opportunities is → C:PIPELINE_STALL (coordinator not forwarding)
- execution-results not growing but execution-requests is → C:PIPELINE_STALL (EE not processing)

---

## Step 4C — Verify endpoint data matches stream flow

```bash
curl -sf --max-time 10 http://localhost:3000/api/opportunities 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('opportunities:', Array.isArray(d)?d.length:0)"
curl -sf --max-time 10 http://localhost:3005/stats 2>/dev/null
curl -sf --max-time 10 http://localhost:3005/health 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('queueSize:', d.queueSize, 'activeExec:', d.activeExecutions, 'successRate:', d.successRate)"
```

If endpoints return 401/403, record I:PIPELINE_FLOW (auth working) and skip data validation.

- Coordinator `/api/opportunities` empty but `stream:opportunities` has entries → H:PIPELINE_FLOW
- EE stats show 0 attempts but `stream:execution-requests` has entries → H:PIPELINE_FLOW

---

## Step 4D — Trace one message through pipeline

If `stream:execution-results` has entries:

```bash
redis-cli XREVRANGE stream:execution-results + - COUNT 1
```

Extract `_trace_traceId` field. If found, search upstream:
```bash
redis-cli XREVRANGE stream:opportunities + - COUNT 50
redis-cli XREVRANGE stream:execution-requests + - COUNT 50
# Search output for matching _trace_traceId
```

Expected: `opportunities(traceId:X) → execution-requests(traceId:X) → execution-results(traceId:X)`

- traceId in result but missing upstream → M:TRACE_INCOMPLETE
- No traceId in any message → M:TRACE_INCOMPLETE (trace system not active)

---

## Step 4E — DLQ growth check

```bash
redis-cli XLEN stream:dead-letter-queue
redis-cli XLEN stream:forwarding-dlq
```

Compare against Step 4A baseline.

- DLQ grew during smoke test → H:DLQ_GROWTH (messages failing in pipeline)
- Forwarding DLQ grew → C:DLQ_GROWTH (coordinator forwarding broken)

---

## Step 4F — Per-chain detection granularity

Re-check partition `/stats` endpoints and compare per-chain counts against smoke baseline.

```bash
curl -sf --max-time 10 http://localhost:3001/stats  # P1: BSC, Polygon, AVAX, FTM
curl -sf --max-time 10 http://localhost:3002/stats  # P2: Arb, OP, Base, Scroll, Blast, Mantle, Mode
curl -sf --max-time 10 http://localhost:3003/stats  # P3: ETH, zkSync, Linea
curl -sf --max-time 10 http://localhost:3004/stats  # P4: Solana
```

Expected chain coverage from `inventory.json`.partitions.

**P4 Solana note:** `pairsMonitored=0` is expected — uses `SolanaArbitrageDetector`
(program-account-based), not EVM pair-initializer. Do NOT flag.

- Non-stub chain with 0 messages during smoke → H:DETECTION_RATE
- Partition reporting fewer chains than expected → M:DETECTION_RATE

---

## Step 4F-2 — Cross-chain detector health

```bash
curl -sf --max-time 10 http://localhost:3006/health
curl -sf --max-time 10 http://localhost:3006/stats 2>/dev/null
```

Verify: `status` healthy/running, `priceUpdatesConsumed > 0`, `maxPriceAgeMs` = 30000 (ADR-033).

- Health endpoint unreachable → H:CROSS_CHAIN_DETECTOR (may have crashed)
- `priceUpdatesConsumed` is 0 after 60s → H:CROSS_CHAIN_DETECTOR (consumer group issue)
- Healthy with active consumption → I:CROSS_CHAIN_DETECTOR

---

## Step 4G — Risk state post-smoke

```bash
curl -sf --max-time 10 http://localhost:3005/health
curl -sf --max-time 10 http://localhost:3005/stats
```

Re-check drawdown circuit breaker state (same fields as Check 3E).

- Drawdown changed NORMAL→CAUTION/HALT during smoke → H:RISK_STATE (sim reporting losses)
- Consecutive loss count > 0 during sim execution → M:RISK_STATE

---

## Step 4H — Backpressure validation

```bash
curl -sf --max-time 10 http://localhost:3000/api/health | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('backpressure:', d.backpressure, 'queueDepth:', d.executionQueueDepth)"
EXEC_LEN=$(redis-cli XLEN stream:execution-requests)
echo "execution-requests length: $EXEC_LEN"
```

Evaluate fill ratio against `inventory.json` MAXLEN (100,000) and backpressure ratio (0.8):
- Fill ratio > 0.8 AND backpressure not active → H:BACKPRESSURE (flow control broken)
- Fill ratio < 0.2 AND backpressure active → M:BACKPRESSURE (stuck on)
- In simulation with light load, backpressure should NOT be active
- Consistent state → I:BACKPRESSURE

---

## Step 4I — Per-partition flow verification

Compare per-partition event counts against Step 4A baseline:

```bash
for port in 3001 3002 3003 3004; do
  curl -sf --max-time 10 http://localhost:$port/health | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('P'+($port-3000)+' events:', d.eventsProcessed??0)"
done
```

If `/health` lacks `eventsProcessed`, fall back to `/stats` per-chain counts.

- Partition with 0 new events while others active → H:PARTITION_FLOW (silent stop)
- Partition rate >10x lower than peers → M:PARTITION_FLOW (degraded)
- All partitions active → I:PARTITION_FLOW

---

## Step 4J — Fast-lane stream validation

```bash
FAST_LEN=$(redis-cli XLEN stream:fast-lane 2>/dev/null || echo "0")
echo "stream:fast-lane length: $FAST_LEN"
redis-cli XINFO GROUPS stream:fast-lane 2>/dev/null
```

Compare FAST_LEN to Step 4A baseline.

- Stream exists but consumer group missing → H:PIPELINE_FLOW (msgs accumulate unprocessed)
- Consumer group exists but PEL growing → M:PIPELINE_FLOW (consumer stalled)
- Stream empty → I:PIPELINE_FLOW (no high-confidence opps — expected in sim)

---

## Step 4K — Business intelligence smoke check

```bash
curl -sf --max-time 10 http://localhost:3005/metrics 2>/dev/null | grep -E \
  "opportunity_outcome_total|profit_slippage_pct|opportunity_age_at_execution|profit_per_execution|gas_cost_per_execution"
```

If executions occurred (`stream:execution-results` grew):
- `opportunity_outcome_total` is 0 → M:BUSINESS_INTELLIGENCE (outcome tracking not wired)
- `opportunity_age_at_execution_ms` is 0 → M:BUSINESS_INTELLIGENCE (age tracking not wired)

No executions → skip BI check (expected in low-activity sim).

---

## Step 4L — Runtime performance delta

```bash
for port in 3001 3002 3003 3004 3005 3006; do
  echo "=== Port $port ==="
  curl -sf --max-time 10 http://localhost:$port/metrics 2>/dev/null | grep -E "runtime_eventloop_delay_p99_ms|runtime_memory_rss_mb"
done
curl -sf --max-time 10 http://localhost:3000/api/metrics/prometheus 2>/dev/null | grep -E "runtime_eventloop_delay_p99_ms|runtime_memory_rss_mb"
```

Compare against Phase 3 values (Checks 3O, 3Q).

- Event loop p99 increased >5x during smoke → H:RUNTIME_DEGRADATION (blocking under load)
- RSS grew >50% during smoke → M:RUNTIME_DEGRADATION (possible memory leak)
- Stable → I:RUNTIME_DEGRADATION

---

## Phase 4 Summary

```
PHASE 4 COMPLETE — Pipeline Smoke Test (12 steps)
  Price updates published: <n>
  Opportunities detected: <n>
  Execution requests forwarded: <n>
  Execution results received: <n>
  Fast-lane processed: <n>
  Pipeline: FLOWING / STALLED at <stage>
  Trace complete: YES / NO / PARTIAL
  DLQ growth: <n> new entries
  Per-chain detection: <n>/<total> chains active
  Risk state post-smoke: NORMAL / CAUTION / HALT / RECOVERY
  Backpressure: INACTIVE / ACTIVE (ratio: <n>%)
  Partition flow: <n>/4 partitions actively processing
  BI metrics recording: YES / NO / N/A
  Runtime stability: STABLE / DEGRADED
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>
```

# Phase 3 -- Runtime Validation (42 checks)

All services must be running. Uses curl, redis-cli, jq.
9 subsections, 42 checks (3A-3AR, excluding 3AL and 3AM -- reclassified to Phase 1).

## References

- **Inventory**: `./monitor-session/config/inventory.json`
- **Config**: `.claude/commands/monitoring/config.json` (thresholds, perChainStalenessThresholds)
- **Findings file**: `./monitor-session/findings/runtime.jsonl`
- **Finding ID prefix**: `RT-NNN`
- **Cache dir**: `./monitor-session/config/cache/`

## Finding Format

```json
{"phase":"RUNTIME","findingId":"RT-NNN","category":"<CATEGORY>","severity":"CRITICAL|HIGH|MEDIUM|LOW|INFO","service":"<name>","stream":"<optional>","consumerGroup":"<optional>","evidence":"<output>","expected":"<what>","actual":"<what>","recommendation":"<fix>"}
```

Category values: `SERVICE_HEALTH`, `LEADER_ELECTION`, `HEALTH_SCHEMA`, `CIRCUIT_BREAKER`,
`RISK_STATE`, `CB_TRANSITIONS`, `CB_FLAPPING`, `BACKPRESSURE`, `DLQ`, `DLQ_ROOT_CAUSE`,
`STREAM_TOPOLOGY`, `CONSUMER_LAG`, `STREAM_TRANSIT`, `MAXLEN_TRIM`, `RUNTIME_PERFORMANCE`,
`MEMORY`, `PROVIDER_QUALITY`, `WEBSOCKET_HEALTH`, `DETECTION_QUALITY`, `GAS_SPIKE`,
`SIMULATION`, `EXECUTION_PROBABILITY`, `BRIDGE_RECOVERY`, `BUSINESS_INTELLIGENCE`,
`METRICS`, `METRICS_COMPLETENESS`, `DIAGNOSTICS`,
`DASHBOARD_AVAILABILITY`, `DASHBOARD_SSE`, `DASHBOARD_REST`, `DASHBOARD_KEY_MISMATCH`,
`DASHBOARD_PROXY`, `DASHBOARD_STREAMS`

---

## Preamble: Endpoint Caching (O-01)

Fetch ALL HTTP endpoints once into cache files. All subsequent checks read from cache.
Cache is stale after 30s -- re-fetch only for post-action comparisons.

```bash
mkdir -p ./monitor-session/config/cache
for port in 3000 3001 3002 3003 3004 3005 3006; do
  curl -sf --max-time 10 http://localhost:$port/health > ./monitor-session/config/cache/health_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/stats > ./monitor-session/config/cache/stats_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/metrics > ./monitor-session/config/cache/metrics_$port.txt 2>/dev/null &
done
curl -sf --max-time 10 http://localhost:3000/api/health > ./monitor-session/config/cache/api_health_3000.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/metrics/prometheus > ./monitor-session/config/cache/prom_3000.txt 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/diagnostics > ./monitor-session/config/cache/diagnostics.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/leader > ./monitor-session/config/cache/leader.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3005/circuit-breaker > ./monitor-session/config/cache/cb_3005.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3005/probability-tracker > ./monitor-session/config/cache/probtracker_3005.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3005/bridge-recovery > ./monitor-session/config/cache/bridge_3005.json 2>/dev/null &
wait
```

Note: Coordinator health is at `/api/health` (cache as `api_health_3000.json`).
Partitions/EE/CC health is at `/health` (cache as `health_$port.json`).

## Preamble: Redis Command Batching (O-02)

Batch all stream XINFO/XLEN commands using discovered streams from Phase 2:

```bash
STREAMS=$(cat ./monitor-session/streams/discovered.txt)
for stream in $STREAMS; do
  echo "=== $stream ==="
  redis-cli XINFO STREAM $stream 2>&1
  redis-cli XINFO GROUPS $stream 2>&1
  redis-cli XLEN $stream 2>&1
done > ./monitor-session/config/cache/stream-inventory.txt
```

## Preamble: Placeholder Metrics Fast-Path

For each metric in `config.json`.placeholderMetrics, if a check only looks for that metric,
skip grep and emit INFO: `"<metric> not yet implemented. Fallback check used instead."`

Current placeholders: `circuit_breaker_transitions_total`, `backpressure_episodes_total`,
`stream_ack_delay_ms`, `stream_trimmed_messages_total`, `pair_cache_hit_total`

---

## Section 3.1: Service Health & Schema

### 3A -- Service Health Matrix

Read cached health responses for all 7 services:
```bash
cat ./monitor-session/config/cache/api_health_3000.json | jq .   # Coordinator
for port in 3001 3002 3003 3004 3005 3006; do
  cat ./monitor-session/config/cache/health_$port.json | jq .
done
```

Also read cached `/stats` for P1-P4 + EE (ports 3001-3005).

Flags:
- status `unhealthy` -> C:SERVICE_HEALTH
- status `degraded` -> H:SERVICE_HEALTH
- Service unreachable (empty cache file) -> C:SERVICE_HEALTH
- 0 chains active on a partition that should have chains -> H:SERVICE_HEALTH

---

### 3B -- Leader Election

```bash
cat ./monitor-session/config/cache/leader.json | jq .
redis-cli GET coordinator:leader:lock
redis-cli TTL coordinator:leader:lock
```

Flags:
- `isLeader` is `false` -> C:LEADER_ELECTION
- Endpoint unreachable -> C:LEADER_ELECTION
- Lock doesn't exist -> C:LEADER_ELECTION
- TTL < 5s -> H:LEADER_ELECTION

---

### 3C -- Health Schema Validation

Use cached health responses from 3A. For each service, validate required fields/types:

**Coordinator** (`api_health_3000.json`): `status` (string enum), `uptime` (number>0),
`isLeader` (boolean), `systemHealth` (number 0-100).
Optional: `services`, `streams`, `backpressure`.

**Partitions P1-P4** (`health_300[1-4].json`): `status` (string enum), `uptime` (number>0),
`eventsProcessed` (number), `chains` (array|number).
Optional (v3.0): `pairsMonitored`, `lastPriceUpdate`, `memoryUsage`, `stalePriceRejections`,
`wsMessageCounts`, `maxPriceStalenessMs`, `avgDetectionCycleDurationMs`, `avgOpportunitiesPerCycle`.

**Execution Engine** (`health_3005.json`): `status` (string enum), `uptime` (number>0).
Optional: `queueSize`, `activeExecutions`, `successRate`, `drawdownState`, `consecutiveLosses`.

**Cross-Chain** (`health_3006.json`): `status` (string enum), `uptime` (number>0).
Optional: `partitionsConnected`, `crossChainPairsMonitored`.

Validation rules:
1. Required fields present (not null/undefined)
2. Types match (string is string, number is number)
3. `status` in `{healthy, degraded, unhealthy}`
4. `uptime` > 0
5. Numeric fields not NaN

Flags:
- Required field missing -> H:HEALTH_SCHEMA
- Type mismatch -> M:HEALTH_SCHEMA
- status unexpected value -> H:HEALTH_SCHEMA
- uptime 0 or NaN -> M:HEALTH_SCHEMA
- All valid -> I:HEALTH_SCHEMA

---

## Section 3.2: Risk & Circuit Breakers

### 3D -- Circuit Breaker States

```bash
cat ./monitor-session/config/cache/cb_3005.json | jq .
```

Flags:
- Any chain `OPEN` -> H:CIRCUIT_BREAKER
- Any chain `HALF_OPEN` -> M:CIRCUIT_BREAKER
- Unreachable -> H:CIRCUIT_BREAKER

---

### 3E -- Drawdown & Risk State

Read from cached EE health+stats (`health_3005.json`, `stats_3005.json`).
Parse: `drawdownState` / `riskState`, `consecutiveLosses`, `dailyPnl`.

States: NORMAL (100%) -> CAUTION (75%) -> HALT (0%) -> RECOVERY (50%)

Flags:
- `HALT` -> C:RISK_STATE (alive but not trading -- invisible failure)
- `CAUTION` -> H:RISK_STATE (75% sizing)
- `RECOVERY` -> M:RISK_STATE (50% sizing)
- Risk state not available in endpoint -> M:RISK_STATE (blind spot)

---

### 3F -- CB Transition History (placeholder: E1-E2)

**Placeholder fast-path**: `circuit_breaker_transitions_total` in `config.json`.placeholderMetrics.
```bash
grep circuit_breaker_transition ./monitor-session/config/cache/metrics_3005.txt
```

If metric exists:
- >5 transitions in session -> M:CB_TRANSITIONS
- CLOSED->OPEN on same chain >3 -> H:CB_TRANSITIONS

If metric does NOT exist, also manually check for flapping:
```bash
redis-cli XREVRANGE stream:circuit-breaker + - COUNT 20
```
- >5 entries with alternating states within 60s -> H:CB_FLAPPING

If neither metric nor entries exist -> I:CB_TRANSITIONS (placeholder not implemented)

---

### 3G -- Backpressure Episodes (placeholder: E4-E5)

**Placeholder fast-path**: `backpressure_episodes_total` in `config.json`.placeholderMetrics.
```bash
grep backpressure_episodes ./monitor-session/config/cache/metrics_3005.txt
cat ./monitor-session/config/cache/api_health_3000.json | jq '{backpressure}'
```

If metric exists:
- Episodes >10 in session -> M:BACKPRESSURE
- Episodes >0 but backpressure inactive + stream fill <20% -> I:BACKPRESSURE (resolved)

If metric does NOT exist -> I:BACKPRESSURE (placeholder not implemented)

---

## Section 3.3: Data Flow & DLQ

### 3H -- DLQ Status

```bash
redis-cli XLEN stream:dead-letter-queue
redis-cli XLEN stream:forwarding-dlq
redis-cli XLEN stream:dlq-alerts
```

Flags:
- `stream:dead-letter-queue` > 0 -> H:DLQ
- `stream:forwarding-dlq` > 0 -> C:DLQ (coordinator can't reach EE)

If DLQ has entries:
```bash
redis-cli XREVRANGE stream:dead-letter-queue + - COUNT 5
redis-cli XREVRANGE stream:forwarding-dlq + - COUNT 5
```

---

### 3I -- Stream Topology Validation

Read from cached `stream-inventory.txt` (O-02 preamble). For each stream in
`inventory.json`.streams, verify:

1. **Exists** -- `XINFO STREAM` succeeds.
   - Missing active stream -> H:STREAM_TOPOLOGY
   - Missing on-demand stream (`system-failures`, `system-control`, `system-scaling`,
     `service-degradation`, `dlq-alerts`) -> M:STREAM_TOPOLOGY
   - Missing ADR-038/039 stream (`exec-requests-fast/l2/premium/solana`, `pre-simulated`)
     when feature disabled -> I:STREAM_TOPOLOGY

2. **Has expected consumer groups** -- compare `XINFO GROUPS` against
   `inventory.json`.consumerGroups for that stream. Missing group -> H:STREAM_TOPOLOGY

3. **Consumer groups have active consumers** -- `consumers` field > 0. Zero -> C:STREAM_TOPOLOGY

4. **Stream length reasonable** -- not 0 for active streams, not at MAXLEN cap.

---

### 3J -- Consumer Lag & Pending Messages

**Part 1: Dynamic discovery** -- Parse `stream-inventory.txt` for all groups per stream.

**Part 2: Per-group pending** -- For each (stream, group) pair:
```bash
redis-cli XPENDING <stream> <group>
```

**Part 3: Cross-reference expected owners** (from `inventory.json`.consumerGroups):

| Group Pattern | Expected Owner |
|---------------|---------------|
| `coordinator-group` | Coordinator (3000) |
| `cross-chain-detector-group` | Cross-Chain (3006) |
| `execution-engine-group` | EE (3005) |
| `mempool-detector-group` | Mempool (3008) |
| `orderflow-pipeline` | Coordinator subsystem |
| `self-healing-manager` | Dynamic |
| `failover-*` | Dynamic |

Also check ALL critical pairs:
```bash
redis-cli XPENDING stream:price-updates coordinator-group
redis-cli XPENDING stream:price-updates cross-chain-detector-group
redis-cli XPENDING stream:opportunities coordinator-group
redis-cli XPENDING stream:whale-alerts coordinator-group
redis-cli XPENDING stream:whale-alerts cross-chain-detector-group
redis-cli XPENDING stream:execution-requests execution-engine-group
redis-cli XPENDING stream:execution-results coordinator-group
redis-cli XPENDING stream:health coordinator-group
redis-cli XPENDING stream:dead-letter-queue coordinator-group
redis-cli XPENDING stream:forwarding-dlq coordinator-group
redis-cli XPENDING stream:fast-lane execution-engine-group
redis-cli XPENDING stream:swap-events coordinator-group
redis-cli XPENDING stream:volume-aggregates coordinator-group
redis-cli XPENDING stream:pending-opportunities cross-chain-detector-group
redis-cli XPENDING stream:pending-opportunities orderflow-pipeline
```

Thresholds (from `config.json`):
- Pending > `consumerLagWarn` (50) -> H:CONSUMER_LAG
- Pending > `consumerLagCrit` (100) -> C:CONSUMER_LAG
- Oldest msg pending > `stuckMsgAgeSec` (30s) -> H:CONSUMER_LAG
- Delivery count > 3 -> H:CONSUMER_LAG (poison message)
- Shared stream: one group >10x pending of peer -> H:CONSUMER_LAG
- Unknown group not matching known patterns -> M:CONSUMER_LAG

---

### 3K -- DLQ Root Cause Analysis

**Prerequisite:** Only run if Check 3H found DLQ length > 0.

```bash
redis-cli XREVRANGE stream:dead-letter-queue + - COUNT 50
redis-cli XREVRANGE stream:forwarding-dlq + - COUNT 20
```

For each entry extract: `reason`/`error`, `originalStream`, `service`, `timestamp`.
Group by rejection reason. Identify top-3 reasons.

Check DLQ growth rate: current XLEN vs Phase 2 baseline. Calculate entries/min.

Check local DLQ fallback files:
```bash
ls -la ./data/dlq-fallback-*.jsonl 2>/dev/null
ls -la ./data/dlq-forwarding-fallback-*.jsonl 2>/dev/null
```

Flags:
- Fallback files exist with today's date -> H:DLQ_ROOT_CAUSE (Redis DLQ write failing)
- Single reason >50% of entries -> H:DLQ_ROOT_CAUSE (systemic failure)
- DLQ growing > `dlqGrowthRateHighPerSec` (1/sec) -> H:DLQ_ROOT_CAUSE
- `hmac_verification_failed` reason -> C:DLQ_ROOT_CAUSE (signing key mismatch)
- Forwarding DLQ has entries -> C:DLQ_ROOT_CAUSE (coordinator can't reach EE)

---

### 3L -- Stream Transit Time

```bash
grep stream_message_transit ./monitor-session/config/cache/metrics_3005.txt
```

Parse `stream_message_transit_ms` histogram, per-stream breakdowns.

Flags (thresholds from `config.json`):
- p95 > `transitP95CritMs` (100ms) -> H:STREAM_TRANSIT
- p95 > `transitP95WarnMs` (50ms) -> M:STREAM_TRANSIT
- `stream:execution-requests` p95 > 200ms -> H:STREAM_TRANSIT (critical path)
- Metric not present -> M:STREAM_TRANSIT
- All < 50ms -> I:STREAM_TRANSIT

Context: localhost sim should be <10ms. Production 20-50ms acceptable.

---

### 3M -- ACK Delay (placeholder: F2)

**Placeholder fast-path**: `stream_ack_delay_ms` in `config.json`.placeholderMetrics.
```bash
grep stream_ack_delay ./monitor-session/config/cache/metrics_3005.txt
```

If exists:
- p95 > 500ms -> M:STREAM_TRANSIT
- p95 > 2000ms -> H:STREAM_TRANSIT

If not -> I:STREAM_TRANSIT (placeholder; fallback: 3J pending age)

---

### 3N -- MAXLEN Trim Detection

**Placeholder fast-path**: `stream_trimmed_messages_total` in `config.json`.placeholderMetrics.
```bash
grep stream_trimmed ./monitor-session/config/cache/metrics_3005.txt
grep stream_trimmed ./monitor-session/config/cache/metrics_3001.txt
```

If metric exists:
- Non-zero on `stream:execution-requests` or `stream:fast-lane` -> H:MAXLEN_TRIM
- Non-zero on `stream:price-updates` -> M:MAXLEN_TRIM

If metric does NOT exist -- manual approximation using `inventory.json` MAXLENs:
```bash
# Read MAXLENs from inventory.json and compare against actual XLEN
# For each stream in inventory.json that has a maxlen value:
cat ./monitor-session/config/inventory.json | jq -r '.streams[] | select(.maxlen != null) | "\(.name):\(.maxlen)"' | while IFS=: read -r _ name maxlen; do
  STREAM="stream:$name"
  XLEN=$(redis-cli XLEN "$STREAM" 2>/dev/null || echo 0)
  RATIO=$(awk "BEGIN {printf \"%.2f\", $XLEN * 100 / $maxlen}" 2>/dev/null || echo "N/A")
  echo "$STREAM: $XLEN / $maxlen ($RATIO%)"
done
```

Thresholds (from `config.json`):
- Fill > `maxlenFillRatioCrit` (90%) -> H:MAXLEN_TRIM
- Fill > `maxlenFillRatioWarn` (80%) -> M:MAXLEN_TRIM
- I:MAXLEN_TRIM (trim counter not implemented; XLEN-vs-MAXLEN approximation used)

---

## Section 3.4: Runtime Performance

### 3O -- Event Loop Health

Thresholds from `config.json`: `eventLoopP99WarnMs` (20), `eventLoopP99CritMs` (50).

```bash
for port in 3001 3002 3003 3004 3005 3006; do
  echo "=== Port $port ==="
  grep runtime_eventloop_delay ./monitor-session/config/cache/metrics_$port.txt
done
grep runtime_eventloop_delay ./monitor-session/config/cache/prom_3000.txt
```

Parse: `runtime_eventloop_delay_p99_ms`, `_p50_ms`, `_mean_ms`, `_max_ms`.

Aggregated alternative (single call):
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.runtime.eventLoop'
```

Flags:
- p99 > `eventLoopP99CritMs` (50ms) -> H:RUNTIME_PERFORMANCE (violates ADR-022)
- p99 > `eventLoopP99WarnMs` (20ms) -> M:RUNTIME_PERFORMANCE
- max > 200ms -> H:RUNTIME_PERFORMANCE (severe stall)
- Metrics not present -> M:RUNTIME_PERFORMANCE
- All p99 < 20ms -> I:RUNTIME_PERFORMANCE

---

### 3P -- GC Pressure

```bash
for port in 3001 3002 3003 3004 3005 3006; do
  grep runtime_gc ./monitor-session/config/cache/metrics_$port.txt
done
grep runtime_gc ./monitor-session/config/cache/prom_3000.txt
```

Parse: `runtime_gc_pause_total_ms`, `runtime_gc_count_total`, `runtime_gc_major_count_total`.

Aggregated alternative:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.runtime.gc'
```

Flags:
- `major_count` > `gcMajorWarn` (10) -> M:RUNTIME_PERFORMANCE
- `pause_total_ms` > 500ms cumulative -> M:RUNTIME_PERFORMANCE
- Major GC > 10% of total GC -> H:RUNTIME_PERFORMANCE (heap pressure)

---

### 3Q -- Memory Breakdown

```bash
for port in 3001 3002 3003 3004 3005; do
  grep runtime_memory ./monitor-session/config/cache/metrics_$port.txt
done
grep runtime_memory ./monitor-session/config/cache/prom_3000.txt
```

Parse: `runtime_memory_heap_used_mb`, `_heap_total_mb`, `_rss_mb`, `_external_mb`, `_array_buffers_mb`.

Aggregated alternative:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.runtime.memory'
```

Also Redis memory:
```bash
redis-cli INFO memory
# Parse: used_memory_human, used_memory_peak_human, maxmemory
```

Flags (from `config.json`):
- `heap_used/heap_total` > `heapRatioWarn` (0.85) -> H:MEMORY
- `rss_mb` > `rssMbCrit` (500) -> H:MEMORY
- `external_mb` > 200 -> M:MEMORY (SharedArrayBuffer growth)
- Memory metrics not present -> L:MEMORY (fallback: /health memoryUsage)
- Redis memory >75% of maxmemory -> H:MEMORY

---

## Section 3.5: Provider Quality

All checks read cached `/stats` and `/metrics` per partition (O-01).
Read mode from `./monitor-session/DATA_MODE`.

`[SIM-ONLY]` All provider quality flags reported as I with `[SIM]` annotation
(simulation uses synthetic events, not real RPC).

`[LIVE/TESTNET]` Apply full severity rules.

### 3R -- Provider Latency & Connectivity

**Part 1: Connection status** -- Parse cached `stats_300[1-4].json`:
- P1 (3001): BSC, Polygon, AVAX, FTM
- P2 (3002): Arb, OP, Base, Scroll, Blast, Mantle, Mode
- P3 (3003): ETH, zkSync, Linea
- P4 (3004): Solana

Check per chain: connection status, messagesReceived, activeSubscriptions.

**Part 2: RPC latency** -- Parse cached `metrics_300[1-4].txt`:
```bash
for port in 3001 3002 3003 3004; do
  grep provider_rpc_call_duration ./monitor-session/config/cache/metrics_$port.txt
done
```

Flags `[LIVE/TESTNET]`:
- Any chain 0 messages received -> C:WEBSOCKET_HEALTH
- Any chain 0 active subscriptions -> C:WEBSOCKET_HEALTH
- RPC p95 > `rpcP95CritMs` (500ms) -> H:PROVIDER_QUALITY
- RPC p95 > `rpcP95WarnMs` (200ms) -> M:PROVIDER_QUALITY
- RPC metrics not present -> I:PROVIDER_QUALITY

---

### 3S -- RPC Error Rate

```bash
for port in 3001 3002 3003 3004; do
  grep provider_rpc_errors_total ./monitor-session/config/cache/metrics_$port.txt
done
```

Parse `provider_rpc_errors_total{chain="...",error_type="..."}`.

Flags `[LIVE/TESTNET]`:
- Any chain total errors > 10 -> M:PROVIDER_QUALITY
- `error_type="rate_limit"` count > 5 -> H:PROVIDER_QUALITY
- `error_type="timeout"` count > 10 -> H:PROVIDER_QUALITY
- Zero errors -> I:PROVIDER_QUALITY

---

### 3T -- Reconnection Frequency

```bash
for port in 3001 3002 3003 3004; do
  grep provider_ws_reconnection ./monitor-session/config/cache/metrics_$port.txt
done
```

Flags `[LIVE/TESTNET]`:
- Any chain > `wsReconnectWarn` (5) reconnections -> H:PROVIDER_QUALITY
- Reconnection p95 > 10s -> M:PROVIDER_QUALITY

---

### 3U -- WebSocket Message Rate

```bash
for port in 3001 3002 3003 3004; do
  grep provider_ws_messages_total ./monitor-session/config/cache/metrics_$port.txt
done
```

Flags `[LIVE/TESTNET]`:
- Any active chain 0 messages total -> C:WEBSOCKET_HEALTH
- Any chain message rate >10x lower than same-partition peers -> M:WEBSOCKET_HEALTH

Note: BSC/Polygon produce 100-1000x more events than Fantom/Scroll. Compare within partition only.

---

### 3V -- Price Staleness

Parse cached `stats_300[1-4].json` for `maxPriceStalenessMs`, `stalePriceRejections`.

Per-chain thresholds from `config.json`.perChainStalenessThresholds (in seconds):
- BSC: 6s, Polygon/AVAX/FTM: 4s, Arbitrum: 2s, Ethereum: 24s, etc.

Flags `[LIVE/TESTNET]`:
- `maxPriceStalenessMs` > chain threshold (from config.json) -> H:PROVIDER_QUALITY
- `maxPriceStalenessMs` > 15000 on fast chains (BSC/Arbitrum/Polygon) -> M:PROVIDER_QUALITY
- `stalePriceRejections` > 0 -> I:PROVIDER_QUALITY (filter working)
- Fields not present -> I:PROVIDER_QUALITY

Tip: High staleness on single chain = slow/dead RPC. Cross-reference 3R + 3S.

---

## Section 3.6: Detection Quality

### 3W -- Detection Cycle Timing

Parse cached `stats_300[1-4].json` for `avgDetectionCycleDurationMs`.

Flags `[ALL-MODES]` (hot-path target applies regardless of data source):
- > 50ms on any partition -> H:DETECTION_QUALITY (exceeds hot-path target)
- > 20ms -> M:DETECTION_QUALITY
- Not present -> I:DETECTION_QUALITY
- All < 20ms -> I:DETECTION_QUALITY

---

### 3X -- Opportunities Per Cycle

Parse cached `stats_300[1-4].json` for `avgOpportunitiesPerCycle`.

Mode-conditional:
- `[SIM]` 0 across ALL partitions after >60s uptime -> M:DETECTION_QUALITY
- `[LIVE/TESTNET]` 0 after >60s uptime -> I:DETECTION_QUALITY `[LIVE-EXPECTED]` (real arb is rare)
- `[LIVE/TESTNET]` >0 on any partition -> I:DETECTION_QUALITY `[LIVE-SIGNAL]` (examine in 3AD/3AE/3AG)

---

### 3Y -- Cache Effectiveness (placeholder: D1, D5)

**Placeholder fast-path**: `pair_cache_hit_total` in `config.json`.placeholderMetrics.
```bash
for port in 3001 3002 3003 3004; do
  grep pair_cache ./monitor-session/config/cache/metrics_$port.txt
done
```

If `pair_cache_hit_total` and `pair_cache_miss_total` exist:
- Hit rate = hits / (hits + misses) * 100
- Hit rate < 50% -> M:DETECTION_QUALITY
- Hit rate < 20% -> H:DETECTION_QUALITY

If not -> I:DETECTION_QUALITY (placeholder; cache size from stats is only visibility)

---

## Section 3.7: Execution & Business Intelligence

### 3Z -- Gas Spike Detection

Parse cached `stats_3005.json`, `health_3005.json`, and:
```bash
grep arbitrage_gas_price_gwei ./monitor-session/config/cache/metrics_3005.txt
```

Flags:
- Any chain gas price = 0 -> H:GAS_SPIKE (not being fetched)
- Active gas spike detected -> M:GAS_SPIKE
- Gas price above chain max (Ethereum max 500 gwei, Arbitrum max 10 gwei) -> H:GAS_SPIKE

---

### 3AA -- Simulation Provider Health

Parse cached `stats_3005.json` for simulation provider status, success rate.

Flags:
- All simulation providers unhealthy -> H:SIMULATION
- Success rate <50% -> M:SIMULATION
- No providers configured -> M:SIMULATION

---

### 3AB -- Execution Probability & Success Rate

```bash
cat ./monitor-session/config/cache/probtracker_3005.json | jq .
```

Flags:
- Overall success rate < `executionSuccessRateCritPct` (30%) -> H:EXECUTION_PROBABILITY
- Any chain 0% success with >0 attempts -> H:EXECUTION_PROBABILITY
- Endpoint returns empty/error -> M:EXECUTION_PROBABILITY

---

### 3AC -- Bridge Recovery Status

```bash
cat ./monitor-session/config/cache/bridge_3005.json | jq .
```

Flags:
- Any bridge stuck >24h -> H:BRIDGE_RECOVERY
- >3 concurrent pending bridges -> M:BRIDGE_RECOVERY
- Corrupt bridge entries -> H:BRIDGE_RECOVERY

---

### 3AD -- Opportunity Outcome Distribution

```bash
grep opportunity_outcome_total ./monitor-session/config/cache/metrics_3005.txt
```

Parse `opportunity_outcome_total{chain="...",outcome="..."}`.
Outcomes: `success`, `revert`, `timeout`, `stale`, `gas_too_high`, `nonce_error`, `error`.

Flags (thresholds from `config.json`):
- Revert rate > `revertRateCritPct` (30%) on any chain -> H:BUSINESS_INTELLIGENCE
- Timeout rate > `timeoutRateWarnPct` (20%) -> M:BUSINESS_INTELLIGENCE
- Stale rate > `staleRateWarnPct` (20%) -> M:BUSINESS_INTELLIGENCE
- `gas_too_high` rate > `gasTooHighRateWarnPct` (10%) -> M:BUSINESS_INTELLIGENCE

---

### 3AE -- Profit Slippage

```bash
grep profit_slippage_pct ./monitor-session/config/cache/metrics_3005.txt
```

Positive slippage = expected > actual (overestimate).

Flags (from `config.json`):
- Median > `profitSlippageCritPct` (50%) -> H:BUSINESS_INTELLIGENCE
- Median > `profitSlippageWarnPct` (25%) -> M:BUSINESS_INTELLIGENCE

Note: Simulation slippage may not reflect production behavior.

---

### 3AF -- Opportunity Age at Execution

```bash
grep opportunity_age_at_execution ./monitor-session/config/cache/metrics_3005.txt
```

Chain-specific TTLs: Fast (Arbitrum ~2s, Solana ~1s), Medium (BSC/Polygon/Base/OP ~5s),
Slow (Ethereum ~12s).

Flags:
- p95 > chain TTL -> H:BUSINESS_INTELLIGENCE
- p95 > 5000ms on any fast chain -> H:BUSINESS_INTELLIGENCE
- Median > 2000ms on any chain -> M:BUSINESS_INTELLIGENCE

---

### 3AG -- Profit & Gas Efficiency

```bash
grep profit_per_execution ./monitor-session/config/cache/metrics_3005.txt
grep gas_cost_per_execution ./monitor-session/config/cache/metrics_3005.txt
```

Flags:
- Median profit <= 0 across all chains -> H:BUSINESS_INTELLIGENCE (losing money)
- Any chain where median gas cost > median profit -> H:BUSINESS_INTELLIGENCE
- Metrics not present -> M:BUSINESS_INTELLIGENCE (no profitability visibility)

Placeholder (F6): When `profit_to_gas_ratio` exists: ratio < 1.5 -> M, ratio < 1.0 -> H.

---

## Section 3.8: Observability

### 3AH -- Prometheus Scrape Validation

Scrape metrics twice, 15s apart. First scrape already cached (O-01). Second scrape:

```bash
> ./monitor-session/metrics_t1.txt
for port in 3001 3002 3003 3004 3005 3006; do
  curl -sf --max-time 10 http://localhost:$port/metrics >> ./monitor-session/metrics_t1.txt 2>/dev/null
done
curl -sf --max-time 10 http://localhost:3000/api/metrics/prometheus >> ./monitor-session/metrics_t1.txt 2>/dev/null
```

Compare cached (t0) vs t1. Look for counter increments.

Flags:
- Counters NOT incrementing between scrapes -> M:METRICS
- Metrics endpoint returns empty/error -> M:METRICS

Note: Cross-chain (3006) `/metrics` may be empty during first ~30s of startup.

---

### 3AI -- Metrics Completeness

Read from `./monitor-session/metrics_t1.txt` (second scrape, more complete).

**Required metrics per service:**

Partitions P1-P4 (ports 3001-3004):
- `pipeline_latency_p50_ms`, `pipeline_latency_p95_ms`, `pipeline_latency_p99_ms`
- `price_updates_total`, `events_processed_total`
- v3.0 runtime: `runtime_eventloop_delay_p50_ms`, `runtime_eventloop_delay_p99_ms`,
  `runtime_memory_heap_used_mb`, `runtime_memory_rss_mb`, `runtime_gc_pause_total_ms`,
  `runtime_gc_count_total`
- v3.0 provider: `provider_rpc_call_duration_ms`, `provider_rpc_errors_total`,
  `provider_ws_messages_total`, `websocket_connections_active`

Execution Engine (port 3005):
- `arbitrage_executions_total`, `arbitrage_execution_success_total`, `arbitrage_gas_price_gwei`
- v3.0 BI: `opportunity_outcome_total`, `profit_slippage_pct`, `opportunity_age_at_execution_ms`,
  `profit_per_execution`, `gas_cost_per_execution`, `stream_message_transit_ms`

Coordinator (`/api/metrics/prometheus`):
- `arbitrage_opportunities_total`, `arbitrage_executions_total`, `arbitrage_executions_successful_total`
- v3.0 runtime: `runtime_eventloop_delay_p99_ms`, `runtime_memory_heap_used_mb`

Cross-Chain (port 3006):
- `cross_chain_opportunities_total`

Flags:
- Required metric missing -> M:METRICS_COMPLETENESS
- >50% required metrics missing from a service -> H:METRICS_COMPLETENESS
- All present -> I:METRICS_COMPLETENESS

---

## Section 3.9: Dashboard Validation

### 3AJ -- SPA Availability

1. Check built SPA: `Glob: services/coordinator/public/index.html`
2. Verify coordinator serves SPA:
```bash
DASHBOARD_HTML=$(curl -sf --max-time 10 http://localhost:3000/ 2>/dev/null | head -20)
echo "$DASHBOARD_HTML"
```

Check for: `<div id="root">` (React SPA), `(legacy view)` (fallback), `Unauthorized` (auth).

Flags:
- SPA not built (index.html missing) -> H:DASHBOARD_AVAILABILITY
- Legacy fallback served -> H:DASHBOARD_AVAILABILITY
- Returns 401 -> M:DASHBOARD_AVAILABILITY (expected with `DASHBOARD_AUTH_TOKEN` set)
- React SPA served -> I:DASHBOARD_AVAILABILITY

---

### 3AK -- SSE Connectivity & Data Shape (LIVE curl -- not cached)

**Must use LIVE curl** (SSE is a streaming connection, not cacheable):
```bash
TOKEN="${DASHBOARD_AUTH_TOKEN:-}"
URL="http://localhost:3000/api/events"
if [ -n "$TOKEN" ]; then URL="$URL?token=$TOKEN"; fi
curl -sf -N --max-time 15 "$URL" 2>/dev/null | head -60 > ./monitor-session/findings/sse-capture.txt
cat ./monitor-session/findings/sse-capture.txt
```

SSE emits `metrics`, `services`, `circuit-breaker` immediately on connect.
`diagnostics` emits every 10s.

**Validate `metrics` data shape** -- required fields (dashboard crashes if missing):
`systemHealth` (number), `totalExecutions` (number), `successfulExecutions` (number),
`totalProfit` (number), `averageLatency` (number), `activeServices` (number),
`totalOpportunities` (number), `opportunitiesDropped` (number), `lastUpdate` (number).

**Validate `services` data shape**: at least one entry with `name`, `status`, `uptime`,
`memoryUsage`, `cpuUsage`.

**Validate `circuit-breaker`**: `state` (CLOSED|OPEN|HALF_OPEN), `consecutiveFailures`,
`totalFailures`, `totalSuccesses`, `timestamp`.

**Validate `diagnostics`**: `timestamp`, `pipeline` (.e2e with p50/p95/p99),
`runtime` (.eventLoop, .memory, .gc, .uptimeSeconds), `providers` (.rpcByChain, .rpcByMethod,
.wsMessages, .totalRpcErrors, .reconnections).

Flags:
- SSE non-200 or timeout -> C:DASHBOARD_SSE
- SSE returns 401 -> H:DASHBOARD_SSE (token mismatch)
- `metrics` missing required field -> H:DASHBOARD_SSE (crash on `.toFixed()`)
- `services` missing `name` or `status` -> H:DASHBOARD_SSE
- `circuit-breaker` missing `state` -> H:DASHBOARD_SSE
- No `metrics` event within 10s -> H:DASHBOARD_SSE
- `diagnostics` missing `pipeline`/`runtime`/`providers` -> H:DASHBOARD_SSE
- No `diagnostics` within 15s -> M:DASHBOARD_SSE
- All events correct -> I:DASHBOARD_SSE

---

### 3AN -- REST Endpoint Validation

Test each dashboard REST dependency using cached data where available:

1. **Leader** (AdminTab): `cat ./monitor-session/config/cache/leader.json`
   Expected: `{ isLeader, instanceId, lockKey }`

2. **Alerts** (AdminTab):
   ```bash
   curl -sf --max-time 10 http://localhost:3000/api/alerts 2>/dev/null
   ```
   Expected: `Alert[]` array. 401 = auth working (INFO).

3. **Redis stats** (StreamsTab):
   ```bash
   curl -sf --max-time 10 http://localhost:3000/api/redis/stats 2>/dev/null
   ```
   Expected: `{ totalCommands?, commandsPerSecond?, memoryUsed?, connectedClients? }`

4. **Diagnostics** (DiagnosticsTab): `cat ./monitor-session/config/cache/diagnostics.json`
   Expected: `DiagnosticsSnapshot` with `timestamp`, `pipeline`, `runtime`, `providers`.

5. **EE health for drawdown** (RiskTab):
   ```bash
   curl -sf --max-time 10 http://localhost:3000/ee/health 2>/dev/null | jq '{riskState, simulationMode, healthyProviders, queueSize, activeExecutions, successRate}'
   ```
   Verify response contains `riskState`. Check dashboard uses `/ee/health` (not `/health`):
   ```
   Grep for: fetchJson.*health  in dashboard/src/tabs/RiskTab.tsx
   ```

Flags:
- `/api/leader` missing `isLeader` -> M:DASHBOARD_REST
- `/api/redis/stats` non-200 -> M:DASHBOARD_REST
- `/ee/health` returns 503 -> H:DASHBOARD_REST (RiskTab drawdown invisible)
- EE uses `riskState` but dashboard expects `drawdownState` -> H:DASHBOARD_REST (field mismatch)
- RiskTab fetches `/health` instead of `/ee/health` -> H:DASHBOARD_REST
- `/api/diagnostics` non-200 -> M:DASHBOARD_REST
- `/api/diagnostics` missing `pipeline`/`runtime` -> H:DASHBOARD_REST
- `/api/alerts` returns 401 without token -> M:DASHBOARD_REST
- All OK -> I:DASHBOARD_REST

---

### 3AO -- Service Name Key Matching

```bash
curl -sf --max-time 10 http://localhost:3000/stats 2>/dev/null | jq '.services | keys'
```

Expected dashboard keys (from ChainsTab.tsx):
`partition-asia-fast` (P1), `partition-l2-turbo` (P2), `partition-high-value` (P3),
`partition-solana-native` (P4), `cross-chain-detector`, `execution-engine`

Cross-ref: `Read dashboard/src/tabs/ChainsTab.tsx` to verify partition `id` values.

Flags:
- Dashboard key not in coordinator map -> H:DASHBOARD_KEY_MISMATCH (shows "unknown")
- Coordinator key not in dashboard -> L:DASHBOARD_KEY_MISMATCH
- All match -> I:DASHBOARD_KEY_MISMATCH

---

### 3AP -- Production Proxy Config

1. Read `dashboard/vite.config.ts` -- extract proxy routes and targets.

Non-coordinator proxies needing coordinator production equivalents:

| Vite Proxy | Target | Needs Coordinator Proxy? |
|-----------|--------|--------------------------|
| `/api` | 3000 | No |
| `/health` | 3000 | No |
| `/circuit-breaker` | 3005 | YES |
| `/ee` | 3005 | YES |

2. Verify coordinator has matching proxies:
```
Grep for: circuit-breaker|ee/health  in services/coordinator/src/api/routes/index.ts
```

3. Test production proxy routes:
```bash
curl -sf --max-time 10 http://localhost:3000/ee/health 2>/dev/null | jq '.riskState // "NOT_PRESENT"'
curl -sf --max-time 10 http://localhost:3000/circuit-breaker 2>/dev/null | jq '.state // "NOT_PRESENT"'
```

Flags:
- `/circuit-breaker` not proxied by coordinator -> H:DASHBOARD_PROXY (CB buttons fail in prod)
- `/ee/health` not proxied by coordinator -> H:DASHBOARD_PROXY (RiskTab blind in prod)
- Proxy returns 503 -> M:DASHBOARD_PROXY (infra works but target down)
- All proxy routes have production equivalents -> I:DASHBOARD_PROXY

---

### 3AQ -- Stream Health Display

1. Capture SSE `streams` event (use 3AK capture or wait):
```bash
TOKEN="${DASHBOARD_AUTH_TOKEN:-}"
URL="http://localhost:3000/api/events"
if [ -n "$TOKEN" ]; then URL="$URL?token=$TOKEN"; fi
curl -sf -N --max-time 15 "$URL" 2>/dev/null | grep -A1 "event: streams" | head -5
```

2. Validate shape per stream entry:
```json
{ "[streamName]": { "length": number, "pending": number, "consumerGroups": number, "status": "healthy|warning|critical|unknown" } }
```

3. Verify numeric fields are numbers (not strings from Redis deser).
   `formatNumber(info.length)` expects `number`, not `string`.

4. Cross-ref SSE streams against Redis discovered streams (3I).
   Stream in Redis but not in SSE -> dashboard blind spot.

5. Verify `status` values in `{healthy, warning, critical, unknown}`.

Flags:
- `streams` event never received in 15s -> M:DASHBOARD_STREAMS
- Active stream in Redis but missing from SSE -> L:DASHBOARD_STREAMS
- `pending`/`length` is string not number -> M:DASHBOARD_STREAMS (NaN display)
- `status` unexpected value -> L:DASHBOARD_STREAMS
- All correct -> I:DASHBOARD_STREAMS

---

### 3AR -- Diagnostics Aggregated Snapshot

1. Read cached diagnostics:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq .
```

2. Validate pipeline latency:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.pipeline.e2e'
cat ./monitor-session/config/cache/diagnostics.json | jq '.pipeline.stages | keys'
```
Stages should include some of: `ws_ingest`, `price_update`, `detection`, `publish`.
E2E p50/p95/p99 should be non-zero if pipeline has processed events.

3. Cross-reference runtime vs Prometheus:
```bash
DIAG_P99=$(cat ./monitor-session/config/cache/diagnostics.json | jq '.runtime.eventLoop.p99')
PROM_P99=$(grep runtime_eventloop_delay_p99_ms ./monitor-session/config/cache/prom_3000.txt | awk '{print $NF}')
echo "Diagnostics p99: $DIAG_P99 | Prometheus p99: $PROM_P99"
```

4. Validate provider quality:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.providers.rpcByChain | keys'
cat ./monitor-session/config/cache/diagnostics.json | jq '.providers.totalRpcErrors'
cat ./monitor-session/config/cache/diagnostics.json | jq '.providers.wsMessages | keys'
```

5. Validate stream health:
```bash
cat ./monitor-session/config/cache/diagnostics.json | jq '.streams // "not_present"'
```

Flags:
- `/api/diagnostics` returns 500 -> H:DIAGNOSTICS (collect() failed)
- `pipeline.e2e` all zeros after 30s+ uptime -> M:DIAGNOSTICS (LatencyTracker disconnected)
- `providers.rpcByChain` empty but partitions have active WS -> M:DIAGNOSTICS
- `runtime.eventLoop.p99` differs from Prometheus by >50% -> L:DIAGNOSTICS (stale data)
- `runtime.uptimeSeconds` is 0 or negative -> L:DIAGNOSTICS
- All populated -> I:DIAGNOSTICS

---

## Phase 3 Summary

After all 42 checks across 9 subsections, read `./monitor-session/findings/runtime.jsonl`:

```
PHASE 3 COMPLETE -- Runtime Validation (42 checks, 9 subsections)
  3.1 Service Health & Schema: 3A health, 3B leader, 3C schema
  3.2 Risk & CB: 3D CB states, 3E drawdown, 3F CB history*, 3G backpressure*
  3.3 Data Flow & DLQ: 3H DLQ, 3I topology, 3J lag, 3K root cause, 3L transit, 3M ack*, 3N trim*
  3.4 Runtime Performance: 3O event loop, 3P GC, 3Q memory
  3.5 Provider Quality: 3R latency, 3S errors, 3T reconnect, 3U WS rate, 3V staleness
  3.6 Detection Quality: 3W cycle timing, 3X opps/cycle, 3Y cache*
  3.7 Execution & BI: 3Z gas, 3AA sim, 3AB probability, 3AC bridge, 3AD outcomes, 3AE slippage, 3AF age, 3AG profit
  3.8 Observability: 3AH prometheus, 3AI completeness
  3.9 Dashboard: 3AJ availability, 3AK SSE, 3AN REST, 3AO keys, 3AP proxy, 3AQ streams, 3AR diagnostics
  (* = placeholder for not-yet-implemented metrics)
  Services healthy: <n>/7
  Leader elected: YES/NO
  Circuit breakers: all CLOSED / <list open chains>
  Drawdown state: NORMAL / CAUTION / HALT / RECOVERY
  DLQ entries: <n> | Top reason: <reason> (<n>%)
  Stream topology: <n>/29 correct
  Consumer groups: <n> discovered, <n> healthy
  Pending messages: <total>
  Stream transit p95: <n>ms
  Event loop p99: <n>ms (target: <50ms)
  GC major: <n> | Memory: all OK / <services above threshold>
  Provider quality: <n>/<total> chains healthy
  Detection cycle avg: <n>ms (target: <50ms)
  Execution: <n>% success, <n>% revert, <n>% timeout
  Profit slippage median: <n>% | Opp age p95: <n>ms
  Pipeline latency p95: <n>ms
  Gas spikes: <n> chains | Sim providers: <n> healthy
  Bridge recoveries pending: <n>
  Health schemas: <n>/7 valid | Metrics: <n>/<total> present
  Dashboard: SPA <OK/MISSING> | SSE <OK/FAIL> | REST <n>/<total> OK | Keys <MATCH/DRIFT> | Proxy <OK/GAPS> | Streams <OK/GAPS>
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>  LOW: <n>
```

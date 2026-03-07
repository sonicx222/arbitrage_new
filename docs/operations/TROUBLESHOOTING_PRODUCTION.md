# Production Troubleshooting Guide

> **Last Updated:** 2026-03-07
> **Related:** [MONITORING_SETUP.md](MONITORING_SETUP.md), [METRICS_REFERENCE.md](METRICS_REFERENCE.md), [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md)

Diagnostic decision trees for the most common production issues. Each section follows: Symptoms -> Diagnosis -> Resolution.

---

## 1. Execution Engine Lag / Backpressure

**Symptoms:**
- `stream:execution-requests` pending count growing (>500 warning, >1000 critical)
- `arbitrage_consumer_lag_pending` gauge increasing over time
- Backpressure ratio >0.6

**Diagnosis:**

```bash
# Check stream pending count
redis-cli XLEN stream:execution-requests
redis-cli XPENDING stream:execution-requests execution-engine-group - + COUNT 10

# Check EE health
curl -s http://localhost:3005/health | jq '.consumerLagPending, .activeExecutions, .queueSize'

# Check EE event loop
curl -s http://localhost:3005/metrics | grep eventloop_delay_p99
```

**Decision Tree:**

```
EE lag growing?
  |
  +-- Is EE healthy? (curl /ready returns 200)
  |     |
  |     +-- YES: EE processing too slowly
  |     |     |
  |     |     +-- Event loop p99 >50ms? --> Heap pressure (see Section 2)
  |     |     +-- Event loop OK? --> Detection rate exceeds EE throughput
  |     |           |
  |     |           +-- Enable chain-group routing: COORDINATOR_CHAIN_GROUP_ROUTING=true
  |     |           +-- Deploy multiple EE instances with EXECUTION_CHAIN_GROUP per group
  |     |
  |     +-- NO: EE is down or unhealthy
  |           |
  |           +-- Check logs for crash reason
  |           +-- Restart: kill the process, supervisor will restart
  |           +-- If OOM: increase MAX_OLD_SPACE_SIZE (see Section 2)
  |
  +-- Is coordinator forwarding? (check coordinator logs for "forwarding opportunity")
        |
        +-- NO: Coordinator not leader, or circuit breaker open
        +-- YES: Messages reaching stream but EE not consuming
              |
              +-- Check consumer group exists: redis-cli XINFO GROUPS stream:execution-requests
              +-- Recreate if missing: redis-cli XGROUP CREATE stream:execution-requests execution-engine-group $ MKSTREAM
```

---

## 2. Memory / Heap Pressure

**Symptoms:**
- `runtime_memory_heap_used_mb` >80% of total
- GC major pauses >1500ms
- `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed` in logs (OOM kill)

**Diagnosis:**

```bash
# Check per-service heap
curl -s http://localhost:3005/metrics | grep runtime_memory_heap
curl -s http://localhost:3000/api/metrics/prometheus | grep runtime_memory

# Check GC pressure
curl -s http://localhost:3005/metrics | grep gc_major_count

# Check system status
npm run dev:status 2>/dev/null | grep -E "Service|Memory|Heap"
```

**Resolution by Service:**

| Service | Common Cause | Fix |
|---------|-------------|-----|
| P4 Solana | Solana account subscriptions accumulate | Increase `--max-old-space-size=512` in startup |
| Coordinator | Health snapshot caching, large opportunity set | Clear stale Redis keys, reduce `MAX_ACTIVE_PAIRS` |
| Execution Engine | Pending bridge recovery entries | Prune `bridge:recovery:*` keys older than 72h |
| Any partition | Pair correlation tracking | Reduce monitored pairs or increase heap |

**Prevention:**
- Set explicit heap limits in Fly.io configs (`--max-old-space-size=384`)
- Monitor `runtime_gc_major_count_total` rate — >10/min indicates pressure
- Alert on heap >80%

---

## 3. Circuit Breaker Open

**Symptoms:**
- Zero new trades executing
- `/circuit-breaker` returns `"state": "OPEN"`
- Logs show "Circuit breaker is OPEN"

**Diagnosis:**

```bash
# Check circuit breaker state
curl -s http://localhost:3005/circuit-breaker | jq '.'

# Check what caused it to open (last failures)
curl -s http://localhost:3005/stats | jq '.stats.failedExecutions, .stats.lastFailureReason'

# Check drawdown circuit breaker
redis-cli GET risk:drawdown:state
```

**Decision Tree:**

```
Circuit breaker OPEN?
  |
  +-- Execution CB (5 consecutive failures)
  |     |
  |     +-- Gas price spike? --> Wait for normalization, CB auto-resets after 5min cooldown
  |     +-- RPC failures? --> Check provider health, failover to backup
  |     +-- All reverts? --> Check DEX liquidity, token approvals, contract state
  |     +-- Force close: POST /circuit-breaker/close (requires CIRCUIT_BREAKER_API_KEY)
  |
  +-- Drawdown CB (daily loss threshold)
  |     |
  |     +-- Check: redis-cli GET risk:drawdown:state
  |     +-- CAUTION state: Reduced position sizing (auto)
  |     +-- HALT state: No new trades until cooldown (1h default)
  |     +-- RECOVERY state: Gradually resuming
  |     +-- Manual reset (after investigation): redis-cli DEL risk:drawdown:state
  |
  +-- RPC CB (per-chain, 5 consecutive RPC failures)
        |
        +-- Check which chain: grep "circuit.*open" logs/*.log
        +-- Wait 30s for auto-reset to HALF_OPEN
        +-- If persistent: check RPC provider status, try backup provider
```

---

## 4. Dead Letter Queue Growth

**Symptoms:**
- `arbitrage_dlq_length` gauge >10
- DLQ alerts in `stream:dlq-alerts`
- Opportunities or executions silently failing

**Diagnosis:**

```bash
# Check DLQ size
redis-cli XLEN stream:dead-letter-queue

# Inspect recent DLQ entries
redis-cli XRANGE stream:dead-letter-queue - + COUNT 5

# Check for DLQ fallback files (written when Redis unavailable)
ls -la /tmp/dlq-fallback-*.jsonl 2>/dev/null
```

**Resolution:**

1. **Identify the failure pattern** from DLQ message metadata (error field)
2. **Fix the underlying cause** (usually a handler bug or schema mismatch)
3. **Clear the DLQ** after fix: `redis-cli DEL stream:dead-letter-queue`
4. **Check fallback files** — these are written when Redis itself was down

---

## 5. WebSocket Disconnections

**Symptoms:**
- `provider_ws_reconnection_duration_ms` spikes
- "WebSocket disconnected" in partition logs
- `healthyChains` count drops on partition health endpoint
- Price data becomes stale (>30s age)

**Diagnosis:**

```bash
# Check partition health
curl -s http://localhost:3001/health | jq '.healthyChains'

# Check connection state per chain
curl -s http://localhost:3001/stats | jq '.chainStats | to_entries[] | {chain: .key, connected: .value.connected}'
```

**Resolution:**

| Cause | Fix |
|-------|-----|
| RPC provider rate limit | Rotate to backup provider, check `RPC_RATE_LIMIT_PER_SEC` |
| Corporate proxy/firewall (Windows dev) | Set `NODE_TLS_REJECT_UNAUTHORIZED=0` for local dev |
| Provider outage | Wait for auto-reconnect (exponential backoff with jitter) |
| Stale connection (no messages) | ADR-010 detects and force-reconnects after chain-specific timeout (5s/10s/15s) |

---

## 6. Redis Connectivity Issues

**Symptoms:**
- Services fail to start: "ECONNREFUSED" on Redis URL
- Health endpoints return `"redisConnected": false`
- Rate limiter fails closed (all requests denied)

**Diagnosis:**

```bash
# Test Redis connection
redis-cli -u $REDIS_URL ping

# Check Redis memory
redis-cli INFO memory | grep -E "used_memory_human|maxmemory_human|maxmemory_policy"

# Check eviction policy (must be noeviction)
redis-cli CONFIG GET maxmemory-policy
```

**Resolution:**

| Issue | Fix |
|-------|-----|
| Redis not running | `npm run dev:redis` or `npm run dev:redis:memory` |
| Wrong URL | Check `REDIS_URL` in `.env.local` |
| Memory full (noeviction) | Check `XLEN` on all streams, trim oversized streams |
| `allkeys-lru` policy (wrong) | Change to `noeviction`: `redis-cli CONFIG SET maxmemory-policy noeviction` |
| BUSYGROUP errors on startup | Safe to ignore — consumer group already exists |

---

## 7. Stale Prices / No Opportunities Detected

**Symptoms:**
- Zero opportunities in coordinator dashboard
- `stream:opportunities` not receiving messages
- Prices >30s old rejected by staleness gate (ADR-033)

**Diagnosis:**

```bash
# Check if partitions are publishing
redis-cli XLEN stream:price-updates

# Check partition health
for port in 3001 3002 3003 3004; do
  echo "=== Port $port ===" && curl -s http://localhost:$port/health | jq '.status, .eventsProcessed'
done

# Check cross-chain detector
curl -s http://localhost:3006/health | jq '.'
```

**Decision Tree:**

```
No opportunities?
  |
  +-- stream:price-updates empty? --> Partitions not publishing
  |     |
  |     +-- Check WebSocket connections (Section 5)
  |     +-- Check partition logs for errors
  |
  +-- stream:price-updates has data, stream:opportunities empty?
  |     |
  |     +-- Cross-chain detector not running: curl http://localhost:3006/ready
  |     +-- Prices too stale (>30s): check staleness gate in detector logs
  |     +-- No profitable opportunities: normal during low-volatility periods
  |
  +-- stream:opportunities has data, no executions?
        |
        +-- Coordinator not leader: curl http://localhost:3000/api/leader
        +-- Circuit breaker open (Section 3)
        +-- Admission control shedding all: check arbitrage_opportunities_shed_total metric
```

---

## Quick Command Reference

```bash
# Full system status
npm run dev:status

# Check all service health at once
for port in 3000 3001 3002 3003 3004 3005 3006; do
  echo "=== $port ===" && curl -s http://localhost:$port/health 2>/dev/null | jq '.status' || echo "DOWN"
done

# Stream lengths
for s in price-updates opportunities execution-requests execution-results dead-letter-queue health; do
  echo "stream:$s = $(redis-cli XLEN stream:$s)"
done

# Force restart all services
npm run dev:stop && npm run dev:all

# Enable debug logging
LOG_LEVEL=debug npm run dev:all

# Pre-deployment validation
npm run validate:deployment
```

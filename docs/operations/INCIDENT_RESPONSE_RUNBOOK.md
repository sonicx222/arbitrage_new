# Incident Response Runbook

> **Last Updated:** 2026-03-07
> **Related:** [TROUBLESHOOTING_PRODUCTION.md](TROUBLESHOOTING_PRODUCTION.md), [MONITORING_SETUP.md](MONITORING_SETUP.md), [METRICS_REFERENCE.md](METRICS_REFERENCE.md)

Procedures for responding to production incidents. Each scenario includes severity, detection, response steps, and recovery verification.

---

## Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| **P0 - Critical** | System down, active capital loss | Immediate | OOM crash, Redis down, all EE circuit breakers open |
| **P1 - High** | Degraded, potential capital loss | 15 min | Single EE down, stream backpressure >80%, heap >90% |
| **P2 - Medium** | Reduced performance, no capital loss | 1 hour | High latency, DLQ growth, single chain disconnected |
| **P3 - Low** | Minor issues, monitoring | Next session | Stale metrics, non-critical log warnings |

---

## P0: System-Wide Service Outage

### Detection
- Multiple services returning 503 on `/health`
- Dashboard unreachable
- No new trades executing

### Response

1. **Assess scope** — which services are down?
   ```bash
   for port in 3000 3001 3002 3003 3004 3005 3006; do
     echo "$port: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:$port/health)"
   done
   ```

2. **Check Redis** (most common root cause of multi-service failure)
   ```bash
   redis-cli ping
   redis-cli INFO memory | grep used_memory_human
   ```

3. **If Redis down:**
   - Restart Redis: `npm run dev:redis` or `docker restart redis`
   - Services auto-reconnect via `onReady()` callbacks
   - Consumer groups auto-recreated on reconnect

4. **If services crashed (not Redis):**
   ```bash
   npm run dev:stop
   npm run dev:all
   ```

5. **Verify recovery:**
   ```bash
   npm run dev:status
   curl -s http://localhost:3000/api/health | jq '.systemHealth'
   ```

### Recovery Checklist
- [ ] All services returning healthy on `/health`
- [ ] DLQ length is 0 or stable
- [ ] Consumer lag not growing
- [ ] Stream lengths within normal range
- [ ] No circuit breakers in OPEN state

---

## P0: Execution Engine OOM / Crash Loop

### Detection
- `arbitrage_consumer_lag_pending` growing rapidly
- EE process exits with code 137 (OOM killed) or FATAL ERROR in logs
- `/ready` returns 503 or connection refused

### Response

1. **Check crash reason:**
   ```bash
   grep -i "FATAL\|heap\|allocation" logs/execution-engine*.log | tail -5
   ```

2. **Increase heap and restart:**
   ```bash
   # In Fly.io config or startup script
   NODE_OPTIONS="--max-old-space-size=512" npm run start:execution-engine
   ```

3. **If crash loop persists:**
   - Check for memory leaks: unbounded Maps/Sets, bridge recovery entries
   - Prune stale data: `redis-cli KEYS "bridge:recovery:*" | head -20`
   - Reduce concurrent executions: `MAX_CONCURRENT_EXECUTIONS=5`

4. **Clear backlog after recovery:**
   - EE will auto-consume pending messages from `stream:execution-requests`
   - Monitor `arbitrage_consumer_lag_pending` — should decrease steadily
   - If backlog too large (>5000): consider trimming stale entries

### Recovery Checklist
- [ ] EE process stable (no restarts for 5 minutes)
- [ ] Consumer lag decreasing
- [ ] Heap usage <70% after stabilization
- [ ] Circuit breaker in CLOSED state

---

## P1: Stream Backpressure Critical (>80%)

### Detection
- `stream_health_status{stream="execution-requests"} == 0` (critical)
- Stream length approaching MAXLEN (100K for execution-requests)
- Active trimming visible in logs

### Response

1. **Assess throughput mismatch:**
   ```bash
   # Detection rate (input)
   redis-cli XLEN stream:opportunities

   # Execution rate (output)
   redis-cli XLEN stream:execution-results
   ```

2. **Short-term: Reduce detection rate**
   - Increase minimum profit threshold to reduce opportunity volume
   - Or increase `PRICE_STALENESS_MS` to reject more stale opportunities

3. **Medium-term: Scale execution**
   ```bash
   # Enable chain-group routing
   COORDINATOR_CHAIN_GROUP_ROUTING=true

   # Deploy per-group EE instances
   EXECUTION_CHAIN_GROUP=fast   # BSC, Polygon, Avalanche, Fantom
   EXECUTION_CHAIN_GROUP=l2     # Arbitrum, Optimism, Base, Scroll, Blast
   EXECUTION_CHAIN_GROUP=premium # Ethereum, zkSync, Linea
   EXECUTION_CHAIN_GROUP=solana  # Solana
   ```

4. **If MAXLEN trimming is causing data loss:**
   - Increase MAXLEN in `shared/core/src/redis/streams.ts` (`STREAM_MAX_LENGTHS`)
   - Rebuild and redeploy

### Recovery Checklist
- [ ] Backpressure ratio <0.6
- [ ] No active MAXLEN trimming
- [ ] Consumer lag stable or decreasing

---

## P1: All Circuit Breakers Open

### Detection
- Zero trades executing across all strategies
- Multiple `arbitrage_circuit_breaker_open` metrics at 1
- Drawdown circuit breaker in HALT state

### Response

1. **Identify root cause (DO NOT blindly force-close):**
   ```bash
   curl -s http://localhost:3005/circuit-breaker | jq '.'
   curl -s http://localhost:3005/stats | jq '.stats.lastFailureReason'
   redis-cli GET risk:drawdown:state
   ```

2. **If gas price spike:**
   - Wait for gas to normalize
   - CB will auto-reset after 5-minute cooldown
   - Monitor: `curl -s http://localhost:3005/metrics | grep gas_price_gwei`

3. **If RPC provider outage:**
   - Check provider status pages
   - Failover occurs automatically if backup providers configured
   - Wait for auto-reset (30s cooldown per RPC CB)

4. **If legitimate drawdown (capital loss):**
   - DO NOT force-close — the CB is protecting capital
   - Review recent trades for patterns (slippage, frontrunning)
   - Adjust strategy parameters before resuming

5. **Force close (only after investigation):**
   ```bash
   curl -X POST -H "X-API-Key: $CIRCUIT_BREAKER_API_KEY" \
     http://localhost:3005/circuit-breaker/close
   ```

### Recovery Checklist
- [ ] Root cause identified and documented
- [ ] Gas prices within normal range
- [ ] RPC providers healthy
- [ ] Force-close only used after investigation
- [ ] Monitoring drawdown state after resumption

---

## P2: Single Chain Disconnected

### Detection
- Partition `/health` shows reduced `healthyChains` count
- `provider_ws_reconnection_duration_ms` spike for specific chain
- Price staleness for one chain (>30s age, rejected by ADR-033)

### Response

1. **Identify which chain:**
   ```bash
   curl -s http://localhost:3001/stats | jq '.chainStats | to_entries[] | select(.value.connected == false) | .key'
   ```

2. **Check if RPC provider issue:**
   - Check provider status page
   - Auto-reconnect with exponential backoff is built-in (ADR-010)
   - Wait 2-3 minutes for auto-recovery

3. **If persistent (>5 min):**
   - Check rate limits: `curl -s http://localhost:3005/metrics | grep rpc_errors`
   - Rotate provider: update `{CHAIN}_RPC_URL` and `{CHAIN}_WS_URL`
   - Restart affected partition only

4. **Cross-chain impact:**
   - Cross-chain opportunities involving the disconnected chain will fail staleness check
   - Same-chain opportunities on other chains continue normally

---

## P2: DLQ Growing

### Detection
- `arbitrage_dlq_length` >10 and increasing
- DLQ alerts in `stream:dlq-alerts`

### Response

1. **Inspect DLQ entries:**
   ```bash
   redis-cli XRANGE stream:dead-letter-queue - + COUNT 5
   ```

2. **Identify pattern:**
   - Consistent error → handler bug (fix code, redeploy)
   - Intermittent errors → transient issue (messages will be retried)
   - Schema mismatch → check producer/consumer version alignment

3. **After fix, clear DLQ:**
   ```bash
   redis-cli DEL stream:dead-letter-queue
   ```

4. **Check for fallback files** (written when Redis was unavailable):
   ```bash
   ls -la /tmp/dlq-fallback-*.jsonl 2>/dev/null
   ```

---

## Post-Incident Procedures

### 1. Document the Incident

Record in a monitoring report or incident log:
- **What happened**: Symptom description
- **When**: Timestamp of detection and resolution
- **Root cause**: Underlying issue
- **Resolution**: Steps taken
- **Duration**: Time from detection to resolution
- **Impact**: Trades missed, capital at risk, data lost

### 2. Verify Data Integrity

```bash
# Check DLQ is empty
redis-cli XLEN stream:dead-letter-queue

# Check stream health
for s in price-updates opportunities execution-requests execution-results; do
  echo "stream:$s = $(redis-cli XLEN stream:$s)"
done

# Verify no duplicate trades (check trade logger)
ls -la trades-$(date +%Y-%m-%d).jsonl
```

### 3. Update Monitoring

- Adjust alert thresholds if detection was too slow
- Add missing alerts for newly discovered failure modes
- Update this runbook with new resolution steps

### 4. Run Validation

```bash
npm run validate:deployment    # Pre-deploy checks
npm run dev:status            # Verify all services healthy
```

---

## Emergency Commands

```bash
# Stop everything immediately
npm run dev:stop

# Restart everything
npm run dev:all

# Redis emergency: flush all streams (DESTRUCTIVE)
# Only use if Redis memory is full and system is completely stuck
redis-cli KEYS "stream:*" | xargs -I{} redis-cli DEL {}

# Check Redis memory
redis-cli INFO memory | grep -E "used_memory|maxmemory"

# Force Redis to save state
redis-cli BGSAVE

# Monitor Redis commands in real-time
redis-cli MONITOR | head -100
```

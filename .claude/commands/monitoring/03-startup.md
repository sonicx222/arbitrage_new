# Phase 2 — Startup & Readiness
# 5 steps + Check 1W (reclassified from Phase 1). ~60 seconds.
# Reads inventory from `./monitor-session/config/inventory.json`
# Reads timeouts from `.claude/commands/monitoring/config.json`

```
[PHASE 2/5] Startup & Readiness — starting (5 steps)
```

**Retry:** Redis commands in this phase use the retry wrapper (O-03 from config.json.retry).
Redis LOADING during startup is expected — retry handles it transparently.

Record findings to `./monitor-session/findings/startup.jsonl`:
```json
{"phase":"STARTUP","findingId":"ST-NNN","category":"SERVICE_READY|SERVICE_FAILED|REDIS_FAILED|REDIS_SECURITY|STREAM_TOPOLOGY|METRICS_ENDPOINT|CONFIG_DRIFT","severity":"...","service":"...","port":0,"startupTimeMs":0,"evidence":"..."}
```

---

## Step 2A — Start Redis

```bash
npm run dev:redis:memory &
sleep 3
redis-cli PING
```

- PING fails → C:REDIS_FAILED — skip to Phase 5 (nothing works without Redis)
  `"quickFix": "npm run dev:redis:memory"`

Verify stream command support:
```bash
redis-cli COMMAND INFO XADD XREAD XREADGROUP XPENDING XINFO XACK XLEN XCLAIM
```

- Any stream command unsupported → C:REDIS_FAILED (version mismatch)

---

## Step 2A.5 — Redis Security (was Check 1W)

```bash
redis-cli CONFIG GET requirepass
redis-cli CONFIG GET bind
```

Flags:
- `requirepass` empty AND `bind` not `127.0.0.1` → H:REDIS_SECURITY (unauthenticated on network)
- `requirepass` set or `bind` is localhost → I:REDIS_SECURITY

---

## Step 2B — Start services (mode-conditional)

All monitoring scripts use `tsx` (no watchers), `CONSTRAINED_MEMORY=true`, `CACHE_L1_SIZE_MB=8`.
Peak RAM: ~600MB (vs ~1.5GB in normal dev).

```bash
MONITOR_DATA_MODE=$(cat ./monitor-session/DATA_MODE)
```

| Mode | Command | Notes |
|------|---------|-------|
| `simulation` | `npm run dev:monitor &` | SIMULATION_REALISM_LEVEL=high (Markov regime) |
| `simulation` (minimal) | `npm run dev:monitor:minimal &` | Coordinator + P1 + EE only (~350MB) |
| `live` | `npm run dev:monitor:live &` | Real WS RPC, mock execution |
| `testnet` | `npm run dev:monitor:testnet &` | Real WS RPC, real testnet execution |

**Simulation realism levels:**

| Level | Behavior |
|-------|----------|
| `low` | Legacy setInterval, flat rate |
| `medium` | Block-driven, Poisson swaps, gas model |
| `high` | Medium + Markov regime (quiet/normal/burst) |

Override: `cross-env SIMULATION_REALISM_LEVEL=medium npm run dev:monitor &`

`[TESTNET]` DANGER: Submits real transactions. Use `.env.local` (gitignored) for testnet
RPC URLs and funded wallet key. Never put private keys in `.env`.

Capture PID for later cleanup.

---

## Step 2C — Poll readiness

Poll each service's ready endpoint every 5s using inventory-driven ports.
Use mode-conditional timeouts from `config.json`.readinessTimeouts:

| Service | Timeout `[SIM]` | Timeout `[LIVE/TESTNET]` | Reason |
|---------|-----------------|--------------------------|--------|
| Coordinator | 30s | 30s | Redis + leader election |
| P1-P4 Partitions | 30s | 60s | `[LIVE]`: real WS connections 5-15s/chain |
| Execution Engine | 30s | 30s | Redis + consumer groups |
| Cross-Chain | 120s | 180s | Needs real partition price data first |

For each service from `inventory.json`.services (ports 3000-3006):
```bash
# Coordinator uses /api/health/ready, all others use /ready
curl -sf --max-time 10 http://localhost:$port/$readyEndpoint
```

Flags:
- Ready within timeout → I:SERVICE_READY (record startup time)
- Cross-chain not ready after timeout → H:SERVICE_FAILED (extended timeout exceeded)
- Any other service not ready after timeout → C:SERVICE_FAILED
  `"quickFix": "npm run dev:stop && npm run dev:all"`
- `[LIVE]` Partition timeout + missing RPC URL → H:SERVICE_FAILED (config gap, not code bug)

**Cross-Chain Detector note:** Its `/ready` requires `chainsMonitored > 0` — needs
at least one price update from partitions. SIM: 60-90s, LIVE: 90-150s. Do NOT treat
expected delay as failure — only flag if exceeds mode-specific timeout.

---

## Step 2D — Capture baseline stream state

```bash
redis-cli --scan --pattern 'stream:*' > ./monitor-session/streams/discovered.txt

for stream in $(cat ./monitor-session/streams/discovered.txt); do
  echo "=== $stream ===" >> ./monitor-session/streams/baseline.txt
  redis-cli XINFO STREAM $stream >> ./monitor-session/streams/baseline.txt
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/baseline.txt
  redis-cli XLEN $stream >> ./monitor-session/streams/baseline.txt
done

redis-cli INFO memory > ./monitor-session/streams/redis-memory-baseline.txt
```

Compare discovered streams against `inventory.json`.streams:
- Expected stream missing → M:STREAM_TOPOLOGY
- Unexpected stream exists → I:STREAM_TOPOLOGY

---

## Step 2E — Readiness endpoint consistency

Test BOTH endpoint patterns on all services:
```bash
for port in $(cat inventory ports 3000-3006); do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:$port/ready 2>/dev/null || echo "000")
  echo "Port $port /ready: $STATUS"
done
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/health/ready 2>/dev/null || echo "000")
echo "Port 3000 /api/health/ready: $STATUS"
```

Test metrics endpoints:
```bash
for port in 3001 3002 3003 3004 3005 3006; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:$port/metrics 2>/dev/null || echo "000")
  echo "Port $port /metrics: $STATUS"
done
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/metrics/prometheus 2>/dev/null || echo "000")
```

Also: Grep `infrastructure/fly/*.toml` for `path =` and `infrastructure/docker/docker-compose*.yml`
for health check paths. Compare against actual service endpoints.

Flags:
- Coordinator 404 on `/ready` → H:SERVICE_READY (infra tools using uniform path will fail)
- Non-coordinator 404 on `/ready` → C:SERVICE_READY
- Infra config path returns 404 → H:CONFIG_DRIFT
- Service `/metrics` non-200 → M:METRICS_ENDPOINT
- Coordinator `/api/metrics/prometheus` non-200 → M:METRICS_ENDPOINT
- All services respond on documented paths → I:SERVICE_READY

---

## Phase 2 Summary

```
[PHASE 2/5] Startup & Readiness — complete (C:<n> H:<n> M:<n>)
PHASE 2 COMPLETE — Startup
  Services ready: <n>/7 (list names)
  Services failed: <n> (list names)
  Streams discovered: <n>/29
  Missing streams: <list>
  Unexpected streams: <list>
  Readiness endpoints: <n>/7 consistent
```

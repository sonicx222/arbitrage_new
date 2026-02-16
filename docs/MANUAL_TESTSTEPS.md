# Manual Test Steps: Local Arbitrage System Verification

## Purpose

This guide verifies the local stack end-to-end against the current codebase, scripts, and environment behavior.

It covers:
- service startup and health
- Redis stream activity
- coordinator/execution integration
- clean shutdown and reset

## Current Service Map (Source of Truth)

| Service | Port | Health Endpoint | Started by `dev:all` |
|---------|------|-----------------|----------------------|
| Redis | 6379 | TCP check (`redis-cli ping`) | No (start separately) |
| Coordinator | 3000 | `/api/health` | Yes |
| P1 Asia-Fast Detector | 3001 | `/health` | Yes |
| P2 L2-Turbo Detector | 3002 | `/health` | Yes |
| P3 High-Value Detector | 3003 | `/health` | Yes |
| Execution Engine | 3005 | `/health` | Yes |
| Cross-Chain Detector | 3006 | `/health` | Yes |
| P4 Solana Detector (optional) | 3004 | `/health` | No |
| Unified Detector (legacy optional) | 3007 | `/health` | No |

Primary references:
- `package.json`
- `scripts/lib/service-definitions.js`
- `shared/constants/service-ports.json`

## Important Notes Before Testing

1. Node requirement is `>=22` (from `package.json` `engines.node`).
2. `npm run dev:all` loads values from `.env` (via `tsx --env-file=.env`).
3. `npm run dev:status` loads `.env` then `.env.local` (with override).
4. If you changed `.env.local`, run `npm run dev:setup` before `dev:all` so `.env` stays in sync.
5. Status output may show `Running (degraded)` when the process is up but health endpoint is slow under load. This is expected and not the same as `Not running`.
6. On Windows PowerShell, you can replace `curl -s` with `irm` (`Invoke-RestMethod`) for HTTP checks.

## Redis Stream Names to Expect

Core streams (from `shared/core/src/redis-streams.ts`):
- `stream:health`
- `stream:opportunities`
- `stream:execution-requests`
- `stream:price-updates`
- `stream:swap-events`
- `stream:whale-alerts`
- `stream:volume-aggregates`
- `stream:pending-opportunities`
- `stream:circuit-breaker`
- `stream:system-failover`

Failure/DLQ streams used by coordinator/execution:
- `stream:dead-letter-queue`
- `stream:forwarding-dlq`

---

## Phase 1: Prerequisites and Setup

```bash
node --version
npm --version
```

Expected:
- Node 22+

Install and sync environment files:

```bash
npm install
npm run dev:setup
```

Optional preflight:

```bash
npm run build
npm run typecheck
```

---

## Phase 2: Start Local Stack

### 2.1 Start Redis (choose one)

In-memory Redis (no Docker required):

```bash
npm run dev:redis:memory
```

Docker Redis:

```bash
npm run dev:redis
```

### 2.2 Start Services

Recommended for manual testing (foreground with hot reload):

```bash
npm run dev:all
```

Alternative managed startup (detached, includes build):

```bash
npm run dev:simulate:full
```

Notes:
- `dev:all` starts 6 core services (Coordinator + P1/P2/P3 + Cross-Chain + Execution).
- `dev:all` does not start Redis.

---

## Phase 3: Verify Startup and Health

In a separate terminal:

```bash
npm run dev:status
```

Expected:
- Redis: `Running`
- Core services: `Running` or `Running (degraded)` during heavy startup/load
- Optional services may show `Not running (optional)`

### 3.1 Quick HTTP health checks

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3001/health
curl -s http://localhost:3002/health
curl -s http://localhost:3003/health
curl -s http://localhost:3005/health
curl -s http://localhost:3006/health
```

PowerShell equivalent:

```powershell
irm http://localhost:3000/api/health
irm http://localhost:3001/health
irm http://localhost:3002/health
irm http://localhost:3003/health
irm http://localhost:3005/health
irm http://localhost:3006/health
```

Coordinator (`/api/health`) currently returns a minimal shape for unauthenticated requests:

```json
{
  "status": "ok",
  "systemHealth": 100,
  "timestamp": 1234567890
}
```

Execution health (`/health`) should include:
- `service: "execution-engine"`
- `status` (`healthy` or `degraded`)
- `simulationMode`

---

## Phase 4: Dashboard and API Checks

Open:

`http://localhost:3000`

Verify:
- dashboard loads
- metrics update over time
- service cards reflect current state

### 4.1 Coordinator API checks

In default local dev (`NODE_ENV=development` and no JWT/API keys configured), read APIs are available:

```bash
curl -s http://localhost:3000/api/metrics
curl -s http://localhost:3000/api/services
curl -s http://localhost:3000/api/leader
```

If you configured `JWT_SECRET` or `API_KEYS`, include auth headers accordingly.

---

## Phase 5: Redis Streams Verification

### 5.1 Connect to Redis CLI

Local/in-memory:

```bash
redis-cli -h 127.0.0.1 -p 6379
```

If `redis-cli` is unavailable on Windows, use Docker Redis (`npm run dev:redis`) and run `docker exec -it arbitrage-redis redis-cli` instead.

Docker:

```bash
docker exec -it arbitrage-redis redis-cli
```

### 5.2 List streams (use SCAN, not KEYS)

```redis
SCAN 0 MATCH stream:* COUNT 200
```

Expected:
- at least `stream:health` and `stream:price-updates`

### 5.3 Validate stream activity

```redis
XLEN stream:health
XLEN stream:price-updates
XLEN stream:opportunities
```

Wait 10-20 seconds and run again. Expected:
- `stream:health` and `stream:price-updates` should increase
- `stream:opportunities` can be zero or non-zero depending on timing and filters

### 5.4 Check recent messages

```redis
XREVRANGE stream:health + - COUNT 3
XREVRANGE stream:price-updates + - COUNT 3
```

### 5.5 Check consumer groups

```redis
XINFO GROUPS stream:health
XINFO GROUPS stream:execution-requests
```

Expected groups:
- `coordinator-group` on coordinator-consumed streams
- `execution-engine-group` on `stream:execution-requests`

---

## Phase 6: Execution Engine API Checks

```bash
curl -s http://localhost:3005/health
curl -s http://localhost:3005/stats
curl -s http://localhost:3005/circuit-breaker
```

PowerShell equivalent:

```powershell
irm http://localhost:3005/health
irm http://localhost:3005/stats
irm http://localhost:3005/circuit-breaker
```

Expected:
- health endpoint responds with service status and simulation flag
- stats endpoint returns execution stats object
- circuit breaker endpoint responds with breaker state data

---

## Phase 7: End-to-End Behavior Check

After 60 seconds of runtime:

1. `npm run dev:status` still shows core services running.
2. `/api/metrics` shows movement (for example price updates and processed counters).
3. Redis stream lengths continue increasing for health and price updates.

Quick checks:

```bash
curl -s http://localhost:3000/api/metrics
redis-cli XLEN stream:health
redis-cli XLEN stream:price-updates
redis-cli XLEN stream:execution-requests
```

Docker Redis equivalent:

```bash
docker exec -it arbitrage-redis redis-cli XLEN stream:health
docker exec -it arbitrage-redis redis-cli XLEN stream:price-updates
docker exec -it arbitrage-redis redis-cli XLEN stream:execution-requests
```

---

## Phase 8: Shutdown and Cleanup

### If started with `dev:all`

- press `Ctrl+C` in the `dev:all` terminal

### If started with managed scripts (`dev:start` / `dev:simulate:*`)

```bash
npm run dev:stop
```

Then verify:

```bash
npm run dev:status
```

Expected:
- core services reported as not running

---

## Troubleshooting

| Issue | Likely Cause | Fix |
|------|--------------|-----|
| `dev:status` says down, terminal looks up | health endpoint timed out or env mismatch | rerun status after warmup; run `npm run dev:setup` to sync `.env` and `.env.local` |
| Services fail immediately on `dev:all` | port conflict or config issue | `npm run dev:cleanup` then retry |
| Redis stream checks empty | Redis not running | start Redis first (`dev:redis` or `dev:redis:memory`) |
| Wrong ports in status checks | `.env` and `.env.local` differ | run `npm run dev:setup` |

### Full local reset

```bash
npm run dev:stop
npm run dev:cleanup
node -e "try{require('fs').unlinkSync('.redis-memory-config.json')}catch{}"
npm run dev:setup
```

Then restart:

```bash
npm run dev:redis:memory
npm run dev:all
```

---

## Success Criteria

- [ ] Redis running and reachable
- [ ] All 6 core services started
- [ ] `npm run dev:status` reports core services as `Running` or `Running (degraded)`
- [ ] Coordinator dashboard reachable at `http://localhost:3000`
- [ ] `stream:health` and `stream:price-updates` actively receiving messages
- [ ] Consumer groups exist for coordinator and execution engine flows
- [ ] Execution engine health/stats/circuit-breaker endpoints respond
- [ ] Shutdown leaves no stale local service processes

## Related Files

- `package.json`
- `scripts/status-local.js`
- `scripts/start-local.js`
- `scripts/stop-local.js`
- `scripts/cleanup-services.js`
- `scripts/lib/services-config.js`
- `shared/core/src/redis-streams.ts`
- `shared/constants/service-ports.json`
- `docs/local-development.md`

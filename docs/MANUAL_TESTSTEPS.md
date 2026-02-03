# Manual Testing Plan: Arbitrage System Local Development Verification

## Overview

This document provides step-by-step manual testing procedures to verify the entire arbitrage system (detection, coordinator, Redis streams, execution) works correctly in local development.

## System Architecture

| Service | Port | Health Endpoint | Purpose |
|---------|------|-----------------|---------|
| Coordinator | 3000 | `/api/health` | Dashboard, leader election, orchestration |
| P1 Asia-Fast | 3001 | `/health` | BSC, Polygon, Avalanche, Fantom detection |
| P2 L2-Turbo | 3002 | `/health` | Arbitrum, Optimism, Base detection |
| P3 High-Value | 3003 | `/health` | Ethereum, zkSync, Linea detection |
| Execution Engine | 3005 | `/health` | Trade execution |
| Cross-Chain | 3006 | `/health` | Cross-chain arbitrage detection |

## Redis Streams

| Stream | Purpose |
|--------|---------|
| `stream:health` | Service heartbeats |
| `stream:opportunities` | Detected arbitrage opportunities |
| `stream:execution-requests` | Forwarded to execution |
| `stream:price-updates` | Price feed data |
| `stream:swap-events` | Swap event data |

---

## Phase 1: Environment Setup (5 min)

### 1.1 Verify Prerequisites
```bash
node --version    # Should be 18+
npm --version     # Should be 9+
```

### 1.2 Build Project
```bash
npm install
npm run build
npm run typecheck   # Should pass with no errors
```

### 1.3 Configure Environment
```bash
npm run dev:setup   # Creates .env from .env.local
```

---

## Phase 2: Start Services (5 min)

### 2.1 Start Redis
```bash
# Option A: In-memory (no Docker required)
npm run dev:redis:memory

# Option B: Docker
npm run dev:redis
```

**Expected:** Redis running on port 6379

### 2.2 Start All Services with Simulation
```bash
# In new terminal - set simulation mode for testing
set SIMULATION_MODE=true
set EXECUTION_SIMULATION_MODE=true
npm run dev:all
```

**Expected:** All 6 services start, logs show "Starting..."

### 2.3 Verify Startup
```bash
npm run dev:status
```

**Expected Output:**
```
Service Status:
  Redis                  (port 6379)   Running
  Coordinator            (port 3000)   Running - healthy
  P1 Asia-Fast Detector  (port 3001)   Running - healthy
  P2 L2-Turbo Detector   (port 3002)   Running - healthy
  P3 High-Value Detector (port 3003)   Running - healthy
  Cross-Chain Detector   (port 3006)   Running - healthy
  Execution Engine       (port 3005)   Running - healthy
```

---

## Phase 3: Health Check Verification (5 min)

### 3.1 Coordinator Health
```bash
curl http://localhost:3000/api/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "isLeader": true,
  "services": {"healthy": 6, "degraded": 0, "unhealthy": 0},
  "metrics": {"systemHealth": 100}
}
```

### 3.2 Execution Engine Health
```bash
curl http://localhost:3005/health
```

**Expected Response:**
```json
{
  "service": "execution-engine",
  "status": "healthy",
  "simulationMode": true,
  "queueSize": 0
}
```

### 3.3 Dashboard Visual Check
Open browser: http://localhost:3000

**Verify:**
- System health shows green/100%
- All 6 services listed as healthy
- Leader status shows "LEADER"

---

## Phase 4: Redis Streams Verification (10 min)

### 4.1 Connect to Redis
```bash
# For in-memory Redis (if redis-cli available)
redis-cli -h 127.0.0.1 -p 6379

# For Docker Redis
docker exec -it arbitrage-redis redis-cli
```

### 4.2 Verify Streams Exist
```
KEYS stream:*
```

**Expected:** At least `stream:health`, `stream:price-updates`

### 4.3 Check Stream Activity
```
XLEN stream:health
# Wait 10 seconds
XLEN stream:health
```

**Expected:** Count increases (health heartbeats)

### 4.4 View Health Messages
```
XREVRANGE stream:health + - COUNT 3
```

**Expected:** Messages with service names, status, timestamps

### 4.5 Check Consumer Groups
```
XINFO GROUPS stream:health
XINFO GROUPS stream:opportunities
```

**Expected:** `coordinator-group` exists with 1+ consumers

---

## Phase 5: Detection Flow Testing (10 min)

### 5.1 Verify Price Updates (Simulation Mode)
```
XLEN stream:price-updates
# Wait 5 seconds
XLEN stream:price-updates
```

**Expected:** Count increases with simulated prices

### 5.2 View Simulated Prices
```
XREVRANGE stream:price-updates + - COUNT 3
```

**Expected:** Price data with chain, dex, pairKey, price fields

### 5.3 Check for Opportunities
```
XLEN stream:opportunities
```

**Expected:** May be > 0 if simulation generated arbitrage scenarios

### 5.4 Verify Coordinator Receives Data
```bash
curl http://localhost:3000/api/metrics
```

**Expected:** `priceUpdatesReceived` > 0, `totalSwapEvents` growing

---

## Phase 6: Coordinator & Leader Election (5 min)

### 6.1 Verify Leader Status
```bash
curl http://localhost:3000/api/health | findstr isLeader
```

**Expected:** `"isLeader": true`

### 6.2 Check Leader Lock in Redis
```
GET coordinator:leader:lock
TTL coordinator:leader:lock
```

**Expected:** Lock value contains instance ID, TTL between 20-30 seconds

### 6.3 Verify Service Registration
```bash
curl http://localhost:3000/api/services
```

**Expected:** All 6 services listed as healthy

---

## Phase 7: Execution Engine Testing (5 min)

### 7.1 Verify Simulation Mode Active
```bash
curl http://localhost:3005/health | findstr simulationMode
```

**Expected:** `"simulationMode": true`

### 7.2 Check Circuit Breaker
```bash
curl http://localhost:3005/circuit-breaker
```

**Expected:** `"state": "CLOSED"`, `"failures": 0`

### 7.3 Check Execution Stats
```bash
curl http://localhost:3005/stats
```

**Expected:** Stats object with executionAttempts, successfulExecutions

### 7.4 Check Execution Requests Stream
```
XLEN stream:execution-requests
XINFO GROUPS stream:execution-requests
```

**Expected:** Consumer group `execution-engine-group` exists

---

## Phase 8: End-to-End Flow Verification (10 min)

### 8.1 Complete Flow Test
Wait 60 seconds after startup with simulation mode, then:

```bash
# 1. Check price data flowing
curl http://localhost:3000/api/metrics

# 2. Check streams have data
redis-cli XLEN stream:price-updates
redis-cli XLEN stream:health

# 3. Check coordinator processing
curl http://localhost:3000/api/health
```

### 8.2 Dashboard Verification
Refresh http://localhost:3000 and verify:
- Metrics updating (opportunity count, price updates)
- Services all healthy
- No error alerts

### 8.3 Graceful Shutdown Test
Press `Ctrl+C` in the `dev:all` terminal

**Verify:**
- Services log "shutting down gracefully"
- `npm run dev:status` shows services stopped
- `GET coordinator:leader:lock` returns `(nil)`

---

## Troubleshooting Quick Reference

| Issue | Check | Fix |
|-------|-------|-----|
| Redis won't connect | Port 6379 in use? | `npm run dev:cleanup` |
| Services won't start | Build errors? | `npm run build` |
| No stream messages | Redis running? | `npm run dev:status` |
| Leader not elected | Stale lock? | `DEL coordinator:leader:lock` |
| Circuit breaker open | Failures > 5? | Restart execution engine |

### Complete Reset
```bash
npm run dev:stop
npm run dev:cleanup
del .redis-memory-config.json
npm run build:clean
npm run dev:redis:memory
npm run dev:all
```

---

## Success Criteria

- [ ] All 6 services start and show healthy status
- [ ] Redis streams created and receiving messages
- [ ] Health heartbeats appearing in `stream:health`
- [ ] Coordinator is leader with valid lock
- [ ] Dashboard displays system metrics
- [ ] Graceful shutdown releases resources

## Critical Files

- `package.json` - npm scripts
- `shared/core/src/redis-streams.ts` - Stream definitions
- `services/coordinator/src/coordinator.ts` - Coordinator logic
- `scripts/lib/services-config.js` - Port configuration
- `docs/local-development.md` - Full documentation

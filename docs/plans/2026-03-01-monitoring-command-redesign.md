# Monitoring Command Redesign — Pre-Deploy Validation

**Date:** 2026-03-01
**Status:** Approved
**Replaces:** `.claude/commands/monitoring.md` (v1.0)

## Problem

The current monitoring command is generic (references "7 services" without naming them), ignores existing infrastructure (health endpoints, Prometheus metrics, Pino logging, OTEL tracing, circuit breakers), uses Linux-only bash (incompatible with Windows dev environment), and duplicates work already handled by TypeScript abstractions in `shared/core/`.

## Decision

Single-orchestrator, 5-phase pre-deploy validation command. No sub-agents — the orchestrator handles all checks directly for maximum reliability (agent stall rate is 30-50% in multi-agent workflows).

## Architecture

### Approach: Single Orchestrator, Phased Pipeline

```
Phase 1: Static Analysis (~60s)     — code/config checks, no services needed
Phase 2: Startup & Readiness (~60s)  — Redis + services with simulation mode
Phase 3: Runtime Validation (~90s)   — health endpoints + Redis stream topology
Phase 4: Pipeline Smoke Test (~90s)  — verify full data flow in simulation
Phase 5: Shutdown & Report (~30s)    — capture final state, generate go/no-go
```

Total: ~5 minutes. Output: `./monitor-session/REPORT_<timestamp>.md`

### Why Single Orchestrator

- 30-50% agent stall rate makes multi-agent unreliable
- ~200 tool calls total — well within single context capacity
- Cross-referencing findings (e.g., consumer lag + DLQ growth) is trivial in single context
- Existing endpoints expose everything needed

## System Inventory (Hardcoded in Command)

### Services (8 total, 7 via dev:all)

| Service | Port | Ready URL |
|---------|------|-----------|
| Coordinator | 3000 | `/api/health/ready` |
| P1 Asia-Fast (BSC, Polygon) | 3001 | `/ready` |
| P2 L2-Turbo (Arb, OP, Base, zkSync, Linea, Blast, Scroll, Mantle, Mode) | 3002 | `/ready` |
| P3 High-Value (ETH, AVAX, FTM) | 3003 | `/ready` |
| P4 Solana | 3004 | `/ready` |
| Execution Engine | 3005 | `/ready` |
| Cross-Chain Detector | 3006 | `/ready` |

### Redis Streams (19 total)

| Stream | MAXLEN | Primary Producer | Consumer Groups |
|--------|--------|-----------------|-----------------|
| `stream:price-updates` | 100,000 | P1-P4 | coordinator-group, cross-chain-detector-group |
| `stream:swap-events` | 50,000 | P1-P4 | coordinator-group |
| `stream:opportunities` | 10,000 | P1-P4, cross-chain | coordinator-group |
| `stream:whale-alerts` | 5,000 | P1-P4 | coordinator-group, cross-chain-detector-group |
| `stream:service-health` | 1,000 | All services | — |
| `stream:service-events` | 5,000 | All services | — |
| `stream:coordinator-events` | 5,000 | Coordinator | — |
| `stream:health` | 1,000 | All services | coordinator-group |
| `stream:health-alerts` | 5,000 | Health monitor | — |
| `stream:execution-requests` | 5,000 | Coordinator | execution-engine-group |
| `stream:execution-results` | 5,000 | Execution engine | coordinator-group |
| `stream:pending-opportunities` | 10,000 | Mempool detector | cross-chain-detector-group |
| `stream:volume-aggregates` | 10,000 | Aggregator | coordinator-group |
| `stream:circuit-breaker` | 5,000 | Execution engine | — |
| `stream:system-failover` | 1,000 | Coordinator | — |
| `stream:system-commands` | 1,000 | Coordinator | — |
| `stream:fast-lane` | — | Fast lane | execution-engine |
| `stream:dead-letter-queue` | 10,000 | Any service | coordinator-group |
| `stream:forwarding-dlq` | — | Coordinator | — |

### Consumer Groups (5 active)

| Group | Service | Streams |
|-------|---------|---------|
| `coordinator-group` | Coordinator | health, opportunities, whale-alerts, swap-events, volume-aggregates, price-updates, execution-results, dead-letter-queue |
| `cross-chain-detector-group` | Cross-Chain | price-updates, whale-alerts, pending-opportunities |
| `execution-engine-group` | Execution Engine | execution-requests |
| `execution-engine` | Execution Engine (fast lane) | fast-lane |
| `mempool-detector-group` | Mempool Detector | pending-opportunities |

## Phase Details

### Phase 1: Static Analysis

| Check | Method | Severity if failed |
|-------|--------|--------------------|
| Stream names match `RedisStreams` constant | Grep XADD/xReadGroup calls, compare to `shared/types/src/events.ts` | HIGH |
| Consumer group names match expected list | Grep createConsumerGroup patterns | CRITICAL |
| MAXLEN on all XADD calls | Grep XADD without MAXLEN | HIGH |
| XACK after every XREADGROUP | Files with consume but no ack | HIGH |
| Env vars in code match `.env.example` | Grep `process.env.*`, diff against `.env.example` | MEDIUM |
| No `\|\| 0` patterns (use `?? 0`) | Grep for `\|\| 0` and `\|\| 0n` | LOW |

### Phase 2: Startup

1. `npm run dev:redis:memory` + verify PING + XADD command support
2. `SIMULATION_MODE=true EXECUTION_SIMULATION_MODE=true npm run dev:all`
3. Poll `/ready` on all 7 services (5s interval, 30s timeout per service)
4. Capture baseline: `XINFO STREAM`, `XINFO GROUPS`, `XLEN` for all 19 streams
5. Capture `redis-cli INFO memory` and `redis-cli INFO stats` baseline

### Phase 3: Runtime Validation

| Check | Endpoint/Command | Pass Criteria | Severity |
|-------|-----------------|---------------|----------|
| Service health | `GET /health` all 7 | Status `healthy` or `degraded` | CRITICAL if unhealthy |
| Leader election | `GET /api/leader` (3000) | `isLeader: true` | CRITICAL |
| Circuit breakers | `GET /circuit-breaker` (3005) | All chains CLOSED | HIGH |
| DLQ empty | `XLEN stream:dead-letter-queue` | 0 | HIGH if >0 |
| Forwarding DLQ empty | `XLEN stream:forwarding-dlq` | 0 | CRITICAL if >0 |
| Stream exists | `XINFO STREAM <name>` all 19 | Exists | MEDIUM per missing stream |
| Consumer groups attached | `XINFO GROUPS <name>` | Expected groups present | HIGH |
| No dead consumers | `XINFO GROUPS` consumer count | >0 per active group | CRITICAL |
| Pending messages | `XPENDING <stream> <group>` | <50 pending | HIGH if >50 |
| Stuck messages | `XPENDING` oldest age | <30s | HIGH if >30s |
| Prometheus incrementing | `GET /metrics` twice, 10s apart | Counters increasing | MEDIUM |

### Phase 4: Pipeline Smoke Test

1. **Wait for cascade** (60s timeout, poll every 5s):
   - `XLEN stream:price-updates` growing → partitions publishing
   - `XLEN stream:opportunities` growing → detectors finding arb
   - `XLEN stream:execution-requests` growing → coordinator forwarding
   - `XLEN stream:execution-results` growing → execution completing

2. **Verify endpoints**:
   - `GET /api/opportunities` (3000) shows entries
   - `GET /stats` (3005) shows execution attempts > 0

3. **Trace one message**:
   - Read latest from `stream:execution-results` via `XREVRANGE`
   - Extract correlationId/traceId
   - Verify same ID appears in `stream:opportunities` and `stream:execution-requests`

4. **DLQ growth check**: DLQ length should not have grown during smoke test

### Phase 5: Report

Go/No-Go decision matrix:
- Any CRITICAL finding → **NO-GO**
- >3 HIGH findings → **NO-GO**
- All else → **GO** (with warnings)

Report sections:
1. Executive Dashboard (go/no-go, finding counts by severity)
2. Static Analysis Results
3. Service Readiness Matrix
4. Redis Stream Health Map (19 streams, length/groups/lag/status)
5. Pipeline Smoke Test Results (with traced message flow)
6. Enhancement Recommendations (non-blocking improvements)

## Windows Compatibility

All commands use:
- `curl` for HTTP (available on Windows 11)
- `redis-cli` for Redis (available via in-memory Redis server)
- Glob/Grep/Read tools for file analysis (native Claude tools)
- No Linux-only tools (no `lsof`, `awk`, `tail -f`, `find -printf`)

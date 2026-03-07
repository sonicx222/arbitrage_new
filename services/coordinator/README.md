# Coordinator Service

System orchestrator that routes arbitrage opportunities to execution engines, manages leader election for high-availability failover, and provides a real-time monitoring dashboard.

## Overview

| Property | Value |
|----------|-------|
| **Port** | 3000 (configurable via `COORDINATOR_PORT`) |
| **Role** | Core orchestrator |
| **Streams Consumed** | opportunities, health, execution-results, whale-alerts, swap-events, dead-letter-queue |
| **Streams Produced** | exec-requests-{fast\|l2\|premium\|solana} (ADR-038), execution-requests (legacy) |

## Quick Start

```bash
npm run dev:coordinator:fast   # Hot reload, port 3000
```

Visit **http://localhost:3000** for the dashboard.

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /` | No | HTML dashboard (auto-refresh 10s) |
| `GET /health` | No | Minimal health for load balancers |
| `GET /ready` | No | GCP-style readiness probe |
| `GET /metrics` | No | Prometheus-format metrics |
| `GET /stats` | No | JSON statistics |
| `GET /api/health` | Yes | Detailed health with service map |
| `GET /api/metrics` | Yes | Authenticated metrics |
| `GET /api/dashboard` | Yes | Dashboard SPA |
| `GET /api/sse` | Yes | Server-Sent Events (live updates) |
| `GET /api/admin/*` | Yes | Admin routes (start/stop services, log level, circuit breaker) |
| `GET /ee/health` | No | Proxied execution engine health |
| `GET /circuit-breaker` | No | Proxied circuit breaker status |
| `POST /circuit-breaker/open` | Yes | Force open circuit breaker |
| `POST /circuit-breaker/close` | Yes | Force close circuit breaker |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `COORDINATOR_PORT` | HTTP port | `3000` |
| `REDIS_URL` | Redis connection URL | Required |
| `IS_STANDBY` | Standby mode | `false` |
| `CAN_BECOME_LEADER` | Allow leadership acquisition | `true` |
| `REGION_ID` | Region for cross-region failover | `us-east1` |
| `INSTANCE_ROLE` | `primary` or `standby` | - |
| `LEADER_LOCK_KEY` | Redis key for leader lock | `coordinator:leader:lock` |
| `LEADER_LOCK_TTL_MS` | Lock TTL | `30000` |
| `LEADER_HEARTBEAT_INTERVAL_MS` | Heartbeat interval (must be < TTL) | `10000` |
| `COORDINATOR_CHAIN_GROUP_ROUTING` | Route to per-chain-group streams (ADR-038) | `false` |
| `EXECUTION_ENGINE_HOST` | EE host for dashboard proxy | `localhost` |
| `EXECUTION_ENGINE_PORT` | EE port for dashboard proxy | `3005` |

## Architecture

```
Coordinator
├── LeadershipElectionService (ADR-007)
│   └── Redis distributed lock with heartbeat
├── OpportunityRouter (ADR-038)
│   ├── Chain-group routing (fast/l2/premium/solana)
│   └── Cross-chain opportunity detection
├── StreamConsumerManager
│   ├── Dedicated Redis connection for opportunities (ADR-037)
│   └── Batch XACK (200 round-trips → 1)
├── HealthMonitor
│   └── Service degradation tracking
└── Express API
    ├── Dashboard routes
    ├── Health/metrics routes
    └── Admin routes (auth-protected)
```

## Related Documentation

- [ADR-002: Redis Streams](../../docs/architecture/adr/ADR-002-redis-streams.md)
- [ADR-007: Failover Strategy](../../docs/architecture/adr/ADR-007-failover-strategy.md)
- [ADR-037: Coordinator Pipeline Optimization](../../docs/architecture/adr/ADR-037-coordinator-pipeline-optimization.md)
- [ADR-038: Chain-Grouped Execution](../../docs/architecture/adr/ADR-038-chain-grouped-execution.md)
- [API Reference](../../docs/architecture/API.md)

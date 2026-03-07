# Monolith Service

Consolidates all 7 arbitrage services into a single Node.js process using worker threads. Eliminates inter-service network latency and enables true shared memory via SharedArrayBuffer for the PriceMatrix. Designed for Oracle Cloud ARM deployment (4 OCPU, 24GB RAM).

## Overview

| Property | Value |
|----------|-------|
| **Port** | 3100 (unified health), 3001-3006/3009 (worker internal ports) |
| **Role** | All-in-one deployment mode |
| **Target** | Oracle Cloud ARM (4 OCPU, 24GB) |

### Performance Benefits

| Metric | Microservices | Monolith | Improvement |
|--------|--------------|----------|-------------|
| Redis RTT | 5-20ms | <0.1ms | 100x |
| Price reads | Network | SharedArrayBuffer | 5000x |
| Detection latency | Baseline | 2.5-3x faster | 2.5-3x |

## Quick Start

```bash
# Requires all services to be built first
npm run build

# Start monolith (allocates 20GB heap for 7 services)
npm run dev:monolith
```

## Worker Services

| Worker | Script | Port | Max Restarts |
|--------|--------|------|-------------|
| partition-asia-fast | partition-asia-fast/dist/index.js | 3001 | 5 |
| partition-l2-turbo | partition-l2-turbo/dist/index.js | 3002 | 5 |
| partition-high-value | partition-high-value/dist/index.js | 3003 | 5 |
| partition-solana | partition-solana/dist/index.js | 3004 | 3 |
| coordinator | coordinator/dist/index.js | 3009 | 5 |
| execution-engine | execution-engine/dist/index.js | 3005 | 5 |
| cross-chain-detector | cross-chain-detector/dist/index.js | 3006 | 5 |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` or `GET /` | Unified health (aggregates all 7 workers) |
| `GET /ready` | Readiness probe (overall != unhealthy) |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `MONOLITH_HEALTH_PORT` | Unified health server port | `3100` |
| `MONOLITH_SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout | `30000` |
| `MONOLITH_REDIS_URL` | Redis URL (falls back to `REDIS_URL`) | `redis://localhost:6379` |
| `PRICE_MATRIX_SLOTS` | SharedArrayBuffer slots (16 bytes each) | `1000` |

## Architecture

```
Main Thread (port 3100)
├── SharedArrayBuffer PriceMatrix (ADR-005)
│   └── 1000 slots x 16 bytes = 16KB shared across all workers
├── Worker Manager
│   ├── Auto-restart with exponential backoff
│   ├── Health aggregation (healthy/degraded/unhealthy)
│   └── Graceful shutdown (30s drain timeout)
└── Unified Health Server
    └── Aggregates status from all 7 workers

Worker Threads (7)
├── P1: Asia-Fast (BSC, Polygon, Avalanche, Fantom)
├── P2: L2-Turbo (Arbitrum, Optimism, Base, Scroll, Blast)
├── P3: High-Value (Ethereum, zkSync, Linea)
├── P4: Solana
├── Coordinator (port 3009, not 3000, to avoid conflict)
├── Execution Engine
└── Cross-Chain Detector
```

## Related Documentation

- [ADR-005: Hierarchical Cache](../../docs/architecture/adr/ADR-005-hierarchical-cache.md)
- [Deployment Guide](../../docs/deployment.md)
- [Current State](../../docs/architecture/CURRENT_STATE.md)

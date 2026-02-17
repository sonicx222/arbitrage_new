# Current Architecture State

**Date:** February 5, 2026
**Version:** 1.1
**Last Updated:** 2026-02-05

---

## Overview

This document provides a snapshot of the current arbitrage trading system architecture, including service inventory, partition mapping, Redis Streams topology, and health monitoring.

**See Also:**
- [Data Flow Diagrams](DATA_FLOW.md) - Visual representation of all system data flows
- [System Architecture](ARCHITECTURE_V2.md) - Comprehensive architecture design document

---

## Service Inventory (8 Services)

| Service | Internal Port | External Port | Type | Description |
|---------|---------------|---------------|------|-------------|
| **Coordinator** | 3000 | 3000 | Core | Orchestrates all services, manages leader election |
| **Partition Asia-Fast** | 3001 | 3011 | Detector | P1: BSC, Polygon, Avalanche, Fantom (Unified Detector) |
| **Partition L2-Turbo** | 3002 | 3012 | Detector | P2: Arbitrum, Optimism, Base (Unified Detector) |
| **Partition High-Value** | 3003 | 3013 | Detector | P3: Ethereum, zkSync, Linea (Unified Detector) |
| **Partition Solana** | 3004 | 3014 | Detector | P4: Solana (non-EVM, Unified Detector) |
| **Execution Engine** | 3005 | 3015 | Core | Trade execution and MEV protection |
| **Cross-Chain Detector** | 3006 | 3016 | Detector | Cross-chain arbitrage opportunities |

> **Note:** `services/mempool-detector` (port 3007) exists in the repository but is orphaned — it is not wired into the dev tooling (`start-local.js`, `service-definitions.js`) and is not started by any `npm run dev:*` command.

**Note**: Each partition service uses a unique internal port (P1:3001, P2:3002, P3:3003, P4:3004, configurable via `HEALTH_CHECK_PORT`). Port assignments are the single source of truth in `shared/constants/service-ports.json`.

---

## Partition Architecture (ADR-003)

### P1: Asia-Fast
- **Partition ID:** `asia-fast`
- **Chains:** BSC, Polygon, Avalanche, Fantom
- **Region:** Asia-Southeast-1 (Oracle Cloud)
- **Standby:** US-West-1 (Render)
- **Resource Profile:** Heavy (768MB)
- **Rationale:** High-throughput Asian chains with fast block times

### P2: L2-Turbo
- **Partition ID:** `l2-turbo`
- **Chains:** Arbitrum, Optimism, Base
- **Region:** Asia-Southeast-1 (Fly.io)
- **Standby:** US-East-1 (Railway)
- **Resource Profile:** Standard (512MB)
- **Rationale:** Ethereum L2 rollups with sub-second confirmations

### P3: High-Value
- **Partition ID:** `high-value`
- **Chains:** Ethereum, zkSync, Linea
- **Region:** US-East-1 (Oracle Cloud)
- **Standby:** EU-West-1 (GCP)
- **Resource Profile:** Heavy (768MB)
- **Rationale:** High-value transactions requiring reliability

### P4: Solana-Native
- **Partition ID:** `solana-native`
- **Chains:** Solana
- **Region:** US-West-1 (Fly.io)
- **Standby:** US-East-1 (Railway)
- **Resource Profile:** Heavy (512MB)
- **Rationale:** Non-EVM chain requiring dedicated handling

---

## Redis Streams Topology (ADR-002)

### Stream Names

| Stream | Purpose | Producers | Consumers |
|--------|---------|-----------|-----------|
| `stream:price-updates` | Real-time price data | Partition Detectors | Cross-Chain Detector, Execution Engine |
| `stream:swap-events` | DEX swap events | Partition Detectors | Analytics, Quality Monitor |
| `stream:opportunities` | Arbitrage opportunities | Partition Detectors | Execution Engine |
| `stream:whale-alerts` | Large trade notifications | All Detectors | Alert Service |
| `stream:volume-aggregates` | Volume aggregation data | Partition Detectors | Coordinator |
| `stream:health` | Service health data | All Services | Coordinator |
| `stream:execution-requests` | Forwarded opportunities | Coordinator | Execution Engine |
| `stream:pending-opportunities` | Mempool pending txs | Mempool Detector | Execution Engine |
| `stream:circuit-breaker` | Circuit breaker events | Execution Engine | All Services |
| `stream:system-failover` | Failover coordination | CrossRegionHealthManager | All Services |

### Consumer Groups

| Group | Members | Purpose |
|-------|---------|---------|
| `execution-engine-group` | Execution Engine | Processes opportunities |
| `cross-chain-detector-group` | Cross-Chain Detector | Processes price updates |
| `analytics-group` | Quality Monitor | Processes events for analytics |

---

## Health Check Endpoints

| Service | Endpoint | Response |
|---------|----------|----------|
| Coordinator | `/api/health` | `{ status, services, leader }` |
| Partition Detectors | `/health` | `{ status, chains, blocksProcessed }` |
| Cross-Chain Detector | `/health` | `{ status, opportunities }` |
| Execution Engine | `/health` | `{ status, trades, pending }` |

### Health Status Values

- `healthy` - All subsystems operational
- `degraded` - Some subsystems have issues but service is operational
- `unhealthy` - Critical issues, service may not be functional
- `starting` - Service is initializing

---

## Key Redis Keys

### Leader Election
- `coordinator:leader:lock` - Distributed lock for leader election (30s TTL)

### Service Health
- `region:health:{regionId}` - Region health data (60s TTL)
- `health:{serviceName}` - Service health data (300s TTL)

### Routing
- `routing:failed:{region}` - Failed region routing redirect

### Metrics
- `metrics:{serviceName}:{bucket}` - Time-bucketed metrics (24h TTL)
- `metrics:{serviceName}:recent` - Rolling metrics list (24h TTL)

---

## Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      WebSocket Providers                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Partition Detectors                          │
│  P1: Asia-Fast  │  P2: L2-Turbo  │  P3: High-Value  │  P4: Solana│
└─────────────────────────────────────────────────────────────────┘
                                │
                    Redis Streams (ADR-002)
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │  Cross-Chain    │ │   Coordinator   │ │   Execution     │
    │   Detector      │ │    (Leader)     │ │     Engine      │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Configuration Sources

### Environment Variables

```bash
# Redis
REDIS_URL=redis://localhost:6379

# Partition
PARTITION_ID=asia-fast|l2-turbo|high-value|solana-native

# Chain-specific (per partition)
ETHEREUM_RPC_URL=https://...
ETHEREUM_WS_URL=wss://...
```

### Packages

- `@arbitrage/config` - Centralized configuration (chains, DEXes, tokens, thresholds)
- `@arbitrage/core` - Core functionality (Redis, logging, monitoring)
- `@arbitrage/test-utils` - Test utilities and mocks

---

## Current Metrics (Phase 1)

| Metric | Current | Target |
|--------|---------|--------|
| Chains | 11 | 11 |
| DEXes | 49 | 49 |
| Tokens | 112 | 112 |
| Target Opportunities/day | 500 | 500 |

---

## Related ADRs

### Core Infrastructure
- [ADR-002: Redis Streams](adr/ADR-002.md) - Message transport
- [ADR-003: Partitioned Detectors](adr/ADR-003.md) - Partition architecture
- [ADR-007: Failover Strategy](adr/ADR-007.md) - Leader election & failover

### Performance & Optimization
- [ADR-011: Tier 1 Performance](adr/ADR-011.md) - O(1) indexing, event batching
- [ADR-012: Worker Threads](adr/ADR-012.md) - Multi-leg path finding
- [ADR-013: Dynamic Gas Pricing](adr/ADR-013.md) - Gas price cache
- [ADR-022: Hot-Path Memory](adr/ADR-022.md) - Ring buffers, LRU cache
- [ADR-023: Detector Pre-validation](adr/ADR-023.md) - Sample-based validation
- [ADR-024: RPC Rate Limiting](adr/ADR-024.md) - Token bucket algorithm
- [ADR-027: Nonce Pre-allocation](adr/ADR-027.md) - Nonce pool for latency

### Code Architecture
- [ADR-009: Test Architecture](adr/ADR-009.md) - Testing patterns
- [ADR-014: Modular Detector](adr/ADR-014.md) - Component extraction
- [ADR-015: Pino Logger](adr/ADR-015.md) - Logger with DI pattern
- [ADR-026: Integration Tests](adr/ADR-026.md) - Test consolidation

### Execution & Risk
- [ADR-016: Transaction Simulation](adr/ADR-016.md) - Pre-flight simulation
- [ADR-017: MEV Protection](adr/ADR-017.md) - Flashbots, Jito integration
- [ADR-018: Circuit Breaker](adr/ADR-018.md) - Failure protection
- [ADR-020: Flash Loan](adr/ADR-020.md) - Aave V3 integration
- [ADR-021: Capital Risk](adr/ADR-021.md) - Kelly criterion, EV filtering

### ML & Advanced
- [ADR-025: ML Model Lifecycle](adr/ADR-025.md) - Model persistence and retraining

---

## Recent Architectural Changes (Since v1.0)

| Date | Change | ADR |
|------|--------|-----|
| 2026-02-04 | Hot-path memory optimization with ring buffers | ADR-022 |
| 2026-02-04 | Detector pre-validation at 10% sampling rate | ADR-023 |
| 2026-02-04 | Multi-provider RPC rate limiting | ADR-024 |
| 2026-02-04 | ML model lifecycle management | ADR-025 |
| 2026-02-04 | Integration test consolidation (34→18 files) | ADR-026 |
| 2026-02-04 | Nonce pre-allocation pool (5-10ms savings) | ADR-027 |

---

## Maintenance Notes

- This document should be updated when:
  - New services are added
  - Partition assignments change
  - Redis Streams topology changes
  - New health endpoints are added
  - New ADRs are created

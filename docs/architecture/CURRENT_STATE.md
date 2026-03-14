# Current Architecture State

**Date:** March 7, 2026
**Version:** 1.5
**Last Updated:** 2026-03-07

---

## Overview

This document provides a snapshot of the current arbitrage trading system architecture, including service inventory, partition mapping, Redis Streams topology, and health monitoring.

**See Also:**
- [Data Flow Diagrams](DATA_FLOW.md) - Visual representation of all system data flows
- [System Architecture](ARCHITECTURE_V2.md) - Comprehensive architecture design document

---

## Service Inventory (8 Core + 1 Optional)

| Service | Internal Port | External Port | Type | Description |
|---------|---------------|---------------|------|-------------|
| **Coordinator** | 3000 | 3000 | Core | Orchestrates all services, manages leader election |
| **Partition Asia-Fast** | 3001 | 3011 | Detector | P1: BSC, Polygon, Avalanche, Fantom (Unified Detector) |
| **Partition L2-Turbo** | 3002 | 3012 | Detector | P2: Arbitrum, Optimism, Base, Scroll, Blast (Unified Detector) |
| **Partition High-Value** | 3003 | 3013 | Detector | P3: Ethereum, zkSync, Linea (Unified Detector) |
| **Partition Solana** | 3004 | 3014 | Detector | P4: Solana (non-EVM, Unified Detector) |
| **Execution Engine** | 3005 | 3015 | Core | Trade execution and MEV protection |
| **Cross-Chain Detector** | 3006 | 3016 | Detector | Cross-chain arbitrage opportunities |
| **Mempool Detector** | 3008 | — | Optional | Pre-block pending tx detection via bloXroute BDN |
| **Monolith** | 3100 | — | Deployment | All-in-one single-process mode for Oracle ARM (4 OCPU, 24GB) |

> **Note:** The Mempool Detector is an optional service — run with `npm run dev:mempool` or `npm run dev:mempool:fast`. Requires bloXroute BDN API key (`BLOXROUTE_AUTH_HEADER`). Currently supports Ethereum and BSC mempool feeds.

> **Note:** The Monolith service consolidates all services into a single Node.js process using worker threads. Designed for Oracle Cloud ARM deployment to eliminate inter-service network latency and enable SharedArrayBuffer-based PriceMatrix. Port 3100 serves a unified health endpoint. See `services/monolith/`.

**Note**: Each partition service uses a unique internal port (P1:3001, P2:3002, P3:3003, P4:3004, configurable via `HEALTH_CHECK_PORT`). Port assignments are the single source of truth in `shared/constants/service-ports.json`.

---

## Partition Architecture (ADR-003)

### P1: Asia-Fast
- **Partition ID:** `asia-fast`
- **Chains:** BSC, Polygon, Avalanche, Fantom
- **Region:** Singapore (Fly.io)
- **Resource Profile:** Heavy (768MB)
- **Rationale:** High-throughput Asian chains with fast block times

### P2: L2-Turbo
- **Partition ID:** `l2-turbo`
- **Chains:** Arbitrum, Optimism, Base, Scroll, Blast, Mantle, Mode
- **Region:** Singapore (Fly.io)
- **Resource Profile:** Heavy (768MB, 7 chains)
- **Rationale:** Ethereum L2 rollups with sub-second confirmations
- **Note:** Scroll and Blast re-added with verified factory addresses (2026-02-26). Mantle and Mode DEX factories RPC-validated 2026-03-08, re-added to partition 2026-03-10.

### P3: High-Value
- **Partition ID:** `high-value`
- **Chains:** Ethereum, zkSync, Linea
- **Region:** US-East (Fly.io)
- **Resource Profile:** Heavy (768MB)
- **Rationale:** High-value transactions requiring reliability

### P4: Solana-Native
- **Partition ID:** `solana-native`
- **Chains:** Solana
- **Region:** US-West (Fly.io)
- **Resource Profile:** Heavy (512MB)
- **Rationale:** Non-EVM chain requiring dedicated handling
- **Execution:** Supported via Jupiter V6 + Jito bundles when `FEATURE_SOLANA_EXECUTION=true` (ADR-034)

---

## Redis Streams Topology (ADR-002)

### Stream Names (29 declared in `shared/types/src/events.ts`)

| Stream | MAXLEN | Purpose | Lifecycle |
|--------|--------|---------|-----------|
| `stream:price-updates` | 100,000 | Real-time price data from partition detectors | ACTIVE |
| `stream:swap-events` | 50,000 | DEX swap events | ACTIVE (simulation) |
| `stream:opportunities` | 500,000 | Arbitrage opportunities from detectors | ACTIVE |
| `stream:whale-alerts` | 5,000 | Large trade notifications | ACTIVE (simulation) |
| `stream:service-health` | 1,000 | Per-service health reports | IDLE |
| `stream:service-events` | 5,000 | Service lifecycle events | IDLE |
| `stream:coordinator-events` | 5,000 | Coordinator broadcasts | IDLE |
| `stream:health` | 1,000 | Service heartbeats | ACTIVE |
| `stream:health-alerts` | 5,000 | Health monitor alerts | ON-DEMAND |
| `stream:execution-requests` | 100,000 | Forwarded opportunities from coordinator (legacy single-stream; see ADR-038 per-group streams below) | ACTIVE |
| `stream:execution-results` | 100,000 | Execution outcomes from engine | ACTIVE |
| `stream:pending-opportunities` | 10,000 | Mempool pending transactions | IDLE |
| `stream:volume-aggregates` | 10,000 | Volume aggregation data | IDLE |
| `stream:circuit-breaker` | 5,000 | Circuit breaker state events | IDLE |
| `stream:system-failover` | 1,000 | Cross-region failover coordination | ON-DEMAND |
| `stream:system-commands` | 1,000 | System control commands | ON-DEMAND |
| `stream:system-failures` | 5,000 | Self-healing failure events | ON-DEMAND |
| `stream:system-control` | 1,000 | Self-healing control commands | ON-DEMAND |
| `stream:system-scaling` | 1,000 | Self-healing scaling commands | ON-DEMAND |
| `stream:service-degradation` | 5,000 | Graceful degradation events | ON-DEMAND |
| `stream:fast-lane` | 5,000 | High-confidence coordinator bypass | ACTIVE |
| `stream:dead-letter-queue` | 10,000 | Failed message dead-letter queue | ACTIVE |
| `stream:dlq-alerts` | 5,000 | DLQ alert notifications | ON-DEMAND |
| `stream:forwarding-dlq` | 5,000 | DLQ forwarding failures | ON-DEMAND |
| `stream:exec-requests-fast` | 25,000 | Exec requests: BSC, Polygon, Avalanche, Fantom (ADR-038) | ACTIVE |
| `stream:exec-requests-l2` | 25,000 | Exec requests: Arbitrum, Optimism, Base, Scroll, Blast (ADR-038) | ACTIVE |
| `stream:exec-requests-premium` | 25,000 | Exec requests: Ethereum, zkSync, Linea (ADR-038) | ACTIVE |
| `stream:exec-requests-solana` | 10,000 | Exec requests: Solana (ADR-038) | ACTIVE |
| `stream:pre-simulated` | 25,000 | Pre-validated opps from SimulationWorker (ADR-039, requires ASYNC_PIPELINE_SPLIT=true) | ACTIVE |

### Consumer Groups (7 active)

| Group | Members | Streams | Purpose |
|-------|---------|---------|---------|
| `coordinator-group` | Coordinator | health, opportunities (dedicated connection — ADR-037), whale-alerts, swap-events, volume-aggregates, price-updates, execution-results, dead-letter-queue, forwarding-dlq, service-degradation | Orchestration, health monitoring, opportunity routing |
| `cross-chain-detector-group` | Cross-Chain Detector | price-updates, whale-alerts, pending-opportunities | Cross-chain opportunity detection |
| `execution-engine-group` | Execution Engine | exec-requests-{fast\|l2\|premium\|solana} (ADR-038), or stream:pre-simulated when ASYNC_PIPELINE_SPLIT=true (ADR-039) | Processes forwarded opportunities |
| `execution-engine-group` | Fast Lane Consumer | fast-lane | Processes fast-lane high-priority opportunities |
| `simulation-worker-group` | SimulationWorker | exec-requests-{fast\|l2\|premium\|solana} | Pre-validates opps via BatchQuoterService; publishes to stream:pre-simulated (ADR-039) |
| `mempool-detector-group` | Mempool Detector | pending-opportunities | Pre-block pending transaction detection |
| `orderflow-pipeline` | Coordinator | pending-opportunities | Orderflow pipeline processing |
| `failover-{serviceName}` | Coordinator | system-failover | Failover coordination (dynamic per-service group) |

---

## Health Check Endpoints

| Service | Endpoint | Response |
|---------|----------|----------|
| Coordinator | `/api/health` | `{ status, isLeader, instanceId, systemHealth, services, timestamp }` |
| Partition Detectors | `/health` | `{ status, partitionId, chains, healthyChains, uptime, eventsProcessed, memoryMB, region }` |
| Cross-Chain Detector | `/health` | `{ status, uptime, memoryMB }` |
| Execution Engine | `/health` | `{ status, simulationMode, redisConnected, healthyProviders, queueSize, activeExecutions, successRate, dlqLength, uptime, memoryMB }` |
| Mempool Detector | `/health` | `{ status, feeds, stats, uptime }` |

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

### Redis Infrastructure

**Self-hosted Redis 7** (recommended): Deployed as Docker sidecar on each Oracle ARM instance. Set `REDIS_SELF_HOSTED=true`. Config at `infrastructure/oracle/redis/redis-production.conf`.

**Upstash Redis** (legacy): 10K commands/day limit. Batching mitigates but does not eliminate the constraint.

### Environment Variables

```bash
# Redis (self-hosted recommended)
REDIS_URL=redis://:password@localhost:6379
REDIS_SELF_HOSTED=true

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
| Chains | 15 (14 EVM + Solana) | 15 |
| DEXes | 78 (71 EVM + 7 Solana) | 80 |
| Tokens | 128 | 150 |
| Strategies | 6 (Intra-chain, Cross-chain, Flash Loan, Statistical Arb, CoW Backrun, Solana/Jito) | 7+ |
| Data Sources | DEX feeds + Binance CEX feed + CoW Settlement watcher | Multi-CEX |
| Target Opportunities/day | 500 | 750 |

---

## Related ADRs

### Core Infrastructure
- [ADR-002: Redis Streams](adr/ADR-002-redis-streams.md) - Message transport
- [ADR-003: Partitioned Detectors](adr/ADR-003-partitioned-detectors.md) - Partition architecture
- [ADR-007: Failover Strategy](adr/ADR-007-failover-strategy.md) - Leader election & failover

### Performance & Optimization
- [ADR-011: Tier 1 Performance](adr/ADR-011-tier1-optimizations.md) - O(1) indexing, event batching
- [ADR-012: Worker Threads](adr/ADR-012-worker-thread-path-finding.md) - Multi-leg path finding
- [ADR-013: Dynamic Gas Pricing](adr/ADR-013-dynamic-gas-pricing.md) - Gas price cache
- [ADR-022: Hot-Path Memory](adr/ADR-022-hot-path-memory-optimization.md) - Ring buffers, LRU cache
- [ADR-023: Detector Pre-validation](adr/ADR-023-detector-prevalidation.md) - Sample-based validation
- [ADR-024: RPC Rate Limiting](adr/ADR-024-rpc-rate-limiting.md) - Token bucket algorithm
- [ADR-027: Nonce Pre-allocation](adr/ADR-027-nonce-preallocation-pool.md) - Nonce pool for latency

### Code Architecture
- [ADR-009: Test Architecture](adr/ADR-009-test-architecture.md) - Testing patterns
- [ADR-014: Modular Detector](adr/ADR-014-modular-detector-components.md) - Component extraction
- [ADR-015: Pino Logger](adr/ADR-015-pino-logger-migration.md) - Logger with DI pattern
- [ADR-026: Integration Tests](adr/ADR-026-integration-test-consolidation.md) - Test consolidation

### Execution & Risk
- [ADR-016: Transaction Simulation](adr/ADR-016-transaction-simulation.md) - Pre-flight simulation
- [ADR-017: MEV Protection](adr/ADR-017-mev-protection.md) - Flashbots, Jito integration
- [ADR-018: Circuit Breaker](adr/ADR-018-circuit-breaker.md) - Failure protection
- [ADR-020: Flash Loan](adr/ADR-020-flash-loan.md) - Aave V3 integration
- [ADR-021: Capital Risk](adr/ADR-021-capital-risk-management.md) - Kelly criterion, EV filtering

### ML & Advanced
- [ADR-025: ML Model Lifecycle](adr/ADR-025-ml-model-lifecycle.md) - Model persistence and retraining

### Solana Execution & New Strategies
- [ADR-034: Solana Execution](adr/ADR-034-solana-execution.md) - Jupiter V6 + Jito bundles
- [ADR-035: Statistical Arbitrage](adr/ADR-035-statistical-arbitrage.md) - Triple-gate signal strategy
- [ADR-036: CEX Price Signals](adr/ADR-036-cex-price-signals.md) - Binance WebSocket feed

### Execution Throughput
- [ADR-038: Chain-Grouped Execution](adr/ADR-038-chain-grouped-execution.md) - Per-group exec-request streams, horizontal EE scaling
- [ADR-039: Async Pipeline Split](adr/ADR-039-async-pipeline-split.md) - SimulationWorker pre-filtering, staleness protection

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
| 2026-02-24 | 4 emerging L2 chains planned (Blast, Scroll, Mantle, Mode) — reverted, placeholder addresses | ADR-003 |
| 2026-02-24 | P2 partition remains at 3 chains (emerging L2s removed pending real DEX addresses) | ADR-003 |
| 2026-02-26 | Scroll + Blast re-added to P2 with verified factory addresses (5 chains total) | ADR-003 |
| 2026-02-24 | Solana execution via Jupiter V6 + Jito bundles | ADR-034 |
| 2026-02-24 | Statistical arbitrage strategy (triple-gate signals) | ADR-035 |
| 2026-02-24 | Binance CEX price signal integration | ADR-036 |
| 2026-02-24 | Self-hosted Redis 7 on Oracle ARM (replaces Upstash) | ADR-002, ADR-006 |
| 2026-03-06 | Chain-grouped exec-request streams (4 streams, per-group consumer isolation) | ADR-038 |
| 2026-03-06 | SimulationWorker async pre-filtering; stream:pre-simulated; staleness filter in EE | ADR-039 |

---

## Maintenance Notes

- This document should be updated when:
  - New services are added
  - Partition assignments change
  - Redis Streams topology changes
  - Redis infrastructure changes (e.g., provider migration)
  - New health endpoints are added
  - New ADRs are created

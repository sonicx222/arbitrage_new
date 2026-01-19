# Project Structure Refactoring Report

**Generated**: 2026-01-19
**Purpose**: Consolidate classes and identify clustering opportunities for better project organization

---

## Executive Summary

The arbitrage system is a **mature, well-architected codebase** with 65+ modules in `shared/core/src/` totaling ~52K lines of code. While the architecture is sound, **root-level file clutter** can be reduced by grouping related files into logical subdirectories.

### Current State
- **4 existing subdirectories** (well-organized): `components/`, `dex-adapters/`, `mev-protection/`, `bridge-router/`
- **54 root-level files** (opportunity for clustering)
- **8 microservices** with clear separation of concerns

### Recommendation
Create **6 new subdirectories** to cluster related functionality, reducing root-level files from 54 to ~15.

---

## Table of Contents

1. [Project Architecture Overview](#1-project-architecture-overview)
2. [Current Directory Structure](#2-current-directory-structure)
3. [Clustering Recommendations](#3-clustering-recommendations)
4. [Service Architecture](#4-service-architecture)
5. [Module Dependency Graph](#5-module-dependency-graph)
6. [Implementation Roadmap](#6-implementation-roadmap)

---

## 1. Project Architecture Overview

### Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LAYER 5: COORDINATION                         │
│                         services/coordinator                         │
│              (Leader Election, Health Monitoring, Dashboard)         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                        LAYER 4: EXECUTION                            │
│                      services/execution-engine                       │
│           (Flash Loans, MEV Protection, Transaction Execution)       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                       LAYER 3: CROSS-CHAIN                           │
│                    services/cross-chain-detector                     │
│              (Cross-Chain Price Comparison, Bridge Routing)          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                        LAYER 2: DETECTION                            │
│                     services/unified-detector                        │
│              (Multi-Chain Detection, Partition Management)           │
│      ┌──────────┬──────────┬──────────┬──────────┐                  │
│      │    P1    │    P2    │    P3    │    P4    │                  │
│      │Asia-Fast │High-Value│ L2-Turbo │  Solana  │                  │
│      └──────────┴──────────┴──────────┴──────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                     LAYER 1: SHARED INFRASTRUCTURE                   │
│                            shared/core                               │
│    (Caching, Redis, WebSocket, Analytics, Resilience, Components)    │
└─────────────────────────────────────────────────────────────────────┘
```

### Package Structure

```
arbitrage_new/
├── shared/                          # Shared libraries
│   ├── core/                        # Core business logic (65+ modules)
│   ├── config/                      # Configuration (chains, DEXs, tokens)
│   ├── types/                       # TypeScript type definitions
│   ├── test-utils/                  # Test factories and mocks
│   ├── security/                    # Auth, rate limiting
│   └── ml/                          # Machine learning (TensorFlow.js)
│
├── services/                        # Microservices
│   ├── unified-detector/            # Multi-chain detection orchestrator
│   ├── coordinator/                 # System orchestration & dashboard
│   ├── execution-engine/            # Opportunity execution
│   ├── cross-chain-detector/        # Cross-chain price comparison
│   ├── partition-asia-fast/         # P1: BSC, Polygon, Avalanche, Fantom
│   ├── partition-high-value/        # P2: ETH, Optimism, Arbitrum, Base, zkSync, Linea
│   ├── partition-l2-turbo/          # P3: Arbitrum, Optimism, Base
│   └── partition-solana/            # P4: Solana (non-EVM)
│
└── docs/                            # Documentation
    ├── architecture/                # ADRs, decision log
    └── agent/                       # Code conventions
```

---

## 2. Current Directory Structure

### shared/core/src/ - Current State

```
shared/core/src/
│
├── components/                      # ✅ WELL-ORGANIZED (Phase 2 Complete)
│   ├── arbitrage-detector.ts        # Detection logic
│   ├── price-calculator.ts          # Pure calculation functions
│   ├── pair-repository.ts           # O(1) pair lookups
│   ├── token-utils.ts               # Token operations
│   └── index.ts
│
├── dex-adapters/                    # ✅ WELL-ORGANIZED
│   ├── balancer-v2-adapter.ts       # Weighted pool support
│   ├── gmx-adapter.ts               # Perpetual futures
│   ├── platypus-adapter.ts          # Stable swap
│   ├── adapter-registry.ts          # Dynamic registration
│   └── index.ts
│
├── mev-protection/                  # ✅ WELL-ORGANIZED
│   ├── flashbots-provider.ts        # Flashbots bundles
│   ├── l2-sequencer-provider.ts     # L2-specific MEV
│   ├── standard-provider.ts         # Standard RPC
│   └── index.ts
│
├── bridge-router/                   # ✅ WELL-ORGANIZED
│   ├── stargate-router.ts           # Cross-chain bridge
│   └── index.ts
│
└── [54 ROOT-LEVEL FILES]            # ⚠️ NEEDS CLUSTERING
    ├── Detection (9 files)
    ├── Caching (5 files)
    ├── Monitoring (4 files)
    ├── Resilience (5 files)
    ├── Async/Concurrency (4 files)
    ├── Redis/Messaging (2 files)
    ├── Analytics (7 files)
    ├── Solana-specific (4 files)
    └── Standalone utilities (14 files)
```

### Root-Level File Inventory

| Category | Files | Lines | Status |
|----------|-------|-------|--------|
| Detection/Arbitrage | 9 | 9,200+ | Core - Keep at root |
| Caching | 5 | 4,800+ | **Cluster → `caching/`** |
| Monitoring/Health | 4 | 3,200+ | **Cluster → `monitoring/`** |
| Resilience/Recovery | 5 | 4,100+ | **Cluster → `resilience/`** |
| Async/Concurrency | 4 | 2,500+ | **Cluster → `async/`** |
| Analytics/Scoring | 7 | 6,500+ | **Cluster → `analytics/`** |
| Solana-Specific | 4 | 4,600+ | **Cluster → `solana/`** |
| Redis/Messaging | 2 | 2,100+ | Keep at root |
| Standalone Utilities | 14 | 5,000+ | Keep at root |

---

## 3. Clustering Recommendations

### 3.1 Create `src/caching/` - Cache Management

**Cohesion**: HIGH - All files manage data caching with TTL and invalidation

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `hierarchical-cache.ts` | `caching/hierarchical-cache.ts` | Multi-tier (memory + Redis) |
| `shared-memory-cache.ts` | `caching/shared-memory.ts` | In-process LRU cache |
| `cache-coherency-manager.ts` | `caching/coherency-manager.ts` | Cross-tier consistency |
| `pair-cache.ts` | `caching/pair-cache.ts` | Trading pair cache |
| `price-matrix.ts` | `caching/price-matrix.ts` | O(1) price lookups |
| `gas-price-cache.ts` | `caching/gas-price-cache.ts` | Gas price tracking |
| - | `caching/index.ts` | Unified exports |

**New Developer Benefit**: Clear entry point for all caching needs.

---

### 3.2 Create `src/monitoring/` - Health & Observability

**Cohesion**: HIGH - All files track system health and performance

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `enhanced-health-monitor.ts` | `monitoring/system-health.ts` | System-wide health |
| `stream-health-monitor.ts` | `monitoring/stream-health.ts` | Redis Stream lag |
| `provider-health-scorer.ts` | `monitoring/provider-scorer.ts` | RPC provider scoring |
| `cross-region-health.ts` | `monitoring/cross-region.ts` | Regional failover |
| - | `monitoring/index.ts` | Unified exports |

**New Developer Benefit**: Single location for all observability concerns.

---

### 3.3 Create `src/resilience/` - Error Handling & Recovery

**Cohesion**: HIGH - All files implement fault tolerance patterns

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `error-handling.ts` | `resilience/error-handling.ts` | Standardized errors |
| `error-recovery.ts` | `resilience/recovery-orchestrator.ts` | Recovery automation |
| `retry-mechanism.ts` | `resilience/retry.ts` | Retry with backoff |
| `circuit-breaker.ts` | `resilience/circuit-breaker.ts` | Fault isolation |
| `dead-letter-queue.ts` | `resilience/dlq.ts` | Failed event handling |
| `graceful-degradation.ts` | `resilience/degradation.ts` | Feature fallbacks |
| `self-healing-manager.ts` | `resilience/self-healing.ts` | Auto-recovery |
| `expert-self-healing-manager.ts` | `resilience/expert-self-healing.ts` | Severity-aware recovery |
| - | `resilience/index.ts` | Unified exports |

**New Developer Benefit**: All fault tolerance in one place.

---

### 3.4 Create `src/async/` - Concurrency Utilities

**Cohesion**: HIGH - All files manage async operations and threading

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `async-utils.ts` | `async/utils.ts` | Timeout, retry, map |
| `async-singleton.ts` | `async/singleton.ts` | Singleton factory |
| `async-mutex.ts` | `async/mutex.ts` | Named mutual exclusion |
| `worker-pool.ts` | `async/worker-pool.ts` | Thread pool |
| - | `async/index.ts` | Unified exports |

**New Developer Benefit**: Clear async/concurrency patterns.

---

### 3.5 Create `src/analytics/` - Price Intelligence & ML

**Cohesion**: HIGH - All files analyze market data and score opportunities

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `price-momentum.ts` | `analytics/momentum.ts` | T2.7: Momentum detection |
| `ml-opportunity-scorer.ts` | `analytics/ml-scorer.ts` | T2.8: ML scoring |
| `whale-activity-tracker.ts` | `analytics/whale-tracker.ts` | T3.12: Whale detection |
| `liquidity-depth-analyzer.ts` | `analytics/liquidity-analyzer.ts` | T3.15: Slippage |
| `swap-event-filter.ts` | `analytics/swap-filter.ts` | Volume filtering |
| `performance-analytics.ts` | `analytics/performance.ts` | Strategy metrics |
| `professional-quality-monitor.ts` | `analytics/quality-monitor.ts` | AD-PQS scoring |
| `price-oracle.ts` | `analytics/price-oracle.ts` | Centralized prices |
| - | `analytics/index.ts` | Unified exports |

**New Developer Benefit**: All market intelligence modules together.

---

### 3.6 Create `src/solana/` - Non-EVM Chain Support

**Cohesion**: HIGH - All files specific to Solana blockchain

| Current Location | New Location | Purpose |
|-----------------|--------------|---------|
| `solana-detector.ts` | `solana/detector.ts` | Main Solana detector |
| `solana-swap-parser.ts` | `solana/swap-parser.ts` | Instruction parsing |
| `solana-price-feed.ts` | `solana/price-feed.ts` | Real-time prices |
| `solana-detector.test.ts` | `solana/__tests__/detector.test.ts` | Tests |
| - | `solana/index.ts` | Unified exports |

**New Developer Benefit**: All Solana code isolated from EVM logic.

---

### 3.7 Files to Keep at Root Level

These files are either:
- Core detection logic (hot path)
- Single-purpose utilities with no clear grouping
- Cross-cutting concerns used everywhere

| File | Reason |
|------|--------|
| `base-detector.ts` | Core detection framework |
| `partitioned-detector.ts` | Multi-chain orchestration |
| `redis.ts` | Core infrastructure |
| `redis-streams.ts` | Core infrastructure |
| `websocket-manager.ts` | Core infrastructure |
| `logger.ts` | Used everywhere |
| `service-state.ts` | Used by all services |
| `distributed-lock.ts` | Core infrastructure |
| `nonce-manager.ts` | Transaction sequencing |
| `validation.ts` | Request validation |
| `message-validators.ts` | Message schemas |
| `repositories.ts` | Data persistence |
| `partition-router.ts` | Partition discovery |
| `simulation-mode.ts` | Dev/test only |
| `index.ts` | Main exports |

---

## 4. Service Architecture

### 4.1 unified-detector (Multi-Chain Detection)

```
services/unified-detector/src/
├── index.ts                         # Entry point
├── unified-detector.ts              # Main orchestrator
├── chain-instance.ts                # Per-chain runner (HOT PATH)
├── chain-instance-manager.ts        # Lifecycle management
├── types.ts                         # Service types
├── health-reporter.ts               # Health checks
├── metrics-collector.ts             # Performance metrics
│
├── simulation/                      # Phase 3.3: Extracted
│   ├── chain.simulator.ts           # Price simulation
│   └── index.ts
│
├── publishers/                      # Phase 3.3: Extracted
│   ├── whale-alert.publisher.ts     # Whale event publishing
│   └── index.ts
│
└── __tests__/
    ├── unified-detector.test.ts
    ├── integration.test.ts
    └── unit/
```

**Responsibility**: Detect arbitrage opportunities across 11 blockchains using partitioned architecture.

---

### 4.2 coordinator (System Orchestration)

```
services/coordinator/src/
├── index.ts                         # Entry point
├── coordinator.ts                   # Main orchestrator (slim composition root)
│
├── api/                             # Phase 3.1: Extracted
│   ├── index.ts                     # Express server
│   ├── middleware/
│   └── routes/
│       ├── health.routes.ts         # GET /health, /ready
│       ├── metrics.routes.ts        # GET /metrics
│       ├── dashboard.routes.ts      # Dashboard data
│       └── admin.routes.ts          # Admin controls
│
├── consumers/                       # Phase 3.1: Extracted
│   ├── opportunity.consumer.ts      # Stream consumer
│   └── health.consumer.ts           # Health events
│
├── services/                        # Phase 3.1: Extracted
│   ├── leader-election.service.ts   # Redis-based election
│   └── metrics.service.ts           # Metrics aggregation
│
└── __tests__/
```

**Responsibility**: Orchestrate all services, provide dashboard API, manage leader election.

---

### 4.3 execution-engine (Opportunity Execution)

```
services/execution-engine/src/
├── index.ts                         # Entry point
├── engine.ts                        # Main executor (slim composition root)
├── types.ts                         # Execution types
│
├── strategies/                      # Phase 3.2: Extracted
│   ├── index.ts
│   ├── base.strategy.ts             # Abstract strategy
│   ├── flash-loan.strategy.ts       # Flash loan execution
│   ├── mev-bundle.strategy.ts       # Flashbots bundles
│   ├── standard.strategy.ts         # Standard transactions
│   └── simulation.strategy.ts       # Dry-run simulation
│
├── services/                        # Phase 3.2: Extracted
│   ├── provider.service.ts          # RPC provider pool
│   ├── queue.service.ts             # Priority queue
│   └── nonce.service.ts             # Nonce management
│
├── consumers/                       # Phase 3.2: Extracted
│   └── opportunity.consumer.ts      # Stream consumer + validation
│
└── __tests__/
```

**Responsibility**: Execute detected opportunities with MEV protection and flash loans.

---

### 4.4 cross-chain-detector (Cross-Chain Arbitrage)

```
services/cross-chain-detector/src/
├── index.ts                         # Entry point
├── detector.ts                      # Main detector
├── stream-consumer.ts               # Redis Streams consumer
├── price-data-manager.ts            # Cross-chain price aggregation
├── opportunity-publisher.ts         # Opportunity publication
├── bridge-predictor.ts              # Bridge cost/time estimation
│
└── __tests__/
    ├── unit/
    └── detector.test.ts
```

**Responsibility**: Detect arbitrage opportunities across different blockchains.

---

## 5. Module Dependency Graph

### Core Module Dependencies

```
                    ┌─────────────────┐
                    │     logger      │
                    └────────┬────────┘
                             │ (used by all)
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     redis       │  │  service-state  │  │   validation    │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    │                    │
┌─────────────────┐          │                    │
│  redis-streams  │          │                    │
└────────┬────────┘          │                    │
         │                   │                    │
         ├───────────────────┼────────────────────┘
         │                   │
         ▼                   ▼
┌─────────────────┐  ┌─────────────────┐
│  base-detector  │◄─┤   components/   │
└────────┬────────┘  │ arbitrage-det.  │
         │           │ price-calc.     │
         │           │ pair-repo.      │
         │           └─────────────────┘
         │
         ▼
┌─────────────────┐  ┌─────────────────┐
│ partitioned-det │  │  solana-det.    │
└────────┬────────┘  └────────┬────────┘
         │                    │
         └────────┬───────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ unified-detector│ (service)
         └─────────────────┘
```

### Analytics Module Dependencies

```
┌─────────────────┐
│  components/    │
│ price-calculator│
└────────┬────────┘
         │
         ├─────────────────────┬────────────────────┐
         │                     │                    │
         ▼                     ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ price-momentum  │  │ ml-opp-scorer   │  │ liquidity-depth │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                     │                    │
         └─────────────────────┼────────────────────┘
                               │
                               ▼
                    ┌─────────────────┐
                    │ whale-tracker   │
                    └─────────────────┘
```

---

## 6. Implementation Roadmap

### Phase 1: Create Directory Structure (Non-Breaking)

```bash
# Create new directories
mkdir -p shared/core/src/caching
mkdir -p shared/core/src/monitoring
mkdir -p shared/core/src/resilience
mkdir -p shared/core/src/async
mkdir -p shared/core/src/analytics
mkdir -p shared/core/src/solana
mkdir -p shared/core/src/solana/__tests__
```

### Phase 2: Move Files (With Re-exports)

For each file move, create re-export from old location:

```typescript
// OLD: shared/core/src/hierarchical-cache.ts
/**
 * @deprecated Import from '@arbitrage/core/caching' instead
 */
export * from './caching/hierarchical-cache';
```

### Phase 3: Update Index Exports

```typescript
// shared/core/src/index.ts
// Add new module exports
export * from './caching';
export * from './monitoring';
export * from './resilience';
export * from './async';
export * from './analytics';
export * from './solana';

// Keep existing exports for backward compatibility
```

### Phase 4: Update Imports Gradually

Update imports across the codebase over time:

```typescript
// Before
import { HierarchicalCache } from '@arbitrage/core';

// After
import { HierarchicalCache } from '@arbitrage/core/caching';
```

### Phase 5: Remove Deprecated Re-exports

After all imports updated, remove deprecated re-export files.

---

## Appendix A: File-to-Module Mapping

### Complete Clustering Map

| File | Current | Recommended |
|------|---------|-------------|
| `hierarchical-cache.ts` | root | `caching/` |
| `shared-memory-cache.ts` | root | `caching/` |
| `cache-coherency-manager.ts` | root | `caching/` |
| `pair-cache.ts` | root | `caching/` |
| `price-matrix.ts` | root | `caching/` |
| `gas-price-cache.ts` | root | `caching/` |
| `enhanced-health-monitor.ts` | root | `monitoring/` |
| `stream-health-monitor.ts` | root | `monitoring/` |
| `provider-health-scorer.ts` | root | `monitoring/` |
| `cross-region-health.ts` | root | `monitoring/` |
| `error-handling.ts` | root | `resilience/` |
| `error-recovery.ts` | root | `resilience/` |
| `retry-mechanism.ts` | root | `resilience/` |
| `circuit-breaker.ts` | root | `resilience/` |
| `dead-letter-queue.ts` | root | `resilience/` |
| `graceful-degradation.ts` | root | `resilience/` |
| `self-healing-manager.ts` | root | `resilience/` |
| `expert-self-healing-manager.ts` | root | `resilience/` |
| `async-utils.ts` | root | `async/` |
| `async-singleton.ts` | root | `async/` |
| `async-mutex.ts` | root | `async/` |
| `worker-pool.ts` | root | `async/` |
| `price-momentum.ts` | root | `analytics/` |
| `ml-opportunity-scorer.ts` | root | `analytics/` |
| `whale-activity-tracker.ts` | root | `analytics/` |
| `liquidity-depth-analyzer.ts` | root | `analytics/` |
| `swap-event-filter.ts` | root | `analytics/` |
| `performance-analytics.ts` | root | `analytics/` |
| `professional-quality-monitor.ts` | root | `analytics/` |
| `price-oracle.ts` | root | `analytics/` |
| `solana-detector.ts` | root | `solana/` |
| `solana-swap-parser.ts` | root | `solana/` |
| `solana-price-feed.ts` | root | `solana/` |

---

## Appendix B: New Developer Quick Reference

### Where to Find Things

| I need to... | Look in... |
|--------------|------------|
| Add arbitrage detection logic | `shared/core/src/components/` |
| Add new DEX support | `shared/core/src/dex-adapters/` |
| Implement MEV protection | `shared/core/src/mev-protection/` |
| Add cross-chain bridge | `shared/core/src/bridge-router/` |
| Implement caching | `shared/core/src/caching/` (proposed) |
| Add health monitoring | `shared/core/src/monitoring/` (proposed) |
| Handle errors/recovery | `shared/core/src/resilience/` (proposed) |
| Add async utilities | `shared/core/src/async/` (proposed) |
| Add market analytics | `shared/core/src/analytics/` (proposed) |
| Add Solana features | `shared/core/src/solana/` (proposed) |
| Configure chains/DEXs | `shared/config/src/` |
| Add new service | `services/` |

### Key Entry Points

| Service | Entry Point | Purpose |
|---------|-------------|---------|
| unified-detector | `services/unified-detector/src/index.ts` | Multi-chain detection |
| coordinator | `services/coordinator/src/index.ts` | System orchestration |
| execution-engine | `services/execution-engine/src/index.ts` | Trade execution |
| cross-chain-detector | `services/cross-chain-detector/src/index.ts` | Cross-chain arbitrage |

---

## Conclusion

This refactoring plan reduces cognitive load for new developers by:

1. **Reducing root-level clutter** from 54 files to ~15
2. **Grouping related functionality** into 6 logical subdirectories
3. **Maintaining backward compatibility** through re-exports
4. **Following established patterns** (existing `components/`, `dex-adapters/`, etc.)

The proposed structure makes it clear where to add new functionality and where to find existing code.

**Risk Level**: LOW - All changes are additive with backward-compatible re-exports.

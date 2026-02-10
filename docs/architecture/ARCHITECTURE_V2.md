# Architecture Design v2.0 - Professional Multi-Chain Arbitrage System

> **Document Version:** 2.8
> **Last Updated:** 2026-02-04
> **Status:** Approved for Implementation
> **Authors:** Architecture Analysis Session

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Vision & Goals](#2-vision--goals)
3. [Architecture Overview](#3-architecture-overview)
4. [System Components](#4-system-components)
5. [Data Flow](#5-data-flow)
6. [Scaling Strategy](#6-scaling-strategy)
7. [Free Hosting Optimization](#7-free-hosting-optimization)
8. [Performance Targets](#8-performance-targets)
9. [Related ADRs](#9-related-adrs)

---

## 1. Executive Summary

This document describes the target architecture for a **professional-grade, multi-chain arbitrage detection and execution system** designed to:

- Monitor **11 blockchains** (10 EVM + Solana) with **49 DEXs** (current) and **112 tokens** (current)
- Achieve **<50ms detection latency** for same-chain EVM arbitrage, **<100ms for Solana**
- Maintain **99.9% uptime** through geographic redundancy
- Operate at **$0/month infrastructure cost** using free hosting tiers
- Generate **profitable arbitrage opportunities** with MEV protection

> **Note**: This document reflects both current implementation and target state. See section 2.2 for specific current vs. target metrics.

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture Pattern | Hybrid Microservices + Event-Driven | Best of both: deployment isolation + async communication |
| Message Broker | Redis Streams (not Pub/Sub) | Persistence, consumer groups, backpressure |
| Chain Scaling | Partitioned Detectors (4 partitions) | Resource efficiency, dynamic assignment |
| Event Strategy | Sync-Primary + Smart Swap Filtering | Speed + predictive signals without resource drain |
| Caching | L1/L2/L3 Hierarchical | Sub-millisecond access with distributed fallback |
| Non-EVM Support | Dedicated Solana Partition (P4) | Different SDK, event model, requires isolation |

---

## 2. Vision & Goals

### 2.1 Primary Vision

Build a **professional and reliable profitable arbitrage application** with:
- Competitive detection speed against MEV bots
- Scalability to emerging blockchains and DEXs
- Zero infrastructure cost through optimized free hosting
- 24/7 autonomous operation with self-healing

### 2.2 Quantitative Goals

**P1-003 FIX: Updated to reflect actual implementation (February 2026)**

| Metric | Current (Feb 2026) | Target (Q2 2026) | Status |
|--------|-------------------|------------------|--------|
| **Chains Supported** | **11** (10 EVM + Solana) | 11 | ✅ Complete |
| **DEXs Monitored** | **49** (42 EVM + 7 Solana) | 54 | 🔄 +5 DEXs planned |
| **Tokens Tracked** | **112** | 143 | 🔄 +31 tokens planned |
| **Detection Latency (EVM)** | <50ms | <50ms | ✅ Achieved |
| **Detection Latency (Solana)** | <100ms | <100ms | ✅ Achieved |
| **Detection Latency (cross-chain)** | <15s | <10s | 🔄 Optimization needed |
| **System Uptime** | 99.5% | 99.9% | 🔄 Improving |
| **Monthly Cost** | $0 | $0 | ✅ Maintained |

**Planned DEX Additions (5)**:
- Curve Finance (Ethereum) - high TVL stablecoin pools
- Velodrome V2 (Optimism) - concentrated liquidity
- Trader Joe V2.1 (Avalanche) - liquidity book model
- WOOFi (BSC, Polygon) - synthetic proactive market maker
- Phoenix (Solana) - central limit order book

**See**: `shared/config/src/dexes/index.ts` for current DEX inventory

### 2.3 Constraints

| Constraint | Limit | Mitigation Strategy |
|------------|-------|---------------------|
| Upstash Redis | 10K commands/day | Aggressive batching (50:1 ratio) |
| Fly.io Memory | 256MB per instance | Streaming mode, no large buffers |
| Oracle Cloud | 4 OCPU, 24GB total | Efficient partitioning |
| RPC Rate Limits (EVM) | Varies by provider | Multi-provider rotation |
| Solana RPC (Helius) | 100K credits/day | WebSocket over polling, batched queries |

---

## 3. Architecture Overview

### 3.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                         ARBITRAGE SYSTEM ARCHITECTURE v2.1                            │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│                              ┌─────────────────────────┐                             │
│                              │   GLOBAL COORDINATOR    │                             │
│                              │   (Leader Election)     │                             │
│                              │   Koyeb US-East         │                             │
│                              └───────────┬─────────────┘                             │
│                                          │                                            │
│    ┌─────────────────────────────────────┼────────────────────────────────────┐      │
│    │                    │                │                │                   │      │
│    ▼                    ▼                ▼                ▼                   ▼      │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌──────┐│
│ │ ASIA-PACIFIC   │ │  US-EAST       │ │  US-WEST       │ │ US-WEST (SOL)  │ │ EXEC ││
│ │ ────────────   │ │  ───────       │ │  ───────       │ │ ────────────   │ │      ││
│ │                │ │                │ │                │ │                │ │      ││
│ │┌──────────────┐│ │┌──────────────┐│ │┌──────────────┐│ │┌──────────────┐│ │ Rail ││
│ ││ Partition 1  ││ ││ Partition 3  ││ ││ Cross-Chain  ││ ││ Partition 4  ││ │ way  ││
│ ││BSC/Poly/Avax ││ ││ ETH/zkSync   ││ ││ Analyzer     ││ ││ SOLANA       ││ │      ││
│ ││ Oracle ARM   ││ ││ Oracle ARM   ││ ││ Oracle AMD   ││ ││ Fly.io US-W  ││ │ + Bkp││
│ │└──────────────┘│ │└──────────────┘│ │└──────────────┘│ │└──────────────┘│ │Render││
│ │                │ │                │ │                │ │                │ │      ││
│ │┌──────────────┐│ │                │ │                │ │ @solana/web3  │ │      ││
│ ││ Partition 2  ││ │                │ │                │ │ Account Subs  │ │      ││
│ ││ ARB/OP/Base  ││ │                │ │                │ │ Helius RPC    │ │      ││
│ ││ Fly.io SG    ││ │                │ │                │ │                │ │      ││
│ │└──────────────┘│ │                │ │                │ │                │ │      ││
│ └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘ └──────┘│
│                                                                                       │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │                            DATA PLANE (Global)                                 │   │
│  │                                                                                │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                │   │
│  │  │ Upstash Redis   │  │ Redis Cache     │  │ L1 Cache        │                │   │
│  │  │ Streams         │  │ (L2 Price Data) │  │ SharedArrayBuf  │                │   │
│  │  │ (Event Backbone)│  │ (Cross-Partition│  │ (Per-Instance)  │                │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                │   │
│  │                                                                                │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Architecture Pattern: Hybrid Microservices + Event-Driven

The architecture combines two patterns:

**Microservices (Deployment & Isolation)**
- Each service is independently deployable
- Services have isolated failure domains
- Enables geographic distribution
- Supports heterogeneous hosting providers

**Event-Driven (Communication & Processing)**
- Asynchronous message passing via Redis Streams
- Event sourcing for audit trail
- Backpressure handling through consumer groups
- Decoupled producers and consumers

### 3.3 Why Not Pure Microservices or Pure Event-Driven?

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Pure Microservices | Clear boundaries, independent scaling | Synchronous coupling, latency overhead | ❌ Too slow |
| Pure Event-Driven | Fast, decoupled | Complex deployment, shared state issues | ❌ Hard to operate |
| **Hybrid** | Best of both, flexibility | Moderate complexity | ✅ Selected |

---

## 4. System Components

### 4.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            COMPONENT HIERARCHY                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  LAYER 1: INGESTION                                                              │
│  ├── Chain Detector Partition 1 (Asia-Fast: BSC, Polygon, Avalanche, Fantom)    │
│  ├── Chain Detector Partition 2 (L2-Fast: Arbitrum, Optimism, Base)             │
│  ├── Chain Detector Partition 3 (High-Value: Ethereum, zkSync, Linea)           │
│  ├── Chain Detector Partition 4 (Solana: Non-EVM, @solana/web3.js)              │
│  ├── Unified Detector - Mempool (bloXroute BDN: Pre-block arbitrage)            │
│  └── Factory Subscription Manager (ADR-019: 40x RPC reduction) ✅ NEW           │
│                                                                                  │
│  **P1-004 FIX**: All partitions (P1-P4) and mempool detector use the same       │
│  **Unified Detector** service (@arbitrage/unified-detector) with different      │
│  PARTITION_ID environment variables. This consolidates chain detection logic    │
│  and enables resource-efficient deployment (ADR-003).                           │
│                                                                                  │
│  LAYER 2: ANALYSIS                                                               │
│  ├── Cross-Chain Analyzer (Multi-chain opportunity detection)                   │
│  ├── ML Predictor (Price movement prediction)                                   │
│  ├── Volume Aggregator (Swap event intelligence)                                │
│  ├── Multi-Leg Path Finder (T3.11: 5-7 token cycle detection)                   │
│  ├── Whale Activity Tracker (T3.12: Pattern detection & signals)                │
│  ├── Liquidity Depth Analyzer (T3.15: Slippage prediction)                      │
│  └── Correlation Analyzer (Predictive cache warming) ✅ NEW                     │
│                                                                                  │
│  LAYER 3: DECISION                                                               │
│  ├── Opportunity Scorer (Profit/risk evaluation)                                │
│  ├── MEV Risk Analyzer (Sandwich risk, tip recommendations) ✅ NEW              │
│  ├── MEV Analyzer (Bot detection, avoidance)                                    │
│  └── Execution Planner (Route optimization)                                     │
│                                                                                  │
│  LAYER 4: EXECUTION                                                              │
│  ├── Execution Engine Primary (MEV-protected trades - **EVM ONLY**)             │
│  │   ├── Transaction Simulation (Tenderly/Alchemy pre-flight) ✅ NEW            │
│  │   ├── Circuit Breaker (Consecutive failure protection) ✅ NEW                │
│  │   ├── DexLookupService (O(1) DEX/router lookups) ✅ NEW                      │
│  │   ├── SwapBuilder (Cached swap step construction) ✅ NEW                     │
│  │   └── Strategy Factory (Intra-chain, Cross-chain, Flash Loan)                │
│  ├── Execution Engine Backup (Failover - **EVM ONLY**)                          │
│  ├── Flash Loan Strategy (Aave V3 + PancakeSwap V3) ✅ NEW                      │
│  ├── Flash Loan Contract (FlashLoanArbitrage.sol) ✅ NEW                        │
│  └── Solana Executor (Jito bundles, priority fees) ⚠️ **DETECTION ONLY**       │
│                                                                                  │
│  LAYER 5: COORDINATION                                                           │
│  ├── Global Coordinator (Health, leader election)                               │
│  ├── Self-Healing Manager (Auto-recovery)                                       │
│  ├── Bridge Recovery Service (Redis-persisted recovery for cross-chain) ✅ NEW  │
│  └── Dashboard (Monitoring, analytics)                                          │
│                                                                                  │
│  SHARED INFRASTRUCTURE                                                           │
│  ├── Redis Streams (Event backbone)                                             │
│  ├── Hierarchical Cache (L1/L2/L3 + Predictive Warming) ✅ ENHANCED             │
│  ├── Circuit Breaker (Execution protection) ✅ NEW                              │
│  ├── MEV Provider Factory (Flashbots, Jito, L2 Sequencer) ✅ ENHANCED           │
│  └── RPC Provider Pool (EVM + Solana)                                           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Layer 4 Extracted Services (Task #4 Refactoring)

The execution engine has been refactored to extract reusable services for improved maintainability and testability.

#### 4.2.1 DexLookupService (`services/execution-engine/src/services/dex-lookup.service.ts`)

**Purpose**: Provides O(1) DEX and router address lookups using Map-based indexing.

**Key Features**:
- Initialized once from `@arbitrage/config` DEXES constant
- Map-based indexing: `dexByNameMap`, `dexByRouterMap`, `dexesByChainMap`
- Zero runtime configuration lookups

**Methods**:
- `getRouterAddress(chainId, dexName)` - Get router address for DEX
- `getDexByName(chainId, dexName)` - Get DEX config by name
- `findDexByRouter(chainId, routerAddress)` - Reverse lookup by router
- `getAllDexesForChain(chainId)` - Get all DEXes for a chain
- `isValidRouter(chainId, routerAddress)` - Validate router address
- `hasChain(chainId)` - Check if chain is supported

**Performance**:
- Memory: ~40 KB (all 49 DEXes cached)
- Lookup time: <0.01ms per operation
- Indexes: 3 maps (by name, by router, by chain)

**Test Coverage**: 21 tests covering initialization, lookups, edge cases

#### 4.2.2 SwapBuilder (`services/execution-engine/src/services/swap-builder.service.ts`)

**Purpose**: Builds swap steps with slippage calculations and result caching.

**Key Features**:
- TTL-based caching (60s default) with LRU eviction
- Automatic slippage calculation (0.5% default, configurable)
- Cache key generation from opportunity data
- Thread-safe cache operations

**Methods**:
- `buildSwapSteps(opportunity, slippageTolerance?)` - Build swap steps with caching

**Cache Strategy**:
- Max entries: 100 (configurable)
- TTL: 60 seconds (configurable)
- Eviction: LRU when max size reached
- Hit rate: Expected 70-90% for repeated opportunities

**Performance**:
- Memory: ~50 KB max (100 cached entries)
- Cache hit: <0.1ms
- Cache miss: ~1-2ms (includes slippage calculation)

**Test Coverage**: 7 tests covering cache behavior, TTL, eviction

**Integration**: Used by BaseStrategy and all strategy subclasses (IntraChainStrategy, CrossChainStrategy, FlashLoanStrategy)

### 4.3 Chain Detector Partitions

Instead of one service per chain, chains are grouped into partitions based on:

1. **Geographic proximity** (to blockchain validators)
2. **Block time similarity** (similar processing cadence)
3. **Resource requirements** (memory, CPU)

| Partition | Chains | Location | Provider | Resources |
|-----------|--------|----------|----------|-----------|
| P1: Asia-Fast | BSC, Polygon, Avalanche, Fantom | Singapore | Oracle ARM | 2 OCPU, 12GB |
| P2: L2-Fast | Arbitrum, Optimism, Base | Singapore | Fly.io x2 | 512MB total |
| P3: High-Value | Ethereum, zkSync, Linea | US-East | Oracle ARM | 2 OCPU, 12GB |
| P4: Solana | Solana (non-EVM) | US-West | Fly.io | 256MB |

### 4.3.1 Solana Partition Details (P4)

Solana requires a dedicated partition due to fundamental architectural differences:

| Aspect | EVM Chains (P1-P3) | Solana (P4) |
|--------|-------------------|-------------|
| SDK | ethers.js | @solana/web3.js |
| Events | Contract event logs | Program account changes |
| Subscription | eth_subscribe (logs) | accountSubscribe |
| Block Time | 2-12 seconds | ~400ms |
| Finality | ~2-60 confirmations | ~32 slots (~13s) |
| MEV Protection | Flashbots, private pools | Jito bundles |

**Solana DEXs (7 DEXs)**:
| DEX | Type | Program ID |
|-----|------|------------|
| Jupiter | Aggregator | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| Raydium AMM | AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` |
| Raydium CLMM | CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Orca Whirlpools | CLMM | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |
| Meteora DLMM | Dynamic AMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| Phoenix | Order Book | `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY` |
| Lifinity | Proactive MM | `2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c` |

**Solana Tokens (15 tokens)**:
SOL, USDC, USDT, JUP, RAY, ORCA, BONK, WIF, JTO, PYTH, mSOL, jitoSOL, BSOL, W, MNDE

### 4.3.2 Mempool Detector (Pre-Block Arbitrage)

The Mempool Detector service provides **pre-block arbitrage detection** by monitoring pending transactions before they are included in blocks.

| Aspect | Details |
|--------|---------|
| **Port** | 3007 |
| **Purpose** | Detect arbitrage opportunities from pending transactions |
| **Data Source** | bloXroute BDN (Blockchain Distribution Network) |
| **Supported Chains** | Ethereum, BSC (configurable) |
| **Output Stream** | `stream:pending-opportunities` |

**Key Features**:
- **bloXroute Integration**: Connects to bloXroute BDN WebSocket feed for real-time pending transaction data
- **Swap Decoder**: Decodes DEX router calls (UniswapV2/V3, PancakeSwap, etc.) to extract swap intents
- **High Performance**: O(1) latency tracking with circular buffers, sub-millisecond decode times
- **Backpressure Protection**: Circular buffer with configurable size to prevent memory overflow
- **Batched Publishing**: Efficient Redis Streams publishing with configurable batch size/timeout
- **Health Monitoring**: HTTP endpoints for health checks, readiness, and statistics

**Architecture**:
```
bloXroute BDN → WebSocket Feed → Swap Decoder → Filter → Redis Streams
                                       ↓
                              PendingSwapIntent
                                       ↓
                         Cross-Chain Detector (consumer)
```

**Configuration**:
- `MEMPOOL_CONFIG.enabled`: Enable/disable mempool detection
- `MEMPOOL_CONFIG.bloxroute.enabled`: Enable bloXroute feed
- `MEMPOOL_CONFIG.filters.minSwapSizeUsd`: Minimum swap size (default: $1000)
- `MEMPOOL_CONFIG.service.maxBufferSize`: Transaction buffer size (default: 10000)
- `MEMPOOL_CONFIG.service.batchSize`: Redis publishing batch size (default: 100)

**Use Case**: Detect large pending swaps before block inclusion, allowing the system to:
1. Front-run arbitrage opportunities with MEV protection
2. Predict price impact before transactions execute
3. Optimize trade timing based on mempool activity

### 4.4 Event Processing Strategy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         EVENT PROCESSING PIPELINE                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  BLOCKCHAIN EVENTS                                                               │
│       │                                                                          │
│       ▼                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │ SYNC EVENTS (Priority: CRITICAL)                                        │    │
│  │                                                                          │    │
│  │ • Process ALL sync events immediately                                    │    │
│  │ • Update price matrix (O(1) indexed structure)                          │    │
│  │ • Trigger arbitrage detection                                           │    │
│  │ • Publish to stream:price-updates                                       │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│       │                                                                          │
│       ▼                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │ SWAP EVENTS (Priority: LOW, Smart Filtering)                            │    │
│  │                                                                          │    │
│  │ Level 1: Edge Filter (90% rejected)                                     │    │
│  │   • Not in watchlist? → DROP                                            │    │
│  │   • Recent duplicate? → DROP                                            │    │
│  │                                                                          │    │
│  │ Level 2: Value Filter (93% of remainder rejected)                       │    │
│  │   • USD < $10K? → Sample 1%                                             │    │
│  │   • USD $10K-$50K? → Process                                            │    │
│  │   • USD > $50K? → WHALE ALERT (immediate)                               │    │
│  │                                                                          │    │
│  │ Level 3: Local Aggregation (no Redis per-swap)                          │    │
│  │   • Aggregate volume by pair (5-second windows)                         │    │
│  │   • Track MEV bot patterns                                              │    │
│  │   • Batch publish aggregates                                            │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  RESULT: 99% reduction in Redis commands, 100% signal retention                 │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Chain Support Scope Clarification

**IMPORTANT**: The execution engine currently supports **EVM chains ONLY**.

| Layer | EVM Chains (10) | Solana |
|-------|-----------------|--------|
| **Detection** | ✅ Fully Supported | ✅ Fully Supported |
| **Execution** | ✅ Fully Supported | ❌ **Not Implemented** |

**EVM Chains Supported for Execution**:
- Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Fantom, zkSync, Linea

**Solana Status**:
- ✅ **Detection**: Partition 4 monitors Solana DEXs (Raydium, Orca, Jupiter, etc.)
- ✅ **Opportunity Finding**: Cross-chain arbs detected between Solana ↔ EVM
- ❌ **Execution**: Requires separate Solana-native executor (different transaction model, SPL tokens, program invocations)

**Why Solana Execution is Separate**:
- Different transaction structure (@solana/web3.js vs ethers.js)
- Account-based model vs EVM contract calls
- SPL token standard vs ERC-20
- Jito bundles vs Flashbots
- Program invocations vs smart contract ABIs

**Future Work**: See roadmap for Solana execution engine development plan.

### 4.6 Bridge Recovery Service

**Purpose**: Ensures cross-chain arbitrage trades complete successfully even after service restarts or failures.

**Problem Solved**: Bridge transactions take 10-30 minutes to complete. If the execution engine crashes or restarts during this window, the system loses track of in-flight bridge transactions, potentially leaving funds locked.

**Solution**: Redis-persisted recovery mechanism

**Key Features**:
- **Redis Persistence**: Stores bridge transaction state with 24-hour TTL
- **Automatic Recovery**: On restart, checks for in-flight bridges and resumes monitoring
- **Deadline Tracking**: Expires old recovery attempts (configurable timeout)
- **Idempotent**: Safe to query bridge status multiple times

**Recovery Flow**:
```
1. Execute Source Chain → Store Recovery State in Redis
2. Bridge Transaction Submitted → Update State
3. [Service Restart/Crash]
4. On Startup → Load Recovery States from Redis
5. Resume Bridge Polling → Complete Destination Chain Execution
```

**Configuration**:
- `BRIDGE_RECOVERY_MAX_AGE_MS`: Maximum age for recovery (default: 24 hours)
- Redis key pattern: `bridge:recovery:{opportunityId}`

**Location**: Implemented in `services/execution-engine/src/strategies/cross-chain.strategy.ts` (lines 1091-1658)

---

## 5. Data Flow

> **See Also**: [DATA_FLOW.md](DATA_FLOW.md) for comprehensive visual diagrams of all data flows.

### 5.1 Price Update Flow (Critical Path)

```
WebSocket Event → Decode Sync → Update Price Matrix → Check Arbitrage → Publish Opportunity
     │                │                │                    │                  │
     └── <1ms ────────┴──── <1ms ──────┴────── <5ms ────────┴────── <2ms ──────┘

Total Target: <10ms end-to-end
```

### 5.2 Cross-Chain Detection Flow

```
Price Update (Chain A) ─┐
                        ├──→ Cross-Chain Analyzer ──→ Opportunity Detected
Price Update (Chain B) ─┘           │
                                    │
                              Uses: Materialized Price Matrix
                              Complexity: O(1) lookup per pair

Total Target: <100ms detection, <10s for bridge opportunities
```

### 5.3 Message Channels (Redis Streams)

| Stream | Producer | Consumer | Volume | Retention |
|--------|----------|----------|--------|-----------|
| `stream:price-updates` | Detectors | Cross-Chain, Dashboard | ~50/sec | 1 hour |
| `stream:opportunities` | Analyzers | Coordinator | ~10/min | 24 hours |
| `stream:execution-requests` | Coordinator | Execution Engine | ~10/min | 24 hours |
| `stream:whale-alerts` | Detectors | All | ~5/hour | 24 hours |
| `stream:volume-aggregates` | Detectors | Analyzer | ~20/min | 1 hour |
| `stream:health` | All | Coordinator | ~10/min | 1 hour |
| `stream:dead-letter-queue` | All | Ops/Monitoring | ~1/hour | 7 days |

### 5.4 Opportunity Execution Flow (Broker Pattern)

The Execution Engine does NOT consume directly from `stream:opportunities`.
Instead, a broker pattern is used where the Coordinator forwards approved
opportunities to the Execution Engine via `stream:execution-requests`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OPPORTUNITY EXECUTION FLOW                          │
│                                                                             │
│  Analyzers                    Coordinator                   Execution       │
│  ────────                    ───────────                    Engine          │
│                                                                             │
│  ┌─────────┐   stream:       ┌─────────────┐   stream:      ┌───────────┐  │
│  │ Cross-  │  opportunities  │  Global     │  execution-   │ Execution │  │
│  │ Chain   │ ───────────────►│ Coordinator │  requests     │  Engine   │  │
│  │Analyzer │                 │  (Leader)   │ ─────────────►│           │  │
│  └─────────┘                 └─────────────┘                └───────────┘  │
│                                    │                              │         │
│  ┌─────────┐                       │                              │         │
│  │   ML    │ ───────────────►      │                              │         │
│  │Predictor│                       │                              │         │
│  └─────────┘                       │                              │         │
│                                    ▼                              ▼         │
│                              ┌──────────┐                  ┌──────────┐     │
│                              │ Pre-exec │                  │ Execute  │     │
│                              │ Filters: │                  │  Trade:  │     │
│                              │ • Leader │                  │ • Gas    │     │
│                              │   only   │                  │ • Nonce  │     │
│                              │ • Circuit│                  │ • MEV    │     │
│                              │   breaker│                  │ • Bridge │     │
│                              │ • Risk   │                  │          │     │
│                              └──────────┘                  └──────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why the Broker Pattern?**

1. **Leader Election Deduplication**: Only the coordinator leader forwards
   opportunities, preventing duplicate executions across multiple instances.

2. **Pre-Execution Filtering**: Coordinator can apply global filters:
   - Operational circuit breaker status
   - Global risk limits
   - Cross-instance deduplication

3. **Routing Decisions**: Coordinator can route to specific executors:
   - Chain-specific execution engines
   - Standby activation (ADR-007)
   - Load balancing across instances

4. **Audit Trail**: Centralized forwarding provides clear observability
   of which opportunities were approved for execution.

**Consumer Group Pattern**

The Execution Engine uses Redis consumer groups for reliable delivery:

```typescript
// Consumer group: execution-engine-group
// Each instance gets unique consumer name (instanceId)
// Guarantees: exactly-once delivery per opportunity
consumerGroup = {
  streamName: 'stream:execution-requests',
  groupName: 'execution-engine-group',
  consumerName: instanceId,  // e.g., 'exec-primary-1'
  startId: '$'  // Only new messages
};
```

**Deferred ACK Pattern**

Messages are ACKed only after execution completes to ensure reliability:

```
Message Received → Validate → Queue → Execute → ACK
       │              │          │        │       │
       │              │          │        │       └── Success: ACK
       │              │          │        └────────── Failure: ACK + DLQ
       │              │          └─────────────────── Queued: Defer ACK
       │              └────────────────────────────── Invalid: ACK + DLQ
       └───────────────────────────────────────────── Empty: ACK immediately
```

---

## 6. Scaling Strategy

### 6.1 Horizontal Scaling (Chains)

New chains are added by:
1. Adding chain config to registry
2. Assigning to appropriate partition (or creating new partition)
3. Deploying unified detector image with partition config

```typescript
// Chain assignment algorithm
function assignChainToPartition(chain: ChainConfig): number {
  // Group by block time similarity
  if (chain.blockTime < 1) return PARTITION_L2_FAST;      // Arbitrum, etc.
  if (chain.blockTime < 5) return PARTITION_ASIA_FAST;   // BSC, Polygon
  return PARTITION_HIGH_VALUE;                            // Ethereum, etc.
}
```

### 6.2 Vertical Scaling (DEXs/Tokens)

Within each partition, scale by:
1. Adding DEX factory addresses to discovery list
2. Adding tokens to watchlist
3. Dynamic pair discovery from factory events

### 6.3 Resource Scaling Projections

| Scale | Chains | DEXs | Tokens | Pairs | Events/sec | Redis Cmds/day |
|-------|--------|------|--------|-------|------------|----------------|
| Current | 5 | 10 | 23 | 50 | ~100 | ~3,000 |
| Phase 1 | 7 | 25 | 60 | 150 | ~300 | ~5,000 |
| Phase 2 | 9 | 45 | 110 | 350 | ~500 | ~7,000 |
| Phase 3 | 11 (10 EVM + Solana) | 54 | 143 | 500 | ~1000 | ~9,500 |

All phases remain within Upstash 10K/day limit due to batching.

**Solana Impact**:
- Adds ~200 events/sec due to fast block times
- 7 DEXs with 15 tokens = ~100 additional pairs
- Uses accountSubscribe (efficient WebSocket) to minimize RPC calls

---

## 7. Free Hosting Optimization

### 7.1 Provider Allocation

| Provider | Service | Region | Resources | Cost |
|----------|---------|--------|-----------|------|
| Oracle Cloud ARM | Partition 1, 3 | SG, US | 4 OCPU, 24GB | $0 |
| Oracle Cloud AMD | Cross-Chain Analyzer | US | 1 OCPU, 1GB | $0 |
| Fly.io | Partition 2 | Singapore | 512MB | $0 |
| Railway | Executor Primary | US-West | 512MB | $0 |
| Render | Executor Backup | US-East | 512MB | $0 |
| Koyeb | Coordinator | US-East | 256MB | $0 |
| GCP | Standby Coordinator | US-Central | 1GB | $0 |
| Upstash | Redis Streams + Cache | Global | 10K/day | $0 |
| Vercel | Dashboard | Edge | 100GB-hrs | $0 |

> **Note**: Original design included MongoDB Atlas for opportunity logging.
> Current implementation uses Redis-only architecture for simplicity.
> MongoDB may be added in future for analytics/ML training data persistence.

**Total: $0/month**

### 7.2 Rate Limit Strategies

**Upstash Redis (10K commands/day)**
- Batch ratio: 50 events → 1 command
- Effective capacity: 500K events/day
- Current usage: ~150K events/day (30%)

**RPC Endpoints (varies)**
- Multi-provider rotation (3+ providers per chain)
- Local response caching (30-second TTL)
- Request deduplication (enabled by default)
- Token bucket rate limiting (opt-in, see [ADR-024](./adr/ADR-024-rpc-rate-limiting.md))
- Batch size optimization (20 requests per batch)

### 7.3 Memory Optimization

| Component | Strategy | Memory Saved |
|-----------|----------|--------------|
| Price Data | Float64Array (not objects) | 60% |
| Event Buffer | Ring buffer (fixed size) | 80% |
| Cache | LRU eviction, TTL expiry | 40% |
| Logs | Sampling, rotation | 70% |
| Token Pair Normalization | LRU cache (10K entries) | 99% allocation reduction |
| Event Latencies | Float64Array ring buffer | Zero hot-path allocation |

### 7.4 Hot-Path Optimization (ADR-022)

The following optimizations ensure the detection hot-path maintains <50ms latency:

**Ring Buffer for Event Latencies**
- Pre-allocated Float64Array (1000 samples)
- O(1) write with zero memory allocation
- Eliminates ~8MB/sec memory churn under high load

**Normalization Cache for Token Pairs**
- LRU-style cache with 10K entry capacity
- >99% cache hit rate for active pairs
- Simple "clear-half" eviction strategy
- Eliminates ~400K string allocations/sec

**Nullish Coalescing for Numeric Values**
- Use `??` instead of `||` for values where 0 is valid
- Prevents incorrect fallback for zero-profit opportunities
- Applied consistently across execution strategies

See [ADR-022](./adr/ADR-022-hot-path-memory-optimization.md) for detailed rationale.

---

## 8. Performance Targets

### 8.1 Latency Budgets

| Operation | Target | Current | Optimization |
|-----------|--------|---------|--------------|
| WebSocket receive | <5ms | ~5ms | ✓ |
| Sync decode | <1ms | ~2ms | Pre-compiled ABI |
| Price matrix update | <1ms | ~10ms | Indexed structure |
| Arbitrage detection | <5ms | ~50ms | O(1) lookups |
| Redis publish | <10ms | ~20ms | Batching |
| **Total (same-chain)** | **<25ms** | **~90ms** | **-65ms** |

### 8.2 Reliability Targets

| Metric | Target | Strategy |
|--------|--------|----------|
| Uptime | 99.9% | Multi-region, failover |
| MTTR | <5 min | Self-healing, auto-restart |
| Data Loss | 0 | Redis Streams persistence |
| False Positives | <5% | Confidence scoring |

### 8.3 Profitability Targets

| Metric | Target | Strategy |
|--------|--------|----------|
| Opportunities/day | 500+ | Multi-chain, multi-DEX |
| Execution success | 85%+ | MEV protection, simulation |
| Avg profit/trade | 0.3%+ | Gas optimization |
| Win rate | 70%+ | Confidence thresholds |

---

## 9. Chain, DEX, and Token Selection

### 9.1 Recommended Chain Coverage (11 Chains)

| Tier | Chain | Priority | Arb Score | Partition | Phase |
|------|-------|----------|-----------|-----------|-------|
| T1 | **Arbitrum** | IMMEDIATE | 95 | P2: L2-Turbo | Current |
| T1 | **BSC** | IMMEDIATE | 92 | P1: Asia-Fast | Current |
| T1 | **Base** | IMMEDIATE | 88 | P2: L2-Turbo | Current |
| T1 | **Solana** | HIGH | 90 | P4: Solana | Phase 2 |
| T2 | **Polygon** | IMMEDIATE | 82 | P1: Asia-Fast | Current |
| T2 | **Optimism** | IMMEDIATE | 78 | P2: L2-Turbo | Phase 1 |
| T2 | **Avalanche** | PHASE 2 | 75 | P1: Asia-Fast | Phase 2 |
| T3 | **Ethereum** | SELECTIVE | 65 | P3: High-Value | Current |
| T3 | **Fantom** | PHASE 2 | 60 | P1: Asia-Fast | Phase 2 |
| T3 | **zkSync Era** | PHASE 3 | 55 | P3: High-Value | Phase 3 |
| T3 | **Linea** | PHASE 3 | 50 | P3: High-Value | Phase 3 |

**Why Solana is T1**:
- $1-2B+ daily DEX volume (top 3 globally)
- ~400ms block time enables faster execution
- Low fees (<$0.001) enable micro-arbitrage
- Unique ecosystem (memecoins, LSTs) not available on EVM

### 9.2 DEX Distribution (54 DEXs: 47 EVM + 7 Solana)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DEX COVERAGE BY CHAIN                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ARBITRUM (9 DEXs)          BSC (8 DEXs)              BASE (7 DEXs)             │
│  ├── Uniswap V3 [C]         ├── PancakeSwap V3 [C]    ├── Uniswap V3 [C]        │
│  ├── Camelot V3 [C]         ├── PancakeSwap V2 [C]    ├── Aerodrome [C]         │
│  ├── SushiSwap [C]          ├── Biswap [C]            ├── BaseSwap [C]          │
│  ├── GMX [H]                ├── THENA [H]             ├── SushiSwap [H]         │
│  ├── Trader Joe [H]         ├── ApeSwap [H]           ├── Maverick [H]          │
│  ├── Balancer [H]           ├── BabyDogeSwap [H]      ├── SwapBased [M]         │
│  ├── Zyberswap [M]          ├── Nomiswap [M]          └── Synthswap [M]         │
│  ├── WooFi [M]              └── KnightSwap [M]                                  │
│  └── Ramses [M]                                                                 │
│                                                                                  │
│  POLYGON (6 DEXs)           OPTIMISM (6 DEXs)         ETHEREUM (5 DEXs)         │
│  ├── Uniswap V3 [C]         ├── Uniswap V3 [C]        ├── Uniswap V3 [C]        │
│  ├── QuickSwap V3 [C]       ├── Velodrome [C]         ├── Uniswap V2 [C]        │
│  ├── SushiSwap [H]          ├── SushiSwap [H]         ├── SushiSwap [C]         │
│  ├── Balancer [H]           ├── Beethoven X [H]       ├── Curve [H]             │
│  ├── DFYN [M]               ├── Zipswap [M]           └── Balancer [H]          │
│  └── Apeswap [M]            └── Rubicon [M]                                     │
│                                                                                  │
│  AVALANCHE (6 DEXs)         FANTOM (4 DEXs)           zkSYNC (4 DEXs)           │
│  ├── Trader Joe V2 [C]      ├── SpookySwap [C]        ├── SyncSwap [C]          │
│  ├── Pangolin [C]           ├── Equalizer [C]         ├── Mute.io [C]           │
│  ├── SushiSwap [H]          ├── SpiritSwap [H]        ├── SpaceFi [H]           │
│  ├── GMX [H]                └── Beethoven X [M]       └── Velocore [M]          │
│  ├── Platypus [M]                                                               │
│  └── KyberSwap [M]                                                              │
│                                                                                  │
│  ═══════════════════════════════════════════════════════════════════════════    │
│  SOLANA (7 DEXs) - NON-EVM                                                      │
│  ├── Jupiter [C]            Main aggregator, routes through all DEXs            │
│  ├── Raydium AMM [C]        Largest AMM by volume                               │
│  ├── Raydium CLMM [C]       Concentrated liquidity pools                        │
│  ├── Orca Whirlpools [C]    Second largest, concentrated liquidity              │
│  ├── Meteora DLMM [H]       Dynamic liquidity market maker                      │
│  ├── Phoenix [H]            On-chain order book                                 │
│  └── Lifinity [M]           Proactive market maker                              │
│                                                                                  │
│  [C]=Critical [H]=High [M]=Medium                                               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 9.3 Token Strategy (143 Tokens, ~500 Pairs)

| Token Category | Count | Per Chain (EVM) | Solana | Example Tokens |
|----------------|-------|-----------------|--------|----------------|
| Native Wrapped | 11 | 1 | SOL | WETH, WBNB, WMATIC, WAVAX, SOL |
| Major Stables | 33 | 3 | 3 | USDT, USDC, DAI |
| Bridged BTC | 10 | 1 | - | WBTC |
| Protocol Tokens | 50 | 5 | - | UNI, AAVE, LINK, CRV, MKR, LDO |
| Chain Governance | 16 | 1-2 | JUP | ARB, OP, MATIC, AVAX, FTM, JUP |
| High-Volume | 35 | 3-5 | 11 | PEPE, SHIB, stETH, BONK, WIF |
| Solana-Native | 15 | - | 15 | RAY, ORCA, JTO, PYTH, mSOL, jitoSOL |

### 9.4 Implementation Phases

| Phase | Chains | DEXs | Tokens | Pairs | Timeline |
|-------|--------|------|--------|-------|----------|
| **Current** | 5 | 10 | 23 | ~50 | Now |
| **Phase 1** | 7 | 25 | 60 | ~150 | Week 1-2 |
| **Phase 2** | 9 + Solana | 52 | 125 | ~450 | Week 3-4 |
| **Phase 3** | 11 | 54 | 143 | ~500 | Week 5-6 |

---

## 10. Phase 1-3 Implementation Details (January 2026)

This section documents the major enhancements implemented in January 2026.

### 10.1 Transaction Simulation (Phase 1.1) ✅ COMPLETE

**Problem**: Transactions sent without simulation result in failed txs consuming gas.

**Solution**: Pre-flight simulation using multi-provider approach with chain-specific routing.

| Component | Purpose |
|-----------|---------|
| SimulationService | Orchestrates simulation with provider fallback and chain routing |
| TenderlyProvider | Primary EVM simulation via Tenderly API |
| AlchemyProvider | Fallback EVM simulation via Alchemy |
| HeliusSimulationProvider | Solana simulation via Helius API (NEW) |
| LocalSimulationProvider | Tertiary fallback using eth_call |
| SimulationMetricsCollector | Tracks success rates and latency |

#### Chain-Specific Simulation (Amendment: 2026-02-04)

SimulationService now routes requests based on chain:

| Chain Type | Primary Provider | Fallback | Monthly Budget |
|------------|------------------|----------|----------------|
| EVM (10 chains) | Tenderly | Alchemy → Local | 25K simulations |
| Solana | Helius API | Native RPC | 100K credits |

**Key Files**: `services/execution-engine/src/services/simulation/`

**Related ADR**: [ADR-016: Transaction Simulation](./adr/ADR-016-transaction-simulation.md)

### 10.2 MEV Protection Enhancement (Phase 1.2) ✅ COMPLETE

**Problem**: Limited MEV protection (Flashbots only), no Solana support.

**Solution**: Chain-aware MEV provider factory with Jito integration and risk analyzer.

| Chain Type | MEV Strategy | Provider |
|------------|--------------|----------|
| Ethereum | Flashbots bundles | FlashbotsProvider |
| Solana | Jito bundles | JitoProvider |
| L2 Rollups | Sequencer protection | L2SequencerProvider |
| BSC/Polygon | Private pools | StandardProvider |

**Key Files**: `shared/core/src/mev-protection/`

### 10.3 Execution Circuit Breaker (Phase 1.3) ✅ COMPLETE

**Problem**: Consecutive failures can drain capital during systemic issues.

**Solution**: Circuit breaker pattern (CLOSED → OPEN → HALF_OPEN → CLOSED).

**Configuration**: 5 failures threshold, 5 min cooldown, API controls.

**Key Files**: `services/execution-engine/src/services/circuit-breaker.ts`

### 10.4 Factory-Level Event Subscriptions (Phase 2.1) ✅ COMPLETE

**Problem**: 1000+ individual pair subscriptions overwhelm RPC rate limits.

**Solution**: Subscribe to ~25 factory contracts instead (40x reduction).

**Key Files**: `shared/config/src/dex-factories.ts`, `shared/core/src/factory-subscription.ts`

### 10.5 Predictive Cache Warming (Phase 2.2) ✅ COMPLETE

**Problem**: Cache misses on correlated pairs reduce detection speed.

**Solution**: Track correlations and pre-warm cache for related pairs.

**Key Files**: `shared/core/src/caching/correlation-analyzer.ts`

### 10.6 Flash Loan Integration (Phase 3.1) ✅ IMPLEMENTED

**Problem**: Capital lockup limits arbitrage capacity.

**Solution**: Dual-protocol flash loan support for optimal fee selection.

**Supported Protocols**:
1. **Aave V3** (0.09% fee)
   - Chains: Ethereum, Polygon, Arbitrum, Optimism, Base
   - Contract: `FlashLoanArbitrage.sol`
   - Largest liquidity pools

2. **PancakeSwap V3** (0% fee)
   - Chains: BSC, Ethereum (limited liquidity)
   - Contract: `PancakeSwapFlashArbitrage.sol`
   - Zero-cost flash loans when liquidity available

**Strategy Selection**: Automatically selects lowest-fee protocol with sufficient liquidity.

**Status**: Fully implemented, testnet deployment pending.

**Key Files**:
- `contracts/src/FlashLoanArbitrage.sol`
- `contracts/src/PancakeSwapFlashArbitrage.sol`
- `services/execution-engine/src/strategies/flash-loan.strategy.ts`
- `services/execution-engine/src/strategies/flash-loan-providers/`

### 10.7 Detector Pre-validation (Phase 4.1) ✅ NEW

**Problem**: Many detected opportunities fail during execution, wasting gas and execution engine resources.

**Solution**: Sample-based pre-validation at the detector level to filter out opportunities that would fail.

| Configuration | Default | Purpose |
|---------------|---------|---------|
| enabled | false | Master switch for pre-validation |
| sampleRate | 0.1 (10%) | Fraction of opportunities to validate |
| minProfitForValidation | $50 USD | Skip validation for small opportunities |
| maxLatencyMs | 100ms | Latency bound for validation |
| monthlyBudget | 2,500 | Simulation budget for pre-validation |
| preferredProvider | alchemy | Use free-tier provider to preserve Tenderly |

**Key Features**:
- Budget-limited: Monthly simulation limits prevent runaway costs
- Sample-based: Only validates a fraction to stay within rate limits
- Fail-open: On errors, allows opportunity through
- Metrics: Tracks success/failure rates for monitoring

**Key Files**: `services/cross-chain-detector/src/detector.ts`, `services/cross-chain-detector/src/types.ts`

**Related ADR**: [ADR-023: Detector Pre-validation](./adr/ADR-023-detector-prevalidation.md)

### 10.8 Strategy Simulation Enhancements (Phase 4.2) ✅ NEW

**Problem**: CrossChainStrategy only simulated sell-side; FlashLoanStrategy didn't validate simulated profit.

**Solution**: Enhanced pre-flight simulation across strategies.

| Strategy | Enhancement | Benefit |
|----------|-------------|---------|
| CrossChainStrategy | Buy-side simulation | Catch failures before bridge quote |
| FlashLoanStrategy | Profit validation from gas | Avoid unprofitable trades from gas spikes |

**Key Files**:
- `services/execution-engine/src/strategies/cross-chain.strategy.ts`
- `services/execution-engine/src/strategies/flash-loan.strategy.ts`

---

## 11. Feature Implementation Status (2026-01-25)

> **Full Evaluation Report**: [docs/reports/deepseek_evaluation_consolidated.md](../reports/deepseek_evaluation_consolidated.md)

### 11.1 Optimization Feature Status

A comprehensive evaluation against `docs/optimizations.md` and `docs/DETECTOR_OPTIMIZATION_ANALYSIS.md` revealed the following implementation status:

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| **Token Pair O(1) Index** | COMPLETE | `base-detector.ts:169-176` | `Map<string, Pair[]>` with normalized keys |
| **Dynamic Slippage** | COMPLETE | `cross-dex-triangular-arbitrage.ts` | Price impact + liquidity-aware |
| **Event Batching (5ms)** | COMPLETE | `event-batcher.ts:47` | Reduced from 25ms |
| **LRU O(1) Operations** | COMPLETE | `hierarchical-cache.ts:33-202` | LinkedHashMap pattern |
| **Chain-Specific Staleness** | COMPLETE | `websocket-manager.ts:29-62` | 5s/10s/15s per chain type |
| **Quadrilateral Detection** | COMPLETE | `cross-dex-triangular-arbitrage.ts:227` | 4-token path detection |
| **Price Momentum** | COMPLETE | `price-momentum.ts` | EMA, z-score, velocity |
| **ML Integration** | PARTIAL | `ml-prediction-manager.ts` | Model exists, needs training |
| **Gas Price Cache** | COMPLETE | `gas-price-cache.ts` | 60s refresh, per-chain |
| **L3 Cache Eviction** | COMPLETE | `hierarchical-cache.ts:267` | LRU eviction policy |
| **Multi-Leg (5-7 tokens)** | COMPLETE | `multi-leg-path-finder.ts` | DFS + worker threads |
| **Whale Detection** | COMPLETE | `whale-activity-tracker.ts` | Pattern detection, LRU |
| **Cross-Chain Multi-Hop** | NOT STARTED | - | Future phase |
| **MEV Protection** | 90% COMPLETE | `mev-protection/` | Jito pending |
| **Liquidity Depth** | COMPLETE | `liquidity-depth-analyzer.ts` | AMM simulation |

### 11.2 WASM Engine Clarification

> **Important**: The `docs/optimizations.md` document contains claims about a Rust/WebAssembly engine that is **NOT implemented**.

**Documentation Claim**:
```markdown
The core arbitrage math is implemented in Rust and compiled to WebAssembly (WASM)
- SIMD Instructions: Vectorized price calculations
- Memory Mapping: Direct access to SharedArrayBuffer from WASM
```

**Actual Implementation**:
- No Rust source code exists in the codebase
- No `.wasm` binaries are generated by the project
- Only a stub comment exists in `event-processor-worker.ts:26-27`:
  ```typescript
  // Use WebAssembly engine for arbitrage detection
  // For now, simulate with mock calculations
  ```

**Current Architecture**: The system uses optimized JavaScript/TypeScript with:
- `SharedArrayBuffer` for cross-worker memory sharing (L1 cache)
- `Float64Array` and `Int32Array` for efficient price storage
- Worker thread pool for CPU-intensive operations
- O(1) data structures throughout

**Performance Note**: JavaScript performance is adequate for current scale. WASM remains a future optimization option if detection latency becomes a bottleneck.

### 11.3 Remaining Optimization Work

| Priority | Item | Effort | Expected Impact |
|----------|------|--------|-----------------|
| **P1** | ML Model Training | Medium | +15-25% prediction accuracy (model persistence complete, see [ADR-025](./adr/ADR-025-ml-model-lifecycle.md)) |
| **P2** | Cross-Chain Multi-Hop | High | +50% ROI potential |
| **P3** | Jito Integration | Low | Solana MEV protection |
| **P4** | WASM Engine | Very High | 10-50x math speedup (optional) |

---

## 12. Related ADRs

The following Architecture Decision Records document key decisions:

### Core Architecture (ADR-001 to ADR-008)
- [ADR-001: Hybrid Architecture Pattern](./adr/ADR-001-hybrid-architecture.md)
- [ADR-002: Redis Streams over Pub/Sub](./adr/ADR-002-redis-streams.md)
- [ADR-003: Partitioned Chain Detectors](./adr/ADR-003-partitioned-detectors.md)
- [ADR-004: Smart Swap Event Filtering](./adr/ADR-004-swap-event-filtering.md)
- [ADR-005: Hierarchical Caching Strategy](./adr/ADR-005-hierarchical-cache.md)
- [ADR-006: Free Hosting Provider Selection](./adr/ADR-006-free-hosting.md)
- [ADR-007: Cross-Region Failover](./adr/ADR-007-failover-strategy.md)
- [ADR-008: Chain/DEX/Token Selection](./adr/ADR-008-chain-dex-token-selection.md)

### Testing & Operations (ADR-009, ADR-026)
- [ADR-009: Test Architecture](./adr/ADR-009-test-architecture.md)
- [ADR-026: Integration Test Consolidation](./adr/ADR-026-integration-test-consolidation.md)

### Connection & Performance (ADR-010 to ADR-013)
- [ADR-010: WebSocket Connection Resilience](./adr/ADR-010-websocket-resilience.md)
- [ADR-011: Tier 1 Performance Optimizations](./adr/ADR-011-tier1-optimizations.md)
- [ADR-012: Worker Thread Multi-Leg Path Finding](./adr/ADR-012-worker-thread-path-finding.md)
- [ADR-013: Dynamic Gas Price Cache](./adr/ADR-013-dynamic-gas-pricing.md)

### Code Architecture (ADR-014, ADR-015)
- [ADR-014: Modular Detector Components](./adr/ADR-014-modular-detector-components.md)
- [ADR-015: Pino Logger Migration](./adr/ADR-015-pino-logger-migration.md)

### Execution Reliability - Phase 1 (ADR-016 to ADR-018)
- [ADR-016: Transaction Simulation Integration](./adr/ADR-016-transaction-simulation.md)
- [ADR-017: MEV Protection Enhancement](./adr/ADR-017-mev-protection.md)
- [ADR-018: Execution Circuit Breaker](./adr/ADR-018-circuit-breaker.md)

### Detection & Capital - Phase 2-3 (ADR-019 to ADR-021)
- [ADR-019: Factory-Level Event Subscriptions](./adr/ADR-019-factory-subscriptions.md)
- [ADR-020: Flash Loan Integration](./adr/ADR-020-flash-loan.md)
- [ADR-021: Capital Risk Management](./adr/ADR-021-capital-risk-management.md)

### Performance Optimization - Phase 4 (ADR-022 to ADR-027)
- [ADR-022: Hot-Path Memory Optimization](./adr/ADR-022-hot-path-memory-optimization.md)
- [ADR-023: Detector Pre-validation](./adr/ADR-023-detector-prevalidation.md)
- [ADR-024: RPC Rate Limiting Strategy](./adr/ADR-024-rpc-rate-limiting.md)
- [ADR-025: ML Model Lifecycle Management](./adr/ADR-025-ml-model-lifecycle.md)
- [ADR-027: Nonce Pre-allocation Pool](./adr/ADR-027-nonce-preallocation-pool.md)

---

## Appendix: Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-XX-XX | Original | Initial microservices design |
| 2.0 | 2025-01-10 | Analysis Session | Hybrid architecture, scaling strategy, swap filtering |
| 2.1 | 2025-01-12 | Architecture Update | Added Solana as P4 partition, 11 chains, 62 DEXs, 165 tokens |
| 2.2 | 2026-01-24 | Phase 1-3 Update | Added simulation, MEV protection, circuit breaker, factory subscriptions, flash loans |
| 2.3 | 2026-01-25 | Optimization Evaluation | Added feature status table, WASM clarification, 13/15 optimizations confirmed complete |
| 2.4 | 2026-01-31 | Config Alignment | Corrected DEX count (62→54), token count (165→143) to match actual config |
| 2.5 | 2026-02-04 | Bug Hunt Fixes | Added ADR-022 (hot-path memory optimization), corrected data plane diagram (no MongoDB), documented ring buffer and normalization cache patterns |
| 2.6 | 2026-02-04 | RPC/ML ADRs | Added ADR-024 (RPC rate limiting), ADR-025 (ML model lifecycle) - documenting existing implementations from RPC_PREDICTION_OPTIMIZATION_RESEARCH.md |
| 2.7 | 2026-02-04 | Simulation Enhancements | Added Solana simulation (HeliusProvider), detector pre-validation (ADR-023), strategy simulation enhancements |
| 2.8 | 2026-02-04 | Documentation Update | Added Mempool Detector service (port 3007), completed ADR references (all 27 ADRs), updated service count to 9 |

---

*This document serves as the authoritative reference for the arbitrage system architecture. All implementation decisions should align with this design.*

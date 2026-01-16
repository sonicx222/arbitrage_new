# Architecture Design v2.0 - Professional Multi-Chain Arbitrage System

> **Document Version:** 2.1
> **Last Updated:** 2025-01-12
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

- Monitor **11 blockchains** (10 EVM + Solana) with **62 DEXs** and **165 tokens**
- Achieve **<50ms detection latency** for same-chain EVM arbitrage, **<100ms for Solana**
- Maintain **99.9% uptime** through geographic redundancy
- Operate at **$0/month infrastructure cost** using free hosting tiers
- Generate **profitable arbitrage opportunities** with MEV protection

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

| Metric | Target | Current | Gap |
|--------|--------|---------|-----|
| Chains Supported | 11 (10 EVM + Solana) | 5 | +6 |
| DEXs Monitored | 62 (55 EVM + 7 Solana) | 10 | +52 |
| Tokens Tracked | 165 | 23 | +142 |
| Detection Latency (EVM same-chain) | <50ms | ~150ms | -100ms |
| Detection Latency (Solana) | <100ms | N/A | New |
| Detection Latency (cross-chain) | <10s | ~30s | -20s |
| System Uptime | 99.9% | ~95% | +4.9% |
| Monthly Cost | $0 | $0 | ✓ |
| Daily Opportunities | 950+ | ~100 | +850 |

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
│  │  │ Upstash Redis   │  │ MongoDB Atlas   │  │ L1 Cache        │                │   │
│  │  │ Streams         │  │ Opportunity Log │  │ SharedArrayBuf  │                │   │
│  │  │ (Event Backbone)│  │ (Analytics)     │  │ (Per-Instance)  │                │   │
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
│  └── Chain Detector Partition 4 (Solana: Non-EVM, @solana/web3.js)              │
│                                                                                  │
│  LAYER 2: ANALYSIS                                                               │
│  ├── Cross-Chain Analyzer (Multi-chain opportunity detection)                   │
│  ├── ML Predictor (Price movement prediction)                                   │
│  ├── Volume Aggregator (Swap event intelligence)                                │
│  ├── Multi-Leg Path Finder (T3.11: 5-7 token cycle detection)                   │
│  ├── Whale Activity Tracker (T3.12: Pattern detection & signals)                │
│  └── Liquidity Depth Analyzer (T3.15: Slippage prediction)                      │
│                                                                                  │
│  LAYER 3: DECISION                                                               │
│  ├── Opportunity Scorer (Profit/risk evaluation)                                │
│  ├── MEV Analyzer (Bot detection, avoidance)                                    │
│  └── Execution Planner (Route optimization)                                     │
│                                                                                  │
│  LAYER 4: EXECUTION                                                              │
│  ├── Execution Engine Primary (MEV-protected trades)                            │
│  ├── Execution Engine Backup (Failover)                                         │
│  ├── Flash Loan Manager (Capital efficiency)                                    │
│  └── Solana Executor (Jito bundles, priority fees)                              │
│                                                                                  │
│  LAYER 5: COORDINATION                                                           │
│  ├── Global Coordinator (Health, leader election)                               │
│  ├── Self-Healing Manager (Auto-recovery)                                       │
│  └── Dashboard (Monitoring, analytics)                                          │
│                                                                                  │
│  SHARED INFRASTRUCTURE                                                           │
│  ├── Redis Streams (Event backbone)                                             │
│  ├── Hierarchical Cache (L1/L2/L3)                                              │
│  ├── Circuit Breaker Registry                                                   │
│  └── RPC Provider Pool (EVM + Solana)                                           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Chain Detector Partitions

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

### 4.2.1 Solana Partition Details (P4)

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

### 4.3 Event Processing Strategy

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

---

## 5. Data Flow

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
| `stream:opportunities` | Analyzers | Executor, Dashboard | ~10/min | 24 hours |
| `stream:whale-alerts` | Detectors | All | ~5/hour | 24 hours |
| `stream:volume-aggregates` | Detectors | Analyzer | ~20/min | 1 hour |
| `stream:health` | All | Coordinator | ~10/min | 1 hour |

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
| Phase 3 | 11 (10 EVM + Solana) | 62 | 165 | 600 | ~1000 | ~9,500 |

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
| Upstash | Redis Streams | Global | 10K/day | $0 |
| MongoDB Atlas | Opportunity Log | Global | 512MB | $0 |
| Vercel | Dashboard | Edge | 100GB-hrs | $0 |

**Total: $0/month**

### 7.2 Rate Limit Strategies

**Upstash Redis (10K commands/day)**
- Batch ratio: 50 events → 1 command
- Effective capacity: 500K events/day
- Current usage: ~150K events/day (30%)

**RPC Endpoints (varies)**
- Multi-provider rotation (3+ providers per chain)
- Local response caching (30-second TTL)
- Request deduplication

### 7.3 Memory Optimization

| Component | Strategy | Memory Saved |
|-----------|----------|--------------|
| Price Data | Float64Array (not objects) | 60% |
| Event Buffer | Ring buffer (fixed size) | 80% |
| Cache | LRU eviction, TTL expiry | 40% |
| Logs | Sampling, rotation | 70% |

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

### 9.2 DEX Distribution (62 DEXs: 55 EVM + 7 Solana)

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

### 9.3 Token Strategy (165 Tokens, 600 Pairs)

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
| **Phase 3** | 11 | 62 | 165 | ~600 | Week 5-6 |

---

## 10. Related ADRs

The following Architecture Decision Records document key decisions:

- [ADR-001: Hybrid Architecture Pattern](./adr/ADR-001-hybrid-architecture.md)
- [ADR-002: Redis Streams over Pub/Sub](./adr/ADR-002-redis-streams.md)
- [ADR-003: Partitioned Chain Detectors](./adr/ADR-003-partitioned-detectors.md)
- [ADR-004: Smart Swap Event Filtering](./adr/ADR-004-swap-event-filtering.md)
- [ADR-005: Hierarchical Caching Strategy](./adr/ADR-005-hierarchical-cache.md)
- [ADR-006: Free Hosting Provider Selection](./adr/ADR-006-free-hosting.md)
- [ADR-007: Cross-Region Failover](./adr/ADR-007-failover-strategy.md)
- [ADR-008: Chain/DEX/Token Selection](./adr/ADR-008-chain-dex-token-selection.md)

---

## Appendix: Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-XX-XX | Original | Initial microservices design |
| 2.0 | 2025-01-10 | Analysis Session | Hybrid architecture, scaling strategy, swap filtering |
| 2.1 | 2025-01-12 | Architecture Update | Added Solana as P4 partition, 11 chains, 62 DEXs, 165 tokens |

---

*This document serves as the authoritative reference for the arbitrage system architecture. All implementation decisions should align with this design.*

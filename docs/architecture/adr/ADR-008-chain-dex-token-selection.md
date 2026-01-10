# ADR-008: Chain, DEX, and Token Selection Strategy

## Status
**Accepted** | 2025-01-10

## Context

The system must select which blockchains, DEX exchanges, and tokens to monitor for professional competitive arbitrage trading. The selection directly impacts:

- **Opportunity volume**: More coverage = more opportunities
- **Competitive edge**: Undermonitored chains = less competition
- **Resource usage**: More monitoring = higher compute/Redis costs
- **Profitability**: Right selection = consistent profits

### Current State

| Metric | Current | Competitors | Gap |
|--------|---------|-------------|-----|
| Chains | 5 | 8-12 | -40% |
| DEXs | 10 | 40+ | -75% |
| Tokens | 23 | 100+ | -77% |
| Pairs | ~50 | ~500 | -90% |

### Key Questions

1. Which chains provide the best arbitrage opportunity/competition ratio?
2. Which DEXs must be monitored for competitive coverage?
3. Which tokens generate consistent arbitrage opportunities?
4. How to maximize coverage while staying within free hosting limits?

## Decision

### Chain Selection (10 Chains)

Prioritize chains by **Arbitrage Score** = (TVL × Volume × DEX_Count) / (Gas_Cost × Competition)

| Tier | Chain | Arb Score | Rationale | Priority |
|------|-------|-----------|-----------|----------|
| **T1** | Arbitrum | 95 | Highest DEX fragmentation, fast blocks, low gas | **IMMEDIATE** |
| **T1** | BSC | 92 | Highest volume, many copycat DEXs, Asia timezone | **IMMEDIATE** |
| **T1** | Base | 88 | Explosive growth, low competition, Coinbase ecosystem | **IMMEDIATE** |
| **T2** | Polygon | 82 | Very low gas, mature ecosystem | **IMMEDIATE** |
| **T2** | Optimism | 78 | OP incentives create inefficiencies | **IMMEDIATE** |
| **T2** | Avalanche | 75 | Fast finality, Asia-focused, undermonitored | **PHASE 2** |
| **T3** | Ethereum | 65 | Only large arbs ($500+), avoid MEV | **SELECTIVE** |
| **T3** | Fantom | 60 | Very low competition, small consistent opps | **PHASE 2** |
| **T3** | zkSync Era | 55 | Emerging, early mover advantage | **PHASE 3** |
| **T3** | Linea | 50 | New L2, low competition | **PHASE 3** |

### DEX Selection (55 DEXs)

Select DEXs by **liquidity depth** and **arbitrage path creation**:

#### Arbitrum (9 DEXs)
```
CRITICAL:  Uniswap V3, Camelot V3, SushiSwap
HIGH:      GMX, Trader Joe, Balancer
MEDIUM:    Zyberswap, WooFi, Ramses
```

#### BSC (8 DEXs)
```
CRITICAL:  PancakeSwap V3, PancakeSwap V2, Biswap
HIGH:      THENA, ApeSwap, BabyDogeSwap
MEDIUM:    Nomiswap, KnightSwap
```

#### Base (7 DEXs)
```
CRITICAL:  Uniswap V3, Aerodrome, BaseSwap
HIGH:      SushiSwap, Maverick
MEDIUM:    SwapBased, Synthswap
```

#### Polygon (6 DEXs)
```
CRITICAL:  Uniswap V3, QuickSwap V3
HIGH:      SushiSwap, Balancer
MEDIUM:    DFYN, Apeswap
```

#### Optimism (6 DEXs)
```
CRITICAL:  Uniswap V3, Velodrome
HIGH:      SushiSwap, Beethoven X
MEDIUM:    Zipswap, Rubicon
```

#### Avalanche (6 DEXs)
```
CRITICAL:  Trader Joe V2, Pangolin
HIGH:      SushiSwap, GMX
MEDIUM:    Platypus, KyberSwap
```

#### Ethereum (5 DEXs)
```
CRITICAL:  Uniswap V3, Uniswap V2, SushiSwap
HIGH:      Curve, Balancer
```

#### Fantom (4 DEXs)
```
CRITICAL:  SpookySwap, Equalizer
HIGH:      SpiritSwap
MEDIUM:    Beethoven X
```

#### zkSync Era (4 DEXs)
```
CRITICAL:  SyncSwap, Mute.io
HIGH:      SpaceFi
MEDIUM:    Velocore
```

### Token Selection (150 Tokens)

#### Token Tiers

**Tier 1: ANCHOR TOKENS (Must Have - 40 tokens)**
- Native wrapped tokens per chain (10)
- Major stablecoins (USDT, USDC, DAI) per chain (30)

**Tier 2: CORE DEFI (60 tokens)**
- WBTC on each chain
- Protocol tokens: UNI, AAVE, LINK, CRV, MKR, LDO, COMP
- Chain governance: ARB, OP, MATIC, AVAX, FTM

**Tier 3: HIGH-VOLUME (30 tokens)**
- Meme coins with >$10M daily volume: PEPE, SHIB, DOGE
- Bridge tokens: SYN, STG
- LST tokens: stETH, rETH, cbETH

**Tier 4: STRATEGIC (20 tokens)**
- New tokens with high volatility
- Cross-chain arbitrage candidates
- Tokens with uneven DEX distribution

#### High-Priority Pairs (500 pairs total)

| Pair Category | Count | Avg Opportunities/Day |
|---------------|-------|----------------------|
| Native/Stablecoin | 60 | 200+ |
| Stablecoin/Stablecoin | 40 | 100+ |
| WBTC pairs | 30 | 50+ |
| DeFi/Native | 100 | 150+ |
| Governance/Native | 50 | 80+ |
| Other | 220 | 200+ |
| **Total** | **500** | **780+** |

## Rationale

### Why These 10 Chains?

| Factor | Weight | Winners |
|--------|--------|---------|
| TVL (liquidity depth) | 25% | Arbitrum, BSC, Ethereum |
| Volume (activity) | 25% | BSC, Arbitrum, Base |
| Gas costs (profitability) | 20% | L2s, Polygon, Fantom |
| Competition (edge) | 15% | Base, Fantom, zkSync |
| DEX count (paths) | 15% | BSC, Arbitrum, Polygon |

### Why 55 DEXs?

- **Coverage vs Resources**: 55 DEXs provides 90% of opportunity volume
- **Diminishing returns**: After top 55, each DEX adds <0.5% opportunities
- **Resource efficiency**: Fits within 10K Redis commands/day

### Why 150 Tokens?

- **80/20 Rule**: Top 150 tokens capture 95% of arbitrage volume
- **Memory constraint**: 500 pairs fits in L1 price matrix (16KB)
- **Event rate**: ~800 events/sec manageable with batching

## Consequences

### Positive
- **10x opportunity increase**: 780+ opportunities/day vs ~100 current
- **Competitive coverage**: Matches top arbitrage bots
- **Low competition chains**: Fantom, zkSync provide edge
- **Free tier compatible**: All within resource limits

### Negative
- **Complexity**: 10 chains, 55 DEXs harder to maintain
- **Configuration**: 150 tokens require accurate addresses
- **Latency variance**: Different chains have different speeds

### Mitigations

1. **Complexity**: Automated config generation from on-chain data
2. **Configuration**: Token registry with validation
3. **Latency**: Partition by block time similarity

## Implementation Plan

### Phase 1 (Immediate - Week 1-2)
- Add: Optimism (6 DEXs, 15 tokens)
- Expand: Base (3 more DEXs, 10 tokens)
- Result: 7 chains, 25 DEXs, 60 tokens

### Phase 2 (Week 3-4)
- Add: Avalanche (6 DEXs, 15 tokens)
- Add: Fantom (4 DEXs, 10 tokens)
- Expand: All existing chains (+20 DEXs, +40 tokens)
- Result: 9 chains, 45 DEXs, 110 tokens

### Phase 3 (Week 5-6)
- Add: zkSync (4 DEXs, 10 tokens)
- Add: Linea (4 DEXs, 10 tokens)
- Expand: Token coverage (+30 tokens)
- Result: 10 chains, 55 DEXs, 150 tokens

## Resource Impact

| Metric | Current | Phase 1 | Phase 2 | Phase 3 |
|--------|---------|---------|---------|---------|
| Chains | 5 | 7 | 9 | 10 |
| DEXs | 10 | 25 | 45 | 55 |
| Tokens | 23 | 60 | 110 | 150 |
| Events/sec | ~100 | ~250 | ~500 | ~800 |
| Redis cmds/day | ~3K | ~5K | ~7K | ~8.5K |
| Oracle RAM | 8GB | 12GB | 16GB | 18GB |

All phases remain within free tier limits.

## Alternatives Considered

### Alternative 1: Focus on Ethereum Only
- **Rejected**: High gas makes small arbs unprofitable, extreme MEV competition
- **Would reconsider if**: Gas drops below $1 consistently

### Alternative 2: Maximum Coverage (20+ chains)
- **Rejected**: Exceeds free tier resources, diminishing returns
- **Would reconsider if**: Paid infrastructure acceptable

### Alternative 3: Only Top 3 Chains
- **Rejected**: Misses low-competition opportunities on emerging chains
- **Would reconsider if**: Resource constraints become critical

## References

- [DeFiLlama Chain TVL](https://defillama.com/chains)
- [DEX Screener](https://dexscreener.com)
- [L2Beat](https://l2beat.com)
- [ADR-003: Partitioned Detectors](./ADR-003-partitioned-detectors.md)
- [ADR-006: Free Hosting](./ADR-006-free-hosting.md)

## Confidence Level

**92%** - Very high confidence based on:
- Data-driven selection using TVL, volume, gas metrics
- Clear resource math showing free tier compatibility
- Phased rollout reduces risk
- Covers 90%+ of available arbitrage opportunity volume

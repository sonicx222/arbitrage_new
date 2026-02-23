# Arbitrage Strategies & Token Selection

> **Last Updated:** 2026-02-05
> **Related ADRs:** [ADR-008](architecture/adr/ADR-008.md) (Chain/DEX/Token Selection), [ADR-021](architecture/adr/ADR-021.md) (Capital Risk Management)

This document outlines the trading strategies and selection methodologies used to maximize profitability while minimizing risk.

---

## Table of Contents

1. [Core Arbitrage Strategies](#core-arbitrage-strategies)
2. [Whale Activity Detection](#whale-activity-detection)
3. [Liquidity Depth Analysis](#liquidity-depth-analysis)
4. [Token Selection Methodology](#token-selection-methodology)
5. [Predictive Opportunity Detection](#predictive-opportunity-detection)
6. [Risk Management](#risk-management)

---

## Core Arbitrage Strategies

### 1. Cross-DEX Arbitrage

Detecting price discrepancies for the same token pair across different Decentralized Exchanges (e.g., PancakeSwap vs. BiSwap on BSC).

- **Execution**: Instant swap on DEX A, sell on DEX B
- **Key Metric**: Net profit after gas and slippage
- **Module**: `services/unified-detector/src/detection/simple-arbitrage.ts`, wired via `services/unified-detector/src/chain-instance.ts`

### 2. Triangular Arbitrage

Exploiting price imbalances between three different assets on the same exchange (e.g., WBNB → BUSD → CAKE → WBNB).

- **Benefit**: No cross-exchange latency, single transaction execution
- **Complexity**: High mathematical search space (O(n³))
- **Module**: `shared/core/src/cross-dex-triangular-arbitrage.ts`

### 3. Cross-Chain Arbitrage

Identifying opportunities between assets on different blockchains (e.g., Ethereum vs. Arbitrum).

- **Risk**: Bridge latency and security
- **Optimization**: Uses ML to predict bridge confirmation times and cost fluctuations
- **Module**: `services/cross-chain-detector/`

### 4. Quadrilateral Arbitrage

Four-token cyclic paths exploiting price imbalances across DEXs (e.g., WETH → USDT → WBTC → DAI → WETH).

- **Benefit**: Captures 20-40% more opportunities than triangular alone
- **Complexity**: O(n⁴) search space, optimized with token pair indexing
- **Related**: [ADR-011](architecture/adr/ADR-011.md) (O(1) token pair indexing)

### 5. Multi-Leg Path Finding

Discovery of 5-7 token arbitrage cycles using depth-first search with pruning.

- **Algorithm**: DFS with liquidity-based candidate prioritization
- **Features**:
  - Dynamic slippage based on pool reserves
  - ExecutionContext for concurrent safety
  - Configurable timeout and profit thresholds
- **Module**: `shared/core/src/multi-leg-path-finder.ts`
- **Related**: [ADR-012](architecture/adr/ADR-012.md) (Worker Thread Path Finding)

---

## Whale Activity Detection

Professional-grade whale tracking for early opportunity detection.

### Wallet Pattern Analysis

| Pattern | Definition | Signal |
|---------|------------|--------|
| **Accumulator** | >70% buy transactions | Follow (bullish) |
| **Distributor** | >70% sell transactions | Fade (bearish) |
| **Swing Trader** | 30-70% buy/sell ratio | Monitor |
| **Arbitrageur** | <60s average between trades | Compete |

### Signal Generation

- **Follow**: Trade in same direction as whale with established pattern
- **Front-run**: Position before anticipated large trade (MEV-protected)
- **Fade**: Counter-trade when pattern breaks (e.g., accumulator starts selling)

### Confidence Scoring

| Factor | Score Impact |
|--------|--------------|
| Base confidence (pattern consistency) | 0.5 - 0.7 |
| Super whale bonus (>$500K) | +0.15 |
| Historical accuracy | ±0.10 |

**Module**: `shared/core/src/whale-activity-tracker.ts`

---

## Liquidity Depth Analysis

AMM pool depth analysis for optimal trade execution.

### Depth Simulation

Simulates order book depth using constant product formula (x * y = k):

- Multiple price levels from $1K to $1M trade sizes
- Slippage prediction at each level
- Price impact calculation

### Key Metrics

| Metric | Description |
|--------|-------------|
| **Optimal Trade Size** | Knee of slippage curve where marginal cost equals gain |
| **Max Size 1% Slippage** | Largest trade with <1% slippage |
| **Max Size 5% Slippage** | Largest trade with <5% slippage |
| **Liquidity Score** | 0-1 based on depth, symmetry, and fees |

### Best Pool Selection

Automatically finds the pool with lowest slippage for a given trade:

- Compares all pools with matching token pairs
- Returns pool address and expected slippage
- Considers DEX-specific fee tiers

**Module**: `shared/core/src/liquidity-depth-analyzer.ts`

---

## Token Selection Methodology

The system focuses on high-liquidity pairings to ensure minimal slippage.

### Supported Chains (11 Total)

| Partition | Chains | Block Time | Rationale |
|-----------|--------|------------|-----------|
| **P1: Asia-Fast** | BSC, Polygon, Avalanche, Fantom | 2-3s | High throughput, low gas |
| **P2: L2-Turbo** | Arbitrum, Optimism, Base | 250ms-2s | Sub-second confirmations |
| **P3: High-Value** | Ethereum, zkSync, Linea | 12s / 1s | High-value, reliable |
| **P4: Solana** | Solana | 400ms | Non-EVM, parallel processing |

### Asset Tiers

| Tier | Examples | Characteristics |
|------|----------|-----------------|
| **Tier 1 (Core)** | WETH, WBNB, USDT, USDC | Highest liquidity, base pairs |
| **Tier 2 (Ecosystem)** | CAKE, ARB, OP, GMX | High volatility, consistent opportunities |
| **Tier 3 (Emerging)** | Top 200 by volume | Selected based on liquidity score |

### DEX Coverage (49 DEXs)

- **Uniswap V2/V3 forks**: 60% of coverage
- **Native DEXs**: Raydium (Solana), Camelot (Arbitrum), etc.
- **Aggregators**: 1inch integration for best execution

**Related**: [ADR-008](architecture/adr/ADR-008.md) (Chain/DEX/Token Selection Strategy)

---

## Predictive Opportunity Detection

Beyond reactive monitoring, the system employs ML models to predict price movements.

### ML-Driven Analysis

| Model | Purpose | Accuracy |
|-------|---------|----------|
| **LSTM** | Trend prediction (500ms horizon) | 70%+ |
| **Whale Shadow** | Slippage impact prediction | 65%+ |
| **Markov Chain** | Recurring pattern identification | 60%+ |

### Model Lifecycle

- **Persistence**: Models saved to disk with versioning
- **Lazy Loading**: Models loaded on-demand with caching
- **Retraining**: Automated pipeline triggered by performance degradation

**Related**: [ADR-025](architecture/adr/ADR-025.md) (ML Model Lifecycle Management)

---

## Risk Management

### Position Sizing (Kelly Criterion)

```
Optimal Position = (Edge × Odds - (1 - Edge)) / Odds
```

Where:
- **Edge**: Probability of profit (from ML confidence)
- **Odds**: Profit/Loss ratio (from simulation)

### Protection Mechanisms

| Mechanism | Trigger | Action |
|-----------|---------|--------|
| **Daily Loss Limit** | Losses > 5% of capital | Halt trading (1h cooldown + manual reset + recovery) |
| **Consecutive Failures** | 5 failed txns in row | Circuit breaker escalation (CAUTION → HALT) |
| **Max Exposure** | Single trade > 2% capital | Reject opportunity |
| **Slippage Guard** | Slippage > 2% | Reject or reduce size |

### Expected Value Filter

Only execute opportunities where:

```
Expected Value = (P(success) × Profit) - (P(failure) × Loss) - Gas Cost > Minimum Threshold
```

**Related**: [ADR-021](architecture/adr/ADR-021.md) (Capital Risk Management)

---

## Related Documentation

- [Architecture Overview](architecture/ARCHITECTURE_V2.md)
- [Current System State](architecture/CURRENT_STATE.md)
- [Flash Loan Integration](architecture/adr/ADR-020.md)
- [MEV Protection](architecture/adr/ADR-017.md)

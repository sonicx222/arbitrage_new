# Arbitrage Strategies & Token Selection

This document outlines the trading strategies and selection methodologies used to maximize profitability while minimizing risk.

## 🎯 Core Arbitrage Strategies

### 1. Cross-DEX Arbitrage
Detecting price discrepancies for the same token pair across different Decentralized Exchanges (e.g., PancakeSwap vs. BiSwap on BSC).
- **Execution**: Instant swap on Dex A, sell on Dex B.
- **Key Metric**: Net profit after gas and slippage.

### 2. Triangular Arbitrage
Exploiting price imbalances between three different assets on the same exchange (e.g., WBNB -> BUSD -> CAKE -> WBNB).
- **Benefit**: No cross-exchange latency, single transaction execution.
- **Complexity**: High mathematical search space (O(n^3)).

### 3. Cross-Chain Arbitrage
Identifying opportunities between assets on different blockchains (e.g., Ethereum vs. Arbitrum).
- **Risk**: Bridge latency and security.
- **Optimization**: Uses ML to predict bridge confirmation times and cost fluctuations.

### 4. Quadrilateral Arbitrage (T2.6)
Four-token cyclic paths exploiting price imbalances across DEXs (e.g., WETH -> USDT -> WBTC -> DAI -> WETH).
- **Benefit**: Captures 20-40% more opportunities than triangular alone.
- **Complexity**: O(n^4) search space, optimized with token pair indexing.

### 5. Multi-Leg Path Finding (T3.11)
Discovery of 5-7 token arbitrage cycles using depth-first search with pruning.
- **Algorithm**: DFS with liquidity-based candidate prioritization.
- **Features**:
  - Dynamic slippage based on pool reserves
  - ExecutionContext for concurrent safety
  - Configurable timeout and profit thresholds
- **Module**: `shared/core/src/multi-leg-path-finder.ts`

---

## Whale Activity Detection (T3.12)

Professional-grade whale tracking for early opportunity detection.

### Wallet Pattern Analysis
- **Accumulator**: Wallets consistently buying (>70% buy transactions)
- **Distributor**: Wallets consistently selling (>70% sell transactions)
- **Swing Trader**: Mixed buy/sell activity (30-70% ratio)
- **Arbitrageur**: Rapid buy/sell cycles (<60s average time between trades)

### Signal Generation
- **Follow**: Trade in same direction as whale with established pattern
- **Front-run**: Position before anticipated large trade
- **Fade**: Counter-trade when pattern breaks (e.g., accumulator starts selling)

### Confidence Scoring
- Base confidence from pattern consistency (0.5-0.7)
- Super whale bonus (+0.15 for trades >$500K)
- Historical accuracy adjustment based on past performance

**Module**: `shared/core/src/whale-activity-tracker.ts`

---

## Liquidity Depth Analysis (T3.15)

AMM pool depth analysis for optimal trade execution.

### Depth Simulation
Simulates order book depth using constant product formula (x * y = k):
- Multiple price levels from $1K to $1M trade sizes
- Slippage prediction at each level
- Price impact calculation

### Key Metrics
| Metric | Description |
|--------|-------------|
| Optimal Trade Size | Knee of slippage curve where marginal cost equals gain |
| Max Size 1% Slippage | Largest trade with <1% slippage |
| Max Size 5% Slippage | Largest trade with <5% slippage |
| Liquidity Score | 0-1 based on depth, symmetry, and fees |

### Best Pool Selection
Automatically finds the pool with lowest slippage for a given trade:
- Compares all pools with matching token pairs
- Returns pool address and expected slippage

**Module**: `shared/core/src/liquidity-depth-analyzer.ts`

---

## 💎 Token Selection Methodology

The system focuses on high-liquidity pairings to ensure minimal slippage.

### Priority Chains
1. **BSC**: High opportunity volume, low gas.
2. **Arbitrum**: Ultra-fast block times (250ms).
3. **Polygon**: Broad asset coverage.

### Asset Tiers
- **Tier 1 (Core)**: WBNB, ETH, BUSD, USDT, USDC. (Highest liquidity, base pairs).
- **Tier 2 (Ecosystem)**: CAKE, MATIC, ARB, GMX. (High volatility, consistent opportunities).
- **Tier 3 (Emerging)**: Selected top 200 tokens by volume.

---

## 🤖 Predictive Opportunity Detection

Beyond reactive monitoring, the system employs **LSTM (Long Short-Term Memory)** models to predict price movements.

### ML-Driven Analysis
- **Trend Prediction**: 70%+ accuracy in predicting price direction in the next 500ms.
- **Whale Tracking**: Monitoring large transaction "shadows" to predict slippage impacts.
- **Markov Chains**: Analyzing transaction sequences to identify recurring profitable patterns.

### Risk Management
- **Kelly Criterion**: Dynamic position sizing based on detection confidence.
- **Drawdown Protection**: Automatic system pause if a threshold of losses is reached within a 24-hour window.
- **Slippage Safeguards**: Real-time calculation of optimal trade size vs. pool depth.

# Consolidated Research Evaluation: BTC/USDT Scalping Strategy Program

> **Date**: 2026-02-18
> **Scope**: Cross-document analysis of all research produced to date
> **Documents Evaluated**:
> 1. `SENTIMENT_MACRO_REGIME_FRAMEWORK.md` — Regime classification & sentiment methodology (Agent 3)
> 2. `btc_usdt_scalping_strategy_report.md` — Orderflow-VP Mean Reversion Scalper (8-agent team, **CONDITIONAL**)
> 3. `BTC_USDT_CONFLUENCE_SCALPER_REPORT.md` — Multi-Signal Confluence Scalper v1.0 (8-agent team, **FRAGILE**)

---

## 1. Meta-Assessment: What This Research Actually Produced

### What Exists

Three documents totaling ~2,500 lines of analysis, covering:
- A regime classification framework with two complementary taxonomies
- Two complete strategy designs with Pine Script implementations
- A comprehensive sentiment/macro/alt-data signal library
- Detailed data source inventory (all free tier)
- Adversarial reviews that caught real problems
- Statistical validation frameworks (code provided, not executed)

### What Does Not Exist

- **Zero backtested results.** Every performance number is `[ESTIMATED]` or `[THEORETICAL]`.
- **Zero live data verification.** Network restrictions prevented all API calls. Regime classifications are `[UNVERIFIED]`.
- **Zero trades taken.** No paper trades, no live trades, no forward-tested data points.
- **Zero Python Tier 2 validation runs.** The statistical pipeline exists as code but has never been executed.

This distinction matters. The research quality is high — the methodology is rigorous, the adversarial process caught genuine problems, and the framework is professionally structured. But the output is a well-designed hypothesis, not a validated strategy. Treating it as the latter would be the most dangerous mistake possible.

---

## 2. Cross-Document Concordance (Where All Three Agree)

These findings are strengthened by independent convergence across documents:

### 2.1. Core Edge Thesis

All documents converge on the same behavioral mechanism:

> Retail traders systematically overreact at volume profile levels. Institutional/passive liquidity absorbs these overreactions, creating predictable mean-reversion setups detectable via CVD divergence and volume confirmation.

- **Edge type**: Behavioral
- **Counterparty**: Retail traders without orderflow literacy
- **Persistence mechanism**: Continuous influx of new retail participants
- **Decay risk**: Institutional HFT firms (Citadel, Jane Street, Virtu) are entering crypto with sub-millisecond execution — this compresses the exploitable window

**Assessment**: The thesis is sound and well-reasoned. Two independent 8-agent research runs arrived at the same conclusion, which is meaningful. However, the thesis remains unvalidated by data.

### 2.2. Funding Rate as Primary Sentiment Signal

All documents identify funding rate as the single most actionable sentiment indicator for BTC scalping:

- **Doc 1**: Provides the most detailed threshold table (6 tiers from +0.005% to >0.1%) with pseudocode for a directional filter
- **Doc 2**: Uses funding as a binary filter (skip longs >0.05%, skip shorts <-0.03%)
- **Doc 3**: Uses funding as a confluence penalty (-1 point at >0.03%) and hard block (|funding| > 0.10%)

**Consolidated position**: Doc 1's graduated threshold approach is superior to the binary filters in Docs 2/3. The funding rate filter should be tiered, not on/off.

### 2.3. Liquidation Cascade Fading

All documents identify post-liquidation cascade mean-reversion as a high-probability setup:

- **Doc 1**: 60-65% win rate, 1:1.5 to 1:2 R:R, detailed entry mechanics
- **Doc 2**: Included as "Liquidity Sweep Fade" in setup table
- **Doc 3**: S2 (Liquidity Sweep + Reclaim), 58-63% WR estimated

**Assessment**: This is the most agreed-upon specific trade setup. The 60-65% WR claim is `[ESTIMATED]` based on professional benchmarks but has not been backtested in this research.

### 2.4. CVD Proxy Limitation

All documents acknowledge that Pine Script's candle-level CVD approximation (`close > open ? volume : -volume`) is materially inferior to true tick-level CVD:

- **Doc 2**: "For live trading, use Bookmap, Exocharts, or ATAS"
- **Doc 3**: "Estimated 2-5% win rate inflation from approximation"
- **Doc 1**: Recommends WebSocket-based real-time CVD from Binance aggTrade stream

**Consolidated position**: Any Pine Script backtest using this CVD proxy will overstate performance. The 2-5% WR inflation estimate from Doc 3's Agent 6 is credible. Python-based backtesting with real trade data is mandatory before drawing conclusions.

### 2.5. Data Source Convergence

All documents converge on the same free-tier data stack:

| Need | Source | Cost |
|------|--------|------|
| Price/OI/Funding/Liquidations/Depth | Binance API | Free |
| Liquidation heatmap, aggregated funding | CoinGlass | Free |
| Fear & Greed | alternative.me | Free |
| Options data, IV, max pain | Deribit API | Free |
| TVL/DeFi | DefiLlama | Free |
| Economic calendar | ForexFactory | Free |
| Token unlocks | TokenUnlocks | Free |

**Total essential cost: $0/month.** This is a genuine strength — the infrastructure barrier to entry is zero.

### 2.6. Execution Reality Discount

All documents apply a scalping discount of 20-40% to backtested results:

- **Doc 2**: Uses 30% midpoint, arrives at 12% annualized expected
- **Doc 3**: Uses 35%, arrives at 36-84% (but this is pre-Agent-6-invalidation)
- **Doc 1**: Cites the same 20-40% range from the research command

**Assessment**: The 20-40% discount for high-frequency scalping is a reasonable professional benchmark. Doc 2's application is more honest.

### 2.7. Psychological Difficulty

Both strategy reports rate the psychological difficulty at **4/5**:

- Screen time: 3-5 hours/day (Doc 2), 13.5-29.5 hours/month (Doc 3)
- Emotional challenge: Thin per-trade edges mean frequent losing streaks
- Both recommend semi-automation or full automation
- Doc 3's Agent 6 explicitly states "any experience level is unrealistic and potentially irresponsible"

**Consolidated position**: This is NOT a beginner strategy. Minimum operator profile: 2+ years Python, 6+ months active crypto trading, API/server administration familiarity.

---

## 3. Cross-Document Conflicts and Resolutions

### 3.1. Regime Classification: Two Incompatible Taxonomies

**Conflict**:

| Document | Taxonomy | Time Horizon | Inputs |
|----------|----------|-------------|--------|
| Doc 1 | Risk-On / Risk-Off / Accumulation / Distribution / Capitulation | Daily/Weekly | EMA trend, funding, OI, DXY, F&G |
| Doc 3 | Trending / Range-Bound / High Vol Event / Low Vol Compression / Post-Liquidation | 5-minute | ATR ratio, ADX, liquidation volume |

Doc 2 references Doc 1's macro regime ("Post-Liquidation / Early Accumulation") but uses Doc 3-style micro weights for strategy execution.

**Resolution**: These are not competing — they are complementary layers that were never properly integrated:

```
HIERARCHICAL REGIME MODEL:

Layer 1 (Macro — Doc 1):   Session-level bias, capital allocation, no-trade decisions
                            Update: start of session + every 1-2 hours
                            Input: daily EMA, funding 7d avg, OI trend, DXY, F&G

Layer 2 (Micro — Doc 3):   Intra-session strategy weight selection, position sizing
                            Update: every 3 consecutive 5-min candles (confirmation window)
                            Input: 5-min ATR ratio, ADX, recent liquidations
```

**Action required**: Build a unified regime engine that feeds Layer 1 into Layer 2. For example: if Layer 1 = "Risk-Off" AND Layer 2 = "Trending", apply trending weights but with 50% position size reduction. If Layer 1 = "Capitulation" AND Layer 2 = "Post-Liquidation", activate cascade fade at full size.

### 3.2. Capital Assumptions: $10K vs $50K

**Conflict**:

| Document | Capital | Risk/Trade | Daily Loss Limit | Max DD |
|----------|---------|-----------|-----------------|--------|
| Doc 1 | $10K | $50-$100 (0.5-1%) | $300 (3%) | $1,500 (15%) |
| Doc 2 | $50K | $250 (0.5%) | $1,000 (2%) | Not specified explicitly |
| Doc 3 | $10K | $50-$150 (0.5-1.5%) | $300 (3%) | $1,500 (15%) |

**Resolution**: The capital assumption must be standardized. The original research target (Doc 1) specifies "$5K-$15K capital" — this is the user's stated context. Doc 2's $50K appears to be a different hypothetical.

**Recommended standardization**:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Starting capital | $10,000 | Midpoint of $5K-$15K user range |
| Risk per trade | 0.5% ($50) | Quarter-Kelly, conservative for scalping |
| Daily loss limit | 2% ($200) | ~4 full-stop losses; tighter than Doc 1/3's 3% |
| Weekly pause threshold | 4% ($400) | Two max-daily-loss days |
| Max drawdown (hard stop) | 15% ($1,500) | Return to paper trading |
| Max concurrent positions | 1 | Sequential scalping, no correlation risk |

**Critical note**: At $10K capital with $50 risk per trade and $200 daily limit, the strategy can only tolerate ~4 full-stop losses per day. This is tight but appropriate for an unvalidated strategy entering paper trading.

### 3.3. Parameter Count: 7 vs 88+

**Conflict**: Doc 2 uses 7 core parameters. Doc 3 uses 88+.

This is not a genuine conflict — it is a clear failure in Doc 3. The research command explicitly states "FLAG any strategy with >5 optimizable parameters as high curve-fitting risk" and the Complexity Gate specifies "13+ REJECT." Doc 3 violates its own framework's rules.

**Resolution**: Doc 2's 7-parameter approach is correct. Doc 3's Agent 6 already resolved this by recommending simplification to 3 strategies (~30-35 parameters), which is still above the ideal but within the "9-12 high risk, justify each" tier.

The recommended path: Start with Doc 2's 7-parameter core, add the Funding Settlement Fade (S7 from Doc 3) as a single additional sub-strategy, keeping total parameters under 12.

### 3.4. Performance Expectations: 12% vs 36-84% Annualized

**Conflict**: Doc 2 estimates 12% annualized after discount. Doc 3 estimates 36-84%.

**Resolution**: Doc 3's estimate is not credible. Its own adversarial reviewer identified 5 fatal flaws and assigned a FRAGILE verdict. The 36-84% range implies raw backtested returns of 55-129%, which would require Sharpe >3.0 — a number Doc 2's Agent 5 explicitly flags as "almost certainly overfit."

Doc 2's 12% estimate (40% raw × 30% discount) is more realistic but still unvalidated. The honest expected range for a well-executed mean-reversion scalper on BTC, accounting for execution reality:

| Scenario | Expected Annual Return | Probability |
|----------|----------------------|-------------|
| Strategy fails validation | 0% (no deployment) | 30-40% |
| Works but thin edge | 5-10% after costs | 25-35% |
| Works as designed | 10-20% after costs | 15-25% |
| Outperforms expectations | >20% | <10% |

This is a more honest distribution than either document provides.

### 3.5. Architecture: TradingView + Webhooks vs Python-Only

**Conflict**:

| Document | Architecture |
|----------|-------------|
| Doc 2 | Pine Script for screening → manual + webhook execution |
| Doc 3 | Pine Script + webhook → Python bot receiver |
| Doc 3 Agent 6 | Eliminate TradingView entirely, build single-tier Python |

**Resolution**: Doc 3's Agent 6 is correct. The webhook architecture introduces:
- Uncontrolled latency variance (500ms+)
- No guaranteed delivery
- $25/month TradingView Pro cost for alerts
- Dependency on an external service for time-critical execution

A direct Python implementation using Binance WebSocket for data + REST API for execution reduces latency to 50-100ms, eliminates webhook reliability concerns, and costs $0/month.

**Recommended architecture**:
```
Binance WebSocket (aggTrade, depth, forceOrder, markPrice)
        ↓
Python regime classifier + signal generator
        ↓
Binance REST API (orders with exchange-resident stop losses)
        ↓
Local logging + monitoring dashboard
```

TradingView remains useful for visual analysis and chart review but should NOT be in the execution path.

---

## 4. Consolidated Edge Assessment

### What the Research Supports (with caveats)

| Finding | Confidence | Supporting Evidence | Key Caveat |
|---------|-----------|-------------------|------------|
| Behavioral edge at VP levels exists | **MEDIUM (70%)** | Two independent analyses converge; sound mechanism | Unquantified; may be too small to survive fees |
| Funding rate is the best sentiment filter | **HIGH (85%)** | All 3 documents agree; clear threshold mechanics | Thresholds are from professional benchmarks, not this research's data |
| Liquidation cascade fading has positive expectancy | **MEDIUM (70%)** | Well-documented in professional literature; sound mechanics | 60-65% WR is `[ESTIMATED]`, not backtested |
| Mean-reversion works better in ranging regimes | **HIGH (85%)** | Consistent with financial theory and all 3 documents | Regime identification itself is unvalidated |
| Fee drag is the primary risk | **HIGH (90%)** | Math is straightforward; 10+ trades/day × 0.04-0.06% is 0.4-0.6% daily drag | Can be mitigated with maker orders (0.02%) |
| Strategy underperforms buy-and-hold in bull markets | **HIGH (90%)** | Mean-reversion strategies inherently underperform strong trends | This is a feature (lower DD), not a bug, IF the edge is real |

### What the Research Does NOT Support

| Claim | Status | Why |
|-------|--------|-----|
| Strategy is profitable | **UNVALIDATED** | Zero backtests completed |
| 12% expected annualized return | **UNVALIDATED** | Based entirely on professional benchmarks, not this strategy's data |
| Win rate of 52-65% | **UNVALIDATED** | Estimated from strategy type, not measured |
| Strategy beats benchmarks | **UNVALIDATED** | Benchmark comparison table uses `[ESTIMATED]` values throughout |
| Edge persists 12-24 months | **SPECULATIVE** | Based on behavioral edge literature, not crypto-specific evidence |
| Regime classifier accurately identifies regimes | **UNVALIDATED** | No live data has been fed through the system |

---

## 5. Unified Strategy Recommendation

### Target Strategy: "Orderflow-VP Scalper v2.0"

Based on the convergence across all three documents and the adversarial reviews, the recommended strategy combines:

| Component | Source | Rationale |
|-----------|--------|-----------|
| Core mean-reversion engine | Doc 2 | CONDITIONAL verdict, 7 params, sound design |
| Funding settlement fade | Doc 3 (S7) | Longest half-life (24-36 months), lowest crowding risk |
| Liquidity sweep fade | Doc 2 + Doc 3 (S2) | Highest-probability setup across both reports |
| Macro regime overlay | Doc 1 | Session-level bias and capital allocation |
| Micro regime weights | Doc 3 | Intra-session strategy activation/weight adjustment |
| Funding rate filter | Doc 1 | Most detailed graduated threshold approach |
| Risk management | Doc 2 (modified) | Standardized to $10K capital |
| Architecture | Doc 3 Agent 6 | Python-only, direct Binance API |

### Estimated Parameters: ~10-12

| Parameter | Purpose |
|-----------|---------|
| ATR period | Volatility reference |
| ATR SL multiplier | Stop distance |
| ATR TP multiplier | Target distance |
| Volume trigger multiplier | Confirmation threshold |
| RSI period + oversold/overbought | Mean-reversion extremes |
| VP lookback | Volume profile calculation |
| Regime ATR ratio thresholds | Micro regime detection |
| Funding rate filter tiers | Directional bias |
| Time stop | Max hold duration |

This falls within the "9-12 high risk, justify each" tier — acceptable for a strategy with 3 sub-components, provided each parameter serves a distinct purpose.

---

## 6. What We Actually Know vs. What We Think We Know

This section exists because the greatest risk in this research program is conflating hypothesis quality with validation status.

### KNOWN (factual, verifiable)

1. BTC/USDT perpetual is the most liquid crypto pair with tight spreads (~$6-7 at $67K)
2. Binance taker fee is 0.04-0.05%, maker fee is 0.02% (VIP 0)
3. Funding rate settles every 8 hours at 00:00/08:00/16:00 UTC
4. All required data is available via free APIs
5. The Pine Script implementations compile and run (syntax-valid)
6. The Python validation framework code exists but has not been executed
7. The research command's 8-agent methodology successfully identified fatal flaws in Doc 3

### BELIEVED (reasonable inference, unvalidated)

1. CVD divergence at VP levels creates mean-reversion opportunities (~70% confidence)
2. Funding rate extremes are contrarian indicators (~80% confidence)
3. Liquidation cascades revert ~60-65% of the time (~65% confidence)
4. The strategy can survive 2x transaction costs (~55% confidence)
5. Behavioral edges decay slower than structural edges (~60% confidence)
6. ES futures lead BTC by 1-3 minutes during US hours (~75% confidence)

### UNKNOWN (requires data to resolve)

1. Whether the edge is large enough to survive real-world fees and slippage
2. Whether the regime classifier correctly identifies regimes in real-time
3. Whether the strategy actually beats buy-and-hold on a risk-adjusted basis
4. Whether 7-12 parameters is the right complexity for this market
5. What the actual walk-forward efficiency is
6. Whether factor alpha is statistically significant after removing BTC beta
7. How the strategy performs in a strong trending regime (the research period is bearish/accumulation)

---

## 7. Prioritized Action Plan

### Phase 0: Resolve Infrastructure Prerequisites

| # | Action | Blocks |
|---|--------|--------|
| 0.1 | Standardize capital assumption to $10K across all documents | All sizing decisions |
| 0.2 | Verify network access to Binance, CoinGlass, Deribit, alternative.me APIs | All live data |
| 0.3 | Set up Python environment with required libraries (vectorbt, statsmodels, scipy, ccxt, arch) | Tier 2 validation |

### Phase 1: Validate the Core Hypothesis (MOST CRITICAL)

| # | Action | Success Gate |
|---|--------|-------------|
| 1.1 | Fetch 6+ months of BTC/USDT 1-min data from Binance via ccxt | Data quality check: no gaps >5 min |
| 1.2 | Implement Doc 2's mean-reversion strategy in Python (not Pine Script) using real OHLCV+volume data | Strategy matches Pine Script logic |
| 1.3 | Run walk-forward analysis (6 rolling folds, 21-day train / 7-day test) | WFE >50% median |
| 1.4 | Run significance tests (t-test, bootstrap Sharpe CI, random-entry permutation) | p < 0.05 on all three |
| 1.5 | Run factor analysis (regress on BTC returns with Newey-West SEs) | Alpha p < 0.05 |
| 1.6 | Test at 1x, 2x, 5x transaction costs | Profitable at 2x |

**Decision gate**: If Phase 1 fails any core gate (1.3-1.6), STOP. The edge does not exist or is too thin. Do not proceed. Return to research with a different thesis.

### Phase 2: Add Supplementary Strategies

| # | Action | Success Gate |
|---|--------|-------------|
| 2.1 | Add Funding Settlement Fade (S7) to the validated core | Incremental PF improvement |
| 2.2 | Add Liquidity Sweep Fade to the validated core | Incremental PF improvement |
| 2.3 | Implement hierarchical regime engine (Layer 1 macro + Layer 2 micro) | Regime filter improves risk-adjusted returns |
| 2.4 | Re-run full validation suite on combined strategy | All gates from Phase 1 still pass |

### Phase 3: Paper Trading

| # | Action | Success Gate |
|---|--------|-------------|
| 3.1 | Build Python bot with direct Binance WebSocket + REST API | 100% signal processing rate on testnet |
| 3.2 | Run live paper trading for minimum 50 trades or 4 weeks | Performance within ±30% of validated backtest |
| 3.3 | Verify regime classifier against real-time market conditions | Regime transitions match manual assessment |
| 3.4 | Document every trade with entry reason, exit reason, P&L | Complete trade journal |

### Phase 4: Micro Live

Deploy $2,000 (20% of capital) at 0.25% risk per trade ($5 risk/trade).

| Gate | Threshold |
|------|-----------|
| Advance to 50% capital | 50+ trades with WR within ±10% of paper |
| Advance to 100% capital | 100+ total trades, rolling Sharpe within CI |
| Return to paper trading | DD >2x backtest max DD OR realized slippage >2x modeled |
| Abandon strategy | Rolling Sharpe negative for 30 trades |

---

## 8. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Edge does not survive Tier 2 validation | **HIGH (40%)** | Strategy abandoned; research time lost but knowledge retained | Accept this as the most likely outcome; plan for it |
| Edge exists but is too thin for $10K capital | **MEDIUM (30%)** | Strategy viable only at $50K+; defer until capital grows | Test at multiple capital levels in Python |
| Regime classifier produces false signals | **MEDIUM (25%)** | Wrong strategy weights applied; suboptimal entries | Paper trade regime classifier independently before coupling to execution |
| Fee structure changes (Binance raises fees) | **LOW (10%)** | Edge erodes or disappears | Test at 2x and 5x costs; have kill-switch on fee monitoring |
| Flash crash during live trading | **LOW (5%)** | Loss exceeding max DD | Exchange-resident stop losses (non-negotiable); 15% hard stop |
| Psychological failure (abandoning after losing streak) | **HIGH (40%)** | Stop trading during a normal drawdown | Start at minimum size ($5 risk/trade); scale only after 200+ trades |
| Overconfidence from paper trading success | **MEDIUM (20%)** | Deploy too much capital too quickly | Strict phase transition gates; no exceptions |

---

## 9. Honest Overall Assessment

### Strengths of This Research Program

1. **Methodology is excellent.** The 8-agent team with adversarial review is a genuine quality control mechanism. It caught the 88-parameter problem, the execution fragility, and the audience mismatch. Agent 6 works.

2. **Intellectual honesty is preserved.** Both verdicts (CONDITIONAL and FRAGILE) are calibrated correctly. The research did not inflate results or hide weaknesses. This is rare and valuable.

3. **Two independent convergences.** The same core edge (mean-reversion at VP levels) emerged from two separate research runs. The same core enhancement (funding settlement fade) was identified as the most durable sub-strategy. Independent convergence is stronger than a single analysis.

4. **Infrastructure cost is zero.** The complete data stack is free. This removes a common barrier to strategy development.

5. **The framework is reusable.** Even if this specific strategy fails validation, the regime classification engine, the sentiment signal library, the statistical validation pipeline, and the adversarial review framework can be applied to any future strategy.

### Weaknesses of This Research Program

1. **Zero validation.** The most fundamental weakness. Everything is theoretical. The research command explicitly states "TradingView backtests are hypothesis screening only" — and not even that screening has been completed with real data.

2. **The research was conducted in a single market regime.** All three documents were produced on 2026-02-18 during a bear/accumulation phase. The strategy is designed for this regime and explicitly acknowledged to underperform in trending markets. There is no evidence of how it behaves in other regimes beyond theory.

3. **The CVD proxy undermines the Pine Script backtest.** The core signal (CVD divergence) cannot be accurately implemented in Pine Script. Any TradingView backtest will overstate performance by an estimated 2-5% on win rate. This means Tier 1 screening results will be misleading — they must be heavily discounted.

4. **Capital-strategy mismatch risk.** At $10K capital with 0.5% risk per trade ($50), the absolute dollar amounts per trade are very small. This means:
   - Each trade risks $50 but incurs ~$2.70 in taker fees ($67K × 0.04%) per side = $5.40 round trip
   - That is 10.8% of risk consumed by fees alone
   - At maker rates (0.02%): $1.35 per side = $2.70 round trip = 5.4% of risk
   - This fee-to-risk ratio is concerning for a strategy with thin edges

5. **No mechanism for strategy iteration.** The documents describe research outputs but not a feedback loop. When Tier 2 validation fails specific gates, there is no documented process for systematic modification and re-testing (versus ad hoc changes).

### The Bottom Line

This is a **well-designed research program that has produced a credible hypothesis but zero evidence**. The hypothesis — behavioral mean-reversion at volume profile levels — is sound. The adversarial process works. The methodology is rigorous.

But the most likely outcome is that **Phase 1 validation will reveal the edge is either non-existent or too thin to survive real-world costs** at the $10K capital level. This is not a reason to abandon the work — it is a reason to run the validation immediately and let the data decide. The research framework, regime engine, and validation pipeline retain their value regardless of whether this specific strategy passes.

The single most important next step is: **Run the Python Tier 2 validation on Doc 2's 7-parameter strategy using 6 months of real BTC/USDT 1-minute data.** Everything else is premature optimization of an unvalidated hypothesis.

---

## Appendix A: Document Comparison Matrix

| Dimension | Doc 1 (Regime Framework) | Doc 2 (OF-VP Scalper) | Doc 3 (Confluence Scalper) |
|-----------|------------------------|----------------------|--------------------------|
| **Type** | Methodology/Framework | Complete Strategy Report | Complete Strategy Report |
| **Verdict** | N/A (framework) | CONDITIONAL | FRAGILE |
| **Parameters** | N/A | 7 | 88+ |
| **Capital** | $10K | $50K | $10K |
| **Risk/Trade** | $50-$100 | $250 (0.5%) | $50-$150 (0.5-1.5%) |
| **Sub-strategies** | N/A | 1 (+ 5 setup templates) | 8 |
| **Regime Model** | Macro (5 regimes, daily) | References Doc 1 | Micro (5 regimes, 5-min) |
| **CVD Source** | Recommends WebSocket | Pine Script proxy | Pine Script proxy |
| **Architecture** | Data infrastructure spec | Pine Script + manual | Pine Script + webhook |
| **Validation Status** | Data unverified | All [ESTIMATED] | All [ESTIMATED] |
| **Key Strength** | Detailed sentiment library | Simplicity, honest sizing | Comprehensive framework |
| **Key Weakness** | No strategy attached | Fee sensitivity | 88 parameters, FRAGILE |
| **Recommended Action** | Integrate as regime layer | Validate in Python (PRIORITY) | Simplify per Agent 6 → merges into Doc 2 |

## Appendix B: Signal Library (Unified from All Documents)

### Tier 1: Per-Trade Signals (1-5 second updates)

| Signal | Source | Use |
|--------|--------|-----|
| CVD divergence | Binance aggTrade WebSocket | Primary entry trigger |
| Volume spike (>1.3x 20-bar avg) | Binance aggTrade | Entry confirmation |
| Order book imbalance (bid/ask >2:1) | Binance depth WebSocket | Short-term directional pressure |
| Liquidation cascade (>$10M in 60s) | Binance forceOrder WebSocket | Cascade fade trigger |
| Candle pattern at VP level | Computed from OHLCV | Entry confirmation |

### Tier 2: Session-Level Signals (hourly updates)

| Signal | Source | Use |
|--------|--------|-----|
| Funding rate (graduated tiers) | Binance markPrice WebSocket | Directional filter |
| Long/short ratio | Binance REST API | Contrarian bias |
| Fear & Greed Index | alternative.me | Session directional bias |
| OI change (5-min delta) | Binance REST API | Momentum/deleveraging detection |
| Micro regime (ATR ratio + ADX) | Computed from 5-min OHLCV | Strategy weight selection |

### Tier 3: Background Context (daily/weekly)

| Signal | Source | Use |
|--------|--------|-----|
| Macro regime (composite score) | Multiple APIs | Capital allocation, no-trade decisions |
| DXY trend | TradingView / FRED | Macro headwind/tailwind |
| ES futures (US hours only) | TradingView / CME | 1-3 minute lead indicator |
| ETH/BTC ratio | Any exchange | Regime classification input |
| Options max pain (expiry day only) | Deribit / Coinglass | Directional anchor |
| Economic calendar | ForexFactory | No-trade zone scheduling |
| Token unlock schedule | TokenUnlocks | Catalyst awareness |

### Not Useful for Scalping (explicitly excluded)

| Signal | Why Excluded |
|--------|-------------|
| MVRV Z-Score | Changes too slowly; weekly context at best |
| NUPL | Same — lagging, regime-level only |
| M2 Money Supply | Monthly update; zero intraday relevance |
| Gold/BTC correlation | Too weak and inconsistent for any signal |
| Hash rate / Miner revenue | Daily, affects weekly outlook only |

---

*This evaluation reflects the state of research as of 2026-02-18. All assessments are based on the documents produced by the 8-agent research team and should be updated as validation data becomes available.*

---
description: Scan and critically evaluate profitability and strategy success using 7-agent team (trade data, strategy economics, contracts/capital, architecture maturity, risk calibration, competitive edge, data integrity)
---

# Profitability & Strategy Audit (Team-Based)

**Audit Target**: `$ARGUMENTS`

> If `$ARGUMENTS` is empty, run a full-system profitability audit across all strategies, chains, and services.

## Model Capabilities (Opus 4.6)

You are running on Claude Opus 4.6 with full agent team capabilities:
- **Team Orchestration**: Spawn and coordinate 7 specialized audit agents working in parallel
- **Parallel Tool Use**: Launch all agents simultaneously in a single message with multiple Task tool calls
- **Cross-Agent Synthesis**: Deduplicate and cross-reference findings across agents — when multiple agents flag the same profitability concern from different angles, that's high-confidence evidence
- **Deep Causal Reasoning**: Trace profitability issues to root causes through multi-step reasoning chains (why is strategy X unprofitable? → high gas costs → miscalibrated gas spike multiplier → config drift from market reality)
- **Calibrated Confidence**: Distinguish proven profitability blockers from speculative concerns. Rate each finding honestly — "we don't know" is more valuable than a guess
- **Self-Correction**: Challenge your own assumptions about what should be profitable. DeFi arbitrage economics are counterintuitive — a strategy with 90% win rate can still lose money after gas and fees

**Leverage these actively**: Use TeamCreate to spawn a team. Use Task tool with `team_name` to spawn teammates. Use TodoWrite to track audit phases. Synthesize all agent results into a single prioritized profitability assessment.

## Role & Expertise

You are a senior DeFi trading systems auditor specializing in:
- Arbitrage P&L analysis across multi-chain environments
- Flash loan economics and fee optimization
- MEV protection and competitive searcher dynamics
- Risk management calibration for automated trading systems
- Trading system deployment readiness assessment

## Context

Professional multi-chain arbitrage trading system:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **DEXs**: 44+ across all chains
- **Strategies**: 10 (cross-DEX, triangular, quadrilateral, multi-leg, cross-chain, flash loan, backrun, UniswapX, statistical arb, Solana-native)
- **Architecture**: Partitioned detectors (4 partitions), Redis Streams (ADR-002), L1 Price Matrix with SharedArrayBuffer (ADR-005), Worker threads for path finding (ADR-012), Circuit breakers (ADR-018)
- **Risk Stack**: Drawdown circuit breaker, EV calculator, Kelly Criterion position sizer, per-chain circuit breakers
- **Trade Data**: Append-only JSONL logs at `data/trades/trades-YYYY-MM-DD.jsonl`, Redis `trade_history` (10K cap)
- **Stack**: TypeScript, Node.js, Solidity (Hardhat), Jest

## CRITICAL PERFORMANCE REQUIREMENT

> **Hot-path latency target: <50ms** (price-update -> detection -> execution)

Any profitability finding that touches hot-path code is automatically P0:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing

## PROFITABILITY AUDIT SCOPE

This audit answers seven fundamental questions:

| # | Question | Agent | Perspective |
|---|----------|-------|-------------|
| 1 | **What happened?** | Trade Data Analyst | Backward-looking: actual P&L, win rates, slippage |
| 2 | **Can each strategy profit?** | Strategy Economics Evaluator | Theoretical: fees, gas, thresholds, market math |
| 3 | **Is the infrastructure deployed?** | Contract & Capital Assessor | Readiness: deployed contracts, capital, flash loan access |
| 4 | **Is the system complete?** | Architecture Maturity Evaluator | Completeness: ADRs, feature flags, service health |
| 5 | **Will we survive losses?** | Risk Calibration Auditor | Protection: drawdown breakers, position sizing, edge cases |
| 6 | **Can we win against competitors?** | Competitive Edge Analyst | External: latency, MEV, strategy crowding, alpha decay |
| 7 | **Can we trust the data?** | Data Integrity Verifier | Foundational: analytics accuracy, monitoring gaps |

### Role Design Rationale

> Validated by the 2026-02-24 full-system audit where all 7 agents completed successfully and produced non-redundant findings.

**Core roles (1-4)** cover internal system analysis:

| # | Role | Covers | Limitation |
|---|------|--------|-----------|
| 1 | Trade Data Analyst | What actually happened (backward-looking P&L) | Blind to theoretical viability and future risks |
| 2 | Strategy Economics Evaluator | Whether strategies can profit (fee stacks, thresholds) | Assumes deployment readiness and ignores competition |
| 3 | Contract & Capital Assessor | Whether infrastructure is deployed and funded | Doesn't assess whether deployed code is economically sound |
| 4 | Architecture Maturity Evaluator | Whether the system is complete (flags, ADRs, services) | Doesn't evaluate calibration quality or external factors |

These 4 roles answer "does the system work?" but not "will it survive?", "can it win?", or "can we trust the data?" Three additional roles fill those gaps:

**Role 5: Risk Calibration Auditor — "Will we survive losses?"**

A system can have working strategies, deployed contracts, and sound architecture, but still bleed capital through miscalibrated risk parameters. This role assesses whether the safety rails' *numbers* are correct, not whether they exist.

Unique findings from 2026-02-24 audit (no other agent caught these):
- Kelly Criterion is conceptually wrong for flash loans — sizes on trade capital, but only gas is at risk (double-confirmed with Agent 3)
- EV calculator's `minEVThreshold` (0.005 ETH ≈ $10) blocks most L2 opportunities where gas is $0.002
- `defaultGasCost` (0.01 ETH) accurate for Ethereum, wrong by 1000x for L2s
- Drawdown circuit breaker resets at UTC midnight — losses can straddle the boundary
- 30% `minWinProbability` with 50% default for first 10 trades — coin-flip sizing for new strategies

**Role 6: Competitive Edge Analyst — "Can we win against competitors?"**

The only externally-focused role. DeFi arbitrage is zero-sum — profitability is relative to competitors, not determined by internal correctness alone. A system with perfect economics earns nothing if it loses every trade to faster searchers.

Unique findings from 2026-02-24 audit:
- Per-chain competitiveness tiers: competitive on 5 chains (50ms vs 2-12s blocks), marginal on 3, non-competitive on 2 (Arbitrum sub-second FCFS, Solana colocated Jito at <5ms)
- Strategy alpha lifetime estimates: cross-DEX 6-12 months, statistical arb 3-5 years
- MEV protection OFF = every transaction frontrunnable, all profitable trades sandwiched
- Real vs theoretical advantages: 10 deployed capabilities vs 6 code-exists-but-untested features
- Directly shaped the strategic recommendation (target BSC/Fantom/Avalanche, not Ethereum)

**Role 7: Data Integrity Verifier — "Can we trust the data?"**

Meta-level role that validates the foundation every other agent stands on. If analytics have hardcoded values, if metrics aren't emitted, if trade logs are incomplete — the entire audit's conclusions are unreliable.

Unique findings from 2026-02-24 audit:
- `PerformanceAnalyticsEngine` is dead code — never imported by any service; `calculateBeta()` returns hardcoded 1.0; benchmarks hardcoded (BTC=5%, ETH=8%); attribution fixed 60/30/5/4/1%
- Prometheus alert rules reference ~10 metrics never emitted — false sense of monitoring coverage
- Alertmanager routing commented out — alerts have nowhere to go
- Trade logger reliable but risk-rejected opportunities not logged (missed-revenue analysis is blind)
- Slippage metric conflates estimation error, price movement, and execution slippage

**Alternative roles considered and rejected:**

| Candidate | Overlaps With | Why Rejected |
|-----------|-------------|-------------|
| Gas Optimization Specialist | Strategy Economics (fee stacks), Risk Calibration (EV gas costs) | Gas is a component of strategy economics, not a separate dimension |
| Market Microstructure Analyst | Competitive Edge (market assessment), Strategy Economics (thresholds) | Requires external market data the system doesn't collect |
| Execution Quality Auditor | Architecture Maturity (service readiness) | Code quality audit, not profitability audit |
| Capital Efficiency Optimizer | Contract & Capital Assessor | Nearly identical scope, would create overlap without new insights |
| Operational Resilience Auditor | Architecture Maturity + Risk Calibration | Covered by combination of existing roles |

**Role interaction map:**

```
Data Integrity (7) validates → All other agents' inputs

Trade Data (1) ←→ Strategy Economics (2)
  "What happened"     "What should happen"
  (actual vs expected P&L reconciliation)

Contract/Capital (3) → Strategy Economics (2)
  "What's deployed"     "What's viable given deployment"

Architecture (4) → Contract/Capital (3)
  "What's complete"    "What's deployable"

Risk Calibration (5) ←→ Strategy Economics (2)
  "Are safety rails right"  "Are thresholds right"
  (both found EV threshold issues from different angles)

Competitive Edge (6) ←→ Strategy Economics (2)
  "Can we win externally"   "Can we profit internally"
  (together determine which chains × strategies to pursue)
```

The 7 roles create a layered assessment: Data Integrity validates the foundation → Trade Data shows reality → Contract/Capital shows readiness → Architecture shows completeness → Strategy Economics shows theoretical viability → Risk Calibration shows survivability → Competitive Edge shows winnability.

**Cross-agent convergence patterns from 2026-02-24 audit:**
- **Triple-confirmed**: Ethereum flash loan arb uneconomical (Agents 2 + 5 + 6 from fee math, gas miscalibration, and latency gap angles)
- **Triple-confirmed**: L2s + Fantom are the sweet spot (Agents 2 + 5 + 6 from spread math, EV threshold blocking, and competitive positioning)
- **Double-confirmed**: Kelly sizing fundamentally wrong for flash loans (Agents 3 + 5 from capital model and risk math angles)
- **Double-confirmed**: Monitoring gives false sense of coverage (Agents 4 + 7 from alert rule existence vs metric emission)

---

## Team Structure

You are the **Team Lead**. Your responsibilities:
1. Create the team and task list using TeamCreate
2. Read trade data samples from `data/trades/` to understand what data exists
3. Spawn all 7 agents **in parallel** (single message, 7 Task tool calls) — **ALL agents MUST use model: opus**
4. Send activation messages to all agents after spawning
5. Monitor progress using the Stall Detection Protocol
6. Deduplicate and cross-reference findings — profitability issues found by multiple agents are highest confidence
7. Produce a unified Profitability Assessment Report with actionable recommendations
8. Assign a letter grade (A-F) with honest justification

---

## Agent Resilience Protocol (MANDATORY)

Lessons from past sessions: agents stall when given weak models, oversized prompts, or no report-back instructions. Follow these rules to prevent stalls:

### 1. Model Requirement
**ALL agents MUST be spawned with `model: "opus"`** — pass this explicitly in the Task tool call. Explore agents default to haiku, which cannot handle multi-file analysis. Never rely on defaults.

### 2. Report-Back Requirement
Every agent prompt MUST include this instruction at the TOP (before any other instructions):
```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool to send your findings back to the team lead. Your text output is NOT visible to the team lead — only SendMessage delivers your results. Use: SendMessage(type: "message", recipient: "<team-lead-name>", content: "<your full findings>", summary: "<5-10 word summary>"). Do this IMMEDIATELY when done.
```

### 3. Prompt Size Limit
Agent prompts MUST be **under 300 lines**. Include:
- The agent's specific mission and focus areas
- The target scope (from `$ARGUMENTS` or full system)
- Key constraints and quality gates

Do NOT copy the entire command file into the agent prompt. Summarize shared context; don't duplicate it.

### 4. Self-Execution Fallback
If an agent is unresponsive after **2 minutes** (not 5):
1. Stop waiting immediately
2. Do the work yourself as Team Lead
3. Note in the final report: "Agent N analysis executed by Team Lead (agent unresponsive)"

This is faster and more reliable than sending multiple nudges that go unread.

### 5. Prefer general-purpose Over Explore
Use `subagent_type: "general-purpose"` for agents that need deep multi-file analysis. Explore agents have limited tools and weaker default models. Use Explore only for read-only survey tasks (Agent 4 only).

---

### Agent 1: "trade-data-analyst" (subagent_type: general-purpose, model: opus)

**Mission**: Analyze actual trade execution data to determine realized profitability, execution quality, and performance patterns.

**Focus areas**:

1. **Trade Log Analysis**
   - Read ALL JSONL trade log files from `data/trades/trades-*.jsonl`
   - Compute: total trades, win rate, total P&L, average profit per trade, average loss per trade
   - Compute: profit factor (gross profit / gross loss)
   - Track: success vs failure counts, failure reasons
   - Identify: most and least profitable opportunity types

2. **Slippage Analysis**
   - Calculate: average slippage (expectedProfit vs actualProfit)
   - Distribution: what percentage of trades have >10% slippage? >20%?
   - Correlation: does slippage correlate with trade size, chain, DEX, or time of day?
   - Flag: trades where slippage exceeds configured tolerance (1%)

3. **Strategy Breakdown**
   - Group trades by `strategyUsed` and `type` fields
   - Per-strategy: trade count, win rate, avg profit, total P&L
   - Identify: which strategies have actually been executed vs which exist only in code
   - Flag: strategies with 0 executed trades (are they dead code?)

4. **Chain & DEX Performance**
   - Group by `chain` and `dex`/`sellDex`
   - Per-chain: execution count, success rate, avg gas cost, net profit after gas
   - Identify: chains with negative net profit (gas > profit)
   - Compare: actual gas costs vs configured estimates ($15 USD default in thresholds.ts)

5. **Temporal Patterns**
   - Trade frequency over time (increasing, decreasing, sporadic?)
   - Time-of-day distribution (are there profitable/unprofitable hours?)
   - Gap analysis: periods with zero trades (system down? no opportunities?)

6. **Data Quality Assessment**
   - Are trade logs from real on-chain execution or simulation/testing?
   - Check opportunity IDs for patterns indicating test data (e.g., "pipeline-test-", "batch-")
   - Check transaction hashes: are they real on-chain txs or generated?
   - Flag if ALL trades are from test/simulation — this fundamentally limits profitability assessment

**Key files**:
- `data/trades/trades-*.jsonl` — Primary trade data
- `data/dlq-fallback-*.jsonl` — Failed opportunities (missed revenue)
- `shared/core/src/persistence/trade-logger.ts` — Logger interface/fields

**Deliverable**: Trade performance report with per-strategy and per-chain breakdowns, slippage analysis, temporal patterns, and data quality assessment.

**Quality Gates**:
- [ ] Read ALL available trade log files (not just samples)
- [ ] Computed aggregate statistics with actual numbers
- [ ] Identified whether data is real or simulated
- [ ] Per-strategy breakdown complete
- [ ] Slippage distribution analyzed
- [ ] DLQ files checked for missed opportunities

---

### Agent 2: "strategy-economics-evaluator" (subagent_type: general-purpose, model: opus)

**Mission**: Evaluate the theoretical economic viability of each implemented strategy against current market economics (fees, gas, liquidity, profit thresholds).

**Focus areas**:

1. **Fee Stack Analysis** (per strategy)
   - DEX swap fees: 0.01% to 1.00% depending on pool/tier
   - Flash loan fees: Balancer 0%, Aave 0.09%, PancakeSwap 0.01-1%, SyncSwap 0.3%
   - Gas costs: per-chain estimates vs actual market (check gas-price-optimizer.ts defaults)
   - Bridge costs: for cross-chain strategies
   - Total fee load per trade: can the expected spread cover ALL fees?

2. **Minimum Profit Threshold Viability**
   - Per-chain thresholds: Ethereum 0.5%, L2s 0.2%, Solana 0.1%
   - Global floor: $2 minimum net profit
   - Default trade size: $10,000 — is this realistic for available liquidity?
   - Math check: at $10K trade with 0.3% DEX fee each way + flash loan fee + gas, what's the minimum spread needed to profit?

3. **Strategy-Specific Economics**
   - **Cross-DEX**: Most competitive, lowest margins — realistic spread persistence?
   - **Triangular/Quadrilateral**: Higher complexity = more gas, but less competition
   - **Cross-Chain**: Bridge costs + latency + non-atomic risk — viable only for large spreads
   - **Flash Loan**: Fee comparison across providers — is Balancer (0%) always used where available?
   - **Backrun/MEV-Share**: 90% retention rate — competitive with other searchers?
   - **UniswapX**: $1 min profit threshold — viable at current gas levels?
   - **Statistical Arb**: $5 min profit, 0.5 confidence — what's the expected EV?

4. **Unrealized Economic Optimizations**
   - Balancer V2 (0% flash loan fee) is available on 5 chains but NOT enabled — quantify savings
   - MultiPathQuoter not deployed — quantify latency/cost improvement from batched quotes
   - DAI Flash Mint (0.01% fee) on Ethereum — is it being used?
   - Flash loan provider selection: is the cheapest provider always chosen per chain?

5. **Market Reality Check**
   - Are the configured profit thresholds competitive with market spreads?
   - Gas spike multipliers (Ethereum 5x, L2s 2x) — do they reject too many/few trades?
   - Opportunity timeout settings — do they match actual block times?
   - Slippage tolerance (1%) — is this too aggressive or conservative?

**Key files**:
- `shared/config/src/thresholds.ts` — Profit thresholds, gas config
- `shared/config/src/service-config.ts` — Flash loan provider mapping
- `shared/core/src/utils/fee-utils.ts` — Fee calculations
- `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts` — Profitability analysis
- `services/execution-engine/src/strategies/` — All strategy implementations
- `services/execution-engine/src/services/gas-price-optimizer.ts` — Gas pricing

**Deliverable**: Per-strategy economic viability assessment with fee stack breakdown, threshold analysis, and quantified optimization opportunities.

**Quality Gates**:
- [ ] ALL 10 strategy types evaluated
- [ ] Fee stacks computed with actual numbers from config
- [ ] Minimum spread needed to profit calculated per strategy
- [ ] Unrealized savings quantified (Balancer V2, MultiPathQuoter)
- [ ] Market reality of thresholds assessed

---

### Agent 3: "contract-capital-assessor" (subagent_type: general-purpose, model: opus)

**Mission**: Assess smart contract deployment readiness, flash loan infrastructure availability, and capital efficiency of the system.

**Focus areas**:

1. **Deployment Status Audit**
   - Read `contracts/deployments/registry.json` — which contracts are deployed, where?
   - Check ALL networks: mainnet, testnets (Sepolia, Arbitrum Sepolia, Base Sepolia, zkSync testnet)
   - For each derived contract (FlashLoanArbitrage, BalancerV2Flash, PancakeSwapFlash, SyncSwapFlash, DaiFlashMint, CommitReveal): deployed or not?
   - MultiPathQuoter deployment status
   - Impact: what strategies are BLOCKED by missing deployments?

2. **Flash Loan Provider Coverage**
   - Per-chain: which flash loan providers are configured and available?
   - Gap analysis: chains where flash loans are impossible (Linea blocked, Solana N/A)
   - Fee optimization: is the cheapest provider used per chain?
   - Read service-config.ts lines 323-457 for current provider mapping
   - Check for commented-out Balancer V2 entries that represent unrealized savings

3. **Capital Configuration**
   - Default total capital: 10 ETH — is this a placeholder or production value?
   - Max single trade fraction: 2% of capital (0.2 ETH at default) — viable for gas costs?
   - Min trade fraction: 0.1% (0.01 ETH) — is this above dust threshold?
   - Kelly criterion parameters: are they calibrated for the actual strategies?
   - Position sizing vs flash loan: does sizing make sense when flash loans provide the capital?

4. **Contract Security & Efficiency**
   - Profit verification layers: are all 5 layers implemented and tested?
   - MinimumProfit enforcement: default 1e14 (0.0001 ETH) — is this economically meaningful after gas?
   - Router approval management: how many routers approved, any missing?
   - Gas estimates per provider: Aave 500K, Balancer 550K, etc. — are these accurate?

5. **DEX Address Verification**
   - Check for placeholder addresses (0x0000...0001 style) in DEX configs
   - Identify emerging L2 chains with dummy addresses (Blast, Scroll, Mantle, Mode)
   - Impact: what chains/DEXs are nonfunctional due to missing addresses?

**Key files**:
- `contracts/deployments/registry.json` — Deployment registry
- `contracts/src/base/BaseFlashArbitrage.sol` — Base contract
- `contracts/src/` — All derived contracts
- `shared/config/src/service-config.ts` — Flash loan config
- `shared/config/src/risk-config.ts` — Capital config
- `shared/config/src/dexes/index.ts` — DEX addresses

**Deliverable**: Deployment readiness matrix, flash loan coverage map, capital configuration assessment, and list of strategies blocked by missing infrastructure.

**Quality Gates**:
- [ ] Deployment registry fully read and tabulated
- [ ] Every chain's flash loan provider status documented
- [ ] Capital config assessed for production viability
- [ ] Placeholder/dummy addresses identified
- [ ] Strategies blocked by missing deployments listed

---

### Agent 4: "architecture-maturity-evaluator" (subagent_type: Explore, model: opus)

**Mission**: Evaluate system completeness, feature flag status, ADR implementation gaps, and operational readiness for profitable trading.

**Focus areas**:

1. **Feature Flag Audit**
   - Read `shared/config/src/feature-flags.ts` — catalog all 16 flags
   - Status: which are ON vs OFF in default config?
   - Impact: which OFF flags block profitability? (e.g., flash loan aggregator, backrun, UniswapX)
   - Dependency: do any flags depend on undeployed infrastructure?

2. **ADR Implementation Status**
   - Read `docs/architecture/adr/README.md` — catalog all 36 ADRs
   - For each: is it fully implemented, partially implemented, or unimplemented?
   - Focus on profit-impacting ADRs: ADR-020 (Flash Loans), ADR-029 (Batched Quotes), ADR-034 (Solana), ADR-035 (Stat Arb), ADR-036 (CEX Signals)
   - Identify ADRs that would improve profitability if fully implemented

3. **Service Readiness**
   - Check health endpoints/configs for all 8 services
   - Identify services with TODOs, incomplete implementations, or missing features
   - P4 (Solana) divergence: does it miss features available in P1-P3 factory pattern?
   - Mempool detector: operational status and MEV-Share integration

4. **Operational Tooling**
   - Monitoring: is Prometheus/Grafana actually running or just configured?
   - Alerting: are alert rules active or example-only?
   - Deployment: are services deployed to Fly.io/Oracle Cloud or local-only?
   - Validation scripts: what do `validate:deployment`, `validate:mev-setup`, `validate:routers` report?

5. **Known Gaps and TODOs**
   - Scan codebase for TODO/FIXME comments that impact profitability
   - Catalog incomplete features that affect trade execution
   - Identify "coming soon" features that are blocking strategies

**Key files**:
- `shared/config/src/feature-flags.ts` — Feature flags
- `docs/architecture/adr/README.md` — ADR index
- `docs/architecture/CURRENT_STATE.md` — Service inventory
- Infrastructure configs in `infrastructure/`
- TODOs across the codebase

**Deliverable**: System completeness scorecard, feature flag impact matrix, ADR gap analysis, and operational readiness assessment.

**Quality Gates**:
- [ ] All 16 feature flags cataloged with ON/OFF status
- [ ] ADRs checked for implementation completeness (focus on profit-impacting ones)
- [ ] Service readiness verified (not just assumed from code existence)
- [ ] Operational tooling status assessed (running vs configured-only)
- [ ] TODOs impacting profitability cataloged

---

### Agent 5: "risk-calibration-auditor" (subagent_type: general-purpose, model: opus)

**Mission**: Evaluate whether the risk management stack is correctly calibrated to protect capital while maximizing profitable trading opportunities.

> This agent exists because a system that is technically correct can still lose money through miscalibrated risk parameters. The question isn't "does risk management exist?" but "are the NUMBERS right?"

**Focus areas**:

1. **Drawdown Circuit Breaker Calibration**
   - Read `shared/core/src/risk/drawdown-circuit-breaker.ts` completely
   - Assess: 5% maxDailyLoss, 3% cautionThreshold — appropriate for 10 ETH default capital?
   - At 10 ETH: CAUTION triggers at 0.3 ETH loss, HALT at 0.5 ETH — is this too tight for gas-intensive strategies?
   - Recovery path: HALT (1h cooldown) → RECOVERY (50% sizing, need 3 wins) → NORMAL — is this realistic?
   - Edge case: daily reset at UTC midnight — can losses straddle the boundary to avoid triggering?
   - Edge case: `totalCapital === 0n` blocks all trading — is this initialized correctly in all paths?

2. **EV Calculator Assessment**
   - Read `shared/core/src/risk/ev-calculator.ts` completely
   - `minEVThreshold`: 0.005 ETH (~$10) — is this too high for L2 low-gas opportunities?
   - `defaultGasCost`: 0.01 ETH — grossly inaccurate for L2s where gas is <$0.01
   - `minWinProbability`: 30% — is this too permissive for new strategies with no history?
   - `defaultProfitEstimate`: 0.02 ETH — does this match actual observed profits?
   - Per-chain calibration: does the EV filter use chain-specific gas costs or a global default?

3. **Position Sizing (Kelly Criterion)**
   - Read `shared/core/src/risk/position-sizer.ts` completely
   - Half-Kelly multiplier (0.5) — appropriate for crypto volatility?
   - `maxSingleTradeFraction`: 2% — at 10 ETH that's 0.2 ETH max trade, is this viable?
   - `minTradeFraction`: 0.1% — at 10 ETH that's 0.01 ETH, below gas on mainnet
   - With flash loans providing capital, does Kelly sizing even apply? The system doesn't risk the trade capital, only gas.
   - Early-stage probability problem: only 10 samples before using learned data, with 50% default — first 10 trades use a coin flip for sizing

4. **TOCTOU and Concurrency**
   - Read `services/execution-engine/src/risk/risk-management-orchestrator.ts`
   - In-flight trade tracking (max 3) — sufficient to prevent drawdown bypass?
   - With 11 chains and 4 partitions, can simultaneous opportunities bypass the 3-trade limit?
   - Distributed lock + risk check ordering: is risk assessed before or after lock acquisition?

5. **Per-Chain Circuit Breaker Gaps**
   - Read `services/execution-engine/src/services/circuit-breaker-manager.ts`
   - Isolated per-chain breakers — correct behavior for independent chain failures
   - But systemic failures (Redis down, RPC cascade) — do they trigger cross-chain halt?
   - Recovery: HALF_OPEN state — how many test trades before fully closing?

6. **Risk Parameter Reality Check**
   - Compare ALL default values against what would be needed for production profitability
   - Identify parameters that are clearly development defaults vs production-ready
   - Flag parameters that contradict each other (e.g., min trade size below gas cost)

**Key files**:
- `shared/core/src/risk/drawdown-circuit-breaker.ts` — Drawdown state machine
- `shared/core/src/risk/ev-calculator.ts` — Expected value filter
- `shared/core/src/risk/position-sizer.ts` — Kelly Criterion sizing
- `shared/core/src/risk/types.ts` — Risk type definitions
- `shared/config/src/risk-config.ts` — Risk configuration
- `services/execution-engine/src/risk/risk-management-orchestrator.ts` — Orchestrator

**Deliverable**: Risk parameter calibration report with specific recommendations for each parameter, edge case analysis, and production-readiness assessment of the risk stack.

**What NOT to Report**:
- Risk management features that are correctly implemented (this audit is about calibration, not bugs)
- Code quality issues unrelated to profitability
- Theoretical attacks without practical exploitation path

**Quality Gates**:
- [ ] ALL risk files read completely (not just interfaces)
- [ ] Every default parameter assessed for production viability
- [ ] Edge cases analyzed (boundary conditions, concurrent access, reset timing)
- [ ] Flash loan capital model considered (risk ≠ trade size, risk = gas cost)
- [ ] Contradictory parameters identified

---

### Agent 6: "competitive-edge-analyst" (subagent_type: general-purpose, model: opus)

**Mission**: Evaluate whether this system can win trades against other arbitrage searchers in the competitive DeFi MEV landscape.

> This agent exists because profitability in DeFi arbitrage is determined not just by whether the math works, but by whether you can execute faster and smarter than everyone else doing the same math. This is the most overlooked dimension in trading system evaluation.

**Focus areas**:

1. **Latency Competitiveness**
   - System target: <50ms hot-path. Professional Ethereum MEV searchers: 1-10ms with colocated nodes
   - Read `shared/core/src/monitoring/latency-tracker.ts` and `performance-monitor.ts`
   - Per-chain assessment: where is <50ms competitive vs where is it too slow?
   - L2s (Arbitrum, Base, Optimism): faster blocks attract more searchers — is <50ms enough?
   - Solana: 400ms blocks, Jito bundles — different competitive dynamics
   - BSC: fewer sophisticated searchers — potentially better for this system's speed tier

2. **MEV Protection Assessment**
   - Read `services/execution-engine/src/services/mev-protection-service.ts`
   - Flashbots/MEV-Share integration: implemented but feature-flagged OFF — impact of running unprotected?
   - Without MEV protection: every submitted tx is frontrunnable. Quantify expected sandwich attack losses
   - MEV-Share `mevShareRefundPercent`: 90% retained — is this competitive? (Top searchers may offer less)
   - Commit-reveal scheme: exists in contract but flagged OFF — when is it worth the extra gas?

3. **Strategy Crowding Analysis**
   - **Cross-DEX simple arb**: THE most competed strategy in DeFi. Realistic for this system? At what speed tier?
   - **Triangular/Quadrilateral**: Less competition due to complexity — but this system hasn't executed any
   - **Cross-chain**: Non-atomic, high risk, but less competition — is the system's bridge infrastructure ready?
   - **Backrun/UniswapX**: Growing MEV share but requires mempool access and speed
   - **Statistical arb**: Least competed, highest complexity — feature-flagged OFF

4. **Alpha Decay Risk**
   - Simple cross-DEX arb margins have compressed 2020→2025 as more searchers enter
   - Are the configured min profit thresholds (0.2-0.5%) still achievable in current markets?
   - Which strategies have the longest expected alpha lifetime?
   - Where should the system invest development effort for sustainable edge?

5. **Competitive Advantages Assessment**
   - Multi-chain coverage (11 chains) — broader than most single-chain bots
   - Flash loan provider diversity (5 protocols) — can choose cheapest per trade
   - Partitioned detection — parallel processing across chain groups
   - Risk management stack — prevents catastrophic losses unlike many raw bots
   - What advantages are REAL (deployed, tested) vs THEORETICAL (code exists, not deployed)?

6. **Recommendations for Competitive Edge**
   - Which chains offer the best risk-adjusted opportunity for this system's speed tier?
   - Which strategies should be prioritized based on competition level?
   - What infrastructure investments would most improve competitiveness?
   - Is the system better positioned as a high-frequency specialist or a multi-strategy generalist?

**Key files**:
- `shared/core/src/monitoring/latency-tracker.ts` — Latency metrics
- `shared/core/src/monitoring/performance-monitor.ts` — Hot-path monitoring
- `services/execution-engine/src/services/mev-protection-service.ts` — MEV protection
- `services/execution-engine/src/strategies/backrun.strategy.ts` — Backrun strategy
- `services/execution-engine/src/strategies/uniswapx-filler.strategy.ts` — UniswapX
- `shared/config/src/thresholds.ts` — Profit thresholds
- `docs/strategies.md` — Strategy documentation

**Deliverable**: Competitive positioning report with per-strategy competition assessment, latency gap analysis, MEV exposure quantification, and recommended strategic focus.

**What NOT to Report**:
- Code quality issues (other agents handle this)
- Theoretical optimizations without competitive context
- Generic "go faster" recommendations without specifics

**Quality Gates**:
- [ ] Latency targets assessed per-chain (not just global <50ms)
- [ ] MEV protection status confirmed (ON vs OFF, impact quantified)
- [ ] Each strategy assessed for competition level
- [ ] Real vs theoretical advantages distinguished
- [ ] Specific chain/strategy recommendations provided

---

### Agent 7: "data-integrity-verifier" (subagent_type: general-purpose, model: opus)

**Mission**: Validate that the monitoring, analytics, and observability infrastructure produces TRUSTWORTHY data — because every other agent's conclusions depend on data quality.

> This agent exists because a profitability audit is only as good as the data it analyzes. If the PerformanceAnalyticsEngine uses hardcoded benchmarks, if Prometheus metrics aren't being scraped, if trade logs are incomplete — then the entire audit is built on sand.

**Focus areas**:

1. **Analytics Engine Accuracy**
   - Read `shared/core/src/analytics/performance-analytics.ts` completely
   - Check: beta calculation — does it return a real value or always 1.0?
   - Check: benchmark comparisons — are returns real or hardcoded (BTC: 5%, ETH: 8%)?
   - Check: attribution analysis — are percentages calculated or fixed?
   - Check: Sharpe/Sortino/VaR calculations — are formulas correct?
   - Impact: if analytics are unreliable, which metrics can still be trusted?

2. **Trade Log Completeness**
   - Read `shared/core/src/persistence/trade-logger.ts`
   - Is logging synchronous or async? Can writes be lost during crashes?
   - Is there reconciliation between JSONL files and Redis `trade_history`?
   - Are ALL execution outcomes logged (successes, failures, timeouts, rejected-by-risk)?
   - What about opportunities that were detected but never executed? Are they tracked?
   - DLQ files: are failed opportunities analyzed for missed revenue?

3. **Prometheus Metrics Reliability**
   - Read `shared/core/src/metrics/` directory
   - Are metrics actually emitting data or just defined as interfaces?
   - Read `infrastructure/monitoring/alert-rules.yml` — do alert rules reference metrics that exist?
   - Is Prometheus scraping configured and running, or just documented?
   - Financial metrics (`arbitrage_profit_usd_total`, `arbitrage_gas_cost_usd_total`) — how are these calculated?

4. **OpenTelemetry Trace Completeness**
   - Read `shared/core/src/tracing/trace-context.ts`
   - Is trace context propagated through ALL services or just some?
   - Are there gaps in the detection → coordination → execution trace chain?
   - Do trade log `traceId` fields correlate back to complete traces?

5. **Monitoring Stack Operational Status**
   - Grafana dashboards: are they provisioned or just JSON files in the repo?
   - Alert routing: is Alertmanager configured or just example templates?
   - Health check scripts: do they cover all critical paths?
   - Is there any evidence the monitoring stack has caught real issues?

6. **Slippage Metric Accuracy**
   - Formula: `(expectedProfit - actualProfit) / expectedProfit`
   - Problem: this conflates estimation error with market impact
   - If `expectedProfit` is wrong, "slippage" is meaningless
   - Are there separate metrics for estimation accuracy vs execution slippage?

7. **Coordinator Metrics vs Reality**
   - Read `services/coordinator/src/api/types.ts` — SystemMetrics interface
   - `totalProfit`, `successfulExecutions` — where do these come from?
   - Is the dashboard showing real-time data or cached/stale values?
   - Is `systemHealth` percentage meaningful or cosmetic?

**Key files**:
- `shared/core/src/analytics/performance-analytics.ts` — Analytics engine
- `shared/core/src/persistence/trade-logger.ts` — Trade logger
- `shared/core/src/metrics/` — Metrics domain
- `shared/core/src/tracing/trace-context.ts` — Tracing
- `shared/core/src/monitoring/` — Monitoring components
- `infrastructure/monitoring/alert-rules.yml` — Alert rules
- `services/coordinator/src/api/types.ts` — System metrics

**Deliverable**: Data integrity assessment with per-component reliability rating (RELIABLE / PARTIALLY RELIABLE / UNRELIABLE / NOT OPERATIONAL), specific inaccuracies identified, and recommendations for making data trustworthy.

**What NOT to Report**:
- Code bugs unrelated to data accuracy
- Performance issues in analytics code (unless they cause data loss)
- Style/refactoring suggestions

**Quality Gates**:
- [ ] Analytics engine formulas verified for correctness
- [ ] Hardcoded/placeholder values identified
- [ ] Trade log completeness assessed (are all outcomes captured?)
- [ ] Metrics emission verified (defined vs actually emitting)
- [ ] Monitoring stack operational status assessed (running vs configured-only)
- [ ] Each data source rated: RELIABLE / PARTIALLY RELIABLE / UNRELIABLE / NOT OPERATIONAL

---

## Critical Rules (Apply to ALL Agents)

### Anti-Hallucination Protocol
- **NEVER** report a profitability issue unless you can point to specific code, data, or configuration
- **NEVER** assume market conditions without labeling: `[ESTIMATED]`, `[CURRENT AS OF cutoff]`, `[THEORETICAL]`
- **IF** you need to see related code, use Read/Grep tools to go look first
- **IF** something is suspicious but unproven, label as "NEEDS VERIFICATION"
- **PREFER** under-reporting to over-reporting. False positives dilute actionable findings
- **NEVER GUESS.** Investigate with tools first.

### Profitability Focus
- **ALWAYS** quantify financial impact of findings where possible ($ or ETH amounts)
- **ALWAYS** distinguish between "technically broken" and "economically unviable"
- **ALWAYS** consider the flash loan capital model: the system doesn't risk trade capital, only gas
- **FLAG** anything that blocks profitability as P0 regardless of technical severity
- A deployed-but-unprofitable system is worse than an undeployed-but-theoretically-sound one

### Investigation Strategy (all agents)
1. **Read the full file** using Read tool
2. **Search for callers/consumers** using Grep in parallel with reading
3. **Search for similar patterns** using Grep across the codebase
4. **Use TodoWrite** to track findings as you go
5. When investigating across multiple files, launch parallel Grep searches in a single response

### Handling Uncertainty

**Missing Data**: When you can't calculate without data that doesn't exist:
```
"Cannot assess [X] because [specific data] is not available.
To enable this assessment: [what needs to be added/collected]."
```

**Conflicting Evidence**: When code says one thing but config says another:
```
"Code at [file:line] expects [X], but config at [file:line] provides [Y].
Net effect: [what actually happens at runtime]."
```

---

## Execution Plan

### Step 1: Setup
1. Use TodoWrite to create tracking items for each audit phase
2. Use TeamCreate to create the audit team
3. Read sample trade data from `data/trades/` to understand what data exists
4. Quick check: are trade logs from real execution or tests? (This fundamentally shapes the audit)

### Step 2: Parallel Agent Launch
Spawn ALL 7 agents in a **single message** with 7 parallel Task tool calls:

| # | Agent Name | subagent_type | model | Focus |
|---|-----------|---------------|-------|-------|
| 1 | trade-data-analyst | general-purpose | opus | Actual P&L, win rates, slippage, patterns |
| 2 | strategy-economics-evaluator | general-purpose | opus | Fee stacks, thresholds, market viability |
| 3 | contract-capital-assessor | general-purpose | opus | Deployments, flash loans, capital config |
| 4 | architecture-maturity-evaluator | Explore | opus | ADRs, feature flags, service readiness |
| 5 | risk-calibration-auditor | general-purpose | opus | Risk parameters, circuit breakers, edge cases |
| 6 | competitive-edge-analyst | general-purpose | opus | Latency, MEV, competition, alpha decay |
| 7 | data-integrity-verifier | general-purpose | opus | Analytics accuracy, monitoring reliability |

Each agent prompt MUST include (keep under 300 lines total):
- **First line**: The SendMessage report-back instruction (see Agent Resilience Protocol)
- Their specific focus areas and deliverable format
- Key quality gates
- Brief summary of Critical Rules
- Instruction to use TodoWrite for progress tracking

### Step 3: Agent Activation & Stall Detection
After spawning all 7 agents:
1. Send each agent an activation message with specific files to start reading
2. Wait up to **2 minutes** for agents to respond via SendMessage
3. Track which agents have reported vs not
4. For any agent unresponsive after 2 minutes: **abandon it and do that agent's work yourself**
5. Do NOT send multiple nudge messages — they rarely work and waste time

**Self-execution is always faster than waiting for a stalled agent.** With 7 agents, expect 2-3 to stall.

### Step 4: Cross-Agent Synthesis
After ALL agents complete (or Step 3 timeout reached):
1. Collect all findings from all 7 agents
2. **Cross-reference for high-confidence findings**: If Agent 2 (economics) says a strategy is unviable AND Agent 1 (data) shows zero trades for it AND Agent 4 (architecture) shows it's feature-flagged OFF — that's a triple-confirmed dead strategy
3. **Validate data quality first**: Use Agent 7's findings to caveat other agents' conclusions. If Agent 7 says trade data is simulated, Agent 1's P&L numbers are meaningless for production profitability
4. **Layer findings**: Start with Agent 3 (are contracts deployed?) → Agent 4 (is the system complete?) → Agent 2 (can strategies profit?) → Agent 5 (are risks calibrated?) → Agent 6 (can we compete?) → Agent 1 (what actually happened?)
5. Score and prioritize using the Priority Formula
6. Produce the unified Profitability Assessment Report

**Priority Scoring Formula**:
```
Score = (Revenue_Impact x 0.4) + (Feasibility x 0.3) + ((5 - Risk) x 0.3)
```
Where Revenue_Impact = estimated $ improvement, Feasibility = ease of implementation, Risk = probability of regression. Each 1-5 scale.

---

## Output Format

### Profitability Assessment Report

#### Executive Summary
- **Overall Grade**: A-F with justification
- **Profitability Verdict**: PROFITABLE / MARGINALLY PROFITABLE / NOT YET PROFITABLE / CANNOT ASSESS
- **Data Quality Warning**: [If trade data is simulated/test, state this prominently]
- **Top 3 Profitability Blockers** (1-sentence each)
- **Top 3 Unrealized Optimizations** (1-sentence each with estimated $ impact)
- **Deployment Readiness**: PRODUCTION / TESTNET / LOCAL-ONLY / NOT DEPLOYABLE
- **Agent Agreement Map**: Areas where multiple agents converged on the same issue

#### 1. Trade Performance Summary (Agent 1)

| Metric | Value | Assessment |
|--------|-------|------------|
| Total Trades | | |
| Win Rate | | |
| Total P&L | | |
| Profit Factor | | |
| Average Profit/Trade | | |
| Average Slippage | | |
| Data Source | Real / Simulated | |

**Per-Strategy Breakdown**:
| Strategy | Trades | Win Rate | Avg Profit | Total P&L | Assessment |
|----------|--------|----------|------------|-----------|------------|

**Per-Chain Breakdown**:
| Chain | Trades | Success Rate | Avg Gas Cost | Net Profit | Assessment |
|-------|--------|-------------|-------------|------------|------------|

#### 2. Strategy Economic Viability (Agent 2)

| Strategy | Min Spread Needed | Fee Stack | Viable? | Competition | Recommendation |
|----------|------------------|-----------|---------|-------------|----------------|

**Unrealized Optimizations**:
| Optimization | Current Cost | Optimized Cost | Annual Savings (est.) | Effort |
|-------------|-------------|---------------|----------------------|--------|

#### 3. Infrastructure Readiness (Agent 3)

**Contract Deployment Matrix**:
| Contract | Mainnet | Testnet | Strategies Blocked |
|----------|---------|---------|-------------------|

**Flash Loan Coverage Map**:
| Chain | Provider | Fee (bps) | Cheapest Available? | Status |
|-------|----------|-----------|-------------------|--------|

**Capital Configuration Assessment**: [Production-ready / Needs calibration / Placeholder values]

#### 4. System Completeness (Agent 4)

**Feature Flag Impact**:
| Flag | Status | Profitability Impact | Recommendation |
|------|--------|---------------------|----------------|

**ADR Implementation Gaps** (profit-impacting only):
| ADR | Status | Impact | Priority |
|-----|--------|--------|----------|

**Operational Readiness**: [Monitoring active / Configured-only / Not set up]

#### 5. Risk Calibration Assessment (Agent 5)

| Parameter | Current Value | Assessment | Recommended | Rationale |
|-----------|-------------|------------|-------------|-----------|

**Edge Cases Identified**:
| Edge Case | Severity | Impact | Mitigation |
|-----------|----------|--------|------------|

**Risk Stack Verdict**: WELL-CALIBRATED / NEEDS TUNING / MISCALIBRATED / DANGEROUS

#### 6. Competitive Position (Agent 6)

| Dimension | Assessment | vs. Competition | Recommendation |
|-----------|------------|----------------|----------------|
| Latency | | | |
| MEV Protection | | | |
| Strategy Diversity | | | |
| Chain Coverage | | | |
| Capital Efficiency | | | |

**Strategy Competition Matrix**:
| Strategy | Competition Level | Our Advantage | Viable? | Priority |
|----------|-----------------|---------------|---------|----------|

**Recommended Strategic Focus**: [Which chains x strategies to prioritize]

#### 7. Data Integrity Assessment (Agent 7)

| Data Source | Reliability | Issues Found | Impact on Audit |
|------------|------------|-------------|-----------------|

**Analytics Engine Status**: [Reliable / Partially reliable / Placeholder values present]
**Monitoring Status**: [Operational / Configured-only / Not set up]
**Caveat for Other Findings**: [Which conclusions from other agents should be taken with reduced confidence]

#### 8. Cross-Agent Insights
Findings where multiple agents converged from different perspectives:
- [Insight: Agent X found Y, Agent Z found W — together they reveal...]

#### 9. Prioritized Action Plan

**Phase 1: Unblock Trading** (Prerequisites for ANY profitable execution)
- [ ] Action item with agent reference and priority score

**Phase 2: Optimize Economics** (Reduce costs, improve margins)
- [ ] Action item with agent reference and estimated $ impact

**Phase 3: Expand Edge** (New strategies, competitive improvements)
- [ ] Action item with agent reference and priority score

**Phase 4: Harden Operations** (Risk calibration, monitoring, data quality)
- [ ] Action item with agent reference and priority score

---

## Confidence Calibration

All findings MUST use these levels:
- **HIGH (90-100%)**: Verified from code + data + config, specific numbers cited, clear financial impact
- **MEDIUM (70-89%)**: Strong code evidence, but market assumptions or data quality limits certainty
- **LOW (50-69%)**: Code-based inference, not directly observable in data, market conditions may vary
- **NEEDS VERIFICATION (<50%)**: Suspicious but unproven — state what would confirm/deny

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| **A** | Contracts deployed, strategies profitable in production, risk calibrated, monitoring active, competitive on target chains |
| **B** | Mostly deployed, strategies viable but unproven in production, minor calibration needed, monitoring partially active |
| **C** | Partially deployed, strategies theoretically viable but untested, significant calibration gaps, monitoring configured but not running |
| **D** | Not deployed, strategies designed but infrastructure missing, risk parameters are defaults, no monitoring |
| **F** | Fundamental design issues preventing profitability, broken economics, missing critical components |

## Verification Protocol

Before submitting the final report:
- [ ] All 7 agents' findings collected and cross-referenced
- [ ] Data quality assessment (Agent 7) used to caveat other agents' conclusions
- [ ] Financial impact quantified where possible
- [ ] Profitability blockers distinguished from nice-to-haves
- [ ] Recommendations are actionable and ordered by impact
- [ ] Grade is honest and justified against rubric
- [ ] Haven't inflated assessment to be encouraging — honest assessment is more valuable
- [ ] Cross-agent insights identified (where multiple agents found the same issue)

**Remember**: The purpose of this audit is to give an honest, actionable assessment of whether this system can make money. Flattering assessments waste the developer's time. Hard truths save money.

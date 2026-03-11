# Research: Realistic Simulation Mode Enhancement

**Date**: 2026-03-11
**Scope**: Gas, fees, token pairs, whale alerts, swap events, volume aggregates, all strategies, realism mode simplification
**Confidence**: HIGH (based on full code analysis of simulation module + 4 parallel agent investigations)

## 1. Current State Analysis

### What EXISTS and Works Well

The simulation subsystem is already substantial (~2,800 lines across 8 files in `shared/core/src/simulation/`):

| Feature | Quality | Files |
|---------|---------|-------|
| Per-chain throughput profiles (15 chains) | Excellent | `throughput-profiles.ts` (551 lines) |
| Block-driven multi-swap model (Poisson) | Excellent | `chain-simulator.ts:455-499` |
| Market regime model (Markov chain) | Good | `constants.ts:439-467`, `chain-simulator.ts:340-348` |
| Gas model per chain (baseFee/priorityFee/gasUnits) | Good | `types.ts:321-334`, `throughput-profiles.ts` |
| Whale simulation (wallet pool, trade sizes, alerts) | Good | `chain-simulator.ts:597-688` |
| 13 strategy types (weighted distribution) | Good | `constants.ts:350-378`, `chain-simulator.ts:813-996` |
| Multi-hop generation (triangular/quadrilateral) | Good | `chain-simulator.ts:1064-1157` |
| Fast-lane opportunity generation | Good | `chain-simulator.ts:1168-end` |
| Cross-chain simulator with bridge costs | Adequate | `cross-chain-simulator.ts` (342 lines) |
| 3 realism levels (low/medium/high) | Over-engineered | `mode-utils.ts` |
| ~50 token prices, chain-specific pairs | Adequate | `constants.ts:70-330` |
| Flash loan fee from production config | Good | Uses `FLASH_LOAN_PROVIDERS[chain].feeBps` |
| SwapEvent + WhaleAlert emission & publishing | Good | `chain-simulator.ts`, `whale-alert.publisher.ts` |
| Pair activity tiers (3 tiers + defaults) | Good | `constants.ts:303-333` |
| Statistical math utilities (Gaussian, Poisson, weighted) | Good | `math-utils.ts` |

### What's MISSING — Gap Analysis

#### GAP-1: Static Token Prices (HIGH IMPACT)

**Current**: `BASE_PRICES` is a hardcoded `Record<string, number>` with ~50 entries (e.g., `WETH: 3200`, `WBTC: 65000`, `SOL: 175`). Prices are initialized once with ±0.05% random variation per DEX. During simulation, prices evolve via random walk with configurable volatility (`SIMULATION_VOLATILITY`, default 0.02).

**Problems**:
- Base prices are stale — they don't reflect real market conditions
- No correlation between related tokens (e.g., WETH↔stETH should co-move with ~0.998 correlation)
- No price impact from large trades (a $500K whale trade should move the price)
- No mean-reversion for pegged pairs (stETH/ETH, USDC/USDT)
- Random walk has constant volatility — no fat tails, no jump diffusion
- No cross-chain price propagation (ETH price change on Ethereum should propagate to Arbitrum)

**File**: `constants.ts:70-152`, `price-simulator.ts:127-161`, `chain-simulator.ts:549-596`

#### GAP-2: EIP-1559 Gas Price Dynamics (MEDIUM IMPACT)

**Current**: Gas prices are sampled per block via `sampleGasPrice()` using Gaussian distribution around static `baseFeeAvg`/`priorityFeeAvg` with `burstMultiplier` during burst regime. This is adequate but static.

**Problems**:
- No EIP-1559 base fee adjustment algorithm (baseFee adjusts ±12.5% based on block utilization)
- No L1 data fee component for L2 chains (dominant cost on rollups, 30-300x underestimate)
- No L2 blob fee component (post-EIP-4844, L2s pay blob data costs that fluctuate)
- No Solana priority fee market dynamics (Jito tips, local fee markets per account)
- No time-of-day gas patterns (gas is 30-50% cheaper at 3-5am UTC vs peak hours)
- Priority fee doesn't correlate with opportunity value (real MEV searchers bid more for profitable opps)

**File**: `chain-simulator.ts:505-521`, `throughput-profiles.ts` gasModel sections

#### GAP-3: No Token Price Correlation or Impact (HIGH IMPACT)

**Current**: Each pair's price evolves independently via random walk. No relationship between WETH/USDC and WETH/USDT prices, no correlation between stETH and WETH.

**Problems**:
- Unrealistic arbitrage patterns — real arb comes from correlated price divergence, not random noise
- Whale trades don't affect pool reserves (trade size is tracked but doesn't modify AMM state proportionally)
- No constant-product AMM simulation for price impact (`x * y = k` should determine slippage)
- Stablecoin pairs (USDC/USDT) can drift ±2% which is extremely unrealistic

**File**: `chain-simulator.ts:549-596` (executeSwap), `chain-simulator.ts:248-265` (initializeReserves)

#### GAP-4: Volume Aggregates Not Published in Simulation (MEDIUM IMPACT)

**Current**: `SwapEventFilter` has full volume aggregation logic (5-second buckets, per-pair, with min/max/avg price). `PublishingService` supports `'volume-aggregate'` message type. The Redis stream `stream:volume-aggregates` exists with MAXLEN 10,000.

**Problem**: In simulation mode, swap events go: `ChainSimulator.emit('swapEvent')` → `WhaleAlertPublisher.publishSwapEvent()` → `stream:swap-events`. They bypass `SwapEventFilter` entirely, so no `VolumeAggregate` objects are produced. The cross-chain detector consumes `stream:volume-aggregates` but it's empty in simulation mode.

**File**: `chain-simulator.ts:580`, `simulation-initializer.ts:287-294`, `swap-event-filter.ts:535-655`

#### GAP-5: Strategy-Specific Simulation Shallow (MEDIUM-HIGH IMPACT)

**Current**: All 13 strategy types are covered via `selectWeightedStrategyType()`, but most types generate generic opportunity objects with only the `type` field and confidence/expiry adjusted.

| Strategy | Simulation Depth | What's Missing |
|----------|-----------------|----------------|
| `simple` | Basic | No V2/V3 pool type distinction |
| `cross-dex` | Good | — |
| `intra-dex` | Basic | No same-DEX different-pool-type simulation |
| `cross-chain` | **Broken** | Type remapped to `cross-dex` in `buildTypedOpportunity` — CrossChainStrategy never exercised |
| `flash-loan` | Good | Uses real `FLASH_LOAN_PROVIDERS` fees |
| `triangular` | Good | Random token path, no liquidity validation |
| `quadrilateral` | Good | Random token path |
| `multi-leg` | **Dead** | No `StrategyType` mapping in `strategy-factory.ts` — always rejected |
| `backrun` | **Broken** | Never populates `opportunity.backrunTarget` — BackrunStrategy always skips |
| `uniswapx` | **Broken** | Never populates `opportunity.uniswapxOrder` — UniswapXFillerStrategy always skips |
| `statistical` | Stub | No mean-reversion/cointegration model |
| `predictive` | **Dead** | No `StrategyType` mapping in `strategy-factory.ts` — always rejected |
| `solana` | Basic | No Jito bundle dynamics, no CPI cost model |

**File**: `chain-simulator.ts:813-996`, `services/execution-engine/src/strategies/strategy-factory.ts`

#### GAP-6: No Temporal Trading Patterns (LOW-MEDIUM IMPACT)

**Current**: All hours are simulated equally. No distinction between Asian/European/US trading sessions. No weekend volume reduction.

**Problem**: Real DeFi has strong temporal patterns:
- Asian session (00-08 UTC): BSC/Polygon peak
- European session (08-16 UTC): Ethereum/Arbitrum peak
- US session (16-00 UTC): Peak volume everywhere
- Weekends: 30-40% lower volume

**File**: `chain-simulator.ts:455-499` (simulateBlock has no time awareness)

#### GAP-7: Emerging L2 Placeholder DEXes (LOW IMPACT)

**Current**: Blast, Scroll, Mantle, Mode all use `['aerodrome', 'uniswap_v3', 'baseswap']` as DEX names — these are Base chain DEXes, not the actual DEXes on those chains. No chain-specific pairs defined for these chains.

**Real DEXes**: Blast (Thruster, BladeSwap, Ring), Scroll (Ambient, NURI, Zebra), Mantle (Agni, FusionX, Merchant Moe), Mode (Kim, SupSwap, SwapMode)

**File**: `constants.ts:231-234`, `constants.ts:163-206` (missing entries for emerging chains)

#### GAP-8: Cross-Chain Bridge Cost Divergence (LOW-MEDIUM IMPACT)

**Current**: `CrossChainSimulator` uses `DEFAULT_BRIDGE_COSTS` in `constants.ts` which diverge significantly from production `bridge-config.ts`:

| Route | Simulation Fixed Cost | Production Min Fee | Simulation Time | Production Latency |
|-------|----------------------|-------------------|-----------------|-------------------|
| ethereum→arbitrum | $15 | $1 (Stargate), $2 (Across) | 600s | 180s |
| arbitrum→base | $4 | $0.3 | 120s | 90s |

Bridge costs in simulation are 5-15x higher than production, and latencies are 2-3x longer.

**File**: `constants.ts:248-286` vs `shared/config/src/bridge-config.ts:63-98`

#### GAP-9: Mantle Native Token Pricing Bug (P0 — 80,000x Gas Error)

**Current**: `throughput-profiles.ts` maps Mantle's native token to `WETH` ($3,200) via `NATIVE_TOKENS` or gas model config. Mantle's actual native token is MNT (~$0.04). This means gas cost calculations for Mantle are off by ~80,000x.

**Impact**: Every Mantle opportunity's gas cost is wildly inflated, making all Mantle arb opportunities appear unprofitable. No Mantle opportunity would ever pass profitability checks.

**File**: `throughput-profiles.ts` (NATIVE_TOKENS or gasModel for mantle)

#### GAP-10: DEX Fee Overestimate (MEDIUM IMPACT)

**Current**: Simulation uses `FEE_CONSTANTS.DEFAULT` (0.003 = 0.3%) for all DEXes. Real Uniswap V3 WETH/USDC pool uses 0.05% fee tier — a 6x overestimate. Uniswap V3 has 4 tiers (0.01%, 0.05%, 0.3%, 1%).

**Impact**: All profit calculations are inflated by excess DEX fees, making the simulation systematically pessimistic on blue-chip pairs.

**File**: `chain-simulator.ts` (fee handling in opportunity generation), `shared/core/src/utils/fee-utils.ts`

#### GAP-11: Non-EVM Simulation Produces No SwapEvent/WhaleAlert Data

**Current**: The non-EVM (Solana) simulation path in `ChainSimulationHandler.initializeNonEvmSimulation()` creates a `ChainSimulator` with callbacks, but the Solana simulator doesn't wire `onSwapEvent` or `onWhaleAlert` callbacks. Zero swap events or whale alerts are generated for Solana.

**Impact**: Dashboard shows no swap/whale activity for Solana. Volume aggregates for Solana are always empty.

**File**: `services/unified-detector/src/simulation/chain.simulator.ts`

#### GAP-12: Realism Levels Over-Engineered (SIMPLIFICATION OPPORTUNITY)

**Current**: Three realism levels (`low`/`medium`/`high`) with branching logic scattered across 4 source files (chain-simulator.ts, price-simulator.ts, cross-chain-simulator.ts, mode-utils.ts) and 8+ test files.

**Problem**: The `low` mode is a legacy flat-interval mode that provides no value — it doesn't exercise the block-driven model, Poisson swaps, activity tiers, regime transitions, or full strategy distribution. The `medium` mode is identical to `high` except it doesn't enable Markov regime transitions (always uses `normal` multipliers). The behavioral difference between medium and high is minimal (only regime transitions). All three modes add branching complexity for no practical benefit — only `high` (realistic) mode should exist.

**Details**: See Section 9 below for full removal analysis.

---

## 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **A: Live Price Bootstrap + Correlated Random Walk** | Wintermute, Jump Crypto backtesting | Realistic starting point, correlations maintained | Requires API call on startup, stale after hours | 3 days |
| **B: Replay Historical Data (recorded DEX events)** | Flashbots research, MEV-Boost | Most realistic, deterministic replay | Requires data collection infra, large storage | 10+ days |
| **C: AMM Simulation (constant product/concentrated liquidity)** | Uniswap V3 simulator, DeFi Llama | Realistic price impact and slippage | Complex math, V3 tick-range simulation is hard | 5-7 days |
| **D: Agent-Based Market Simulation** | Academic research, Gauntlet | Emergent behavior, realistic dynamics | Extremely complex, hard to calibrate | 15+ days |
| **E: Incremental Enhancement (fix gaps in existing model)** | Pragmatic approach | Builds on solid foundation, low risk | Not "research-grade" realistic | 5-8 days total |

## 3. Recommended Solution

**Approach**: E — Incremental Enhancement, organized in 5 priority batches (was 4; added Batch 0 for cleanup/fixes)

**Confidence**: HIGH

**Justification**: The existing simulation is already sophisticated (block-driven, Poisson, Markov regime, per-chain profiles). The gaps are specific and well-defined. A full rewrite (B, C, D) would be massive effort for marginal benefit over targeted fixes. Approach A (live price bootstrap) is a quick win that can be combined with E.

**ADR Compatibility**: No conflicts. All changes are within the simulation module boundary. No hot-path impact (simulation code doesn't run in production).

---

## 4. Implementation Plan

### Batch 0: Critical Fixes & Simplification (HIGH IMPACT, 1-2 days)

This batch removes the low/medium realism modes (keeping only realistic/high behavior), fixes P0 bugs, and cleans up broken strategy routing.

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 0.1 | **Remove low/medium realism modes**: Collapse `SimulationRealismLevel` type to removed. Delete `getSimulationRealismLevel()`. Hardcode all behavior to current `high` paths: always use block-driven model, always enable regime transitions, always use activity tiers, always use weighted strategy selection. Remove `SIMULATION_REALISM_LEVEL` env var. Update 8+ test files. (See Section 9 for full impact analysis.) | 0.5 day | 95% | None | Existing tests updated to remove env var manipulation; all pass with realistic behavior |
| 0.2 | **Fix Mantle native token pricing**: Change NATIVE_TOKENS mapping for mantle from `WETH` to `WMNT`. Add `WMNT` to `BASE_PRICES` if missing (price ~$0.04). Verify gas cost calculations use correct token. | 0.25 day | 95% | None | Unit test: Mantle gas cost in USD is reasonable (~$0.01-0.10, not ~$800) |
| 0.3 | **Fix strategy routing gaps**: In `buildTypedOpportunity()`, populate `backrunTarget` for backrun type, `uniswapxOrder` for uniswapx type, so execution engine strategies don't skip them. Add `multi-leg` and `predictive` to strategy-factory.ts mapping (or map to nearest equivalent: multi-leg→flash-loan, predictive→statistical). Fix cross-chain type remapping. | 0.5 day | 85% | None | Unit test: each of the 13 strategy types produces a valid opportunity that the execution engine can route |
| 0.4 | **Add per-DEX fee tiers**: Replace flat 0.3% default with per-pool fee tiers based on DEX type. V3 pools: select from [0.01%, 0.05%, 0.3%, 1%] weighted by pair type (blue-chip pairs → 0.05%, others → 0.3%). V2 pools: 0.3%. | 0.25 day | 90% | None | Unit test: WETH/USDC on Uniswap V3 uses 0.05% fee, not 0.3% |

**Expected Impact**: Eliminates 80,000x Mantle gas error, enables 4 broken/dead strategy types, removes ~150 lines of branching complexity, corrects 6x fee overestimate on blue-chip pairs.

### Batch 1: Price Realism (HIGH IMPACT, 2-3 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1.1 | **Live price bootstrap**: Add `PriceBootstrapper` class that fetches current prices from CoinGecko free API on simulator startup. Fall back to `BASE_PRICES` if API unavailable. Update `BASE_PRICES` at init time. | 1 day | 90% | None | Unit test with mocked fetch, integration test with fallback |
| 1.2 | **Token correlation groups**: Define correlation matrix (`ETH↔stETH: 0.998`, `ETH↔WBTC: 0.85`, stablecoins: `0.999`). When a token price changes, propagate correlated moves to related tokens. | 1 day | 85% | 1.1 | Unit test correlation propagation, verify stablecoin pegs stay tight |
| 1.3 | **Price impact from trades**: In `executeSwap()`, use constant-product formula `(x + dx)(y - dy) = x*y` to calculate actual reserve changes proportional to trade size (currently uses random walk only). | 0.5 day | 90% | None | Unit test: large trade moves price more than small trade |
| 1.4 | **Mean-reversion for pegged pairs**: Add Ornstein-Uhlenbeck process for stablecoin and LST pairs (stETH/ETH, USDC/USDT). Mean-reverts to 1.0 with configurable speed. | 0.5 day | 85% | 1.2 | Unit test: stETH/ETH ratio stays within ±0.5% |

**Expected Impact**: Profit calculations become realistic (current: ±50% error). Arbitrage patterns emerge from correlated price divergence rather than random noise.

### Batch 2: Gas & Fee Dynamics (MEDIUM IMPACT, 2.5 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 2.1 | **EIP-1559 base fee adjustment**: Track block utilization (swap_count / target_swaps_per_block). Adjust `baseFee` by up to ±12.5% per block based on utilization ratio. Clamp to `[baseFeeAvg * 0.1, baseFeeAvg * 20]`. | 0.5 day | 90% | None | Unit test: consecutive full blocks → rising baseFee |
| 2.2 | **L1 data fee component for L2 chains**: Add `l1DataFeeGwei` to gas model for rollup chains (Arbitrum, Optimism, Base, zkSync, Linea, Scroll, Blast, Mantle, Mode). L1 data fee = `txDataBytes * l1BaseFee * l1FeeScalar`. Add to total gas cost. | 0.5 day | 85% | None | Unit test: L2 gas cost includes L1 data fee component; L2 total > L2 execution-only |
| 2.3 | **Time-of-day gas multiplier**: Add hourly multiplier array (24 entries). Peak: 1.5x during 14-18 UTC. Trough: 0.5x during 3-5 UTC. Apply to baseFee sampling. | 0.5 day | 85% | None | Unit test: gas at 3am < gas at 3pm |
| 2.4 | **Bridge cost alignment**: Replace `DEFAULT_BRIDGE_COSTS` in simulation with import from `shared/config/src/bridge-config.ts`. Transform `BridgeRouteConfig` to simulation format. | 0.5 day | 95% | None | Unit test: simulation bridge costs match production |
| 2.5 | **Slippage simulation**: Add slippage calculation based on trade size vs pool liquidity. For position size P and pool TVL L, effective slippage ≈ `P / (2 * L)`. Deduct from profit. | 0.5 day | 80% | None | Unit test: $100K trade in $1M pool → ~5% slippage |

**Expected Impact**: Gas costs realistic to within ±30% (current: ±200% for cross-chain, 30-300x underestimate for L2 data fees). Slippage reduces unrealistic profit estimates.

### Batch 3: Pipeline Completeness (MEDIUM IMPACT, 2 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 3.1 | **Volume aggregate publishing**: In `SimulationInitializer.createSimulationCallbacks()`, route swap events through a `SwapEventFilter` instance before publishing. This generates `VolumeAggregate` objects. Publish aggregates to `stream:volume-aggregates`. | 0.5 day | 90% | None | Integration test: volume aggregates appear in Redis stream |
| 3.2 | **Emerging L2 real DEX names**: Update `DEXES` for Blast (thruster, bladeswap, ring), Scroll (ambient, nuri), Mantle (agni, fusionx), Mode (kim, supswap). Update DEX market share in throughput profiles. | 0.5 day | 95% | None | Existing tests pass, verify chain-specific DEX selection |
| 3.3 | **Emerging L2 chain-specific pairs**: Add `CHAIN_SPECIFIC_PAIRS` entries for Blast (WETH/USDB, BLAST/WETH), Scroll (WETH/USDC, SCR/WETH), Mantle (WMNT/USDC, WMNT/WETH), Mode (MODE/WETH). Add new tokens to `BASE_PRICES` (BLAST, SCR, WMNT, MODE, USDB). | 0.5 day | 90% | None | Unit test: emerging chains have ≥2 pairs each |
| 3.4 | **Non-EVM (Solana) SwapEvent/WhaleAlert generation**: Wire `onSwapEvent` and `onWhaleAlert` callbacks in the non-EVM simulation path. Generate swap events from Solana simulator's pair updates. | 0.5 day | 85% | None | Unit test: Solana simulation produces swap events and whale alerts |

**Expected Impact**: Full pipeline testing (volume aggregates flow to cross-chain detector). Dashboard shows realistic data for all 15 chains including Solana.

### Batch 4: Strategy & Temporal Enrichment (MEDIUM IMPACT, 2-3 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 4.1 | **Backrun MEV-Share simulation**: Generate simulated MEV-Share event hints (tx hash, logs hint) alongside backrun opportunities. Add `mevShareHint` field to `SimulatedOpportunity`. | 0.5 day | 75% | 0.3 | Unit test: backrun opps include hint data |
| 4.2 | **UniswapX Dutch auction decay**: For uniswapx type, generate initial price and decay rate. Add `auctionStartBlock`, `decayRate` fields. Price decreases over blocks until filled. | 0.5 day | 75% | 0.3 | Unit test: opportunity price decays over time |
| 4.3 | **Statistical mean-reversion model**: For statistical type, track z-score of pair price deviation from rolling mean. Generate opportunity when z-score exceeds ±2 σ. | 0.5 day | 80% | 1.2 (correlation) | Unit test: opps generated at extreme deviations |
| 4.4 | **Trading session multipliers**: Add `getSessionMultiplier(chainId: string, hour: number)` returning activity multiplier (0.4-1.5) based on chain's primary trading session. Apply in `simulateBlock()`. | 0.5 day | 90% | None | Unit test: BSC busier during Asian hours |
| 4.5 | **Predictive confidence decay**: For predictive type, set initial high confidence that decays over time (half-life ~30 blocks). Expired predictions auto-fail. | 0.5 day | 85% | 0.3 | Unit test: confidence decreases each block |

**Expected Impact**: Each strategy type exercises its specific execution path realistically. Dashboard shows temporal patterns matching real DeFi.

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| CoinGecko API rate limit (50 req/min free) | MEDIUM | LOW | Cache prices, fall back to `BASE_PRICES`, only fetch on startup |
| Price correlation matrix causes unrealistic lockstep movement | LOW | MEDIUM | Add configurable correlation noise (±5% deviation from correlation) |
| EIP-1559 simulation adds latency to block generation | LOW | LOW | All simulation code is cold-path; no production impact |
| Volume aggregates increase Redis memory | LOW | LOW | Already has MAXLEN 10,000; aggregation reduces volume |
| Slippage calculation makes all opportunities unprofitable | MEDIUM | MEDIUM | Calibrate slippage constant per chain; use realistic pool TVLs from throughput profiles |
| Removing low/medium breaks test expectations | LOW | LOW | Tests already use `high` in `.env.local`; update test env vars in affected files |
| L1 data fee makes all L2 opportunities appear unprofitable | LOW | MEDIUM | Use realistic L1 base fee (~30 gwei) and fee scalar from chain config |

---

## 6. Success Metrics

- [ ] Token prices within 5% of real market on startup (currently: ±20-50% stale)
- [ ] Gas costs within 30% of real chain gas (currently: adequate for most chains, ±200% for cross-chain bridge costs)
- [ ] L2 gas costs include L1 data fee component (currently: missing entirely)
- [ ] Mantle gas costs are in MNT not WETH (currently: 80,000x overestimate)
- [ ] All 15 chains have ≥2 chain-specific pairs (currently: 4 chains have only generic pairs)
- [ ] Volume aggregates appear in `stream:volume-aggregates` during simulation (currently: empty)
- [ ] All 13 strategy types produce routable opportunities (currently: 4 are broken/dead)
- [ ] Cross-chain bridge costs match production config within 10% (currently: 5-15x divergence)
- [ ] Stablecoin pair prices stay within ±0.5% of $1.00 peg (currently: can drift ±2%)
- [ ] Dashboard shows time-of-day activity patterns (currently: flat)
- [ ] No `SIMULATION_REALISM_LEVEL` env var needed (currently: 3 modes with branching in 4 files)
- [ ] Solana simulation generates swap events and whale alerts (currently: zero)

---

## 7. ADR Recommendation

**New ADR Needed?**: No — this is an enhancement to existing simulation infrastructure, not an architectural change.

**Documentation Update**: Update `docs/CONFIGURATION.md` simulation section:
- Remove `SIMULATION_REALISM_LEVEL` env var documentation
- Add `SIMULATION_PRICE_BOOTSTRAP=true|false` — enable CoinGecko price fetch
- Add `SIMULATION_COINGECKO_API_KEY` — optional API key for higher rate limits
- Add `SIMULATION_SESSION_PATTERNS=true|false` — enable time-of-day multipliers
- Add `SIMULATION_SLIPPAGE_MODEL=true|false` — enable AMM slippage simulation

---

## 8. File Impact Summary

### New Files (0)
None — all enhancements fit within existing module structure.

### Modified Files

| File | Changes | Batch |
|------|---------|-------|
| `shared/core/src/simulation/mode-utils.ts` | Remove `getSimulationRealismLevel()`, remove `SimulationRealismLevel` import | 0.1 |
| `shared/core/src/simulation/types.ts` | Remove `SimulationRealismLevel` type. Add `mevShareHint`, `auctionStartBlock`, `decayRate`, `zScore`, `backrunTarget`, `uniswapxOrder` fields | 0.1, 0.3, 4.1-4.3 |
| `shared/core/src/simulation/index.ts` | Remove `SimulationRealismLevel` and `getSimulationRealismLevel` exports | 0.1 |
| `shared/core/src/simulation/chain-simulator.ts` | Remove all realism branching (always block-driven + regime + tiers). Fix strategy metadata. Price impact in executeSwap. EIP-1559 baseFee. Slippage. Session multiplier. Per-DEX fees. | 0.1, 0.3, 0.4, 1.3, 2.1, 2.5, 4.1-4.5 |
| `shared/core/src/simulation/price-simulator.ts` | Remove realism branching (always block-driven). Correlation propagation. Mean-reversion. | 0.1, 1.2, 1.4 |
| `shared/core/src/simulation/cross-chain-simulator.ts` | Remove realism branching. Import production bridge config. | 0.1, 2.4 |
| `shared/core/src/simulation/constants.ts` | Add correlation matrix, session multipliers, emerging L2 DEXes/pairs, new token prices (BLAST, SCR, WMNT, MODE, USDB) | 1.2, 3.2, 3.3, 4.4 |
| `shared/core/src/simulation/throughput-profiles.ts` | Fix Mantle native token. Emerging L2 DEX market share. L1 data fee config. | 0.2, 2.2, 3.2 |
| `services/unified-detector/src/simulation-initializer.ts` | Route swap events through SwapEventFilter for volume aggregation | 3.1 |
| `services/unified-detector/src/simulation/chain.simulator.ts` | Wire non-EVM SwapEvent/WhaleAlert callbacks | 3.4 |
| `services/execution-engine/src/strategies/strategy-factory.ts` | Add multi-leg and predictive strategy mappings | 0.3 |
| `.env.example` | Remove SIMULATION_REALISM_LEVEL. Add SIMULATION_PRICE_BOOTSTRAP, SIMULATION_SESSION_PATTERNS | 0.1 |
| `docs/CONFIGURATION.md` | Update simulation section | 0.1 |
| 8+ test files | Remove `SIMULATION_REALISM_LEVEL` env var manipulation, update assertions | 0.1 |

### Estimated Total: 10-13 days across 5 batches

**Recommended execution order**: Batch 0 → Batch 1 → Batch 2 → Batch 3 → Batch 4 (each batch is independently shippable)

---

## 9. Realism Mode Removal Analysis

### Current Architecture

`SimulationRealismLevel` is a union type `'low' | 'medium' | 'high'` checked via `getSimulationRealismLevel()` which reads `SIMULATION_REALISM_LEVEL` env var (defaults to `'medium'`).

The three modes create branching in 4 source files:

| File | Low Behavior | Medium Behavior | High Behavior |
|------|-------------|-----------------|---------------|
| `chain-simulator.ts:start()` | Legacy `setInterval` (flat 1000ms) | Block-driven `scheduleNextBlock()` | Same as medium |
| `chain-simulator.ts:simulateTick()` | No regime transitions, `REGIME_CONFIGS['normal']` | No regime transitions, `REGIME_CONFIGS['normal']` | Markov regime transitions, `REGIME_CONFIGS[currentRegime]` |
| `chain-simulator.ts:simulateTick()` | No activity tiers (all pairs every tick) | Activity tiers enabled | Same as medium |
| `chain-simulator.ts:simulateBlock()` | N/A (not used in low) | No regime transitions | Markov regime transitions |
| `chain-simulator.ts:executeSwap()` | `REGIME_CONFIGS['normal']` | `REGIME_CONFIGS['normal']` | `REGIME_CONFIGS[currentRegime]` |
| `chain-simulator.ts:createOpportunityWithType()` | Legacy 70/30 cross-dex/flash-loan | Weighted strategy selection (all 13 types) | Same as medium |
| `price-simulator.ts:start()` | Legacy `setInterval` | Block-driven scheduling | Same as medium |
| `cross-chain-simulator.ts:start()` | Config interval (1000ms) | 5000ms interval | Same as medium |

### Behavioral Difference Summary

- **Low → Medium**: Major behavioral change (flat interval → block-driven, no tiers → tiers, 2 strategies → 13)
- **Medium → High**: Minor behavioral change (only adds Markov regime transitions)

### What Gets Simplified

Removing low/medium and hardcoding high behavior eliminates:

1. **~15 `getSimulationRealismLevel()` calls** across chain-simulator.ts, price-simulator.ts, cross-chain-simulator.ts
2. **~30 lines of conditional branching** (`if (realismLevel === 'low')`, `if (realismLevel === 'high')`, ternaries)
3. **`getEffectiveInterval()` method** (28 lines) — block time is always used
4. **`simulateTick()` method** — only used by low mode's `setInterval` path; can be removed (block-driven `simulateBlock()` handles medium/high)
5. **`SimulationRealismLevel` type** and `getSimulationRealismLevel()` function
6. **Test complexity**: 8+ test files set `process.env.SIMULATION_REALISM_LEVEL` and test different behaviors per level

### Files Requiring Changes

#### Source Files (4)

| File | Lines | Change |
|------|-------|--------|
| `shared/core/src/simulation/mode-utils.ts` | ~5 lines removed | Delete `getSimulationRealismLevel()`, remove `SimulationRealismLevel` import |
| `shared/core/src/simulation/types.ts` | 1 line removed | Delete `SimulationRealismLevel` type |
| `shared/core/src/simulation/index.ts` | 2 lines removed | Remove re-exports |
| `shared/core/src/simulation/chain-simulator.ts` | ~80 lines simplified | Remove all `realismLevel` checks. Always use block-driven model. Always enable regime transitions. Always use activity tiers. Always use weighted strategy selection. Remove `simulateTick()` and `getEffectiveInterval()` methods. |
| `shared/core/src/simulation/price-simulator.ts` | ~10 lines simplified | Remove `realismLevel` check in `start()`. Always use block-driven scheduling. |
| `shared/core/src/simulation/cross-chain-simulator.ts` | ~8 lines simplified | Remove `realismLevel` check. Always use 5000ms interval. |

#### Test Files (8+)

| File | Change |
|------|--------|
| `shared/core/__tests__/unit/simulation/mode-utils.test.ts` | Remove `getSimulationRealismLevel` tests (lines 80-102) |
| `shared/core/__tests__/unit/simulation/chain-simulator-throughput.test.ts` | Remove `SIMULATION_REALISM_LEVEL` env var setup; update assertions |
| `shared/core/__tests__/unit/simulation/chain-simulator-fast-lane.test.ts` | Remove low/medium env var toggles |
| `shared/core/__tests__/unit/simulation/chain-simulator-whale-events.test.ts` | Remove env var setup (was setting to 'medium') |
| `shared/core/__tests__/unit/simulation/price-simulator.test.ts` | Remove low-mode env var |
| `shared/core/__tests__/unit/cross-chain-simulator.test.ts` | Remove low-mode env var |
| `shared/core/__tests__/unit/chain-simulator-multi-hop.test.ts` | Remove low-mode env var |
| `services/unified-detector/__tests__/unit/chain-simulation-handler.test.ts` | Remove low-mode env var |
| `services/unified-detector/__tests__/integration/whale-pipeline.integration.test.ts` | Remove medium-mode env var |

#### Config/Doc Files (3+)

| File | Change |
|------|--------|
| `.env.example` | Remove `SIMULATION_REALISM_LEVEL=high` line |
| `.env.local` | Remove `SIMULATION_REALISM_LEVEL=high` line |
| `docs/CONFIGURATION.md` | Remove `SIMULATION_REALISM_LEVEL` row from env var table |
| `.claude/commands/monitoring/03-startup.md` | Remove realism level override instructions |
| `.claude/commands/autopilot.md` | Remove realism level reference |
| `scripts/measure-simulation-throughput.ts` | Remove realism level env var setup and logging |

### Migration Path

1. Since `.env.local` already has `SIMULATION_REALISM_LEVEL=high`, current behavior is already "high" in practice
2. No external consumers depend on the realism level — it's purely internal simulation config
3. The `SIMULATION_UPDATE_INTERVAL_MS` env var override is kept (useful for testing/benchmarking) — it bypasses block-driven scheduling regardless of realism level

### Risk Assessment

**Risk**: LOW. The `.env.local` already runs with `high`. No production code references realism levels. All changes are within the simulation cold path.

**Confidence**: 95%. This is a straightforward dead-code removal + constant folding exercise.

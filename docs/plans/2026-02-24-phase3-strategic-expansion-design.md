# Phase 3: Strategic Expansion Design

> **Date:** 2026-02-24
> **Scope:** 6 items (#28-#33) from Deep Enhancement Analysis Phase 3
> **Approach:** Sequential by readiness, parallelizable within groups

---

## Items Overview

| # | Item | Readiness | Priority |
|---|------|-----------|----------|
| 30 | DAI Flash Minting | ~95% (provider done) | Group 1 |
| 33 | Emerging L2s (Blast, Scroll, Mantle, Mode) | 0% (config-only) | Group 1 |
| 29 | Solana Execution (Jito Bundles) | ~70% (detection + Jito done) | Group 2 |
| 31 | Statistical Arbitrage Module | ~40% (analytics done) | Group 3 |
| 32 | CEX Price Signals (Binance) | 0% (new pipeline) | Group 3 |
| 28 | CoW Protocol Watch-Only + Backrun | 0% (new source) | Group 4 |

---

## Architecture

```
                          ┌────────────────────────────────┐
                          │     NEW DATA SOURCES           │
                          │                                │
                          │  #32 Binance WS Price Feed ────┼──► PriceMatrix (L1 cache)
                          │  #28 CoW Settlement Watcher ───┼──► BackrunStrategy (existing)
                          └────────────────────────────────┘
                                        │
    ┌───────────────────────────────────┼───────────────────────────────────┐
    │                    DETECTION LAYER                                    │
    │                                                                       │
    │  Existing: P1-P4 partitions detect DEX-to-DEX arbitrage              │
    │  #31 NEW: StatisticalArbitrageDetector (correlated-pair z-score)     │
    │  #32 NEW: CexDexSpreadDetector (Binance vs DEX spread)              │
    └───────────────────────────────────┼───────────────────────────────────┘
                                        │ Redis Streams
    ┌───────────────────────────────────┼───────────────────────────────────┐
    │                    EXECUTION LAYER                                    │
    │                                                                       │
    │  Existing: FlashLoanStrategy, IntraChainStrategy, CrossChainStrategy │
    │  #30: DAI Flash Mint (provider DONE, needs contract + e2e test)      │
    │  #31 NEW: StatisticalArbitrageStrategy                               │
    │  #29 NEW: SolanaExecutionStrategy (Jupiter API + Jito bundles)       │
    └───────────────────────────────────┼───────────────────────────────────┘
                                        │
    ┌───────────────────────────────────┼───────────────────────────────────┐
    │                    CHAIN LAYER                                        │
    │                                                                       │
    │  Existing: 11 chains                                                 │
    │  #29: Solana upgraded to full execution                              │
    │  #33 NEW: Blast, Scroll, Mantle, Mode (4 new L2s)                   │
    └──────────────────────────────────────────────────────────────────────┘
```

All new items plug into existing abstractions (strategies, providers, chain configs, detectors). No new architectural paradigms.

---

## Item #30: DAI Flash Minting (Finish Wiring)

### Current State
- `DaiFlashMintProvider` at `services/execution-engine/src/strategies/flash-loan-providers/dai-flash-mint.provider.ts` -- COMPLETE
- Registered in `FlashLoanProviderFactory` -- COMPLETE
- Config: `dai_flash_mint: true` for Ethereum in `flash-loan-availability.ts` -- COMPLETE
- `FLASH_LOAN_PROVIDERS.ethereum` has `dai_flash_mint` entry -- COMPLETE

### What's Missing
1. **Contract:** No `DaiFlashMintArbitrage.sol`. DAI flash mint uses EIP-3156 (`onFlashLoan` callback), same interface as SyncSwap.
2. **Integration test:** No test verifying provider factory creates DAI provider on Ethereum.

### Design
- `contracts/src/DaiFlashMintArbitrage.sol` -- Extends `BaseFlashArbitrage`, implements IERC3156FlashBorrower `onFlashLoan` callback. Near-identical to `SyncSwapFlashArbitrage.sol` pattern (~80 lines).
- `contracts/src/mocks/MockDssFlash.sol` -- Mock for DssFlash contract (EIP-3156 lender).
- `contracts/test/DaiFlashMintArbitrage.test.ts` -- Hardhat tests: callback security, profit verification, fee handling.
- `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/dai-flash-mint.provider.test.ts` -- Jest provider tests.

### Key Details
- DssFlash contract: `0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853`
- DAI address: `0x6B175474E89094C44Da98b954EedeAC495271d0F`
- Fee: 1 bps (0.01%) -- cheapest flash loan source
- Ethereum mainnet only

---

## Item #29: Solana Execution with Jito Bundles

### Current State
- Detection: `SolanaArbitrageDetector` fully operational (7 DEXs, cross-chain comparison)
- Jito: `JitoProvider` at `shared/core/src/mev-protection/jito-provider.ts` -- bundle submission, simulation, tip accounts
- Missing: Execution engine, transaction building, Jupiter integration

### Design

```
partition-solana (P4)
  │ detects opportunities → Redis Stream: arb:opportunities:solana
  ▼
SolanaExecutionStrategy
  ├── JupiterSwapClient
  │    - GET /quote → route + expected output
  │    - POST /swap → serialized versioned transaction
  │    - Retry with slippage adjustment on quote expiry
  ├── SolanaTransactionBuilder
  │    - Compose: compute budget + Jupiter swap + Jito tip transfer
  │    - Versioned transaction (v0) with address lookup tables
  │    - Compute unit estimation via simulateTransaction
  ├── JitoProvider (existing)
  │    - Bundle simulation before submission
  │    - Bundle submission to Block Engine
  │    - Status polling + fallback to public RPC
  └── SolanaRiskManager
       - Slippage: abort if quote deviates >1% from detection-time price
       - Min profit: configurable SOL threshold (after tip deduction)
       - Rate limit: respect Solana 100 TPS per IP
```

### New Files
- `services/execution-engine/src/strategies/solana-execution.strategy.ts`
- `services/execution-engine/src/solana/jupiter-client.ts` -- Jupiter V6 API client
- `services/execution-engine/src/solana/transaction-builder.ts` -- Solana tx composition
- `shared/types/src/solana.ts` -- Extended Solana types

### Strategy Factory Changes
- Add `'solana'` to `StrategyType` union
- Add `registerSolanaStrategy()` method
- Resolution: `chain === 'solana'` routes to SolanaExecutionStrategy

### Config Changes
- Add `'solana'` to `SUPPORTED_EXECUTION_CHAINS` in `service-config.ts`
- Add Solana-specific execution config (Jupiter API URL, tip amount, slippage tolerance)

### Dependencies
- `@solana/web3.js` (already in partition-solana package.json)
- `@solana/spl-token` (for SPL token account creation)

---

## Item #31: Statistical Arbitrage Module

### Current State
- `PriceMomentumTracker` (price-momentum.ts): EMA, z-score, velocity, acceleration -- COMPLETE
- `PairActivityTracker` (pair-activity-tracker.ts): volatility ranking -- COMPLETE
- `MLOpportunityScorer` (ml-opportunity-scorer.ts): scoring framework -- COMPLETE
- Missing: pair correlation, spread tracking, regime detection, strategy class

### Design

```
PriceMomentumTracker (existing)          PairActivityTracker (existing)
  │ z-score, EMA, velocity                 │ volatility, volume ranking
  └──────────┬──────────────────────────────┘
             ▼
   StatisticalArbitrageDetector (new)
     ├── PairCorrelationTracker
     │    - Rolling Pearson correlation (60-sample window)
     │    - Simplified cointegration (Engle-Granger via OLS residual stationarity)
     │    - Pair universe: WETH/WBTC, USDC/USDT, USDC/DAI, stETH/rETH, stETH/WETH
     ├── SpreadTracker
     │    - Spread = log(price_A / price_B)
     │    - Bollinger Bands (20-period, 2σ)
     │    - Entry signal: spread crosses ±2σ
     │    - Exit signal: spread returns to mean (0σ)
     └── RegimeDetector
          - Hurst exponent estimation (rescaled range method)
          - H < 0.5: mean-reverting (stat arb favorable)
          - H > 0.5: trending (suppress stat arb signals)
          - 100-sample rolling window
```

### Execution Flow
1. SpreadTracker monitors pair spreads continuously via PriceMatrix
2. Spread crosses ±2σ → generate `StatArbSignal`
3. RegimeDetector confirms mean-reverting regime (Hurst < 0.5)
4. PairCorrelationTracker confirms correlation > 0.7
5. Publish `ArbitrageOpportunity` with `type: 'statistical'`
6. `StatisticalArbitrageStrategy` executes:
   - Long the undervalued side (DEX swap)
   - Short the overvalued side (flash loan borrow + sell)
   - Wait for mean reversion, close position

### New Files
- `shared/core/src/analytics/pair-correlation-tracker.ts` -- Pearson + cointegration
- `shared/core/src/analytics/spread-tracker.ts` -- Bollinger Bands on log spreads
- `shared/core/src/analytics/regime-detector.ts` -- Hurst exponent
- `shared/core/src/detector/statistical-arbitrage-detector.ts` -- Signal generation
- `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts`

### Strategy Factory Changes
- Add `'statistical'` to `StrategyType` union
- Add `registerStatisticalStrategy()` method
- Resolution: `opportunity.type === 'statistical'`

### Target Pairs (Initial)
| Pair | Expected Correlation | Spread Std Dev | Chain |
|------|---------------------|----------------|-------|
| WETH/WBTC | 0.85-0.95 | ~0.5-1.5% | Ethereum, Arbitrum |
| USDC/USDT | 0.99+ | ~0.01-0.05% | All chains |
| USDC/DAI | 0.99+ | ~0.01-0.1% | Ethereum |
| stETH/WETH | 0.99+ | ~0.05-0.3% | Ethereum |
| rETH/WETH | 0.98+ | ~0.1-0.5% | Ethereum |

---

## Item #32: CEX Price Signals (Binance, Read-Only)

### Design

```
BinanceWebSocketClient
  │ wss://stream.binance.com:9443/ws
  │ Combined stream: btcusdt@trade, ethusdt@trade, ...
  ├── CexPriceNormalizer
  │    - Map Binance symbols → internal token IDs
  │    - USDT-denominated → USD-normalized
  │    - Handle Binance precision (8 decimals price, 8 qty)
  ├── CexDexSpreadCalculator
  │    - Compare Binance mid vs best DEX price
  │    - Rolling 5-min spread history
  │    - Alert when CEX-DEX spread > threshold (configurable, default 0.3%)
  └── PriceMatrix integration
       - Write CEX prices to dedicated PriceMatrix slots
       - New price source flag: 'cex_binance'
       - Detection pipeline uses CEX as "fair value" reference
```

### New Files
- `shared/core/src/feeds/binance-ws-client.ts` -- WebSocket with auto-reconnect, heartbeat
- `shared/core/src/feeds/cex-price-normalizer.ts` -- Symbol mapping + normalization
- `shared/core/src/analytics/cex-dex-spread.ts` -- Spread calculation + alerting

### Binance Pairs (Initial)
BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, AVAXUSDT, MATICUSDT, ARBUSDT, OPUSDT

These cover the native tokens of supported chains for maximum detection overlap.

### Integration Points
- PriceMatrix: CEX prices as new source (adds `cex` origin flag)
- Detection: DEX price vs CEX "fair value" pre-filtering
- Statistical Arb (#31): CEX prices for faster signal generation
- Feature flag: `FEATURE_CEX_PRICE_SIGNALS=true` for opt-in

---

## Item #33: Emerging L2s (Blast, Scroll, Mantle, Mode)

### Per-Chain Configuration

| Component | File | Change |
|-----------|------|--------|
| Chain registry | `shared/config/src/chains/index.ts` | Add 4 chain entries |
| DEX registry | `shared/config/src/dexes/index.ts` | Add 12-16 DEX entries |
| Token config | `shared/config/src/tokens/index.ts` | Add token addresses per chain |
| Flash loans | `shared/config/src/flash-loan-availability.ts` | Per-chain availability |
| Chain IDs | `shared/config/src/service-config.ts` | Add to `MAINNET_CHAIN_IDS` |
| Partitions | `shared/config/src/partitions.ts` | Assign to P2 (L2 partition) |
| Execution | `shared/config/src/service-config.ts` | Add to `SUPPORTED_EXECUTION_CHAINS` |
| MEV config | `shared/config/src/mev-config.ts` | Sequencer strategy for all 4 |
| Cross-chain | `shared/config/src/cross-chain.ts` | Bridge routes if applicable |

### Chain Details

| Chain | Chain ID | Native Token | Block Time | DEXs | Flash Loans |
|-------|----------|-------------|------------|------|-------------|
| Blast | 81457 | ETH | 2s | Thruster V2/V3, BladeSwap, Ring Protocol | None native |
| Scroll | 534352 | ETH | 3s | SyncSwap, SpaceFi, Ambient, Zebra | SyncSwap |
| Mantle | 5000 | MNT | 2s | Merchant Moe, Agni Finance, FusionX | None native |
| Mode | 34443 | ETH | 2s | Kim Exchange, SupSwap, SwapMode | None native |

### RPC Provider Strategy
Use 6-Provider Shield pattern (same as existing chains):
- dRPC > Ankr > PublicNode > Infura > Alchemy > BlastAPI
- Not all providers support all chains; fill available ones, use chain-native RPCs as fallback

### Partition Assignment
All 4 new L2s assigned to P2 (currently: Arbitrum, Optimism, Base). P2 already handles OP-stack/L2 chains. This increases P2's chain count from 3 to 7, which is within the memory budget (~45MB per chain, 7 × 45 = 315MB, well within Fly.io's 512MB).

---

## Item #28: CoW Protocol Watch-Only + Backrun

### Design

```
CowSettlementWatcher
  │ Subscribe to GPv2Settlement events:
  │ 0x9008D19f58AAbD9eD0D60971565AA8510560ab41
  │ Event: Settlement(address solver, ...)
  │ + Trade events for individual fills
  ├── SettlementDecoder
  │    - Decode Trade/Settlement event logs
  │    - Extract: tokens traded, amounts, clearing prices
  │    - Filter: large settlements only (>$50K volume)
  ├── BackrunOpportunityGenerator
  │    - Compare post-settlement DEX prices to pre-settlement
  │    - Compute price impact on affected pools
  │    - Generate backrun opportunity if displacement > threshold
  └── Existing BackrunStrategy
       - Submit backrun via Flashbots bundle
       - CoW settlement tx first, backrun tx second
```

### New Files
- `shared/core/src/feeds/cow-settlement-watcher.ts` -- Event subscription + decoding
- `shared/core/src/detector/cow-backrun-detector.ts` -- Opportunity generation

### Integration
- Ethereum mainnet only (CoW Protocol is Ethereum-primary)
- Feeds into existing `BackrunStrategy` via standard opportunity pipeline
- No new strategy type -- CoW is a new *source* of backrun opportunities
- Feature flag: `FEATURE_COW_BACKRUN=true` for opt-in

### Key Contracts
- GPv2Settlement: `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`
- GPv2Authentication: `0x2c4c28DDBdAc9C5E7055b4C863b72eA0149D8aFE`

---

## Implementation Groups

```
Group 1 (parallelizable):
  #30 DAI Flash Mint    -- contract + tests
  #33 Emerging L2s      -- config entries (no code logic)

Group 2:
  #29 Solana Execution  -- Jupiter client + Jito wiring + strategy

Group 3 (parallelizable):
  #31 Statistical Arb   -- correlation + spread + regime + strategy
  #32 CEX Signals       -- Binance WS + normalization + spread calc

Group 4:
  #28 CoW Watch-Only    -- settlement watcher + backrun detector
```

### Testing Strategy
- **#30:** Hardhat contract tests + Jest provider integration
- **#29:** Jest unit (mocked Jupiter API, tx builder) + integration (simulated Jito)
- **#31:** Jest unit (correlation, spread, regime) + integration (full signal pipeline)
- **#32:** Jest unit (WS client mock, normalizer, spread) + integration (PriceMatrix write)
- **#33:** Config validation tests (chain IDs resolve, DEXs valid, partitions correct)
- **#28:** Jest unit (settlement decoder, backrun gen) + integration (opportunity pipeline)

---

## New Types Required

```typescript
// StrategyType expansion
type StrategyType = ... | 'solana' | 'statistical';

// ArbitrageOpportunity.type expansion
type OpportunityType = ... | 'statistical' | 'cex_dex_spread';

// New chain IDs
type ChainId = ... | 'blast' | 'scroll' | 'mantle' | 'mode';
```

## Risk Considerations

- **Solana execution** is the riskiest item (non-EVM, different transaction model). Jupiter API dependency adds external failure mode.
- **Statistical arb** involves holding positions across blocks (not atomic). Requires careful risk limits.
- **CEX signals** add a non-blockchain dependency. Binance WS may rate-limit or disconnect.
- **Emerging L2s** have lower liquidity; false-positive opportunities may be higher.
- **CoW backrun** competes with professional solvers who have better infrastructure.

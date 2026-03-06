# ADR-040: Real-Time Native Token Pricing and Gas Cost Calibration

## Status
Accepted

## Date
2026-03-06

## Context

Gas cost estimation across the multi-chain arbitrage system relied on static `NATIVE_TOKEN_PRICES` hardcoded in `shared/config/src/tokens/index.ts` (last updated 2026-02-23). This caused systematic profit miscalculation:

- **25% ETH price drift** ($3200 → $4000) makes ALL gas estimates on 8 ETH-native chains 25% low → false positives (unprofitable trades executed)
- **Post-execution `calculateActualProfit()`** subtracted native-token-denominated gas cost from USD expected profit — a unit mismatch
- **Bridge cost estimator** used a single `currentEthPriceUsd` for ALL chains, wrong for BSC (BNB), Polygon (MATIC), Avalanche (AVAX), etc.
- **OP Stack L1 fee oracle** used pre-Dencun `l1BaseFee()` instead of blob-aware `getL1FeeUpperBound()`, overestimating rollup costs post-EIP-4844
- **No feedback loop** — no mechanism to compare estimated vs actual gas costs and self-correct

### Requirements

1. Fetch real-time native token prices within the existing 60s GasPriceCache refresh cycle
2. Maintain $0/month constraint (ADR-006) — no paid price feeds
3. Preserve <50ms hot-path latency target — price fetch is background-only
4. Fix unit mismatches in profit calculation and bridge cost estimation
5. Upgrade OP Stack L1 fee to post-Dencun blob-aware oracle
6. Implement self-correcting gas estimation via post-execution calibration

## Decision

### 1. On-Chain Native Token Price Pools (Task 1)

New config module `shared/config/src/tokens/native-token-price-pools.ts` provides Uniswap V2-style DEX pool addresses for 11 chains:

| Chain | DEX | Pool | Pair |
|-------|-----|------|------|
| ethereum | Uniswap V2 | `0xB4e1...C9Dc` | WETH/USDC |
| bsc | PancakeSwap V2 | `0x58F8...Dc16` | WBNB/BUSD |
| polygon | QuickSwap V2 | `0x6e7a...4827` | WMATIC/USDC |
| avalanche | TraderJoe V1 | `0xf400...adb` | WAVAX/USDC |
| fantom | SpookySwap | `0x2b4C...5c` | WFTM/USDC |
| arbitrum | Camelot V2 | `0x8465...E27` | WETH/USDC |
| optimism | Velodrome V2 | `0x0493...39A` | WETH/USDC |
| base | Aerodrome | `0xcDAC...C43` | WETH/USDC |
| zksync | SyncSwap | `0x8011...05c` | WETH/USDC |
| linea | Lynex | `0x58aa...94a` | WETH/USDC |
| mantle | Merchant Moe | `0x06c0...39e` | WMNT/USDC |

Pool selection criteria: highest TVL NativeToken/Stablecoin V2-style pair (>$100K TVL minimum). V2 `getReserves()` is simpler and cheaper than V3 `sqrtPriceX96` math.

ETH-native L2 chains without their own pool (blast, scroll, mode) fall back to ethereum's price.

### 2. Background Price Refresh (Task 2)

`GasPriceCache.refreshNativeTokenPrices()` runs inside the existing 60s `refreshAll()` cycle:

1. For each chain with a pool config, call `getReserves()` via the chain's RPC provider
2. Calculate price using `calculateNativeTokenPrice()` with decimal normalization
3. Sanity check: reject prices outside $0.001–$1,000,000 range
4. Update via `setNativeTokenPrice(chain, price)` (replaces static fallback)
5. For ETH-native chains without pools, propagate ethereum's live price
6. All calls use `Promise.allSettled()` — individual chain failures don't block others
7. Providers are lazily created and cached in a `Map<string, JsonRpcProvider>`

**Hot-path impact**: NONE. Price fetch is purely background; the hot path reads from the in-memory `nativeTokenPrices` Map (O(1) lookup, no change).

### 3. Per-Chain Native Token Price in Profit Calculation (Task 3)

`base.strategy.ts:calculateActualProfit()` fixed to:

```
gasCostNative = formatEther(gasUsed × gasPrice)   // in native token units
gasCostUsd = gasCostNative × getNativeTokenPrice(chain)  // convert to USD
actualProfit = expectedProfit - gasCostUsd         // both in USD
```

Previously subtracted native-token-denominated gas directly from USD profit.

### 4. Per-Chain Bridge Cost Estimation (Task 4)

`bridge-cost-estimator.ts:getDetailedEstimate()` changed from:

```
costUsd = costEth × currentEthPriceUsd  // WRONG for BSC, Polygon, etc.
```

to:

```
costNative = costWei / 1e18
nativePrice = getNativeTokenPrice(sourceChain)
costUsd = costNative × nativePrice
```

### 5. Blob-Aware OP Stack L1 Fee (Task 5)

OP Stack chains (optimism, base, blast, scroll, mode) updated to use:

```solidity
GasPriceOracle.getL1FeeUpperBound(unsignedTxSize)  // EIP-4844 blob-aware
```

With graceful fallback to pre-Dencun `l1BaseFee()` for chains that haven't upgraded.

### 6. Post-Execution Gas Calibration (Tasks 6 & 7)

EMA-based feedback loop:

1. **Recording** (Task 6): After each execution, `base.strategy.ts` calls `recordGasCalibration(chain, operationType, estimatedCostUsd, actualCostUsd)` on the GasPriceCache singleton
2. **EMA update**: `ratio = α × rawRatio + (1-α) × oldRatio` where α=0.1 (10% weight to new sample)
3. **Outlier rejection**: Samples with raw ratio < 0.1 or > 10 are rejected to prevent EMA corruption
4. **Application** (Task 7): `estimateGasCostUsd()` multiplies the base estimate by the calibration ratio when an `operationType` is provided and ≥5 samples exist
5. **Clamping**: Output ratio clamped to [0.5, 2.0] — never reduces estimates by >50% or increases by >100%

Calibration key format: `{chain}:{operationType}` (e.g., `arbitrum:triangular`).

## Consequences

### Positive
- Gas cost estimates track real token prices within 60s of market moves
- Per-chain pricing eliminates systematic errors for non-ETH chains (BSC, Polygon, Avalanche, Fantom, Mantle)
- Calibration loop self-corrects systematic estimation biases per chain and operation type
- Blob-aware L1 fees produce more accurate rollup cost estimates post-Dencun
- $0/month cost — uses free-tier RPC calls to existing DEX pools
- Fully backward compatible — falls back to static prices on RPC failure

### Negative
- 11 additional RPC calls per 60s refresh cycle (one `getReserves()` per chain)
- Pool addresses may need updating if DEX liquidity migrates
- Calibration EMA needs ~50 executions (5 min samples × 10 trades) before becoming effective
- `calculateNativeTokenPrice()` uses floating-point division — acceptable for price estimation but not for on-chain token math

### Risks
- Low-liquidity pools could be manipulated to produce incorrect native token prices — mitigated by $100K minimum TVL requirement and $0.001–$1M sanity bounds
- RPC rate limits on chains with aggressive free-tier throttling — mitigated by `Promise.allSettled()` (individual failures are isolated) and lazy provider creation
- Calibration ratio could drift if execution patterns change significantly — mitigated by EMA decay and [0.5, 2.0] clamp

## Files Changed

### Created
- `shared/config/src/tokens/native-token-price-pools.ts` — Pool config, price calculation, constants

### Modified
- `shared/config/src/index.ts` — Re-export native token price pool config
- `shared/core/src/caching/gas-price-cache.ts` — Tasks 2, 5, 6, 7 (price refresh, blob L1 fee, calibration)
- `services/execution-engine/src/strategies/base.strategy.ts` — Tasks 3, 6 (USD conversion fix, calibration hook)
- `services/cross-chain-detector/src/bridge-cost-estimator.ts` — Task 4 (per-chain native price)

## References

- ADR-006: $0/month infrastructure constraint
- ADR-013: Dynamic Gas Pricing (original gas price caching)
- `docs/reports/GAS_FEE_HANDLING_RESEARCH_2026-03-06.md` — Full research report

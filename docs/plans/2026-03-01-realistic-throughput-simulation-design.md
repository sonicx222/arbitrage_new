# Realistic Throughput Simulation Design

**Date**: 2026-03-01
**Status**: Approved — Pending Implementation
**Scope**: Replace flat-interval simulation with block-driven multi-swap model calibrated to real chain throughput

---

## Problem

The simulation system (post-commit `939420d2`) uses `setInterval` at each chain's block time, updating all eligible pairs once per tick. This produces:

- **Perfect periodicity** — real blocks have timing jitter and occasional missed slots
- **One update per pair per block** — real blocks contain multiple independent DEX swaps
- **Uniform DEX distribution** — real DEX activity follows power-law market share
- **Static gas costs** — real gas prices spike during congestion (burst regimes)

While the event *rate* (~600/s) happens to match aggregate real throughput, the *distribution across chains* is wrong: Ethereum generates too many events, Solana too few.

---

## Solution: Block-Driven Multi-Swap Model (Approach C)

### Core Changes

1. **Block time jitter**: Replace `setInterval` with `setTimeout` chain using Gaussian-jittered delays + slot miss modeling
2. **Multi-swap per block**: Generate `Poisson(λ)` independent swap events per block (λ = chain-specific DEX swaps/block)
3. **DEX market share weighting**: Each swap selects a DEX weighted by real market share
4. **Dynamic gas pricing**: EIP-1559-style base fee that correlates with market regime

### New Data Structure: Chain Throughput Profile

```typescript
export interface ChainThroughputProfile {
  // Block timing
  blockTimeMs: number;
  blockTimeJitterMs: number;
  slotMissRate: number;

  // DEX swap throughput
  dexSwapsPerBlock: number;
  dexMarketShare: Record<string, number>;
  tradeSizeRange: [number, number];

  // Gas economics
  gasModel: {
    baseFeeAvg: number;       // gwei (or lamports/CU for Solana)
    baseFeeStdDev: number;
    priorityFeeAvg: number;   // gwei
    priorityFeeStdDev: number;
    swapGasUnits: number;     // gas units per swap
    burstMultiplier: number;  // base fee multiplier in burst regime
  };
}
```

---

## Per-Chain Throughput Profiles

Calibrated to real on-chain data (public explorer/analytics sources, 2025 averages):

### EVM Chains

| Chain | Block Time | Jitter σ | Slot Miss | Swaps/Block λ | Trade Size USD | Top DEX (share) |
|-------|-----------|----------|-----------|---------------|---------------|-----------------|
| Ethereum | 12,000ms | 500ms | 1% | 40 | $5K-200K | Uniswap V3 (65%) |
| BSC | 3,000ms | 200ms | 0% | 80 | $500-50K | PancakeSwap V3 (70%) |
| Arbitrum | 250ms | 150ms | 0% | 5 | $500-50K | Uniswap V3 (55%) |
| Polygon | 2,000ms | 300ms | 0.5% | 25 | $200-20K | QuickSwap V3 (45%) |
| Optimism | 2,000ms | 100ms | 0% | 8 | $500-30K | Velodrome (50%) |
| Base | 2,000ms | 100ms | 0% | 25 | $200-30K | Aerodrome (55%) |
| Avalanche | 2,000ms | 300ms | 0% | 6 | $200-20K | Trader Joe V2 (55%) |
| Fantom | 1,000ms | 200ms | 0% | 3 | $100-10K | SpookySwap (60%) |
| zkSync | 1,000ms | 500ms | 0.5% | 4 | $200-15K | SyncSwap (65%) |
| Linea | 2,000ms | 300ms | 0% | 3 | $100-10K | SyncSwap (60%) |
| Blast | 2,000ms | 100ms | 0% | 4 | $200-15K | Thruster (50%) |
| Scroll | 3,000ms | 500ms | 0.5% | 3 | $100-10K | SyncSwap (55%) |
| Mantle | 2,000ms | 300ms | 0% | 1 | $100-5K | Agni (50%) |
| Mode | 2,000ms | 300ms | 0% | 1 | $50-3K | SwapMode (50%) |

### Non-EVM

| Chain | Slot Time | Jitter σ | Slot Miss | Swaps/Slot λ | Trade Size USD | Top DEX (share) |
|-------|----------|----------|-----------|--------------|---------------|-----------------|
| Solana | 400ms | 100ms | 0.5% | 120 | $50-10K | Jupiter (40%), Raydium (20%) |

### Gas Models

| Chain | Base Fee (gwei) | σ | Priority Fee | σ | Swap Gas | Burst Mult |
|-------|----------------|---|-------------|---|----------|-----------|
| Ethereum | 25 | 15 | 2.0 | 1.5 | 150,000 | 5x |
| BSC | 3 | 1 | 0 | 0 | 120,000 | 2x |
| Arbitrum | 0.1 | 0.05 | 0.01 | 0.01 | 800,000 | 3x |
| Polygon | 30 | 10 | 30 | 10 | 150,000 | 3x |
| Optimism | 0.005 | 0.002 | 0.001 | 0.001 | 150,000 | 3x |
| Base | 0.005 | 0.002 | 0.001 | 0.001 | 150,000 | 3x |
| Avalanche | 25 | 8 | 1 | 0.5 | 150,000 | 3x |
| Fantom | 10 | 5 | 0 | 0 | 130,000 | 2x |
| zkSync | 0.25 | 0.1 | 0 | 0 | 500,000 | 3x |
| Linea | 0.5 | 0.2 | 0.1 | 0.05 | 150,000 | 2x |
| Blast | 0.005 | 0.002 | 0.001 | 0.001 | 150,000 | 3x |
| Scroll | 0.1 | 0.05 | 0.01 | 0.01 | 400,000 | 3x |
| Mantle | 0.02 | 0.01 | 0 | 0 | 150,000 | 2x |
| Mode | 0.005 | 0.002 | 0 | 0 | 150,000 | 2x |
| Solana | 5000 lamports/CU | 2000 | 1000 | 500 | 200,000 CU | 4x |

---

## Block Tick Engine

Replace `setInterval` with self-scheduling `setTimeout`:

```typescript
private scheduleNextBlock(): void {
  if (!this.running) return;

  const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];

  // Slot miss check
  const isMissedSlot = Math.random() < profile.slotMissRate;
  const baseDelay = isMissedSlot
    ? profile.blockTimeMs * 2
    : profile.blockTimeMs;

  // Gaussian jitter
  const jitter = gaussianRandom() * profile.blockTimeJitterMs;
  const delay = Math.max(50, Math.round(baseDelay + jitter));

  this.blockTimeout = setTimeout(() => {
    this.simulateBlock();
    this.scheduleNextBlock();
  }, delay);
}
```

### `gaussianRandom()` — Box-Muller transform

```typescript
export function gaussianRandom(mean = 0, stdDev = 1): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z * stdDev + mean;
}
```

### `poissonRandom(λ)` — Knuth algorithm

```typescript
export function poissonRandom(lambda: number): number {
  if (lambda <= 0) return 0;
  // For large λ, use Gaussian approximation
  if (lambda > 30) {
    return Math.max(0, Math.round(gaussianRandom(lambda, Math.sqrt(lambda))));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}
```

---

## Multi-Swap Block Simulation

Replace `simulateTick()` → `simulateBlock()`:

```typescript
private simulateBlock(): void {
  this.blockNumber++;
  this.emit('blockUpdate', { blockNumber: this.blockNumber });

  const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];
  const regimeConfig = REGIME_CONFIGS[this.currentRegime];

  // Regime transition (high realism)
  if (getSimulationRealismLevel() === 'high') {
    this.currentRegime = transitionRegime(this.currentRegime);
  }

  // Poisson-distributed swap count
  const avgSwaps = profile.dexSwapsPerBlock * regimeConfig.pairActivityMultiplier;
  const swapCount = poissonRandom(avgSwaps);

  // Update gas price for this block
  this.currentGasPrice = this.sampleGasPrice(profile, regimeConfig);

  // Generate individual swap events
  for (let i = 0; i < swapCount; i++) {
    const dex = selectWeightedDex(profile.dexMarketShare);
    const pair = this.selectSwapPair(dex);
    if (pair) {
      this.executeSwap(pair, dex);
    }
  }

  // Opportunity detection
  const effectiveArbChance = this.config.arbitrageChance * regimeConfig.arbChanceMultiplier;
  if (Math.random() < effectiveArbChance) {
    this.detectAndEmitOpportunities();
  }
}
```

### Swap Pair Selection (Activity-Tier Weighted)

```typescript
private selectSwapPair(dex: string): SimulatedPairConfig | null {
  // Filter pairs available on this DEX
  const dexPairs = this.config.pairs.filter(p => p.dex === dex);
  if (dexPairs.length === 0) return null;

  // Weight by activity tier
  const weights = dexPairs.map(p => {
    const key = `${p.token0Symbol}/${p.token1Symbol}`;
    return PAIR_ACTIVITY_TIERS[key] ?? DEFAULT_PAIR_ACTIVITY;
  });

  return weightedRandomSelect(dexPairs, weights);
}
```

### Gas Price Sampling

```typescript
private sampleGasPrice(
  profile: ChainThroughputProfile,
  regime: RegimeConfig
): { baseFee: number; priorityFee: number; gasCostUsd: number } {
  const gas = profile.gasModel;
  const burstMult = this.currentRegime === 'burst' ? gas.burstMultiplier : 1.0;

  const baseFee = Math.max(0, gaussianRandom(gas.baseFeeAvg * burstMult, gas.baseFeeStdDev));
  const priorityFee = Math.max(0, gaussianRandom(gas.priorityFeeAvg, gas.priorityFeeStdDev));

  const nativePrice = getNativeTokenPrice(this.config.chainId);
  const gasCostUsd = ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e9;

  return { baseFee, priorityFee, gasCostUsd };
}
```

---

## Backward Compatibility

- `SIMULATION_REALISM_LEVEL=low` keeps the current `setInterval` + all-pairs-per-tick behavior
- `SIMULATION_REALISM_LEVEL=medium` uses new multi-swap model without regime transitions
- `SIMULATION_REALISM_LEVEL=high` uses multi-swap model + market regime Markov chain
- `SIMULATION_UPDATE_INTERVAL_MS` env var override still works (forces flat interval)

---

## Expected Throughput

| Chain | Current Events/s | New Events/s | Real-World Reference |
|-------|-----------------|-------------|---------------------|
| Ethereum | ~40 | ~3.3 | ~3-5 |
| BSC | ~130 | ~26.7 | ~25-40 |
| Arbitrum | ~160 | ~20 | ~15-30 |
| Base | ~55 | ~12.5 | ~10-20 |
| Polygon | ~55 | ~12.5 | ~10-20 |
| Optimism | ~55 | ~4 | ~3-8 |
| Solana | ~95 | ~300 | ~250-500 |
| Others | ~100 | ~15 | ~10-20 |
| **Total** | **~690/s** | **~394/s** | **~350-600/s** |

Solana correctly dominates (76% of events). Ethereum is appropriately slow (0.8%). L2s fill the middle.

---

## Files to Modify

| File | Change | LOC Est |
|------|--------|---------|
| `shared/core/src/simulation/types.ts` | Add `ChainThroughputProfile`, `GasModel` interfaces | +30 |
| `shared/core/src/simulation/constants.ts` | Add `CHAIN_THROUGHPUT_PROFILES`, `gaussianRandom()`, `poissonRandom()`, `weightedRandomSelect()`, `selectWeightedDex()` | +180 |
| `shared/core/src/simulation/chain-simulator.ts` | Replace `setInterval`→`setTimeout`, `simulateTick`→`simulateBlock`, add multi-swap + gas | +120, -80 |
| `shared/core/src/simulation/price-simulator.ts` | Same `setTimeout` jitter pattern | +30, -10 |
| `shared/core/src/simulation/index.ts` | Export new types/functions | +5 |
| Tests (4-5 files) | Verify Poisson distribution, jitter, gas, DEX market share | +150 |

**Total**: ~515 LOC added, ~90 LOC removed

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| setTimeout drift accumulation | Each timeout is independent — no drift since we don't chain cumulative delays |
| Poisson λ=120 (Solana) creates CPU spikes | Gaussian approximation for λ>30, each swap is O(1) |
| Gas model values drift from reality | All values in one `CHAIN_THROUGHPUT_PROFILES` constant — easy to update |
| Lower Ethereum event rate starves detection | This is correct behavior — Ethereum blocks are slow; test with `SIMULATION_REALISM_LEVEL=low` for fast iteration |

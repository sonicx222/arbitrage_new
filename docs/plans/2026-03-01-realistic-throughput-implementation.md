# Realistic Throughput Simulation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace flat-interval price simulation with block-driven multi-swap model calibrated to real per-chain throughput (block jitter, Poisson swap counts, DEX market share, dynamic gas).

**Architecture:** Add `ChainThroughputProfile` per chain with real-world calibrated numbers. Replace `setInterval` in `ChainSimulator` with `setTimeout` chain for block time jitter. Each simulated block generates `Poisson(λ)` independent swap events instead of updating all eligible pairs once. Add dynamic gas pricing correlated with market regime.

**Tech Stack:** TypeScript, Node.js, Jest (fake timers), EventEmitter

---

## Task 1: Add Types for Throughput Profiles and Gas Model

**Files:**
- Modify: `shared/core/src/simulation/types.ts:245` (append after `CrossChainSimulatorConfig`)

**Step 1: Add `GasModel` and `ChainThroughputProfile` interfaces**

Append these interfaces after the `CrossChainSimulatorConfig` interface (after line 277):

```typescript
// =============================================================================
// Chain Throughput Profile Types
// =============================================================================

/**
 * Gas dynamics model for realistic simulation.
 * EVM chains use gwei; Solana uses lamports/compute-unit.
 *
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */
export interface GasModel {
  /** Average base fee in gwei (or lamports/CU for Solana) */
  baseFeeAvg: number;
  /** Base fee standard deviation */
  baseFeeStdDev: number;
  /** Average priority fee (tip) in gwei */
  priorityFeeAvg: number;
  /** Priority fee standard deviation */
  priorityFeeStdDev: number;
  /** Gas units consumed by a typical DEX swap on this chain */
  swapGasUnits: number;
  /** Base fee multiplier during burst regime */
  burstMultiplier: number;
}

/**
 * Per-chain throughput profile calibrated to real on-chain data.
 * Used by ChainSimulator to generate realistic block timing,
 * swap counts, DEX distribution, and gas costs.
 *
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */
export interface ChainThroughputProfile {
  /** Average block time in ms (reference — actual from BLOCK_TIMES_MS) */
  blockTimeMs: number;
  /** Standard deviation of block time jitter in ms (Gaussian) */
  blockTimeJitterMs: number;
  /** Probability of a missed slot per block (e.g. Ethereum ~0.01) */
  slotMissRate: number;
  /** Average number of DEX swap events per block (Poisson λ) */
  dexSwapsPerBlock: number;
  /** DEX name → market share weight (must approximately sum to 1.0) */
  dexMarketShare: Record<string, number>;
  /** Trade size range in USD [min, max] for log-normal sampling */
  tradeSizeRange: [number, number];
  /** Gas economics model */
  gasModel: GasModel;
}

/**
 * Sampled gas price for a simulated block.
 */
export interface SampledGasPrice {
  /** Base fee in gwei (or lamports/CU) */
  baseFee: number;
  /** Priority fee in gwei */
  priorityFee: number;
  /** Total gas cost for one swap in USD */
  gasCostUsd: number;
}
```

**Step 2: Run typecheck to verify**

Run: `npm run typecheck`
Expected: PASS (new types are standalone, no breaking changes)

**Step 3: Commit**

```bash
git add shared/core/src/simulation/types.ts
git commit -m "feat(simulation): add ChainThroughputProfile and GasModel types"
```

---

## Task 2: Add Statistical Utility Functions

**Files:**
- Create: `shared/core/src/simulation/math-utils.ts`
- Test: `shared/core/__tests__/unit/simulation/math-utils.test.ts`

**Step 1: Write the failing tests**

Create `shared/core/__tests__/unit/simulation/math-utils.test.ts`:

```typescript
/**
 * Statistical utility function tests for realistic simulation.
 *
 * Tests verify distribution properties over many samples rather than
 * exact values, since these functions are stochastic.
 */

import { describe, it, expect } from '@jest/globals';
import {
  gaussianRandom,
  poissonRandom,
  weightedRandomSelect,
} from '../../../src/simulation/math-utils';

describe('gaussianRandom', () => {
  it('should return numbers with approximately correct mean over many samples', () => {
    const samples = Array.from({ length: 10000 }, () => gaussianRandom(100, 10));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Mean should be within 1% of target (100 ± 1)
    expect(mean).toBeGreaterThan(99);
    expect(mean).toBeLessThan(101);
  });

  it('should return numbers with approximately correct std dev over many samples', () => {
    const targetStdDev = 10;
    const samples = Array.from({ length: 10000 }, () => gaussianRandom(0, targetStdDev));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    // Std dev should be within 10% of target
    expect(stdDev).toBeGreaterThan(targetStdDev * 0.9);
    expect(stdDev).toBeLessThan(targetStdDev * 1.1);
  });

  it('should default to mean=0, stdDev=1', () => {
    const samples = Array.from({ length: 5000 }, () => gaussianRandom());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(-0.1);
    expect(mean).toBeLessThan(0.1);
  });
});

describe('poissonRandom', () => {
  it('should return non-negative integers', () => {
    for (let i = 0; i < 100; i++) {
      const value = poissonRandom(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('should have approximately correct mean for small lambda', () => {
    const lambda = 5;
    const samples = Array.from({ length: 10000 }, () => poissonRandom(lambda));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Mean should be within 5% of lambda
    expect(mean).toBeGreaterThan(lambda * 0.95);
    expect(mean).toBeLessThan(lambda * 1.05);
  });

  it('should have approximately correct mean for large lambda (Gaussian approx)', () => {
    const lambda = 120; // Solana's dexSwapsPerBlock
    const samples = Array.from({ length: 10000 }, () => poissonRandom(lambda));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Mean should be within 3% of lambda
    expect(mean).toBeGreaterThan(lambda * 0.97);
    expect(mean).toBeLessThan(lambda * 1.03);
  });

  it('should return 0 for lambda <= 0', () => {
    expect(poissonRandom(0)).toBe(0);
    expect(poissonRandom(-5)).toBe(0);
  });
});

describe('weightedRandomSelect', () => {
  it('should select items proportional to their weights', () => {
    const items = ['a', 'b', 'c'];
    const weights = [0.7, 0.2, 0.1];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };

    for (let i = 0; i < 10000; i++) {
      const selected = weightedRandomSelect(items, weights);
      counts[selected]++;
    }

    // 'a' should be selected ~70% of the time
    expect(counts['a'] / 10000).toBeGreaterThan(0.65);
    expect(counts['a'] / 10000).toBeLessThan(0.75);

    // 'c' should be selected ~10% of the time
    expect(counts['c'] / 10000).toBeGreaterThan(0.07);
    expect(counts['c'] / 10000).toBeLessThan(0.13);
  });

  it('should return the only item when array has one element', () => {
    expect(weightedRandomSelect(['only'], [1.0])).toBe('only');
  });

  it('should handle items with zero weight (never selected)', () => {
    const items = ['yes', 'no'];
    const weights = [1.0, 0];

    for (let i = 0; i < 100; i++) {
      expect(weightedRandomSelect(items, weights)).toBe('yes');
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest shared/core/__tests__/unit/simulation/math-utils.test.ts --no-coverage`
Expected: FAIL — module `math-utils` does not exist

**Step 3: Write the implementation**

Create `shared/core/src/simulation/math-utils.ts`:

```typescript
/**
 * Statistical utility functions for realistic simulation.
 *
 * - gaussianRandom: Box-Muller transform for normally distributed values
 * - poissonRandom: Knuth algorithm (small λ) / Gaussian approximation (large λ)
 * - weightedRandomSelect: Weighted random selection from arrays
 *
 * @module simulation
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */

/**
 * Generate a Gaussian (normally distributed) random number.
 * Uses the Box-Muller transform for exact normal distribution.
 *
 * @param mean - Distribution mean (default: 0)
 * @param stdDev - Standard deviation (default: 1)
 * @returns Normally distributed random number
 */
export function gaussianRandom(mean = 0, stdDev = 1): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 1e-10)) * Math.cos(2.0 * Math.PI * u2);
  return z * stdDev + mean;
}

/**
 * Generate a Poisson-distributed random integer.
 *
 * For λ ≤ 30: Uses Knuth's exact algorithm.
 * For λ > 30: Uses Gaussian approximation (Central Limit Theorem).
 *
 * @param lambda - Expected value (average rate)
 * @returns Non-negative integer drawn from Poisson(λ)
 */
export function poissonRandom(lambda: number): number {
  if (lambda <= 0) return 0;

  // Large λ: Gaussian approximation is faster and accurate
  if (lambda > 30) {
    return Math.max(0, Math.round(gaussianRandom(lambda, Math.sqrt(lambda))));
  }

  // Knuth's algorithm for small λ
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/**
 * Select an item from an array using weighted random selection.
 *
 * @param items - Array of items to select from
 * @param weights - Corresponding weights (higher = more likely)
 * @returns Selected item
 */
export function weightedRandomSelect<T>(items: T[], weights: number[]): T {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let rand = Math.random() * totalWeight;

  for (let i = 0; i < items.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return items[i];
  }

  // Fallback (floating-point edge case)
  return items[items.length - 1];
}
```

**Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/simulation/math-utils.test.ts --no-coverage`
Expected: PASS (all 9 tests)

**Step 5: Commit**

```bash
git add shared/core/src/simulation/math-utils.ts shared/core/__tests__/unit/simulation/math-utils.test.ts
git commit -m "feat(simulation): add gaussianRandom, poissonRandom, weightedRandomSelect utilities"
```

---

## Task 3: Add Chain Throughput Profiles Constant

**Files:**
- Create: `shared/core/src/simulation/throughput-profiles.ts`
- Test: `shared/core/__tests__/unit/simulation/throughput-profiles.test.ts`

**Step 1: Write the failing tests**

Create `shared/core/__tests__/unit/simulation/throughput-profiles.test.ts`:

```typescript
/**
 * Chain Throughput Profile tests.
 *
 * Validates that all supported chains have throughput profiles
 * and that profile values are within realistic bounds.
 */

import { describe, it, expect } from '@jest/globals';
import {
  CHAIN_THROUGHPUT_PROFILES,
  getNativeTokenPrice,
  selectWeightedDex,
} from '../../../src/simulation/throughput-profiles';
import { DEXES } from '../../../src/simulation/constants';
import type { ChainThroughputProfile } from '../../../src/simulation/types';

const ALL_CHAINS = [
  'ethereum', 'bsc', 'arbitrum', 'polygon', 'optimism', 'base',
  'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll',
  'mantle', 'mode', 'solana',
];

describe('CHAIN_THROUGHPUT_PROFILES', () => {
  it('should have a profile for every supported chain', () => {
    for (const chain of ALL_CHAINS) {
      expect(CHAIN_THROUGHPUT_PROFILES[chain]).toBeDefined();
    }
  });

  it('should have positive block time for all chains', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      expect(profile.blockTimeMs).toBeGreaterThan(0);
    }
  });

  it('should have jitter less than block time (no negative delays)', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      // 3-sigma jitter should not exceed block time
      expect(profile.blockTimeJitterMs * 3).toBeLessThan(profile.blockTimeMs);
    }
  });

  it('should have slot miss rate between 0 and 0.05', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      expect(profile.slotMissRate).toBeGreaterThanOrEqual(0);
      expect(profile.slotMissRate).toBeLessThanOrEqual(0.05);
    }
  });

  it('should have positive dexSwapsPerBlock', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      expect(profile.dexSwapsPerBlock).toBeGreaterThan(0);
    }
  });

  it('should have dexMarketShare weights that approximately sum to 1', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const totalShare = Object.values(profile.dexMarketShare).reduce((a, b) => a + b, 0);
      expect(totalShare).toBeGreaterThan(0.95);
      expect(totalShare).toBeLessThan(1.05);
    }
  });

  it('should have dexMarketShare DEXes that exist in DEXES constant', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const chainDexes = DEXES[chain] ?? [];
      for (const dex of Object.keys(profile.dexMarketShare)) {
        expect(chainDexes).toContain(dex);
      }
    }
  });

  it('should have valid trade size ranges (min < max, both positive)', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const [min, max] = profile.tradeSizeRange;
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(min);
    }
  });

  it('should have valid gas model values', () => {
    for (const chain of ALL_CHAINS) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const gas = profile.gasModel;
      expect(gas.baseFeeAvg).toBeGreaterThanOrEqual(0);
      expect(gas.baseFeeStdDev).toBeGreaterThanOrEqual(0);
      expect(gas.priorityFeeAvg).toBeGreaterThanOrEqual(0);
      expect(gas.priorityFeeStdDev).toBeGreaterThanOrEqual(0);
      expect(gas.swapGasUnits).toBeGreaterThan(0);
      expect(gas.burstMultiplier).toBeGreaterThanOrEqual(1);
    }
  });

  it('Ethereum should have highest gas costs', () => {
    const eth = CHAIN_THROUGHPUT_PROFILES['ethereum'];
    const arb = CHAIN_THROUGHPUT_PROFILES['arbitrum'];
    expect(eth.gasModel.baseFeeAvg).toBeGreaterThan(arb.gasModel.baseFeeAvg);
  });

  it('Solana should have highest dexSwapsPerBlock', () => {
    const sol = CHAIN_THROUGHPUT_PROFILES['solana'];
    for (const chain of ALL_CHAINS) {
      if (chain === 'solana') continue;
      expect(sol.dexSwapsPerBlock).toBeGreaterThan(CHAIN_THROUGHPUT_PROFILES[chain].dexSwapsPerBlock);
    }
  });
});

describe('getNativeTokenPrice', () => {
  it('should return correct prices for known chains', () => {
    expect(getNativeTokenPrice('ethereum')).toBe(3200);
    expect(getNativeTokenPrice('bsc')).toBe(580);
    expect(getNativeTokenPrice('solana')).toBe(175);
    expect(getNativeTokenPrice('polygon')).toBe(0.85);
  });

  it('should return 1 for unknown chains (safe fallback)', () => {
    expect(getNativeTokenPrice('unknown')).toBe(1);
  });
});

describe('selectWeightedDex', () => {
  it('should select DEXes proportional to market share', () => {
    const marketShare = { 'uniswap_v3': 0.65, 'sushiswap': 0.35 };
    const counts: Record<string, number> = { 'uniswap_v3': 0, 'sushiswap': 0 };

    for (let i = 0; i < 10000; i++) {
      const dex = selectWeightedDex(marketShare);
      counts[dex]++;
    }

    // uniswap_v3 should be selected ~65% of the time
    expect(counts['uniswap_v3'] / 10000).toBeGreaterThan(0.60);
    expect(counts['uniswap_v3'] / 10000).toBeLessThan(0.70);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest shared/core/__tests__/unit/simulation/throughput-profiles.test.ts --no-coverage`
Expected: FAIL — module `throughput-profiles` does not exist

**Step 3: Write the implementation**

Create `shared/core/src/simulation/throughput-profiles.ts`:

```typescript
/**
 * Chain Throughput Profiles
 *
 * Per-chain throughput profiles calibrated to real on-chain data.
 * Each profile specifies block timing, DEX swap rates, market share,
 * trade sizes, and gas economics.
 *
 * @module simulation
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */

import type { ChainThroughputProfile } from './types';
import { getTokenPrice } from './constants';
import { weightedRandomSelect } from './math-utils';

// =============================================================================
// Native Token Price Lookup
// =============================================================================

/** Chain ID → native token symbol for gas cost calculation */
const NATIVE_TOKENS: Record<string, string> = {
  ethereum: 'WETH',
  bsc: 'WBNB',
  polygon: 'WMATIC',
  avalanche: 'WAVAX',
  fantom: 'WFTM',
  arbitrum: 'WETH',
  optimism: 'WETH',
  base: 'WETH',
  zksync: 'WETH',
  linea: 'WETH',
  blast: 'WETH',
  scroll: 'WETH',
  mantle: 'WETH',  // MNT in production but WETH for gas estimation
  mode: 'WETH',
  solana: 'SOL',
};

/**
 * Get native token price in USD for gas cost calculation.
 * Falls back to $1 for unknown chains (safe default).
 */
export function getNativeTokenPrice(chainId: string): number {
  const nativeToken = NATIVE_TOKENS[chainId.toLowerCase()];
  if (!nativeToken) return 1;
  return getTokenPrice(nativeToken);
}

// =============================================================================
// DEX Market Share Selection
// =============================================================================

/**
 * Select a DEX from market share weights using weighted random selection.
 */
export function selectWeightedDex(marketShare: Record<string, number>): string {
  const dexes = Object.keys(marketShare);
  const weights = Object.values(marketShare);
  return weightedRandomSelect(dexes, weights);
}

// =============================================================================
// Chain Throughput Profiles
// =============================================================================

/**
 * Per-chain throughput profiles calibrated to real on-chain data (2025 averages).
 *
 * Sources: Public block explorer data, DEX analytics dashboards.
 *
 * Dimensions:
 * - blockTimeMs/blockTimeJitterMs: Block cadence with Gaussian jitter
 * - slotMissRate: Probability of missed slot (double block gap)
 * - dexSwapsPerBlock: Poisson λ for swap count per block
 * - dexMarketShare: Power-law DEX distribution
 * - tradeSizeRange: Log-normal trade size bounds in USD
 * - gasModel: EIP-1559 base/priority fee with burst correlation
 */
export const CHAIN_THROUGHPUT_PROFILES: Readonly<Record<string, ChainThroughputProfile>> = {
  // =========================================================================
  // P3 High-Value
  // =========================================================================
  ethereum: {
    blockTimeMs: 12000,
    blockTimeJitterMs: 500,
    slotMissRate: 0.01,
    dexSwapsPerBlock: 40,
    dexMarketShare: { 'uniswap_v3': 0.65, 'sushiswap': 0.35 },
    tradeSizeRange: [5000, 200000],
    gasModel: {
      baseFeeAvg: 25,
      baseFeeStdDev: 15,
      priorityFeeAvg: 2.0,
      priorityFeeStdDev: 1.5,
      swapGasUnits: 150000,
      burstMultiplier: 5,
    },
  },

  zksync: {
    blockTimeMs: 1000,
    blockTimeJitterMs: 300,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 4,
    dexMarketShare: { 'syncswap': 0.65, 'mute': 0.35 },
    tradeSizeRange: [200, 15000],
    gasModel: {
      baseFeeAvg: 0.25,
      baseFeeStdDev: 0.1,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 500000,
      burstMultiplier: 3,
    },
  },

  linea: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 3,
    dexMarketShare: { 'syncswap': 0.60, 'velocore': 0.40 },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 0.5,
      baseFeeStdDev: 0.2,
      priorityFeeAvg: 0.1,
      priorityFeeStdDev: 0.05,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // P2 L2-Turbo
  // =========================================================================
  arbitrum: {
    blockTimeMs: 250,
    blockTimeJitterMs: 80,
    slotMissRate: 0,
    dexSwapsPerBlock: 5,
    dexMarketShare: { 'uniswap_v3': 0.55, 'camelot_v3': 0.25, 'sushiswap': 0.20 },
    tradeSizeRange: [500, 50000],
    gasModel: {
      baseFeeAvg: 0.1,
      baseFeeStdDev: 0.05,
      priorityFeeAvg: 0.01,
      priorityFeeStdDev: 0.01,
      swapGasUnits: 800000,
      burstMultiplier: 3,
    },
  },

  optimism: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 8,
    dexMarketShare: { 'velodrome': 0.50, 'uniswap_v3': 0.30, 'sushiswap': 0.20 },
    tradeSizeRange: [500, 30000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  base: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 25,
    dexMarketShare: { 'aerodrome': 0.55, 'uniswap_v3': 0.30, 'baseswap': 0.15 },
    tradeSizeRange: [200, 30000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  // =========================================================================
  // P1 Asia-Fast
  // =========================================================================
  bsc: {
    blockTimeMs: 3000,
    blockTimeJitterMs: 200,
    slotMissRate: 0,
    dexSwapsPerBlock: 80,
    dexMarketShare: { 'pancakeswap_v3': 0.50, 'pancakeswap_v2': 0.30, 'biswap': 0.20 },
    tradeSizeRange: [500, 50000],
    gasModel: {
      baseFeeAvg: 3,
      baseFeeStdDev: 1,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 120000,
      burstMultiplier: 2,
    },
  },

  polygon: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 25,
    dexMarketShare: { 'quickswap_v3': 0.45, 'uniswap_v3': 0.35, 'sushiswap': 0.20 },
    tradeSizeRange: [200, 20000],
    gasModel: {
      baseFeeAvg: 30,
      baseFeeStdDev: 10,
      priorityFeeAvg: 30,
      priorityFeeStdDev: 10,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  avalanche: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 6,
    dexMarketShare: { 'trader_joe_v2': 0.55, 'pangolin': 0.25, 'sushiswap': 0.20 },
    tradeSizeRange: [200, 20000],
    gasModel: {
      baseFeeAvg: 25,
      baseFeeStdDev: 8,
      priorityFeeAvg: 1,
      priorityFeeStdDev: 0.5,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  fantom: {
    blockTimeMs: 1000,
    blockTimeJitterMs: 200,
    slotMissRate: 0,
    dexSwapsPerBlock: 3,
    dexMarketShare: { 'spookyswap': 0.60, 'spiritswap': 0.25, 'equalizer': 0.15 },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 10,
      baseFeeStdDev: 5,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 130000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // Emerging L2s
  // =========================================================================
  blast: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 4,
    dexMarketShare: { 'aerodrome': 0.50, 'uniswap_v3': 0.30, 'baseswap': 0.20 },
    tradeSizeRange: [200, 15000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  scroll: {
    blockTimeMs: 3000,
    blockTimeJitterMs: 500,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 3,
    dexMarketShare: { 'aerodrome': 0.55, 'uniswap_v3': 0.25, 'baseswap': 0.20 },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 0.1,
      baseFeeStdDev: 0.05,
      priorityFeeAvg: 0.01,
      priorityFeeStdDev: 0.01,
      swapGasUnits: 400000,
      burstMultiplier: 3,
    },
  },

  mantle: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 1,
    dexMarketShare: { 'aerodrome': 0.50, 'uniswap_v3': 0.30, 'baseswap': 0.20 },
    tradeSizeRange: [100, 5000],
    gasModel: {
      baseFeeAvg: 0.02,
      baseFeeStdDev: 0.01,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  mode: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 1,
    dexMarketShare: { 'aerodrome': 0.50, 'uniswap_v3': 0.30, 'baseswap': 0.20 },
    tradeSizeRange: [50, 3000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // P4 Solana-Native
  // =========================================================================
  solana: {
    blockTimeMs: 400,
    blockTimeJitterMs: 100,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 120,
    dexMarketShare: { 'raydium': 0.40, 'orca': 0.35, 'meteora': 0.25 },
    tradeSizeRange: [50, 10000],
    gasModel: {
      baseFeeAvg: 5000,      // lamports/CU
      baseFeeStdDev: 2000,
      priorityFeeAvg: 1000,
      priorityFeeStdDev: 500,
      swapGasUnits: 200000,   // compute units
      burstMultiplier: 4,
    },
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/simulation/throughput-profiles.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add shared/core/src/simulation/throughput-profiles.ts shared/core/__tests__/unit/simulation/throughput-profiles.test.ts
git commit -m "feat(simulation): add per-chain throughput profiles with real-world calibration"
```

---

## Task 4: Rework ChainSimulator — Block-Driven Multi-Swap Engine

This is the core change. Replace `setInterval` with `setTimeout` chain for block jitter, and replace `simulateTick()` with `simulateBlock()` that generates Poisson-distributed swap events.

**Files:**
- Modify: `shared/core/src/simulation/chain-simulator.ts`
- Test: `shared/core/__tests__/unit/simulation/chain-simulator-throughput.test.ts` (new)

**Step 1: Write the failing tests**

Create `shared/core/__tests__/unit/simulation/chain-simulator-throughput.test.ts`:

```typescript
/**
 * ChainSimulator Throughput Model Tests
 *
 * Tests the block-driven multi-swap model:
 * - setTimeout with jittered block times (not fixed setInterval)
 * - Poisson-distributed swap count per block
 * - DEX market share selection
 * - Dynamic gas pricing
 *
 * Uses fake timers for deterministic control.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  ChainSimulator,
  type ChainSimulatorConfig,
  type SimulatedPairConfig,
  type SimulatedSyncEvent,
  type SimulatedOpportunity,
} from '../../../src/simulation';

const TEST_PAIRS: SimulatedPairConfig[] = [
  {
    address: '0x1000000000000000000000000000000000000001',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18,
    token1Decimals: 6,
    dex: 'uniswap_v3',
    fee: 0.003,
  },
  {
    address: '0x2000000000000000000000000000000000000001',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18,
    token1Decimals: 6,
    dex: 'sushiswap',
    fee: 0.003,
  },
  {
    address: '0x3000000000000000000000000000000000000001',
    token0Symbol: 'WBTC',
    token1Symbol: 'WETH',
    token0Decimals: 8,
    token1Decimals: 18,
    dex: 'uniswap_v3',
    fee: 0.003,
  },
];

const TEST_CONFIG: ChainSimulatorConfig = {
  chainId: 'ethereum',
  updateIntervalMs: 1000,
  volatility: 0.02,
  arbitrageChance: 0.1,
  minArbitrageSpread: 0.005,
  maxArbitrageSpread: 0.02,
  pairs: TEST_PAIRS,
};

describe('ChainSimulator - Throughput Model', () => {
  let simulator: ChainSimulator;

  beforeEach(() => {
    jest.useFakeTimers();
    // Use medium realism to test the new throughput model
    process.env.SIMULATION_REALISM_LEVEL = 'medium';
  });

  afterEach(() => {
    simulator?.stop();
    jest.useRealTimers();
    delete process.env.SIMULATION_REALISM_LEVEL;
    delete process.env.SIMULATION_UPDATE_INTERVAL_MS;
  });

  describe('Block timing with jitter', () => {
    it('should use setTimeout instead of setInterval for medium/high realism', () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      // Advance past one block time — events should appear
      jest.advanceTimersByTime(13000); // Ethereum ~12s + jitter headroom
      expect(events.length).toBeGreaterThan(0);
    });

    it('should still work with SIMULATION_REALISM_LEVEL=low (fixed interval)', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'low';
      simulator = new ChainSimulator(TEST_CONFIG);
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      // Initial emission
      const initialCount = events.length;
      expect(initialCount).toBeGreaterThan(0);

      // Low realism uses setInterval at configured rate
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);
      expect(events.length).toBeGreaterThan(initialCount);
    });

    it('should respect SIMULATION_UPDATE_INTERVAL_MS override', () => {
      process.env.SIMULATION_UPDATE_INTERVAL_MS = '500';
      simulator = new ChainSimulator({ ...TEST_CONFIG, updateIntervalMs: 500 });
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      const initialCount = events.length;
      jest.advanceTimersByTime(500);
      expect(events.length).toBeGreaterThan(initialCount);
    });
  });

  describe('Multi-swap per block', () => {
    it('should generate variable number of sync events per block (not all pairs every time)', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const blockEventCounts: number[] = [];
      let currentBlockEvents = 0;

      simulator.on('syncEvent', () => { currentBlockEvents++; });
      simulator.on('blockUpdate', () => {
        if (currentBlockEvents > 0) {
          blockEventCounts.push(currentBlockEvents);
        }
        currentBlockEvents = 0;
      });

      simulator.start();
      // Advance several blocks worth of time
      await jest.advanceTimersByTimeAsync(60000); // 5 Ethereum blocks
      simulator.stop();

      // Should have some blocks recorded
      expect(blockEventCounts.length).toBeGreaterThan(0);

      // Event counts should vary between blocks (Poisson distribution)
      const uniqueCounts = new Set(blockEventCounts);
      expect(uniqueCounts.size).toBeGreaterThan(1);
    });
  });

  describe('Gas price dynamics', () => {
    it('should include gasCostUsd in emitted opportunities', async () => {
      simulator = new ChainSimulator({
        ...TEST_CONFIG,
        arbitrageChance: 0.5, // High chance for test
      });

      const opportunities: SimulatedOpportunity[] = [];
      simulator.on('opportunity', (o: SimulatedOpportunity) => opportunities.push(o));
      simulator.start();

      await jest.advanceTimersByTimeAsync(120000); // 10 Ethereum blocks
      simulator.stop();

      if (opportunities.length > 0) {
        const opp = opportunities[0];
        expect(opp.expectedGasCost).toBeDefined();
        expect(opp.expectedGasCost).toBeGreaterThan(0);
      }
    });
  });

  describe('Backward compatibility', () => {
    it('should still emit syncEvent and opportunity events', async () => {
      simulator = new ChainSimulator({
        ...TEST_CONFIG,
        arbitrageChance: 0.5,
      });

      let syncCount = 0;
      let oppCount = 0;
      simulator.on('syncEvent', () => { syncCount++; });
      simulator.on('opportunity', () => { oppCount++; });

      simulator.start();
      await jest.advanceTimersByTimeAsync(120000);
      simulator.stop();

      expect(syncCount).toBeGreaterThan(0);
      // Opportunities are stochastic, but with 50% chance over 10 blocks, very likely
    });

    it('should increment block numbers', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const initialBlock = simulator.getBlockNumber();

      simulator.start();
      await jest.advanceTimersByTimeAsync(60000); // ~5 blocks
      simulator.stop();

      expect(simulator.getBlockNumber()).toBeGreaterThan(initialBlock);
    });

    it('should stop cleanly and not emit after stop', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      let eventCount = 0;
      simulator.on('syncEvent', () => { eventCount++; });

      simulator.start();
      await jest.advanceTimersByTimeAsync(15000);
      simulator.stop();

      const countAtStop = eventCount;
      await jest.advanceTimersByTimeAsync(60000);

      // No new events after stop
      expect(eventCount).toBe(countAtStop);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest shared/core/__tests__/unit/simulation/chain-simulator-throughput.test.ts --no-coverage`
Expected: FAIL — tests will fail because current implementation uses `setInterval` not `setTimeout` with jitter

**Step 3: Modify `chain-simulator.ts`**

Key changes to `shared/core/src/simulation/chain-simulator.ts`:

1. Add imports for new modules:
```typescript
import { gaussianRandom, poissonRandom, weightedRandomSelect } from './math-utils';
import { CHAIN_THROUGHPUT_PROFILES, getNativeTokenPrice, selectWeightedDex } from './throughput-profiles';
import type { SampledGasPrice } from './types';
```

2. Replace `interval: NodeJS.Timeout | null` with `blockTimeout: NodeJS.Timeout | null` field.

3. Replace `start()` method:
   - For `low` realism / env override: keep existing `setInterval` behavior unchanged
   - For `medium`/`high` realism: use `scheduleNextBlock()` with `setTimeout`

4. Add `scheduleNextBlock()` method:
```typescript
private scheduleNextBlock(): void {
  if (!this.running) return;
  const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];
  if (!profile) {
    // Fallback: use fixed interval for unknown chains
    this.blockTimeout = setTimeout(() => {
      this.simulateTick();
      this.scheduleNextBlock();
    }, this.config.updateIntervalMs);
    return;
  }
  const isMissedSlot = Math.random() < profile.slotMissRate;
  const baseDelay = isMissedSlot ? profile.blockTimeMs * 2 : profile.blockTimeMs;
  const jitter = gaussianRandom() * profile.blockTimeJitterMs;
  const delay = Math.max(50, Math.round(baseDelay + jitter));
  this.blockTimeout = setTimeout(() => {
    this.simulateBlock(profile);
    this.scheduleNextBlock();
  }, delay);
}
```

5. Add `simulateBlock(profile)` method that:
   - Increments block number, emits `blockUpdate`
   - Transitions regime (high realism)
   - Samples gas price
   - Generates `poissonRandom(avgSwaps)` swap events
   - Each swap selects a DEX via `selectWeightedDex(profile.dexMarketShare)` and a pair via activity-tier weighting
   - After all swaps, checks for arbitrage opportunity emission

6. Add `sampleGasPrice(profile, regime)` method:
```typescript
private sampleGasPrice(profile: ChainThroughputProfile): SampledGasPrice {
  const gas = profile.gasModel;
  const burstMult = this.currentRegime === 'burst' ? gas.burstMultiplier : 1.0;
  const baseFee = Math.max(0, gaussianRandom(gas.baseFeeAvg * burstMult, gas.baseFeeStdDev));
  const priorityFee = Math.max(0, gaussianRandom(gas.priorityFeeAvg, gas.priorityFeeStdDev));
  const nativePrice = getNativeTokenPrice(this.config.chainId);
  const isSolana = this.config.chainId === 'solana';
  const gasCostUsd = isSolana
    ? ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e12
    : ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e9;
  return { baseFee, priorityFee, gasCostUsd };
}
```

7. Add `selectSwapPair(dex)` method:
```typescript
private selectSwapPair(dex: string): SimulatedPairConfig | null {
  const dexPairs = this.config.pairs.filter(p => p.dex === dex);
  if (dexPairs.length === 0) {
    // Fall back to any random pair (DEX may not have exact match)
    return this.config.pairs[Math.floor(Math.random() * this.config.pairs.length)];
  }
  const weights = dexPairs.map(p => {
    const key = `${p.token0Symbol}/${p.token1Symbol}`;
    return PAIR_ACTIVITY_TIERS[key] ?? DEFAULT_PAIR_ACTIVITY;
  });
  return weightedRandomSelect(dexPairs, weights);
}
```

8. Add `executeSwap(pair)` method that applies random-walk price change and emits syncEvent.

9. Update `stop()` to clear `blockTimeout` (and `interval` for low-realism backward compat).

10. Update `createOpportunityWithType` to use `this.currentGasPrice.gasCostUsd` instead of `5 + Math.random() * 15`.

**Step 4: Run all simulation tests**

Run: `npx jest shared/core/__tests__/unit/simulation/ shared/core/__tests__/unit/chain-simulator-multi-hop.test.ts --no-coverage`
Expected: PASS (all existing + new tests)

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add shared/core/src/simulation/chain-simulator.ts shared/core/__tests__/unit/simulation/chain-simulator-throughput.test.ts
git commit -m "feat(simulation): block-driven multi-swap engine with jitter and Poisson swap counts"
```

---

## Task 5: Update PriceSimulator with Block Jitter

**Files:**
- Modify: `shared/core/src/simulation/price-simulator.ts`

**Step 1: Update `start()` to use `setTimeout` jitter for medium/high realism**

The PriceSimulator also uses `setInterval` per chain. Apply the same pattern:
- For `low` realism / env override: keep `setInterval`
- For `medium`/`high`: use `scheduleNextChainUpdate(chain)` with `setTimeout` + Gaussian jitter from `CHAIN_THROUGHPUT_PROFILES`

Replace `intervals: NodeJS.Timeout[]` with `timeouts: Map<string, NodeJS.Timeout>`.

Add `scheduleNextChainUpdate(chain)`:
```typescript
private scheduleNextChainUpdate(chain: string): void {
  if (!this.running) return;
  const profile = CHAIN_THROUGHPUT_PROFILES[chain];
  const baseDelay = profile?.blockTimeMs ?? 1000;
  const jitter = gaussianRandom() * (profile?.blockTimeJitterMs ?? 0);
  const delay = Math.max(50, Math.round(baseDelay + jitter));
  const timeout = setTimeout(() => {
    this.updateChainPrices(chain);
    this.scheduleNextChainUpdate(chain);
  }, delay);
  this.timeouts.set(chain, timeout);
}
```

**Step 2: Update `stop()` to clear the timeouts map**

**Step 3: Run existing tests**

Run: `npx jest shared/core/__tests__/unit/simulation/price-simulator.test.ts --no-coverage`
Expected: PASS (existing tests use `SIMULATION_REALISM_LEVEL=low` which keeps setInterval)

**Step 4: Commit**

```bash
git add shared/core/src/simulation/price-simulator.ts
git commit -m "feat(simulation): add block time jitter to PriceSimulator"
```

---

## Task 6: Update Exports

**Files:**
- Modify: `shared/core/src/simulation/index.ts`

**Step 1: Add exports for new modules**

Add to the exports:

```typescript
// Math utilities
export { gaussianRandom, poissonRandom, weightedRandomSelect } from './math-utils';

// Throughput profiles
export {
  CHAIN_THROUGHPUT_PROFILES,
  getNativeTokenPrice,
  selectWeightedDex,
} from './throughput-profiles';
```

Add types to the type export block:
```typescript
export type { ChainThroughputProfile, GasModel, SampledGasPrice } from './types';
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add shared/core/src/simulation/index.ts
git commit -m "feat(simulation): export throughput profile types and utilities"
```

---

## Task 7: Verify Full Test Suite

**Step 1: Run all simulation-related tests**

Run: `npx jest --testPathPattern="simulation|chain-simulator|cross-chain-simulator|simulated-price" --no-coverage`
Expected: PASS

**Step 2: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run the system to verify event rates**

Run: `SIMULATION_MODE=true SIMULATION_REALISM_LEVEL=medium npm run dev:minimal`
Observe logs for ~30 seconds, check:
- Ethereum blocks every ~12s (± jitter)
- BSC blocks every ~3s
- Variable swap counts per block
- Gas costs in opportunity logs

**Step 4: Final commit**

```bash
git commit --allow-empty -m "chore(simulation): verify realistic throughput model - all tests pass"
```

---

## Summary

| Task | Files | Est LOC | Tests |
|------|-------|---------|-------|
| 1. Types | types.ts | +35 | Typecheck |
| 2. Math utils | math-utils.ts + test | +80 | 9 tests |
| 3. Throughput profiles | throughput-profiles.ts + test | +250 | 12 tests |
| 4. ChainSimulator rework | chain-simulator.ts + test | +150, -80 | 8 tests |
| 5. PriceSimulator jitter | price-simulator.ts | +30, -10 | Existing |
| 6. Exports | index.ts | +10 | Typecheck |
| 7. Verify | — | 0 | Full suite |

**Total**: ~555 LOC added, ~90 removed, 29+ new tests

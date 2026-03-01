/**
 * Per-chain throughput profile tests.
 *
 * Validates that every chain has a well-formed ChainThroughputProfile
 * with realistic parameters, and that helper functions behave correctly.
 */

import { describe, it, expect } from '@jest/globals';
import {
  CHAIN_THROUGHPUT_PROFILES,
  NATIVE_TOKENS,
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
  it('should contain all 15 chains', () => {
    for (const chain of ALL_CHAINS) {
      expect(CHAIN_THROUGHPUT_PROFILES).toHaveProperty(chain);
    }
    expect(Object.keys(CHAIN_THROUGHPUT_PROFILES)).toHaveLength(15);
  });

  describe.each(ALL_CHAINS)('%s profile', (chain) => {
    let profile: ChainThroughputProfile;

    beforeEach(() => {
      profile = CHAIN_THROUGHPUT_PROFILES[chain];
    });

    it('should have a positive block time', () => {
      expect(profile.blockTimeMs).toBeGreaterThan(0);
    });

    it('should have jitter * 3 < block time (no negative delays)', () => {
      expect(profile.blockTimeJitterMs * 3).toBeLessThan(profile.blockTimeMs);
    });

    it('should have slot miss rate between 0 and 0.05', () => {
      expect(profile.slotMissRate).toBeGreaterThanOrEqual(0);
      expect(profile.slotMissRate).toBeLessThanOrEqual(0.05);
    });

    it('should have positive dexSwapsPerBlock', () => {
      expect(profile.dexSwapsPerBlock).toBeGreaterThan(0);
    });

    it('should have market share weights that approximately sum to 1', () => {
      const totalWeight = Object.values(profile.dexMarketShare)
        .reduce((sum, w) => sum + w, 0);
      expect(totalWeight).toBeGreaterThan(0.99);
      expect(totalWeight).toBeLessThan(1.01);
    });

    it('should have DEX names that exist in the DEXES constant', () => {
      const chainDexes = DEXES[chain];
      expect(chainDexes).toBeDefined();
      for (const dexName of Object.keys(profile.dexMarketShare)) {
        expect(chainDexes).toContain(dexName);
      }
    });

    it('should have a valid trade size range (min < max, both positive)', () => {
      const [min, max] = profile.tradeSizeRange;
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(0);
      expect(min).toBeLessThan(max);
    });

    it('should have valid gas model values (non-negative, burst >= 1)', () => {
      const { gasModel } = profile;
      expect(gasModel.baseFeeAvg).toBeGreaterThanOrEqual(0);
      expect(gasModel.baseFeeStdDev).toBeGreaterThanOrEqual(0);
      expect(gasModel.priorityFeeAvg).toBeGreaterThanOrEqual(0);
      expect(gasModel.priorityFeeStdDev).toBeGreaterThanOrEqual(0);
      expect(gasModel.swapGasUnits).toBeGreaterThan(0);
      expect(gasModel.burstMultiplier).toBeGreaterThanOrEqual(1);
    });
  });

  it('should have ethereum with the highest gas costs (USD per swap)', () => {
    // Compare gas cost in USD: baseFee * swapGasUnits * nativeTokenPrice / 1e9
    // This is the meaningful comparison since raw gwei differs across chains
    const ethGas = CHAIN_THROUGHPUT_PROFILES['ethereum'].gasModel;
    const ethPrice = getNativeTokenPrice('ethereum');
    const ethCostUsd = ethGas.baseFeeAvg * ethGas.swapGasUnits * ethPrice / 1e9;

    for (const [chain, profile] of Object.entries(CHAIN_THROUGHPUT_PROFILES)) {
      if (chain === 'ethereum' || chain === 'solana') continue;
      const chainPrice = getNativeTokenPrice(chain);
      const chainCostUsd =
        profile.gasModel.baseFeeAvg * profile.gasModel.swapGasUnits * chainPrice / 1e9;
      expect(ethCostUsd).toBeGreaterThan(chainCostUsd);
    }
  });

  it('should have solana with the highest dexSwapsPerBlock', () => {
    const solanaSwaps = CHAIN_THROUGHPUT_PROFILES['solana'].dexSwapsPerBlock;
    for (const [chain, profile] of Object.entries(CHAIN_THROUGHPUT_PROFILES)) {
      if (chain === 'solana') continue;
      expect(solanaSwaps).toBeGreaterThan(profile.dexSwapsPerBlock);
    }
  });
});

describe('getNativeTokenPrice', () => {
  it('should return correct prices for known chains', () => {
    // Ethereum native is WETH, price should be 3200
    expect(getNativeTokenPrice('ethereum')).toBe(3200);
    // BSC native is WBNB, price should be 580
    expect(getNativeTokenPrice('bsc')).toBe(580);
    // Solana native is SOL, price should be 175
    expect(getNativeTokenPrice('solana')).toBe(175);
    // Polygon native is WMATIC, price should be 0.85
    expect(getNativeTokenPrice('polygon')).toBe(0.85);
  });

  it('should return 1 for unknown chains', () => {
    expect(getNativeTokenPrice('unknown_chain')).toBe(1);
  });
});

describe('selectWeightedDex', () => {
  it('should select DEXes proportional to their weights', () => {
    const marketShare: Record<string, number> = {
      dex_a: 0.70,
      dex_b: 0.20,
      dex_c: 0.10,
    };

    const counts: Record<string, number> = { dex_a: 0, dex_b: 0, dex_c: 0 };
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const selected = selectWeightedDex(marketShare);
      counts[selected]++;
    }

    // dex_a should be selected ~70% of the time
    expect(counts['dex_a'] / iterations).toBeGreaterThan(0.65);
    expect(counts['dex_a'] / iterations).toBeLessThan(0.75);

    // dex_c should be selected ~10% of the time
    expect(counts['dex_c'] / iterations).toBeGreaterThan(0.07);
    expect(counts['dex_c'] / iterations).toBeLessThan(0.13);
  });
});

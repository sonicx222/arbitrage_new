/**
 * Native Token Price Pools Tests (ADR-040)
 *
 * Tests for the on-chain native token pricing configuration and
 * calculateNativeTokenPrice() utility function.
 */

import { describe, it, expect } from '@jest/globals';
import {
  NATIVE_TOKEN_PRICE_POOLS,
  ETH_NATIVE_CHAINS,
  MIN_POOL_TVL_USD,
  calculateNativeTokenPrice,
  type NativeTokenPricePool,
} from '../../src/tokens/native-token-price-pools';

describe('NATIVE_TOKEN_PRICE_POOLS', () => {
  it('should have pool configs for at least 10 chains', () => {
    const chains = Object.keys(NATIVE_TOKEN_PRICE_POOLS);
    expect(chains.length).toBeGreaterThanOrEqual(10);
  });

  it('should have valid pool addresses (0x-prefixed, 42 chars)', () => {
    for (const [chain, pool] of Object.entries(NATIVE_TOKEN_PRICE_POOLS)) {
      expect(pool.poolAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('should have 18 nativeDecimals for all EVM chains', () => {
    for (const [, pool] of Object.entries(NATIVE_TOKEN_PRICE_POOLS)) {
      expect(pool.nativeDecimals).toBe(18);
    }
  });

  it('should have valid stablecoinDecimals (6 or 18)', () => {
    for (const [, pool] of Object.entries(NATIVE_TOKEN_PRICE_POOLS)) {
      expect([6, 18]).toContain(pool.stablecoinDecimals);
    }
  });

  it('should have non-empty dex and stablecoinSymbol', () => {
    for (const [, pool] of Object.entries(NATIVE_TOKEN_PRICE_POOLS)) {
      expect(pool.dex.length).toBeGreaterThan(0);
      expect(pool.stablecoinSymbol.length).toBeGreaterThan(0);
    }
  });

  it('should include key non-ETH chains', () => {
    expect(NATIVE_TOKEN_PRICE_POOLS).toHaveProperty('bsc');
    expect(NATIVE_TOKEN_PRICE_POOLS).toHaveProperty('polygon');
    expect(NATIVE_TOKEN_PRICE_POOLS).toHaveProperty('avalanche');
    expect(NATIVE_TOKEN_PRICE_POOLS).toHaveProperty('fantom');
    expect(NATIVE_TOKEN_PRICE_POOLS).toHaveProperty('mantle');
  });
});

describe('ETH_NATIVE_CHAINS', () => {
  it('should list L2 chains that use ETH as native token', () => {
    expect(ETH_NATIVE_CHAINS).toContain('arbitrum');
    expect(ETH_NATIVE_CHAINS).toContain('optimism');
    expect(ETH_NATIVE_CHAINS).toContain('base');
    expect(ETH_NATIVE_CHAINS).toContain('zksync');
    expect(ETH_NATIVE_CHAINS).toContain('linea');
  });

  it('should NOT include non-ETH chains', () => {
    expect(ETH_NATIVE_CHAINS).not.toContain('bsc');
    expect(ETH_NATIVE_CHAINS).not.toContain('polygon');
    expect(ETH_NATIVE_CHAINS).not.toContain('avalanche');
    expect(ETH_NATIVE_CHAINS).not.toContain('ethereum');
  });
});

describe('MIN_POOL_TVL_USD', () => {
  it('should be $100,000', () => {
    expect(MIN_POOL_TVL_USD).toBe(100_000);
  });
});

describe('calculateNativeTokenPrice', () => {
  // Helper to create a pool config for testing
  const makePool = (overrides: Partial<NativeTokenPricePool> = {}): NativeTokenPricePool => ({
    poolAddress: '0x0000000000000000000000000000000000000000',
    token0IsNative: true,
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'TestDex',
    stablecoinSymbol: 'USDC',
    ...overrides,
  });

  describe('basic price calculation', () => {
    it('should calculate ETH price from WETH/USDC pool (token0=native)', () => {
      // Simulate: 1000 WETH (18 dec) and 3,500,000 USDC (6 dec)
      // Price = 3,500,000 / 1,000 * (10^(18-6)) / 10^12 = 3500
      const nativeReserve = BigInt('1000000000000000000000'); // 1000 * 1e18
      const stableReserve = BigInt('3500000000000'); // 3,500,000 * 1e6

      const price = calculateNativeTokenPrice(
        nativeReserve, // reserve0 = native (token0IsNative: true)
        stableReserve, // reserve1 = stable
        makePool({ token0IsNative: true, stablecoinDecimals: 6, nativeDecimals: 18 }),
      );

      expect(price).toBeCloseTo(3500, 0);
    });

    it('should calculate ETH price when token0 is stablecoin', () => {
      // Simulate: USDC/WETH pool where token0=USDC, token1=WETH
      const stableReserve = BigInt('3500000000000'); // 3,500,000 * 1e6
      const nativeReserve = BigInt('1000000000000000000000'); // 1000 * 1e18

      const price = calculateNativeTokenPrice(
        stableReserve, // reserve0 = stable
        nativeReserve, // reserve1 = native
        makePool({ token0IsNative: false, stablecoinDecimals: 6, nativeDecimals: 18 }),
      );

      expect(price).toBeCloseTo(3500, 0);
    });

    it('should calculate BNB price from BUSD/WBNB pool (18 dec stablecoin)', () => {
      // BSC: BUSD has 18 decimals, WBNB has 18 decimals
      // Simulate: 1000 WBNB and 600,000 BUSD (both 18 dec)
      const stableReserve = BigInt('600000000000000000000000'); // 600,000 * 1e18
      const nativeReserve = BigInt('1000000000000000000000'); // 1000 * 1e18

      const price = calculateNativeTokenPrice(
        stableReserve, // reserve0 = BUSD (token0IsNative: false)
        nativeReserve, // reserve1 = WBNB
        makePool({ token0IsNative: false, stablecoinDecimals: 18, nativeDecimals: 18 }),
      );

      expect(price).toBeCloseTo(600, 0);
    });
  });

  describe('edge cases', () => {
    it('should return null when reserve0 is zero', () => {
      const price = calculateNativeTokenPrice(0n, 1000n, makePool());
      expect(price).toBeNull();
    });

    it('should return null when reserve1 is zero', () => {
      const price = calculateNativeTokenPrice(1000n, 0n, makePool());
      expect(price).toBeNull();
    });

    it('should return null when both reserves are zero', () => {
      const price = calculateNativeTokenPrice(0n, 0n, makePool());
      expect(price).toBeNull();
    });

    it('should return null for price below $0.001 (sanity check)', () => {
      // Extreme: tiny stable reserve relative to huge native reserve
      const price = calculateNativeTokenPrice(
        BigInt('1000000000000000000000000'), // 1M native tokens
        BigInt('1'), // effectively 0 USDC
        makePool(),
      );
      expect(price).toBeNull();
    });

    it('should return null for price above $1,000,000 (sanity check)', () => {
      // Extreme: huge stable reserve relative to tiny native reserve
      const price = calculateNativeTokenPrice(
        BigInt('1'), // ~0 native tokens
        BigInt('2000000000000000'), // 2B USDC (6 dec)
        makePool(),
      );
      expect(price).toBeNull();
    });
  });

  describe('decimal normalization', () => {
    it('should handle 18-18 decimal pairs correctly (e.g., BSC WBNB/BUSD)', () => {
      // When both tokens have 18 decimals, scaleFactor = 10^(18-18) = 1
      const nativeReserve = BigInt('500000000000000000000'); // 500 * 1e18
      const stableReserve = BigInt('150000000000000000000000'); // 150,000 * 1e18

      const price = calculateNativeTokenPrice(
        nativeReserve, stableReserve,
        makePool({ token0IsNative: true, stablecoinDecimals: 18, nativeDecimals: 18 }),
      );

      expect(price).toBeCloseTo(300, 0);
    });

    it('should handle 18-6 decimal pairs correctly (e.g., ETH WETH/USDC)', () => {
      // scaleFactor = 10^(18-6) = 10^12
      const nativeReserve = BigInt('100000000000000000000'); // 100 * 1e18
      const stableReserve = BigInt('350000000000'); // 350,000 * 1e6

      const price = calculateNativeTokenPrice(
        nativeReserve, stableReserve,
        makePool({ token0IsNative: true, stablecoinDecimals: 6, nativeDecimals: 18 }),
      );

      expect(price).toBeCloseTo(3500, 0);
    });
  });
});

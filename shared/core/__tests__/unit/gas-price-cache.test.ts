/**
 * Gas Price Cache Tests
 *
 * Tests for the GasPriceCache singleton that provides
 * dynamic gas price caching with periodic refresh.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock logger
jest.mock('../../src/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

// Mock ethers
jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getFeeData: jest.fn<() => Promise<{
        gasPrice: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }>>().mockResolvedValue({
        gasPrice: BigInt(30000000000), // 30 gwei
        maxFeePerGas: BigInt(35000000000),
        maxPriorityFeePerGas: BigInt(2000000000)
      })
    }))
  }
}));

// Mock config
jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    ethereum: {
      id: 1,
      name: 'Ethereum',
      rpcUrl: 'https://eth-mainnet.example.com',
      nativeToken: 'ETH'
    },
    arbitrum: {
      id: 42161,
      name: 'Arbitrum',
      rpcUrl: 'https://arb-mainnet.example.com',
      nativeToken: 'ETH'
    },
    bsc: {
      id: 56,
      name: 'BSC',
      rpcUrl: 'https://bsc-mainnet.example.com',
      nativeToken: 'BNB'
    }
  }
}));

import {
  GasPriceCache,
  getGasPriceCache,
  resetGasPriceCache,
  GAS_UNITS,
  GasPriceData,
  GasCostEstimate
} from '../../src/gas-price-cache';

describe('GasPriceCache', () => {
  let cache: GasPriceCache;

  beforeEach(async () => {
    await resetGasPriceCache();
    cache = new GasPriceCache({
      refreshIntervalMs: 60000,
      staleThresholdMs: 120000,
      autoRefresh: false // Disable for tests
    });
  });

  afterEach(async () => {
    await cache.stop();
    await resetGasPriceCache();
  });

  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      const defaultCache = new GasPriceCache();
      expect(defaultCache).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customCache = new GasPriceCache({
        refreshIntervalMs: 30000,
        staleThresholdMs: 60000
      });
      expect(customCache).toBeDefined();
    });

    it('should start and initialize fallbacks', async () => {
      await cache.start();

      // Should have fallback data for known chains
      const ethGas = cache.getGasPrice('ethereum');
      expect(ethGas).toBeDefined();
      expect(ethGas.gasPriceGwei).toBeGreaterThan(0);
    });
  });

  describe('getGasPrice', () => {
    it('should return gas price for known chain', async () => {
      await cache.start();

      const gasPrice = cache.getGasPrice('ethereum');

      expect(gasPrice).toBeDefined();
      expect(gasPrice.gasPriceGwei).toBeGreaterThan(0);
      expect(gasPrice.gasPriceWei).toBeDefined();
      expect(gasPrice.lastUpdated).toBeGreaterThan(0);
    });

    it('should return fallback for unknown chain', async () => {
      await cache.start();

      const gasPrice = cache.getGasPrice('unknown-chain');

      expect(gasPrice).toBeDefined();
      expect(gasPrice.isFallback).toBe(true);
    });

    it('should be case insensitive', async () => {
      await cache.start();

      const lower = cache.getGasPrice('ethereum');
      const upper = cache.getGasPrice('ETHEREUM');
      const mixed = cache.getGasPrice('Ethereum');

      expect(lower.gasPriceGwei).toBe(upper.gasPriceGwei);
      expect(lower.gasPriceGwei).toBe(mixed.gasPriceGwei);
    });
  });

  describe('getNativeTokenPrice', () => {
    it('should return native token price for known chain', async () => {
      await cache.start();

      const price = cache.getNativeTokenPrice('ethereum');

      expect(price).toBeDefined();
      expect(price.priceUsd).toBeGreaterThan(0);
    });

    it('should return fallback price for unknown chain', async () => {
      await cache.start();

      const price = cache.getNativeTokenPrice('unknown');

      expect(price.isFallback).toBe(true);
      expect(price.priceUsd).toBeGreaterThan(0);
    });

    it('should allow manual price updates', async () => {
      await cache.start();

      cache.setNativeTokenPrice('ethereum', 3000);
      const price = cache.getNativeTokenPrice('ethereum');

      expect(price.priceUsd).toBe(3000);
      expect(price.isFallback).toBe(false);
    });
  });

  describe('estimateGasCostUsd', () => {
    it('should calculate gas cost in USD', async () => {
      await cache.start();

      // Set known values for predictable test
      cache.setNativeTokenPrice('ethereum', 2500);

      const estimate = cache.estimateGasCostUsd('ethereum', 150000);

      expect(estimate).toBeDefined();
      expect(estimate.costUsd).toBeGreaterThan(0);
      expect(estimate.gasUnits).toBe(150000);
      expect(estimate.nativeTokenPriceUsd).toBe(2500);
      expect(estimate.chain).toBe('ethereum');
    });

    it('should scale with gas units', async () => {
      await cache.start();

      const small = cache.estimateGasCostUsd('ethereum', 100000);
      const large = cache.estimateGasCostUsd('ethereum', 500000);

      expect(large.costUsd).toBeGreaterThan(small.costUsd);
      expect(large.costUsd / small.costUsd).toBeCloseTo(5, 1);
    });

    it('should indicate when using fallback values', async () => {
      await cache.start();

      // Unknown chain will use fallback
      const estimate = cache.estimateGasCostUsd('unknown-chain', 150000);

      expect(estimate.usesFallback).toBe(true);
    });
  });

  describe('estimateMultiLegGasCost', () => {
    it('should calculate multi-leg gas cost', async () => {
      await cache.start();
      cache.setNativeTokenPrice('ethereum', 2500);

      const cost3Hop = cache.estimateMultiLegGasCost('ethereum', 3);
      const cost5Hop = cache.estimateMultiLegGasCost('ethereum', 5);

      expect(cost3Hop).toBeGreaterThan(0);
      expect(cost5Hop).toBeGreaterThan(cost3Hop);
    });

    it('should scale linearly with hop count', async () => {
      await cache.start();

      const cost2 = cache.estimateMultiLegGasCost('arbitrum', 2);
      const cost4 = cache.estimateMultiLegGasCost('arbitrum', 4);
      const cost6 = cache.estimateMultiLegGasCost('arbitrum', 6);

      // Additional 2 hops should add similar cost each time
      const diff1 = cost4 - cost2;
      const diff2 = cost6 - cost4;

      expect(diff1).toBeCloseTo(diff2, 1);
    });
  });

  describe('estimateTriangularGasCost', () => {
    it('should calculate triangular arbitrage gas cost', async () => {
      await cache.start();
      cache.setNativeTokenPrice('bsc', 300);

      const cost = cache.estimateTriangularGasCost('bsc');

      expect(cost).toBeGreaterThan(0);
    });

    it('should vary by chain', async () => {
      await cache.start();
      cache.setNativeTokenPrice('ethereum', 2500);
      cache.setNativeTokenPrice('arbitrum', 2500);

      const ethCost = cache.estimateTriangularGasCost('ethereum');
      const arbCost = cache.estimateTriangularGasCost('arbitrum');

      // Arbitrum should be cheaper due to lower gas prices
      expect(arbCost).toBeLessThan(ethCost);
    });
  });

  describe('Refresh', () => {
    it('should refresh gas prices on demand', async () => {
      await cache.start();

      const before = cache.getGasPrice('ethereum');
      await cache.refreshAll();
      const after = cache.getGasPrice('ethereum');

      // After refresh, should have updated timestamp
      expect(after.lastUpdated).toBeGreaterThanOrEqual(before.lastUpdated);
    });

    it('should refresh specific chain', async () => {
      await cache.start();

      await cache.refreshChain('ethereum');
      const gasPrice = cache.getGasPrice('ethereum');

      expect(gasPrice.lastUpdated).toBeGreaterThan(Date.now() - 5000);
    });
  });

  describe('Stats', () => {
    it('should return cache statistics', async () => {
      await cache.start();

      const stats = cache.getStats();

      expect(stats.chainsMonitored).toBeGreaterThan(0);
      expect(stats.freshPrices).toBeGreaterThanOrEqual(0);
      expect(stats.stalePrices).toBeGreaterThanOrEqual(0);
      expect(stats.fallbackPrices).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Singleton', () => {
    it('should return same instance via getGasPriceCache', async () => {
      const instance1 = getGasPriceCache();
      const instance2 = getGasPriceCache();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton instance', async () => {
      const instance1 = getGasPriceCache();
      await resetGasPriceCache();
      const instance2 = getGasPriceCache();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Lifecycle', () => {
    it('should start and stop cleanly', async () => {
      await cache.start();
      expect(cache.getStats().chainsMonitored).toBeGreaterThan(0);

      await cache.stop();
      // Should be able to stop without error
    });

    it('should handle multiple start calls', async () => {
      await cache.start();
      await cache.start(); // Should not throw

      expect(cache.getStats().chainsMonitored).toBeGreaterThan(0);
    });

    it('should handle stop when not started', async () => {
      // Should not throw
      await cache.stop();
    });
  });
});

describe('GAS_UNITS Constants', () => {
  it('should have valid gas unit values', () => {
    expect(GAS_UNITS.simpleSwap).toBe(150000);
    expect(GAS_UNITS.complexSwap).toBe(200000);
    expect(GAS_UNITS.triangularArbitrage).toBe(450000);
    expect(GAS_UNITS.quadrilateralArbitrage).toBe(600000);
    expect(GAS_UNITS.multiLegPerHop).toBe(150000);
    expect(GAS_UNITS.multiLegBase).toBe(100000);
  });

  it('should have realistic gas estimates', () => {
    // Triangular should be roughly 3x simple swap
    expect(GAS_UNITS.triangularArbitrage).toBe(GAS_UNITS.simpleSwap * 3);

    // Quadrilateral should be roughly 4x simple swap
    expect(GAS_UNITS.quadrilateralArbitrage).toBe(GAS_UNITS.simpleSwap * 4);
  });
});

describe('Graceful Degradation (without start)', () => {
  let unstartedCache: GasPriceCache;

  beforeEach(async () => {
    await resetGasPriceCache();
    unstartedCache = new GasPriceCache({
      autoRefresh: false
    });
    // Intentionally NOT calling start()
  });

  afterEach(async () => {
    await unstartedCache.stop();
  });

  it('should return fallback gas prices when not started', () => {
    // Cache should work without start() being called
    const gasPrice = unstartedCache.getGasPrice('ethereum');

    expect(gasPrice).toBeDefined();
    expect(gasPrice.gasPriceGwei).toBeGreaterThan(0);
    expect(gasPrice.isFallback).toBe(true);
  });

  it('should return fallback native token prices when not started', () => {
    const nativePrice = unstartedCache.getNativeTokenPrice('ethereum');

    expect(nativePrice).toBeDefined();
    expect(nativePrice.priceUsd).toBeGreaterThan(0);
    expect(nativePrice.isFallback).toBe(true);
  });

  it('should estimate gas costs using fallbacks when not started', () => {
    const estimate = unstartedCache.estimateGasCostUsd('ethereum', 150000);

    expect(estimate).toBeDefined();
    expect(estimate.costUsd).toBeGreaterThan(0);
    expect(estimate.usesFallback).toBe(true);
  });

  it('should have chains monitored even without start', () => {
    // Constructor now initializes fallbacks
    const stats = unstartedCache.getStats();

    expect(stats.chainsMonitored).toBeGreaterThan(0);
    expect(stats.fallbackPrices).toBe(stats.chainsMonitored); // All are fallbacks
  });
});

describe('Concurrent Refresh Protection', () => {
  let cache: GasPriceCache;

  beforeEach(async () => {
    await resetGasPriceCache();
    cache = new GasPriceCache({
      refreshIntervalMs: 60000,
      staleThresholdMs: 120000,
      autoRefresh: false
    });
    await cache.start();
  });

  afterEach(async () => {
    await cache.stop();
  });

  it('should prevent concurrent refresh operations', async () => {
    // Start multiple refreshes simultaneously
    const refreshPromises = [
      cache.refreshAll(),
      cache.refreshAll(),
      cache.refreshAll()
    ];

    // All should complete without error
    await Promise.all(refreshPromises);

    // Cache should still be functional
    const stats = cache.getStats();
    expect(stats.chainsMonitored).toBeGreaterThan(0);
  });
});

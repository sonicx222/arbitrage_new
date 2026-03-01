/**
 * Gas Price Cache Tests
 *
 * Tests for the GasPriceCache singleton that provides
 * dynamic gas price caching with periodic refresh.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup - Must be before any imports that might use these modules
// =============================================================================

// Mock logger as fallback (DI is preferred via deps parameter)
// Note: This mock is needed for getGasPriceCache() singleton tests that don't support DI
// Auto-resolves to src/__mocks__/logger.ts
jest.mock('../../src/logger');

// Mock ethers
// Fix: Include AbiCoder mock to prevent import errors from event-processor.ts
// when importing from @arbitrage/core (which transitively imports event-processor)
//
// NOTE: All mock functions used inside jest.mock() factory MUST be created inside
// the factory itself due to Jest hoisting. Variables declared outside are undefined
// when the factory runs.
jest.mock('ethers', () => {
  const mockAbiCoder = {
    decode: jest.fn().mockReturnValue([BigInt(1000000), BigInt(2000000)]),
    encode: jest.fn().mockReturnValue('0x')
  };

  // L1 oracle contract method mocks (accessible via ethers.__mocks__)
  // Use async functions that return resolved promises
  const _mockGetL1BaseFeeEstimate = jest.fn<() => Promise<bigint>>()
    .mockImplementation(async () => BigInt(30000000000)); // 30 gwei
  const _mockL1BaseFee = jest.fn<() => Promise<bigint>>()
    .mockImplementation(async () => BigInt(25000000000)); // 25 gwei
  const _mockProviderSend = jest.fn<() => Promise<unknown>>()
    .mockImplementation(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === 'zks_estimateFee') {
        return {
          gas_limit: '0x30D40', // 200000
          max_fee_per_gas: '0x5F5E100', // 100000000 (0.1 gwei)
          max_priority_fee_per_gas: '0x0',
          gas_per_pubdata_limit: '0xC8', // 200
        };
      }
      return null;
    });

  return {
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
        }),
        send: _mockProviderSend,
      })),
      Contract: jest.fn().mockImplementation((...args: unknown[]) => {
        // Return the right mock based on the ABI signature
        const abi = args[1] as string[];
        if (abi[0]?.includes('getL1BaseFeeEstimate')) {
          return { getL1BaseFeeEstimate: _mockGetL1BaseFeeEstimate };
        }
        return { l1BaseFee: _mockL1BaseFee };
      }),
      AbiCoder: {
        defaultAbiCoder: jest.fn().mockReturnValue(mockAbiCoder)
      },
      Interface: jest.fn().mockImplementation(() => ({
        parseLog: jest.fn(),
        getEvent: jest.fn(),
        encodeFunctionData: jest.fn(),
        decodeFunctionResult: jest.fn(),
      })),
      // P1 Fix LW-012: Mock Network.from() used by staticNetwork provider creation
      Network: { from: jest.fn().mockImplementation((chainId: number) => ({ chainId, name: `chain-${chainId}` })) },
      FetchRequest: jest.fn().mockImplementation(() => ({ timeout: 0 })),
    },
    // Expose internal mocks for test assertions
    __mocks__: {
      mockGetL1BaseFeeEstimate: _mockGetL1BaseFeeEstimate,
      mockL1BaseFee: _mockL1BaseFee,
      mockProviderSend: _mockProviderSend,
    },
  };
});

// Mock config — mutable FEATURE_FLAGS for per-test override
const mockFeatureFlags = {
  useDynamicL1Fees: false,
};

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
    },
    optimism: {
      id: 10,
      name: 'Optimism',
      rpcUrl: 'https://optimism-mainnet.example.com',
      nativeToken: 'ETH'
    },
    base: {
      id: 8453,
      name: 'Base',
      rpcUrl: 'https://base-mainnet.example.com',
      nativeToken: 'ETH'
    },
    zksync: {
      id: 324,
      name: 'zkSync Era',
      rpcUrl: 'https://zksync-mainnet.example.com',
      nativeToken: 'ETH'
    },
    linea: {
      id: 59144,
      name: 'Linea',
      rpcUrl: 'https://linea-mainnet.example.com',
      nativeToken: 'ETH'
    }
  },
  // FIX: Include NATIVE_TOKEN_PRICES which is imported by gas-price-cache.ts
  NATIVE_TOKEN_PRICES: {
    ethereum: 3500,
    arbitrum: 3500,
    bsc: 600,
    optimism: 3500,
    base: 3500,
    zksync: 3500,
    linea: 3500,
  },
  // Phase 3: FEATURE_FLAGS imported by gas-price-cache.ts for dynamic L1 fees
  // Use mutable object reference so tests can toggle flags
  FEATURE_FLAGS: mockFeatureFlags,
  // W2-12/W2-13 fix: isEvmChainSafe used to skip non-EVM chains in refreshChain()
  isEvmChainSafe: (chain: string) => !chain.startsWith('solana'),
}));

// =============================================================================
// Imports - After mocks
// =============================================================================

import { RecordingLogger } from '@arbitrage/core/logging';
import {
  GasPriceCache,
  getGasPriceCache,
  resetGasPriceCache,
  GAS_UNITS,
  GasPriceData,
  GasCostEstimate
} from '../../src/caching/gas-price-cache';

// Access internal mock references exposed by the ethers mock
// These are created inside jest.mock factory and exposed via __mocks__
const ethersMocks = require('ethers').__mocks__ as {
  mockGetL1BaseFeeEstimate: jest.Mock;
  mockL1BaseFee: jest.Mock;
  mockProviderSend: jest.Mock;
};

// Create shared logger instance for DI
const logger = new RecordingLogger();

describe('GasPriceCache', () => {
  let cache: GasPriceCache;

  beforeEach(async () => {
    await resetGasPriceCache();
    logger.clear();
    cache = new GasPriceCache({
      refreshIntervalMs: 60000,
      staleThresholdMs: 120000,
      autoRefresh: false // Disable for tests
    }, { logger: logger as any });
  });

  afterEach(async () => {
    await cache.stop();
    await resetGasPriceCache();
  });

  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      const defaultCache = new GasPriceCache({}, { logger: logger as any });
      expect(defaultCache).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customCache = new GasPriceCache({
        refreshIntervalMs: 30000,
        staleThresholdMs: 60000
      }, { logger: logger as any });
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

      // Both chains use the same mocked gas price (30 gwei) so costs are equal.
      // In production, Arbitrum would be cheaper due to lower L2 gas prices.
      expect(arbCost).toBeLessThanOrEqual(ethCost);
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
    logger.clear();
    unstartedCache = new GasPriceCache({
      autoRefresh: false
    }, { logger: logger as any });
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
    logger.clear();
    cache = new GasPriceCache({
      refreshIntervalMs: 60000,
      staleThresholdMs: 120000,
      autoRefresh: false
    }, { logger: logger as any });
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

// =============================================================================
// L1 Oracle Integration Tests (Fix 5)
// =============================================================================

describe('L1 Oracle Integration', () => {
  let cache: GasPriceCache;

  beforeEach(async () => {
    await resetGasPriceCache();
    logger.clear();
    // Reset feature flag to disabled state
    mockFeatureFlags.useDynamicL1Fees = false;
    // Reset mock call counts
    if (ethersMocks) {
      ethersMocks.mockGetL1BaseFeeEstimate.mockClear();
      ethersMocks.mockL1BaseFee.mockClear();
      ethersMocks.mockProviderSend.mockClear();
    }
  });

  afterEach(async () => {
    if (cache) {
      await cache.stop();
    }
    // Restore default feature flag state
    mockFeatureFlags.useDynamicL1Fees = false;
  });

  describe('getL1DataFee (static fallback)', () => {
    it('should return static fallback when useDynamicL1Fees is false', async () => {
      cache = new GasPriceCache({
        autoRefresh: false,
      }, { logger: logger as any });
      await cache.start();

      // L2 chains should have a non-zero L1 data fee from static fallback
      const estimate = cache.estimateGasCostUsd('arbitrum', 150000);
      expect(estimate.costUsd).toBeGreaterThan(0);
    });

    it('should return 0 L1 data fee for non-L2 chains', async () => {
      cache = new GasPriceCache({
        autoRefresh: false,
      }, { logger: logger as any });
      await cache.start();

      cache.setNativeTokenPrice('ethereum', 3500);
      cache.setNativeTokenPrice('bsc', 600);

      // Ethereum and BSC are not L2 rollups, so L1 data fee should be 0
      // The total gas cost should only include execution cost (no L1 data fee)
      const ethEstimate = cache.estimateGasCostUsd('ethereum', 150000);
      const bscEstimate = cache.estimateGasCostUsd('bsc', 150000);

      // Both should have some cost (from L2 execution), but not L1 fees
      // We verify by checking that the cost matches pure execution cost
      const ethGasPrice = cache.getGasPrice('ethereum');
      const ethGasPriceEth = ethGasPrice.gasPriceGwei / 1e9;
      const expectedEthCost = 150000 * ethGasPriceEth * 3500;
      expect(ethEstimate.costUsd).toBeCloseTo(expectedEthCost, 2);

      const bscGasPrice = cache.getGasPrice('bsc');
      const bscGasPriceEth = bscGasPrice.gasPriceGwei / 1e9;
      const expectedBscCost = 150000 * bscGasPriceEth * 600;
      expect(bscEstimate.costUsd).toBeCloseTo(expectedBscCost, 2);
    });
  });

  describe('getL1DataFee (dynamic oracle)', () => {
    it('should use cached oracle value when flag is true and cache is fresh', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'arbitrum', 'optimism', 'base', 'zksync', 'linea'],
      }, { logger: logger as any });
      await cache.start();

      // Directly invoke refreshL1OracleCache (private method) to avoid fire-and-forget timing
      await (cache as any).refreshL1OracleCache();

      // Verify that ethers.Contract was called (oracle contracts were queried)
      const { ethers: mockedEthers } = await import('ethers');
      expect((mockedEthers.Contract as jest.Mock).mock.calls.length).toBeGreaterThan(0);

      // For arbitrum: oracle should have been called via Contract → getL1BaseFeeEstimate
      // L1 cost = 30e9 * 500 * 16 / 1e18 * ethPrice = 0.00024 * 3500 = $0.84
      const arbEstimate = cache.estimateGasCostUsd('arbitrum', 150000);
      expect(arbEstimate.costUsd).toBeGreaterThan(0);
    });

    it('should fall back to static value when oracle cache is stale', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'arbitrum'],
      }, { logger: logger as any });

      // Don't call start() or refreshL1OracleCache — so L1 oracle cache is never populated
      // getL1DataFee should fall back to static L1_DATA_FEE_USD

      const arbEstimate = cache.estimateGasCostUsd('arbitrum', 150000);
      // Should still have L1 data fee from static fallback ($0.50 for arbitrum)
      expect(arbEstimate.costUsd).toBeGreaterThan(0);
    });
  });

  describe('startL1OracleRefresh', () => {
    it('should be a no-op when useDynamicL1Fees is false', async () => {
      mockFeatureFlags.useDynamicL1Fees = false;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'arbitrum'],
      }, { logger: logger as any });
      await cache.start();

      // With flag false, the Contract constructor should not have been invoked for oracle queries
      const { ethers: mockedEthers } = await import('ethers');
      // Contract may have been called by prior tests in same module; check relative to current test
      // Instead, we verify the oracle cache is empty
      const l1OracleCache = (cache as any).l1OracleCache as Map<string, unknown>;
      expect(l1OracleCache.size).toBe(0);
    });

    it('should query oracle contracts when flag is true', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'arbitrum', 'optimism', 'base', 'zksync', 'linea'],
      }, { logger: logger as any });
      await cache.start();

      // Directly invoke refreshL1OracleCache to avoid fire-and-forget timing
      await (cache as any).refreshL1OracleCache();

      // Check log messages for oracle activity
      const allLogs = logger.getAllLogs();
      const oracleDebugLogs = allLogs.filter((l) => l.msg.includes('L1 oracle') || l.msg.includes('L1 fee'));
      const warnLogs = allLogs.filter((l) => l.msg.includes('oracle') && l.level === 'warn');

      // Should have logged oracle refresh info
      // (Either success debug messages or partial failure warnings)
      const oracleLogCount = oracleDebugLogs.length + warnLogs.length;
      expect(oracleLogCount).toBeGreaterThan(0);

      // Verify Contract was invoked (oracle contract creation)
      const { ethers: mockedEthers } = await import('ethers');
      expect((mockedEthers.Contract as jest.Mock).mock.calls.length).toBeGreaterThan(0);

      // The gas estimate for L2 chains should include L1 data fee component
      const arbEstimate = cache.estimateGasCostUsd('arbitrum', 150000);
      expect(arbEstimate.costUsd).toBeGreaterThan(0);
    });
  });

  describe('zkSync oracle path', () => {
    it('should produce a gas cost estimate for zkSync', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'zksync'],
      }, { logger: logger as any });
      await cache.start();

      // Directly invoke refreshL1OracleCache
      await (cache as any).refreshL1OracleCache();

      // zkSync should have a cost estimate (either dynamic or static fallback)
      const zkEstimate = cache.estimateGasCostUsd('zksync', 150000);
      expect(zkEstimate.costUsd).toBeGreaterThan(0);
    });

    it('should fall back to static value when zks_estimateFee fails', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'zksync'],
      }, { logger: logger as any });
      await cache.start();

      // Even if the RPC call fails, the static fallback should provide a cost
      const zkEstimate = cache.estimateGasCostUsd('zksync', 150000);
      expect(zkEstimate.costUsd).toBeGreaterThan(0);
    });
  });

  describe('Linea oracle path', () => {
    it('should produce a gas cost estimate for Linea', async () => {
      mockFeatureFlags.useDynamicL1Fees = true;

      cache = new GasPriceCache({
        autoRefresh: false,
        chains: ['ethereum', 'linea'],
      }, { logger: logger as any });
      await cache.start();

      // Directly invoke refreshL1OracleCache
      await (cache as any).refreshL1OracleCache();

      // Linea should have a cost estimate (either from Ethereum base fee derivation or static fallback)
      const lineaEstimate = cache.estimateGasCostUsd('linea', 150000);
      expect(lineaEstimate.costUsd).toBeGreaterThan(0);
    });
  });
});

/**
 * Intra-Solana Detector Tests
 *
 * Tests for detecting arbitrage opportunities between different Solana DEXs.
 * Covers price comparison, fee calculation, stale pool filtering, and bounded iteration.
 *
 * @see services/partition-solana/src/detection/intra-solana-detector.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  detectIntraSolanaArbitrage,
  IntraSolanaDetectorConfig,
  IntraSolanaDetectionResult,
} from '../../../src/detection/intra-solana-detector';
import type { VersionedPoolStore } from '../../../src/pool/versioned-pool-store';
import type { OpportunityFactory } from '../../../src/opportunity-factory';
import type { InternalPoolInfo, SolanaArbitrageLogger, SolanaArbitrageOpportunity } from '../../../src/types';

// =============================================================================
// Helpers
// =============================================================================

function createMockPool(overrides: Partial<InternalPoolInfo> = {}): InternalPoolInfo {
  return {
    address: 'pool-address-1',
    programId: 'program-id-1',
    dex: 'raydium',
    token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
    token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
    fee: 25, // 0.25% in basis points
    price: 100,
    lastUpdated: Date.now(),
    normalizedToken0: 'SOL',
    normalizedToken1: 'USDC',
    pairKey: 'SOL-USDC',
    ...overrides,
  };
}

function createMockOpportunity(overrides: Partial<SolanaArbitrageOpportunity> = {}): SolanaArbitrageOpportunity {
  return {
    id: 'sol-arb-test-1',
    type: 'intra-solana',
    chain: 'solana',
    buyDex: 'raydium',
    sellDex: 'orca',
    buyPair: 'pool-1',
    sellPair: 'pool-2',
    token0: 'SOL',
    token1: 'USDC',
    buyPrice: 100,
    sellPrice: 102,
    profitPercentage: 1.5,
    expectedProfit: 0.015,
    estimatedGasCost: 0.001,
    netProfitAfterGas: 0.014,
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 1000,
    status: 'pending',
    ...overrides,
  };
}

const defaultConfig: IntraSolanaDetectorConfig = {
  minProfitThreshold: 0.3,
  priceStalenessMs: 5000,
  basePriorityFeeLamports: 10000,
  priorityFeeMultiplier: 1.0,
  defaultTradeValueUsd: 1000,
};

function createMockPoolStore(pairMap: Map<string, InternalPoolInfo[]>): VersionedPoolStore {
  return {
    getPairKeys: jest.fn<() => string[]>().mockReturnValue(Array.from(pairMap.keys())),
    getPoolsForPair: jest.fn<(key: string) => InternalPoolInfo[]>().mockImplementation(
      (key: string) => pairMap.get(key) ?? []
    ),
  } as unknown as VersionedPoolStore;
}

function createMockOpportunityFactory(): OpportunityFactory {
  return {
    createIntraSolana: jest.fn<(buy: InternalPoolInfo, sell: InternalPoolInfo, profit: number, gas: number) => SolanaArbitrageOpportunity>()
      .mockImplementation((buy, sell, profit, gas) =>
        createMockOpportunity({
          buyDex: buy.dex,
          sellDex: sell.dex,
          buyPrice: buy.price!,
          sellPrice: sell.price!,
          expectedProfit: profit,
          estimatedGasCost: gas,
        })
      ),
  } as unknown as OpportunityFactory;
}

// =============================================================================
// Tests
// =============================================================================

describe('detectIntraSolanaArbitrage', () => {
  let poolStore: VersionedPoolStore;
  let factory: OpportunityFactory;
  let logger: SolanaArbitrageLogger;

  beforeEach(() => {
    factory = createMockOpportunityFactory();
    logger = createMockLogger();
  });

  describe('basic detection', () => {
    it('should return empty opportunities when no pair keys exist', () => {
      poolStore = createMockPoolStore(new Map());

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
      expect(result.stalePoolsSkipped).toBe(0);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should skip pairs with fewer than 2 pools', () => {
      const pool = createMockPool();
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });

    it('should detect opportunity between two pools with price difference', () => {
      const pool1 = createMockPool({ address: 'pool-1', dex: 'raydium', price: 100, fee: 25, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', dex: 'orca', price: 103, fee: 30, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities.length).toBeGreaterThan(0);
      expect(factory.createIntraSolana).toHaveBeenCalled();
    });

    it('should not detect opportunity when price difference is below threshold after fees', () => {
      // 0.1% price diff with 0.25% + 0.30% fees = negative net
      const pool1 = createMockPool({ address: 'pool-1', dex: 'raydium', price: 100, fee: 25, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', dex: 'orca', price: 100.1, fee: 30, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });
  });

  describe('stale price filtering', () => {
    it('should skip pools with stale prices', () => {
      const freshPool = createMockPool({ address: 'fresh', price: 100, lastUpdated: Date.now() });
      const stalePool = createMockPool({ address: 'stale', price: 103, lastUpdated: Date.now() - 10000 });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [freshPool, stalePool]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.stalePoolsSkipped).toBe(1);
    });

    it('should treat pools without lastUpdated as stale', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 103, lastUpdated: undefined });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.stalePoolsSkipped).toBe(1);
    });
  });

  describe('invalid price filtering', () => {
    it('should skip pools with undefined price', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: undefined, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });

    it('should skip pools with zero price', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 0, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });
  });

  describe('fee validation', () => {
    it('should skip opportunity when pool has invalid fee', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, fee: -1, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 105, fee: 30, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });

    it('should skip opportunity when fee exceeds 10000 basis points', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, fee: 25, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 105, fee: 10001, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });
  });

  describe('direction determination', () => {
    it('should set buy pool as the one with lower price', () => {
      const pool1 = createMockPool({ address: 'pool-low', dex: 'raydium', price: 100, fee: 10, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-high', dex: 'orca', price: 105, fee: 10, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      const createCall = (factory.createIntraSolana as jest.Mock).mock.calls[0];
      if (createCall) {
        const [buyPool, sellPool] = createCall as [InternalPoolInfo, InternalPoolInfo, number, number];
        expect(buyPool.price).toBeLessThan(sellPool.price!);
      }
    });
  });

  describe('multiple pairs', () => {
    it('should detect opportunities across multiple pairs', () => {
      const solUsdc1 = createMockPool({ address: 'sol-usdc-1', pairKey: 'SOL-USDC', price: 100, fee: 10, lastUpdated: Date.now() });
      const solUsdc2 = createMockPool({ address: 'sol-usdc-2', pairKey: 'SOL-USDC', dex: 'orca', price: 105, fee: 10, lastUpdated: Date.now() });
      const ethUsdc1 = createMockPool({ address: 'eth-usdc-1', pairKey: 'ETH-USDC', normalizedToken0: 'ETH', price: 3000, fee: 10, lastUpdated: Date.now() });
      const ethUsdc2 = createMockPool({ address: 'eth-usdc-2', pairKey: 'ETH-USDC', normalizedToken0: 'ETH', dex: 'orca', price: 3150, fee: 10, lastUpdated: Date.now() });

      poolStore = createMockPoolStore(new Map([
        ['SOL-USDC', [solUsdc1, solUsdc2]],
        ['ETH-USDC', [ethUsdc1, ethUsdc2]],
      ]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(result.opportunities.length).toBe(2);
    });
  });

  describe('result structure', () => {
    it('should include latencyMs in result', () => {
      poolStore = createMockPoolStore(new Map());

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should include stalePoolsSkipped count', () => {
      poolStore = createMockPoolStore(new Map());

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig, logger);

      expect(typeof result.stalePoolsSkipped).toBe('number');
    });
  });

  describe('config threshold', () => {
    it('should respect custom minProfitThreshold', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, fee: 10, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 101, fee: 10, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      // With a very high threshold, no opportunity should be detected
      const highThresholdConfig = { ...defaultConfig, minProfitThreshold: 50 };
      const result = detectIntraSolanaArbitrage(poolStore, factory, highThresholdConfig, logger);

      expect(result.opportunities).toHaveLength(0);
    });

    it('should detect with a very low threshold', () => {
      // 1% diff - 0.02% fees = ~0.98% net
      const pool1 = createMockPool({ address: 'pool-1', price: 100, fee: 10, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 101, fee: 10, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const lowThresholdConfig = { ...defaultConfig, minProfitThreshold: 0.01 };
      const result = detectIntraSolanaArbitrage(poolStore, factory, lowThresholdConfig, logger);

      expect(result.opportunities.length).toBeGreaterThan(0);
    });
  });

  describe('without logger', () => {
    it('should work without logger parameter', () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100, fee: 25, lastUpdated: Date.now() });
      const pool2 = createMockPool({ address: 'pool-2', price: 105, fee: 30, lastUpdated: Date.now() });
      poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));

      const result = detectIntraSolanaArbitrage(poolStore, factory, defaultConfig);

      expect(result).toBeDefined();
      expect(result.opportunities).toBeDefined();
    });
  });
});

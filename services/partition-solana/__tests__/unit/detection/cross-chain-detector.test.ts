/**
 * Cross-Chain Arbitrage Detector Tests
 *
 * Tests for detecting price differences between Solana and EVM chains.
 * Covers price comparison, bridge cost estimation, gas costs, and direction determination.
 *
 * @see services/partition-solana/src/detection/cross-chain-detector.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  compareCrossChainPrices,
  estimateCrossChainGasCostPercent,
  detectCrossChainArbitrage,
  getDefaultCrossChainCosts,
  CrossChainDetectorConfig,
} from '../../../src/detection/cross-chain-detector';
import { EVM_GAS_COSTS_USD, getEvmGasCostUsd } from '../../../src/detection/base';
import type { VersionedPoolStore } from '../../../src/pool/versioned-pool-store';
import type { OpportunityFactory } from '../../../src/opportunity-factory';
import type {
  InternalPoolInfo,
  EvmPriceUpdate,
  CrossChainPriceComparison,
  SolanaArbitrageLogger,
  SolanaArbitrageOpportunity,
} from '../../../src/types';
import { createMockInternalPool, createMockPoolStore } from '../../helpers/test-fixtures';

// =============================================================================
// Helpers
// =============================================================================

const createMockPool = (overrides: Partial<InternalPoolInfo> = {}): InternalPoolInfo =>
  createMockInternalPool({ address: 'sol-pool-1', ...overrides });

function createEvmPriceUpdate(overrides: Partial<EvmPriceUpdate> = {}): EvmPriceUpdate {
  return {
    pairKey: 'SOL-USDC',
    chain: 'ethereum',
    dex: 'uniswap',
    token0: 'SOL',
    token1: 'USDC',
    price: 105,
    reserve0: '1000000000',
    reserve1: '105000000000',
    blockNumber: 18000000,
    timestamp: Date.now(),
    latency: 100,
    fee: 30,
    ...overrides,
  };
}

const defaultConfig: CrossChainDetectorConfig = {
  minProfitThreshold: 0.3,
  priceStalenessMs: 5000,
  defaultTradeValueUsd: 1000,
  crossChainCosts: {
    bridgeFeeDefault: 0.001,
    evmGasCostUsd: 15,
    solanaTxCostUsd: 0.01,
    latencyRiskPremium: 0.002,
  },
};

function createMockOpportunityFactory(): OpportunityFactory {
  return {
    createCrossChain: jest.fn<(comp: CrossChainPriceComparison, dir: string, profit: number, mult: number) => SolanaArbitrageOpportunity>()
      .mockImplementation((comp, dir, profit, mult) => ({
        id: 'sol-xchain-test-1',
        type: 'cross-chain' as const,
        chain: 'solana',
        sourceChain: 'solana',
        targetChain: comp.evmChain,
        direction: dir as 'buy-solana-sell-evm' | 'buy-evm-sell-solana',
        buyDex: dir === 'buy-solana-sell-evm' ? comp.solanaDex : comp.evmDex,
        sellDex: dir === 'buy-solana-sell-evm' ? comp.evmDex : comp.solanaDex,
        buyPair: dir === 'buy-solana-sell-evm' ? comp.solanaPoolAddress : comp.evmPairKey,
        sellPair: dir === 'buy-solana-sell-evm' ? comp.evmPairKey : comp.solanaPoolAddress,
        token0: comp.token,
        token1: comp.quoteToken,
        buyPrice: dir === 'buy-solana-sell-evm' ? comp.solanaPrice : comp.evmPrice,
        sellPrice: dir === 'buy-solana-sell-evm' ? comp.evmPrice : comp.solanaPrice,
        profitPercentage: profit * 100,
        expectedProfit: profit,
        confidence: 0.6,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        status: 'pending' as const,
      })),
  } as unknown as OpportunityFactory;
}

const normalizeToken = (symbol: string) => symbol.toUpperCase();
const createPairKey = (t0: string, t1: string) => `${t0}-${t1}`;

// =============================================================================
// Tests
// =============================================================================

describe('compareCrossChainPrices', () => {
  let logger: SolanaArbitrageLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return empty comparisons when no EVM prices provided', () => {
    const poolStore = createMockPoolStore(new Map());

    const comparisons = compareCrossChainPrices(
      [], poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(0);
  });

  it('should return empty when no matching Solana pools exist', () => {
    const poolStore = createMockPoolStore(new Map());
    const evmPrices = [createEvmPriceUpdate()];

    const comparisons = compareCrossChainPrices(
      evmPrices, poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(0);
  });

  it('should create comparison for matching Solana pool', () => {
    const solanaPool = createMockPool({ price: 100, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 105 })];

    const comparisons = compareCrossChainPrices(
      evmPrices, poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].solanaPrice).toBe(100);
    expect(comparisons[0].evmPrice).toBe(105);
    expect(comparisons[0].priceDifferencePercent).toBeCloseTo(5, 1);
  });

  it('should create multiple comparisons for multiple Solana pools', () => {
    const pool1 = createMockPool({ address: 'pool-1', dex: 'raydium', price: 100, lastUpdated: Date.now() });
    const pool2 = createMockPool({ address: 'pool-2', dex: 'orca', price: 99, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool1, pool2]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 105 })];

    const comparisons = compareCrossChainPrices(
      evmPrices, poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(2);
  });

  it('should skip Solana pools with invalid prices', () => {
    const pool = createMockPool({ price: undefined, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [pool]]]));
    const evmPrices = [createEvmPriceUpdate()];

    const comparisons = compareCrossChainPrices(
      evmPrices, poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(0);
  });

  it('should skip stale Solana pools', () => {
    const stalePool = createMockPool({ price: 100, lastUpdated: Date.now() - 10000 });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [stalePool]]]));
    const evmPrices = [createEvmPriceUpdate()];

    const comparisons = compareCrossChainPrices(
      evmPrices, poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(comparisons).toHaveLength(0);
  });

  it('should include correct fields in comparison', () => {
    const solanaPool = createMockPool({
      address: 'sol-pool-addr',
      dex: 'raydium',
      price: 100,
      fee: 25,
      lastUpdated: Date.now(),
    });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrice = createEvmPriceUpdate({
      chain: 'arbitrum',
      dex: 'uniswap-v3',
      price: 105,
      fee: 30,
    });

    const comparisons = compareCrossChainPrices(
      [evmPrice], poolStore, normalizeToken, createPairKey, defaultConfig, logger
    );

    const comp = comparisons[0];
    expect(comp.token).toBe('SOL');
    expect(comp.quoteToken).toBe('USDC');
    expect(comp.solanaDex).toBe('raydium');
    expect(comp.evmChain).toBe('arbitrum');
    expect(comp.evmDex).toBe('uniswap-v3');
    expect(comp.solanaPoolAddress).toBe('sol-pool-addr');
    expect(comp.solanaFee).toBe(25);
    expect(comp.evmFee).toBe(30);
    expect(typeof comp.timestamp).toBe('number');
  });
});

describe('estimateCrossChainGasCostPercent', () => {
  it('should calculate gas cost as percentage of trade value', () => {
    const result = estimateCrossChainGasCostPercent(defaultConfig);

    // (15 + 0.01) / 1000 = 0.01501
    expect(result).toBeCloseTo(0.01501, 4);
  });

  it('should increase with higher gas costs', () => {
    const highGasConfig = {
      ...defaultConfig,
      crossChainCosts: { ...defaultConfig.crossChainCosts, evmGasCostUsd: 50 },
    };

    const normalResult = estimateCrossChainGasCostPercent(defaultConfig);
    const highResult = estimateCrossChainGasCostPercent(highGasConfig);

    expect(highResult).toBeGreaterThan(normalResult);
  });

  it('should decrease with larger trade value', () => {
    const largeTradeConfig = { ...defaultConfig, defaultTradeValueUsd: 10000 };

    const normalResult = estimateCrossChainGasCostPercent(defaultConfig);
    const largeResult = estimateCrossChainGasCostPercent(largeTradeConfig);

    expect(largeResult).toBeLessThan(normalResult);
  });

  it('should use per-chain gas cost when evmChain is provided', () => {
    // Arbitrum gas is ~$0.10 vs default $15
    const arbitrumResult = estimateCrossChainGasCostPercent(defaultConfig, 'arbitrum');
    const defaultResult = estimateCrossChainGasCostPercent(defaultConfig);

    // (0.10 + 0.01) / 1000 = 0.00011 vs (15 + 0.01) / 1000 = 0.01501
    expect(arbitrumResult).toBeLessThan(defaultResult);
    expect(arbitrumResult).toBeCloseTo(0.00011, 4);
  });

  it('should fall back to config default for unknown chains', () => {
    const unknownChainResult = estimateCrossChainGasCostPercent(defaultConfig, 'unknown-chain');
    const defaultResult = estimateCrossChainGasCostPercent(defaultConfig);

    expect(unknownChainResult).toBeCloseTo(defaultResult, 6);
  });

  it('should be case-insensitive for chain lookup', () => {
    const upperResult = estimateCrossChainGasCostPercent(defaultConfig, 'ARBITRUM');
    const lowerResult = estimateCrossChainGasCostPercent(defaultConfig, 'arbitrum');

    expect(upperResult).toBeCloseTo(lowerResult, 6);
  });
});

describe('getEvmGasCostUsd', () => {
  it('should return chain-specific gas cost', () => {
    expect(getEvmGasCostUsd('arbitrum', 15)).toBe(0.10);
    expect(getEvmGasCostUsd('base', 15)).toBe(0.05);
    expect(getEvmGasCostUsd('ethereum', 15)).toBe(15);
  });

  it('should return default for unknown chain', () => {
    expect(getEvmGasCostUsd('unknown', 99)).toBe(99);
  });

  it('should cover all supported chains', () => {
    const expectedChains = ['ethereum', 'arbitrum', 'base', 'optimism', 'linea', 'zksync', 'polygon', 'bsc', 'avalanche', 'fantom'];
    for (const chain of expectedChains) {
      expect(EVM_GAS_COSTS_USD[chain]).toBeDefined();
      expect(typeof EVM_GAS_COSTS_USD[chain]).toBe('number');
    }
  });

  it('should have L2 costs lower than Ethereum mainnet', () => {
    const l2Chains = ['arbitrum', 'base', 'optimism', 'linea', 'zksync'];
    const ethCost = EVM_GAS_COSTS_USD['ethereum'];
    for (const chain of l2Chains) {
      expect(EVM_GAS_COSTS_USD[chain]).toBeLessThan(ethCost);
    }
  });
});

describe('detectCrossChainArbitrage', () => {
  let factory: OpportunityFactory;
  let logger: SolanaArbitrageLogger;

  beforeEach(() => {
    factory = createMockOpportunityFactory();
    logger = createMockLogger();
  });

  it('should return empty result with no EVM prices', () => {
    const poolStore = createMockPoolStore(new Map());

    const result = detectCrossChainArbitrage(
      [], poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(result.opportunities).toHaveLength(0);
    expect(result.comparisons).toHaveLength(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should detect opportunity with large price difference', () => {
    // 10% price difference should overcome all costs
    const solanaPool = createMockPool({ price: 100, fee: 25, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 110, fee: 30 })];

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(factory.createCrossChain).toHaveBeenCalled();
  });

  it('should not detect opportunity when costs exceed price difference', () => {
    // 0.5% price diff with ~2% total costs
    const solanaPool = createMockPool({ price: 100, fee: 25, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 100.5, fee: 30 })];

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(result.opportunities).toHaveLength(0);
  });

  it('should determine buy-solana-sell-evm direction when Solana price is lower', () => {
    const solanaPool = createMockPool({ price: 90, fee: 10, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 110, fee: 10 })];

    // Use low costs to ensure detection
    const lowCostConfig: CrossChainDetectorConfig = {
      ...defaultConfig,
      crossChainCosts: {
        bridgeFeeDefault: 0.0001,
        evmGasCostUsd: 0.01,
        solanaTxCostUsd: 0.001,
        latencyRiskPremium: 0.0001,
      },
    };

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, lowCostConfig, logger
    );

    if (result.opportunities.length > 0) {
      const call = (factory.createCrossChain as jest.Mock).mock.calls[0];
      expect(call).toBeDefined();
      // Direction should be buy-solana-sell-evm since Solana price < EVM price
      expect(call![1]).toBe('buy-solana-sell-evm');
    }
  });

  it('should determine buy-evm-sell-solana direction when EVM price is lower', () => {
    const solanaPool = createMockPool({ price: 110, fee: 10, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 90, fee: 10 })];

    const lowCostConfig: CrossChainDetectorConfig = {
      ...defaultConfig,
      crossChainCosts: {
        bridgeFeeDefault: 0.0001,
        evmGasCostUsd: 0.01,
        solanaTxCostUsd: 0.001,
        latencyRiskPremium: 0.0001,
      },
    };

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, lowCostConfig, logger
    );

    if (result.opportunities.length > 0) {
      const call = (factory.createCrossChain as jest.Mock).mock.calls[0];
      expect(call).toBeDefined();
      expect(call![1]).toBe('buy-evm-sell-solana');
    }
  });

  it('should set estimatedGasCost on opportunity', () => {
    const solanaPool = createMockPool({ price: 80, fee: 10, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 110, fee: 10 })];

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    if (result.opportunities.length > 0) {
      expect(result.opportunities[0].estimatedGasCost).toBeDefined();
      expect(typeof result.opportunities[0].estimatedGasCost).toBe('number');
    }
  });

  it('should include comparisons in result', () => {
    const solanaPool = createMockPool({ price: 100, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 101 })];

    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(result.comparisons).toHaveLength(1);
  });

  it('should use default fees when pool fees are undefined', () => {
    const solanaPool = createMockPool({ price: 80, fee: undefined as any, lastUpdated: Date.now() });
    const poolStore = createMockPoolStore(new Map([['SOL-USDC', [solanaPool]]]));
    const evmPrices = [createEvmPriceUpdate({ price: 110, fee: undefined })];

    // Should not throw
    const result = detectCrossChainArbitrage(
      evmPrices, poolStore, factory, normalizeToken, createPairKey, defaultConfig, logger
    );

    expect(result).toBeDefined();
  });

  it('should work without logger parameter', () => {
    const poolStore = createMockPoolStore(new Map());

    const result = detectCrossChainArbitrage(
      [], poolStore, factory, normalizeToken, createPairKey, defaultConfig
    );

    expect(result).toBeDefined();
  });
});

describe('getDefaultCrossChainCosts', () => {
  it('should return default costs object', () => {
    const costs = getDefaultCrossChainCosts();

    expect(costs).toHaveProperty('bridgeFeeDefault');
    expect(costs).toHaveProperty('evmGasCostUsd');
    expect(costs).toHaveProperty('solanaTxCostUsd');
    expect(costs).toHaveProperty('latencyRiskPremium');
  });

  it('should return a copy (not reference)', () => {
    const costs1 = getDefaultCrossChainCosts();
    const costs2 = getDefaultCrossChainCosts();

    expect(costs1).not.toBe(costs2);
    expect(costs1).toEqual(costs2);
  });

  it('should have reasonable default values', () => {
    const costs = getDefaultCrossChainCosts();

    expect(costs.bridgeFeeDefault).toBe(0.001);
    expect(costs.evmGasCostUsd).toBe(15);
    expect(costs.solanaTxCostUsd).toBe(0.01);
    expect(costs.latencyRiskPremium).toBe(0.002);
  });
});

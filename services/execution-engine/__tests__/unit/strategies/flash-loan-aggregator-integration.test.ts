/**
 * Flash Loan Aggregator Integration Tests
 *
 * Tests the aggregator -> strategy -> execution pipeline:
 * - Provider ranking and selection
 * - Fallback on execution failure
 * - Metrics recording
 * - Backward compatibility
 *
 * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
 */

// Mock @arbitrage/config before importing strategy
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000),
  FLASH_LOAN_PROVIDERS: {
    ethereum: { address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', protocol: 'aave_v3', feeBps: 5 },
    bsc: { address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', protocol: 'pancakeswap_v3', feeBps: 25 },
  },
  FLASH_LOAN_PROVIDER_REGISTRY: {
    ethereum: [
      { protocol: 'balancer_v2', address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', feeBps: 0, priority: 0 },
      { protocol: 'aave_v3', address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', feeBps: 5, priority: 1 },
    ],
    bsc: [
      { protocol: 'pancakeswap_v3', address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', feeBps: 25, priority: 0 },
    ],
  },
  FLASH_LOAN_AGGREGATOR_CONFIG: {
    liquidityCheckThresholdUsd: 100000,
    rankingCacheTtlMs: 30000,
    liquidityCacheTtlMs: 300000,
    weights: { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
    maxProvidersToRank: 3,
  },
  ARBITRAGE_CONFIG: { slippageTolerance: 50, minProfitThresholdUsd: 1 },
  CHAINS: {},
  DEXES: {},
  isExecutionSupported: jest.fn().mockReturnValue(true),
  getSupportedExecutionChains: jest.fn().mockReturnValue(['ethereum', 'bsc']),
  MEV_CONFIG: {},
  getV3AdapterAddress: jest.fn().mockReturnValue(null),
}));

import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import type { InMemoryAggregatorMetrics } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';

const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn().mockReturnThis(), fatal: jest.fn(), trace: jest.fn(),
  silent: jest.fn(), level: 'info', isLevelEnabled: jest.fn().mockReturnValue(true),
};

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

function createOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'test-opp-1',
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: '1000000000000000000',
    buyPrice: 2000,
    sellPrice: 2010,
    buyDex: 'uniswap_v2',
    sellDex: 'sushiswap',
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    expectedProfit: 10,
    confidence: 0.85,
    timestamp: Date.now(),
    ...overrides,
  } as ArbitrageOpportunity;
}

function createStrategy(enableAggregator: boolean): FlashLoanStrategy {
  return new FlashLoanStrategy(mockLogger as any, {
    contractAddresses: { ethereum: '0x0000000000000000000000000000000000000001' },
    approvedRouters: { ethereum: [ROUTER] },
    enableAggregator,
  });
}

describe('Flash Loan Aggregator Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Provider Selection', () => {
    it('aggregator is enabled when enableAggregator=true', () => {
      const strategy = createStrategy(true);
      expect((strategy as any).isAggregatorEnabled()).toBe(true);
      expect((strategy as any).aggregator).toBeDefined();
    });

    it('aggregator disabled uses hardcoded path', () => {
      const strategy = createStrategy(false);
      expect((strategy as any).isAggregatorEnabled()).toBe(false);
      expect((strategy as any).aggregator).toBeUndefined();
    });

    it('single-provider chain uses fast path', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      // BSC has only one provider — aggregator should use fast path
      const opportunity = createOpportunity({ buyChain: 'bsc' });
      const selection = await aggregator.selectProvider(opportunity, {
        chain: 'bsc',
        estimatedValueUsd: 10,
      });

      expect(selection.isSuccess).toBe(true);
      expect(selection.protocol).toBe('pancakeswap_v3');
      expect(selection.selectionReason).toBe('Only provider available');
    });
  });

  describe('Aggregator Ranking', () => {
    it('ranks balancer_v2 above aave_v3 on fee score (0 bps vs 5 bps)', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const opportunity = createOpportunity();
      const selection = await aggregator.selectProvider(opportunity, {
        chain: 'ethereum',
        estimatedValueUsd: 10,
      });

      expect(selection.isSuccess).toBe(true);
      // Balancer V2 has 0 bps fee -> higher fee score -> selected first
      expect(selection.protocol).toBe('balancer_v2');
      // Aave V3 should be in alternatives
      expect(selection.rankedAlternatives.length).toBeGreaterThanOrEqual(1);
      expect(selection.rankedAlternatives[0].protocol).toBe('aave_v3');
    });
  });

  describe('Fallback Decision', () => {
    it('decideFallback retries on insufficient liquidity', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('insufficient liquidity in pool'),
        [{ protocol: 'aave_v3', score: 0.9 }],
      );

      expect(decision.shouldRetry).toBe(true);
      expect(decision.nextProtocol).toBe('aave_v3');
      expect(decision.errorType).toBe('insufficient_liquidity');
    });

    it('decideFallback aborts on permanent error', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('contract paused'),
        [{ protocol: 'aave_v3', score: 0.9 }],
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.nextProtocol).toBeNull();
      expect(decision.errorType).toBe('permanent');
    });

    it('decideFallback aborts when no alternatives remain', async () => {
      const strategy = createStrategy(true);
      const aggregator = (strategy as any).aggregator;

      const decision = await aggregator.decideFallback(
        'balancer_v2',
        new Error('insufficient liquidity'),
        [], // no alternatives
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.nextProtocol).toBeNull();
    });
  });

  describe('Metrics', () => {
    it('aggregator metrics tracker is initialized when aggregator is enabled', () => {
      const strategy = createStrategy(true);
      const metrics = (strategy as any).aggregatorMetrics as InMemoryAggregatorMetrics;
      expect(metrics).toBeDefined();

      const summary = metrics.getMetricsSummary();
      expect(typeof summary).toBe('string');
    });

    it('metrics are not initialized when aggregator is disabled', () => {
      const strategy = createStrategy(false);
      expect((strategy as any).aggregatorMetrics).toBeUndefined();
    });
  });
});

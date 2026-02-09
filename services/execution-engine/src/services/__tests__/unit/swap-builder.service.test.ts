/**
 * SwapBuilder Tests
 *
 * Tests swap steps building with caching and slippage calculations.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SwapBuilder } from '../../swap-builder.service';
import { DexLookupService } from '../../dex-lookup.service';
import type { ILogger } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// Mock logger
const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(() => mockLogger)
};

// Test constants
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function createMockOpportunity(overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity {
  return {
    id: 'test-opp-1',
    type: 'simple',
    chain: 'ethereum',
    tokenIn: WETH_ADDRESS,
    tokenOut: WETH_ADDRESS,
    amountIn: '1000000000000000000', // 1 ETH
    buyPrice: 2000,
    sellPrice: 2010,
    expectedProfit: 10,
    buyDex: 'uniswap_v3',
    sellDex: 'sushiswap',
    confidence: 0.95,
    timestamp: Date.now(),
    ...overrides
  };
}

describe('SwapBuilder', () => {
  let swapBuilder: SwapBuilder;
  let dexLookup: DexLookupService;

  beforeEach(() => {
    dexLookup = new DexLookupService();
    swapBuilder = new SwapBuilder(dexLookup, mockLogger);
  });

  describe('initialization', () => {
    it('should create SwapBuilder with DexLookupService', () => {
      expect(swapBuilder).toBeDefined();
    });
  });

  describe('buildSwapSteps', () => {
    it('should build 2-hop swap steps', () => {
      const opportunity = createMockOpportunity();

      const steps = swapBuilder.buildSwapSteps(opportunity, {
        buyRouter: 'uniswap_v3',
        sellRouter: 'sushiswap',
        intermediateToken: USDC_ADDRESS,
        chain: 'ethereum',
        slippageBps: 50 // 0.5%
      });

      expect(steps).toHaveLength(2);

      // First hop: WETH -> USDC
      expect(steps[0].tokenIn).toBe(WETH_ADDRESS);
      expect(steps[0].tokenOut).toBe(USDC_ADDRESS);
      expect(steps[0].router).toBeDefined();
      expect(typeof steps[0].amountOutMin).toBe('bigint');

      // Second hop: USDC -> WETH
      expect(steps[1].tokenIn).toBe(USDC_ADDRESS);
      expect(steps[1].tokenOut).toBe(WETH_ADDRESS);
      expect(steps[1].router).toBeDefined();
      expect(typeof steps[1].amountOutMin).toBe('bigint');
    });

    it('should throw on invalid opportunity data', () => {
      const invalidOpp = createMockOpportunity({ tokenIn: undefined });

      expect(() => {
        swapBuilder.buildSwapSteps(invalidOpp, {
          buyRouter: 'uniswap_v3',
          sellRouter: 'sushiswap',
          intermediateToken: USDC_ADDRESS,
          chain: 'ethereum'
        });
      }).toThrow('[SwapBuilder] Invalid opportunity');
    });

    it('should throw on invalid router', () => {
      const opportunity = createMockOpportunity();

      expect(() => {
        swapBuilder.buildSwapSteps(opportunity, {
          buyRouter: 'unknown_router',
          sellRouter: 'sushiswap',
          intermediateToken: USDC_ADDRESS,
          chain: 'ethereum'
        });
      }).toThrow('[SwapBuilder] Buy router not found');
    });
  });
});

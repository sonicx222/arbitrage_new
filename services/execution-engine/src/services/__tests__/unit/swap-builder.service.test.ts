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
});

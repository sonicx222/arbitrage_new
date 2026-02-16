/**
 * P3-3: Shared orderflow mock helpers for ML test files.
 *
 * Extracts duplicated MockWhaleActivitySummary, createMockWhaleActivitySummary,
 * and createDefaultInput helpers used by both orderflow-predictor.test.ts and
 * orderflow-features.test.ts.
 */

import type { OrderflowFeatureInput } from '../../../src/orderflow-features';

/**
 * Mock WhaleActivitySummary matching the real @arbitrage/core interface.
 */
export interface MockWhaleActivitySummary {
  pairKey: string;
  chain: string;
  windowMs: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  netFlowUsd: number;
  whaleCount: number;
  superWhaleCount: number;
  dominantDirection: 'bullish' | 'bearish' | 'neutral';
  avgPriceImpact: number;
}

/**
 * Create a mock whale activity summary with sensible defaults.
 */
export function createMockWhaleActivitySummary(
  overrides: Partial<MockWhaleActivitySummary> = {}
): MockWhaleActivitySummary {
  return {
    pairKey: 'WETH-USDC',
    chain: 'ethereum',
    windowMs: 3600000,
    buyVolumeUsd: 500000,
    sellVolumeUsd: 300000,
    netFlowUsd: 200000,
    whaleCount: 15,
    superWhaleCount: 2,
    dominantDirection: 'bullish',
    avgPriceImpact: 0.05,
    ...overrides,
  };
}

/**
 * Create a default OrderflowFeatureInput with sensible defaults.
 */
export function createDefaultInput(
  overrides: Partial<OrderflowFeatureInput> = {}
): OrderflowFeatureInput {
  return {
    pairKey: 'WETH-USDC',
    chain: 'ethereum',
    currentTimestamp: Date.now(),
    poolReserves: {
      reserve0: 1000000n,
      reserve1: 500000n,
    },
    recentSwaps: [],
    liquidationData: {
      nearestLiquidationLevel: 0,
      openInterestChange24h: 0,
    },
    ...overrides,
  };
}

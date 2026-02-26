/**
 * WhaleAnalyzer Unit Tests
 *
 * Tests the whale log message fix: 'Super whale detected' should only be logged
 * when the trigger is actually a super whale (usdValue >= superWhaleThresholdUsd).
 * When triggered by significant net flow, the log should say 'Significant whale activity'.
 *
 * @see whale-analyzer.ts
 * @see docs/reports/local-dev-terminal-analysis-2026-02-26.md Finding G
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

import { WhaleAnalyzer } from '../../src/whale-analyzer';
import type { WhaleAnalyzerDeps } from '../../src/whale-analyzer';
import type { WhaleTransaction } from '@arbitrage/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockDeps(overrides?: Partial<WhaleAnalyzerDeps>): WhaleAnalyzerDeps {
  return {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    whaleConfig: {
      superWhaleThresholdUsd: 500000,
      significantFlowThresholdUsd: 100000,
      whaleBullishBoost: 1.15,
      whaleBearishPenalty: 0.85,
      superWhaleBoost: 1.25,
      activityWindowMs: 5 * 60 * 1000,
    },
    whaleGuard: {
      tryAcquire: jest.fn().mockReturnValue(jest.fn()),
      getRemainingCooldownMs: jest.fn().mockReturnValue(0),
    } as unknown as WhaleAnalyzerDeps['whaleGuard'],
    getWhaleTracker: jest.fn().mockReturnValue({
      recordTransaction: jest.fn(),
      getActivitySummary: jest.fn().mockReturnValue({
        dominantDirection: 'neutral',
        netFlowUsd: 0,
        superWhaleCount: 0,
        totalBuyVolumeUsd: 0,
        totalSellVolumeUsd: 0,
        transactionCount: 1,
      }),
    }),
    getPriceDataManager: jest.fn().mockReturnValue(null),
    findArbitrageInPrices: jest.fn().mockReturnValue([]),
    publishArbitrageOpportunity: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockWhaleTx(overrides?: Partial<WhaleTransaction>): WhaleTransaction {
  return {
    transactionHash: '0xabc123',
    address: '0xwhale',
    token: 'WETH/USDC',
    amount: 100,
    usdValue: 50000,
    direction: 'buy' as const,
    dex: 'uniswap',
    chain: 'ethereum',
    timestamp: Date.now(),
    impact: 0.5,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('WhaleAnalyzer', () => {
  describe('Log message for whale-triggered detection', () => {
    it('should log "Super whale" when usdValue >= superWhaleThresholdUsd', async () => {
      const deps = createMockDeps();
      const analyzer = new WhaleAnalyzer(deps);

      // Super whale: $600K >= $500K threshold
      const superWhaleTx = createMockWhaleTx({ usdValue: 600000 });

      await analyzer.analyzeWhaleImpact(superWhaleTx);

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Super whale'),
        expect.objectContaining({
          token: 'WETH/USDC',
          chain: 'ethereum',
          usdValue: 600000,
          isSuperWhale: true,
        }),
      );
    });

    it('should log "Significant whale activity" when triggered by net flow (not super whale)', async () => {
      const deps = createMockDeps();
      // Make getActivitySummary return significant net flow
      const mockTracker = {
        recordTransaction: jest.fn(),
        getActivitySummary: jest.fn().mockReturnValue({
          dominantDirection: 'bullish',
          netFlowUsd: 150000, // > 100K significant flow threshold
          superWhaleCount: 0,
          totalBuyVolumeUsd: 200000,
          totalSellVolumeUsd: 50000,
          transactionCount: 5,
        }),
      };
      deps.getWhaleTracker = jest.fn().mockReturnValue(mockTracker);

      const analyzer = new WhaleAnalyzer(deps);

      // Regular whale: $50K < $500K threshold, but significant net flow > $100K
      const regularWhaleTx = createMockWhaleTx({ usdValue: 50000 });

      await analyzer.analyzeWhaleImpact(regularWhaleTx);

      // Should NOT say "Super whale"
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Significant whale activity'),
        expect.objectContaining({
          usdValue: 50000,
          isSuperWhale: false,
        }),
      );

      // Should NOT say "Super whale" in the log
      expect(deps.logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Super whale'),
        expect.anything(),
      );
    });

    it('should not trigger detection for non-super-whale with low net flow', async () => {
      const deps = createMockDeps();
      const mockTracker = {
        recordTransaction: jest.fn(),
        getActivitySummary: jest.fn().mockReturnValue({
          dominantDirection: 'neutral',
          netFlowUsd: 50000, // < 100K threshold
          superWhaleCount: 0,
          totalBuyVolumeUsd: 50000,
          totalSellVolumeUsd: 0,
          transactionCount: 1,
        }),
      };
      deps.getWhaleTracker = jest.fn().mockReturnValue(mockTracker);
      const analyzer = new WhaleAnalyzer(deps);

      // Small whale: $50K < $500K, net flow $50K < $100K
      const smallWhaleTx = createMockWhaleTx({ usdValue: 50000 });

      await analyzer.analyzeWhaleImpact(smallWhaleTx);

      // Should NOT log the immediate detection trigger message
      const infoCallArgs = (deps.logger.info as jest.Mock).mock.calls;
      const triggerLogCalls = infoCallArgs.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('triggering immediate opportunity scan')
      );
      expect(triggerLogCalls).toHaveLength(0);
    });
  });
});

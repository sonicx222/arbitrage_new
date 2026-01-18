/**
 * Unit Tests for OpportunityPublisher
 *
 * Tests the opportunity publishing module extracted from CrossChainDetectorService.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  createOpportunityPublisher,
  OpportunityPublisher,
  CrossChainOpportunity,
} from '../../opportunity-publisher';
import { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Helper
// =============================================================================

const createTestOpportunity = (overrides?: Partial<CrossChainOpportunity>): CrossChainOpportunity => ({
  token: 'WETH/USDC',
  sourceChain: 'ethereum',
  sourceDex: 'uniswap',
  sourcePrice: 2500,
  targetChain: 'arbitrum',
  targetDex: 'camelot',
  targetPrice: 2530,
  priceDiff: 30,
  percentageDiff: 1.2,
  estimatedProfit: 100,
  bridgeCost: 15,
  netProfit: 85,
  confidence: 0.9,
  createdAt: Date.now(),
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityPublisher', () => {
  let mockLogger: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };
  let mockStreamsClient: {
    xadd: jest.Mock<(stream: string, data: any) => Promise<string>>;
  };
  let mockPerfLogger: {
    logArbitrageOpportunity: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    mockStreamsClient = {
      xadd: jest.fn<(stream: string, data: any) => Promise<string>>().mockResolvedValue('stream-id'),
    };

    mockPerfLogger = {
      logArbitrageOpportunity: jest.fn(),
    };
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createOpportunityPublisher', () => {
    it('should create publisher with required config', () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      expect(publisher).toBeDefined();
      expect(typeof publisher.publish).toBe('function');
      expect(typeof publisher.getCacheSize).toBe('function');
      expect(typeof publisher.cleanup).toBe('function');
      expect(typeof publisher.clear).toBe('function');
    });
  });

  // ===========================================================================
  // publish
  // ===========================================================================

  describe('publish', () => {
    it('should publish new opportunity', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity();
      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
      expect(mockStreamsClient.xadd).toHaveBeenCalled();
      expect(mockPerfLogger.logArbitrageOpportunity).toHaveBeenCalled();
    });

    it('should convert to ArbitrageOpportunity format', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity();
      await publisher.publish(opportunity);

      const publishedOpp = mockStreamsClient.xadd.mock.calls[0][1] as ArbitrageOpportunity;
      expect(publishedOpp.type).toBe('cross-chain');
      expect(publishedOpp.buyDex).toBe('uniswap');
      expect(publishedOpp.sellDex).toBe('camelot');
      expect(publishedOpp.buyChain).toBe('ethereum');
      expect(publishedOpp.sellChain).toBe('arbitrum');
      expect(publishedOpp.bridgeRequired).toBe(true);
    });

    it('should extract token names from pair key', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity({ token: 'WETH/USDC' });
      await publisher.publish(opportunity);

      const publishedOpp = mockStreamsClient.xadd.mock.calls[0][1] as ArbitrageOpportunity;
      expect(publishedOpp.tokenIn).toBe('WETH');
      expect(publishedOpp.tokenOut).toBe('USDC');
    });

    it('should cache opportunity after publishing', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity();
      await publisher.publish(opportunity);

      expect(publisher.getCacheSize()).toBe(1);
    });

    it('should return false on publish error', async () => {
      mockStreamsClient.xadd.mockRejectedValue(new Error('Redis error'));

      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity();
      const result = await publisher.publish(opportunity);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Deduplication
  // ===========================================================================

  describe('deduplication', () => {
    it('should skip duplicate opportunities within dedupe window', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        dedupeWindowMs: 5000,
      });

      const opportunity = createTestOpportunity();

      // First publish - should succeed
      const result1 = await publisher.publish(opportunity);
      expect(result1).toBe(true);

      // Second publish - should be deduplicated
      const result2 = await publisher.publish(opportunity);
      expect(result2).toBe(false);

      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
    });

    it('should republish if profit improved significantly', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        dedupeWindowMs: 5000,
        minProfitImprovement: 0.1, // 10% improvement needed
      });

      const opportunity1 = createTestOpportunity({ netProfit: 100 });
      const opportunity2 = createTestOpportunity({ netProfit: 120 }); // 20% improvement

      await publisher.publish(opportunity1);
      const result2 = await publisher.publish(opportunity2);

      expect(result2).toBe(true);
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(2);
    });

    it('should not republish if profit improvement is below threshold', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        dedupeWindowMs: 5000,
        minProfitImprovement: 0.1, // 10% improvement needed
      });

      const opportunity1 = createTestOpportunity({ netProfit: 100 });
      const opportunity2 = createTestOpportunity({ netProfit: 105 }); // Only 5% improvement

      await publisher.publish(opportunity1);
      const result2 = await publisher.publish(opportunity2);

      expect(result2).toBe(false);
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
    });

    it('should generate deterministic dedupe key', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      // Same source-target-token should dedupe
      const opp1 = createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        token: 'WETH/USDC',
        sourceDex: 'uniswap',
      });

      const opp2 = createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        token: 'WETH/USDC',
        sourceDex: 'sushiswap', // Different dex, same key
      });

      await publisher.publish(opp1);
      const result2 = await publisher.publish(opp2);

      // Same chain pair and token = same dedupe key
      expect(result2).toBe(false);
    });

    it('should allow different chain pairs', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opp1 = createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
      });

      const opp2 = createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'optimism', // Different target chain
      });

      await publisher.publish(opp1);
      const result2 = await publisher.publish(opp2);

      expect(result2).toBe(true);
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  describe('getCacheSize', () => {
    it('should return current cache size', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      expect(publisher.getCacheSize()).toBe(0);

      await publisher.publish(createTestOpportunity({ token: 'WETH/USDC' }));
      expect(publisher.getCacheSize()).toBe(1);

      await publisher.publish(createTestOpportunity({
        token: 'WBTC/USDC',
        sourceChain: 'ethereum',
        targetChain: 'polygon',
      }));
      expect(publisher.getCacheSize()).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should remove entries older than TTL', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        cacheTtlMs: 100, // 100ms TTL
        maxCacheSize: 1000,
      });

      await publisher.publish(createTestOpportunity());

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      publisher.cleanup();

      expect(publisher.getCacheSize()).toBe(0);
    });

    it('should trim cache when over max size', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        maxCacheSize: 2,
        cacheTtlMs: 60000, // Long TTL
      });

      // Add 3 opportunities (exceeds maxCacheSize of 2)
      await publisher.publish(createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        token: 'TOKEN1',
      }));

      await publisher.publish(createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'optimism',
        token: 'TOKEN2',
      }));

      await publisher.publish(createTestOpportunity({
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        token: 'TOKEN3',
      }));

      // Cache should be trimmed to maxCacheSize
      expect(publisher.getCacheSize()).toBeLessThanOrEqual(2);
    });
  });

  describe('clear', () => {
    it('should remove all cached opportunities', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      await publisher.publish(createTestOpportunity({ token: 'TOKEN1' }));
      await publisher.publish(createTestOpportunity({
        token: 'TOKEN2',
        sourceChain: 'polygon',
        targetChain: 'bsc',
      }));

      publisher.clear();

      expect(publisher.getCacheSize()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('cleared')
      );
    });

    it('should allow publishing after clear', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity();

      await publisher.publish(opportunity);
      publisher.clear();

      // Should be able to publish same opportunity again
      const result = await publisher.publish(opportunity);
      expect(result).toBe(true);
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // ArbitrageOpportunity Conversion
  // ===========================================================================

  describe('ArbitrageOpportunity conversion', () => {
    it('should set correct profit fields', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity({
        percentageDiff: 1.5, // 1.5%
      });

      await publisher.publish(opportunity);

      const publishedOpp = mockStreamsClient.xadd.mock.calls[0][1] as ArbitrageOpportunity;

      // expectedProfit = (percentageDiff / 100) * amountInTokens (1.0)
      expect(publishedOpp.expectedProfit).toBeCloseTo(0.015, 5);
      expect(publishedOpp.profitPercentage).toBeCloseTo(0.015, 5);
    });

    it('should set cross-chain specific fields', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
      });

      const opportunity = createTestOpportunity({
        bridgeCost: 25,
      });

      await publisher.publish(opportunity);

      const publishedOpp = mockStreamsClient.xadd.mock.calls[0][1] as ArbitrageOpportunity;

      expect(publishedOpp.bridgeRequired).toBe(true);
      expect(publishedOpp.bridgeCost).toBe(25);
      expect(publishedOpp.type).toBe('cross-chain');
    });

    it('should generate unique IDs', async () => {
      const publisher = createOpportunityPublisher({
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        dedupeWindowMs: 0, // Disable dedupe to test ID generation
      });

      await publisher.publish(createTestOpportunity());
      publisher.clear();
      await publisher.publish(createTestOpportunity());

      const id1 = (mockStreamsClient.xadd.mock.calls[0][1] as ArbitrageOpportunity).id;
      const id2 = (mockStreamsClient.xadd.mock.calls[1][1] as ArbitrageOpportunity).id;

      expect(id1).not.toBe(id2);
      expect(id1).toContain('cross-chain-');
      expect(id2).toContain('cross-chain-');
    });
  });
});

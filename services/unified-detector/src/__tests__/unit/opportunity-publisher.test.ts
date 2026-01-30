/**
 * Unit Tests for OpportunityPublisher
 *
 * Tests opportunity publishing to Redis Streams, error handling, and stats tracking.
 *
 * @see implementation_plan.md: Fix Missing Opportunity Publisher
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { OpportunityPublisher, OpportunityPublisherConfig } from '../../publishers';
import { Logger } from '../../types';
import { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Setup
// =============================================================================

// Create mock logger
const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

// Create mock Redis streams client
const createMockStreamsClient = () => ({
  xadd: jest.fn().mockResolvedValue('stream-id'),
  xaddWithLimit: jest.fn().mockResolvedValue('stream-id'),
  STREAMS: {
    OPPORTUNITIES: 'stream:opportunities',
  },
});

// Create sample opportunity
const createSampleOpportunity = (overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity => ({
  id: `opp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  type: 'cross-dex',
  chain: 'ethereum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  tokenIn: 'WETH',
  tokenOut: 'USDC',
  expectedProfit: 100,
  profitPercentage: 0.5,
  confidence: 0.85,
  timestamp: Date.now(),
  blockNumber: 12345678,
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityPublisher', () => {
  let publisher: OpportunityPublisher;
  let logger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();

    publisher = new OpportunityPublisher({
      logger,
      streamsClient: mockStreamsClient as any,
      partitionId: 'asia-fast',
    });
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create publisher with config', () => {
      expect(publisher).toBeDefined();
    });

    it('should use default partitionId when not provided', () => {
      const publisherNoPartition = new OpportunityPublisher({
        logger,
        streamsClient: mockStreamsClient as any,
      });
      expect(publisherNoPartition).toBeDefined();
    });
  });

  // ===========================================================================
  // publish
  // ===========================================================================

  describe('publish', () => {
    it('should publish opportunity to Redis Streams', async () => {
      const opportunity = createSampleOpportunity();

      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          id: opportunity.id,
          type: opportunity.type,
          _source: 'unified-detector-asia-fast',
          _publishedAt: expect.any(Number),
        })
      );
    });

    it('should log debug message on successful publish', async () => {
      const opportunity = createSampleOpportunity();

      await publisher.publish(opportunity);

      expect(logger.debug).toHaveBeenCalledWith(
        'Opportunity published to stream',
        expect.objectContaining({
          opportunityId: opportunity.id,
          type: opportunity.type,
        })
      );
    });

    it('should update stats on successful publish', async () => {
      const opportunity = createSampleOpportunity();

      await publisher.publish(opportunity);

      const stats = publisher.getStats();
      expect(stats.published).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.lastPublishedAt).not.toBeNull();
    });

    it('should handle publish errors gracefully', async () => {
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis connection error'));

      const opportunity = createSampleOpportunity();
      const result = await publisher.publish(opportunity);

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to publish opportunity to stream',
        expect.objectContaining({
          opportunityId: opportunity.id,
          error: 'Redis connection error',
        })
      );
    });

    it('should update failed count on publish error', async () => {
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis error'));

      const opportunity = createSampleOpportunity();
      await publisher.publish(opportunity);

      const stats = publisher.getStats();
      expect(stats.published).toBe(0);
      expect(stats.failed).toBe(1);
    });

    it('should include _source metadata with partitionId', async () => {
      const opportunity = createSampleOpportunity();

      await publisher.publish(opportunity);

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          _source: 'unified-detector-asia-fast',
        })
      );
    });

    it('should include _publishedAt timestamp', async () => {
      const beforePublish = Date.now();
      const opportunity = createSampleOpportunity();

      await publisher.publish(opportunity);

      const afterPublish = Date.now();
      const publishCall = mockStreamsClient.xaddWithLimit.mock.calls[0][1];

      expect(publishCall._publishedAt).toBeGreaterThanOrEqual(beforePublish);
      expect(publishCall._publishedAt).toBeLessThanOrEqual(afterPublish);
    });

    it('should preserve all opportunity fields', async () => {
      const opportunity = createSampleOpportunity({
        buyChain: 'ethereum',
        sellChain: 'arbitrum',
        bridgeRequired: true,
        bridgeCost: 5,
      });

      await publisher.publish(opportunity);

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          id: opportunity.id,
          type: opportunity.type,
          chain: opportunity.chain,
          buyDex: opportunity.buyDex,
          sellDex: opportunity.sellDex,
          expectedProfit: opportunity.expectedProfit,
          profitPercentage: opportunity.profitPercentage,
          confidence: opportunity.confidence,
          timestamp: opportunity.timestamp,
          bridgeRequired: true,
          bridgeCost: 5,
        })
      );
    });

    it('should handle opportunities with minimal fields', async () => {
      const minimalOpportunity: ArbitrageOpportunity = {
        id: 'minimal-opp-123',
        confidence: 0.7,
        timestamp: Date.now(),
      };

      const result = await publisher.publish(minimalOpportunity);

      expect(result).toBe(true);
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          id: 'minimal-opp-123',
          confidence: 0.7,
        })
      );
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = publisher.getStats();

      expect(stats).toEqual({
        published: 0,
        failed: 0,
        lastPublishedAt: null,
      });
    });

    it('should track multiple publishes', async () => {
      await publisher.publish(createSampleOpportunity());
      await publisher.publish(createSampleOpportunity());
      await publisher.publish(createSampleOpportunity());

      const stats = publisher.getStats();
      expect(stats.published).toBe(3);
    });

    it('should track mixed success and failure', async () => {
      await publisher.publish(createSampleOpportunity()); // success

      mockStreamsClient.xaddWithLimit.mockRejectedValueOnce(new Error('error'));
      await publisher.publish(createSampleOpportunity()); // failure

      await publisher.publish(createSampleOpportunity()); // success

      const stats = publisher.getStats();
      expect(stats.published).toBe(2);
      expect(stats.failed).toBe(1);
    });

    it('should return a copy of stats (not reference)', () => {
      const stats1 = publisher.getStats();
      const stats2 = publisher.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });

  // ===========================================================================
  // resetStats
  // ===========================================================================

  describe('resetStats', () => {
    it('should reset all stats to initial values', async () => {
      await publisher.publish(createSampleOpportunity());
      await publisher.publish(createSampleOpportunity());

      publisher.resetStats();

      const stats = publisher.getStats();
      expect(stats).toEqual({
        published: 0,
        failed: 0,
        lastPublishedAt: null,
      });
    });

    it('should allow tracking after reset', async () => {
      await publisher.publish(createSampleOpportunity());
      publisher.resetStats();
      await publisher.publish(createSampleOpportunity());

      const stats = publisher.getStats();
      expect(stats.published).toBe(1);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty opportunity id', async () => {
      const opportunity = createSampleOpportunity({ id: '' });

      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
      // The publisher doesn't validate - that's the coordinator's job
    });

    it('should handle opportunity with special characters in id', async () => {
      const opportunity = createSampleOpportunity({
        id: 'opp:special/chars\\test-123',
      });

      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
    });

    it('should handle very large profit values', async () => {
      const opportunity = createSampleOpportunity({
        expectedProfit: Number.MAX_SAFE_INTEGER,
        profitPercentage: 999999,
      });

      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
    });

    it('should handle negative profit values', async () => {
      const opportunity = createSampleOpportunity({
        expectedProfit: -50,
        profitPercentage: -0.1,
      });

      const result = await publisher.publish(opportunity);

      expect(result).toBe(true);
      // Negative profits are valid (opportunity went bad), coordinator will filter
    });

    it('should handle concurrent publishes', async () => {
      const opportunities = Array.from({ length: 10 }, () => createSampleOpportunity());

      const results = await Promise.all(
        opportunities.map((opp) => publisher.publish(opp))
      );

      expect(results.every((r) => r === true)).toBe(true);
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(10);

      const stats = publisher.getStats();
      expect(stats.published).toBe(10);
    });
  });

  // ===========================================================================
  // Integration with Coordinator Format
  // ===========================================================================

  describe('coordinator compatibility', () => {
    it('should publish fields at top level (not nested in data)', async () => {
      const opportunity = createSampleOpportunity();

      await publisher.publish(opportunity);

      const publishedMessage = mockStreamsClient.xaddWithLimit.mock.calls[0][1];

      // Verify fields are at top level (coordinator expects this)
      expect(publishedMessage.id).toBe(opportunity.id);
      expect(publishedMessage.timestamp).toBe(opportunity.timestamp);
      expect(publishedMessage.confidence).toBe(opportunity.confidence);
      expect(publishedMessage.profitPercentage).toBe(opportunity.profitPercentage);

      // Verify no nested data field (old wrapper format)
      expect(publishedMessage.data).toBeUndefined();
    });

    it('should include all fields coordinator uses for validation', async () => {
      const opportunity = createSampleOpportunity({
        id: 'test-123',
        timestamp: 1700000000000,
        confidence: 0.9,
        profitPercentage: 2.5,
        chain: 'ethereum',
        buyDex: 'uniswap',
        sellDex: 'sushiswap',
        expiresAt: 1700000060000,
        status: 'pending',
      });

      await publisher.publish(opportunity);

      const publishedMessage = mockStreamsClient.xaddWithLimit.mock.calls[0][1];

      // These are the fields coordinator's handleOpportunityMessage() uses
      expect(publishedMessage.id).toBe('test-123');
      expect(publishedMessage.timestamp).toBe(1700000000000);
      expect(publishedMessage.confidence).toBe(0.9);
      expect(publishedMessage.profitPercentage).toBe(2.5);
      expect(publishedMessage.chain).toBe('ethereum');
      expect(publishedMessage.buyDex).toBe('uniswap');
      expect(publishedMessage.sellDex).toBe('sushiswap');
      expect(publishedMessage.expiresAt).toBe(1700000060000);
      expect(publishedMessage.status).toBe('pending');
    });
  });
});

/**
 * Unit Tests for FastLaneConsumer
 *
 * Tests the coordinator-bypass fast lane consumer that processes
 * high-confidence opportunities from stream:fast-lane.
 *
 * @see fast-lane.consumer.ts
 * @see Item 12: Coordinator Bypass Fast Lane
 */

import { FastLaneConsumer, FastLaneConsumerConfig } from '../../../src/consumers/fast-lane.consumer';
import {
  createMockLogger,
  createMockStats,
  createMockQueueService,
  createMockOpportunity,
} from './consumer-test-helpers';

// =============================================================================
// Mocks
// =============================================================================

// Track the handler callback from StreamConsumer construction
let capturedHandler: ((message: { id: string; data: unknown }) => Promise<void>) | null = null;
let lastMockConsumer: any = null;

jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core');
  return {
    ...actual,
    StreamConsumer: jest.fn().mockImplementation((_client: unknown, opts: any) => {
      capturedHandler = opts.handler;
      lastMockConsumer = {
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
        pause: jest.fn(),
        resume: jest.fn(),
      };
      return lastMockConsumer;
    }),
    stopAndNullify: jest.fn().mockImplementation(async (obj: any) => {
      if (obj && typeof obj.stop === 'function') {
        await obj.stop();
      }
      return null;
    }),
  };
});

// Mock feature flags — enable fast lane by default in tests
const mockFeatureFlags = { useFastLane: true };

jest.mock('@arbitrage/config', () => {
  const actual = jest.requireActual('@arbitrage/config');
  return {
    ...actual,
    get FEATURE_FLAGS() {
      return { ...actual.FEATURE_FLAGS, ...mockFeatureFlags };
    },
    ARBITRAGE_CONFIG: {
      ...actual.ARBITRAGE_CONFIG,
      confidenceThreshold: 0.5,
      minProfitPercentage: 0.1,
    },
  };
});

// =============================================================================
// Helper
// =============================================================================

function createConsumerConfig(
  overrides: Partial<FastLaneConsumerConfig> = {}
): FastLaneConsumerConfig {
  return {
    logger: createMockLogger(),
    streamsClient: {
      createConsumerGroup: jest.fn().mockResolvedValue(undefined),
      xack: jest.fn().mockResolvedValue(1),
      STREAMS: { FAST_LANE: 'stream:fast-lane' },
    } as any,
    queueService: createMockQueueService(),
    stats: createMockStats(),
    instanceId: 'test-instance-1',
    isAlreadySeen: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('FastLaneConsumer', () => {
  beforeEach(() => {
    capturedHandler = null;
    lastMockConsumer = null;
    mockFeatureFlags.useFastLane = true;
    // Re-set the mock implementation after clearAllMocks
    const { StreamConsumer } = require('@arbitrage/core');
    (StreamConsumer as jest.Mock).mockImplementation((_client: unknown, opts: any) => {
      capturedHandler = opts.handler;
      lastMockConsumer = {
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
        pause: jest.fn(),
        resume: jest.fn(),
      };
      return lastMockConsumer;
    });
    const { stopAndNullify } = require('@arbitrage/core');
    (stopAndNullify as jest.Mock).mockImplementation(async (obj: any) => {
      if (obj && typeof obj.stop === 'function') {
        await obj.stop();
      }
      return null;
    });
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('createConsumerGroup', () => {
    it('should create consumer group for fast lane stream', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      await consumer.createConsumerGroup();

      expect(config.streamsClient.createConsumerGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: 'stream:fast-lane',
          groupName: 'execution-engine',
          consumerName: 'test-instance-1',
        })
      );
    });

    it('should handle BUSYGROUP error gracefully', async () => {
      const config = createConsumerConfig();
      (config.streamsClient.createConsumerGroup as jest.Mock).mockRejectedValue(
        new Error('BUSYGROUP Consumer Group name already exists')
      );
      const consumer = new FastLaneConsumer(config);

      // Should not throw
      await consumer.createConsumerGroup();
    });
  });

  describe('start', () => {
    it('should start stream consumer when feature flag is on', () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      consumer.start();

      expect(lastMockConsumer).not.toBeNull();
      expect(lastMockConsumer.start).toHaveBeenCalled();
    });

    it('should not start when feature flag is off', () => {
      mockFeatureFlags.useFastLane = false;

      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      consumer.start();

      expect(lastMockConsumer).toBeNull();
      expect((config.logger.info as jest.Mock)).toHaveBeenCalledWith(
        'Fast lane consumer disabled (FEATURE_FAST_LANE not set)'
      );
    });
  });

  describe('stop', () => {
    it('should stop stream consumer', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      consumer.start();
      const startedConsumer = lastMockConsumer;
      await consumer.stop();

      expect(startedConsumer.stop).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  describe('handleStreamMessage', () => {
    it('should enqueue valid opportunities', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      const opp = createMockOpportunity({ id: 'fast-lane-1' });
      await capturedHandler!({ id: 'msg-1', data: opp });

      expect(config.queueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fast-lane-1' })
      );
      expect(consumer.getStats().enqueued).toBe(1);
    });

    it('should skip opportunities already seen via normal path', async () => {
      const isAlreadySeen = jest.fn().mockReturnValue(true);
      const config = createConsumerConfig({ isAlreadySeen });
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      const opp = createMockOpportunity({ id: 'already-seen-1' });
      await capturedHandler!({ id: 'msg-1', data: opp });

      expect(config.queueService.enqueue).not.toHaveBeenCalled();
      expect(consumer.getStats().deduplicated).toBe(1);
    });

    it('should reject invalid messages', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      // Missing required fields
      await capturedHandler!({ id: 'msg-1', data: { foo: 'bar' } });

      expect(config.queueService.enqueue).not.toHaveBeenCalled();
      expect(consumer.getStats().rejected).toBe(1);
    });

    it('should silently skip system messages', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      await capturedHandler!({ id: 'msg-1', data: { type: 'stream-init' } });

      expect(config.queueService.enqueue).not.toHaveBeenCalled();
      expect(consumer.getStats().rejected).toBe(0);
    });

    it('should reject opportunities with low confidence', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      const opp = createMockOpportunity({
        confidence: 0.1, // Below threshold of 0.5
      });

      await capturedHandler!({ id: 'msg-1', data: opp });

      expect(config.queueService.enqueue).not.toHaveBeenCalled();
      expect(consumer.getStats().rejected).toBe(1);
    });

    it('should handle queue backpressure gracefully', async () => {
      const config = createConsumerConfig({
        queueService: createMockQueueService({
          enqueue: jest.fn().mockReturnValue(false),
        }),
      });
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      const opp = createMockOpportunity();
      await capturedHandler!({ id: 'msg-1', data: opp });

      expect(consumer.getStats().enqueued).toBe(0);
    });

    it('should increment opportunitiesReceived stat on enqueue', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      const opp = createMockOpportunity();
      await capturedHandler!({ id: 'msg-1', data: opp });

      expect(config.stats.opportunitiesReceived).toBe(1);
    });

    it('should handle empty message data', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      await capturedHandler!({ id: 'msg-1', data: null });

      expect(config.queueService.enqueue).not.toHaveBeenCalled();
      expect(consumer.getStats().rejected).toBe(1);
    });
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  describe('getStats', () => {
    it('should return initial stats', () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      expect(consumer.getStats()).toEqual({
        received: 0,
        enqueued: 0,
        deduplicated: 0,
        rejected: 0,
      });
    });

    it('should return a copy of stats', () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);

      const stats1 = consumer.getStats();
      const stats2 = consumer.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });

    it('should track multiple enqueued messages', async () => {
      const config = createConsumerConfig();
      const consumer = new FastLaneConsumer(config);
      consumer.start();

      await capturedHandler!({ id: 'msg-1', data: createMockOpportunity({ id: 'opp-1' }) });
      await capturedHandler!({ id: 'msg-2', data: createMockOpportunity({ id: 'opp-2' }) });
      await capturedHandler!({ id: 'msg-3', data: createMockOpportunity({ id: 'opp-3' }) });

      const stats = consumer.getStats();
      expect(stats.received).toBe(3);
      expect(stats.enqueued).toBe(3);
    });
  });
});

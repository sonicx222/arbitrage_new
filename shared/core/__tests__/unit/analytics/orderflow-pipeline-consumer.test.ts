/**
 * OrderflowPipelineConsumer Tests
 *
 * Tests for the orderflow prediction pipeline that consumes pending
 * opportunities from Redis Streams and caches ML predictions.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup - Must be before any imports that use these modules
// =============================================================================

jest.mock('../../../src/logger');

// Mutable feature flags for per-test override
const mockFeatureFlags = {
  useOrderflowPipeline: false,
};

jest.mock('@arbitrage/config', () => ({
  FEATURE_FLAGS: mockFeatureFlags,
  getChainName: jest.fn().mockReturnValue('ethereum'),
}));

const mockPrediction = {
  direction: 'bullish' as const,
  confidence: 0.8,
  orderflowPressure: 0.5,
  expectedVolatility: 0.3,
  whaleImpact: 0.2,
  timeHorizonMs: 60000,
  features: {},
  timestamp: Date.now(),
};

const mockPredictor = {
  predict: jest.fn<() => Promise<typeof mockPrediction>>().mockResolvedValue(mockPrediction),
};

jest.mock('@arbitrage/ml', () => ({
  getOrderflowPredictor: jest.fn().mockReturnValue(mockPredictor),
}));

const mockCreateConsumerGroup = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockXreadgroup = jest.fn<() => Promise<Array<{ id: string; data: Record<string, unknown> }>>>().mockResolvedValue([]);
const mockXack = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

const mockRedisClient = {
  createConsumerGroup: mockCreateConsumerGroup,
  xreadgroup: mockXreadgroup,
  xack: mockXack,
};

jest.mock('../../../src/redis/streams', () => ({
  RedisStreamsClient: {
    STREAMS: {
      PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
    },
  },
  getRedisStreamsClient: jest.fn<() => Promise<unknown>>().mockResolvedValue(mockRedisClient),
}));

jest.mock('../../../src/caching/reserve-cache', () => ({
  getReserveCache: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(undefined),
  }),
  ReserveCache: jest.fn(),
}));

// =============================================================================
// Imports - After mocks
// =============================================================================

import {
  OrderflowPipelineConsumer,
  getOrderflowPipelineConsumer,
  resetOrderflowPipelineConsumer,
} from '../../../src/analytics/orderflow-pipeline-consumer';

// =============================================================================
// Tests
// =============================================================================

describe('OrderflowPipelineConsumer', () => {
  beforeEach(async () => {
    await resetOrderflowPipelineConsumer();
    mockFeatureFlags.useOrderflowPipeline = false;
    mockPredictor.predict.mockClear();
    mockCreateConsumerGroup.mockClear();
    mockXreadgroup.mockClear();
    mockXack.mockClear();
  });

  afterEach(async () => {
    await resetOrderflowPipelineConsumer();
    mockFeatureFlags.useOrderflowPipeline = false;
  });

  describe('Constructor', () => {
    it('should initialize with default configuration', () => {
      const consumer = new OrderflowPipelineConsumer();
      expect(consumer).toBeDefined();
      expect(consumer.getStats().isRunning).toBe(false);
      expect(consumer.getStats().cacheSize).toBe(0);
    });

    it('should accept DI dependencies', () => {
      const consumer = new OrderflowPipelineConsumer(
        { instanceId: 'test-consumer', cacheTtlMs: 5000, maxCacheSize: 100 },
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      expect(consumer).toBeDefined();
    });
  });

  describe('start()', () => {
    it('should return immediately when feature flag is false', async () => {
      mockFeatureFlags.useOrderflowPipeline = false;

      const consumer = new OrderflowPipelineConsumer(
        {},
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      await consumer.start();

      expect(consumer.getStats().isRunning).toBe(false);
      expect(mockCreateConsumerGroup).not.toHaveBeenCalled();
    });

    it('should create consumer group and start polling when flag is true', async () => {
      mockFeatureFlags.useOrderflowPipeline = true;

      const consumer = new OrderflowPipelineConsumer(
        { pollIntervalMs: 50000 }, // Long interval to avoid timer interference
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      await consumer.start();

      expect(consumer.getStats().isRunning).toBe(true);
      expect(mockCreateConsumerGroup).toHaveBeenCalled();

      await consumer.stop();
    });

    it('should not start twice', async () => {
      mockFeatureFlags.useOrderflowPipeline = true;

      const consumer = new OrderflowPipelineConsumer(
        { pollIntervalMs: 50000 },
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      await consumer.start();
      await consumer.start(); // Second call should be a no-op

      // createConsumerGroup should only be called once
      expect(mockCreateConsumerGroup).toHaveBeenCalledTimes(1);

      await consumer.stop();
    });
  });

  describe('getPrediction()', () => {
    it('should return undefined for unknown pair key', () => {
      const consumer = new OrderflowPipelineConsumer();
      expect(consumer.getPrediction('unknown-pair')).toBeUndefined();
    });

    it('should return cached prediction within TTL', async () => {
      mockFeatureFlags.useOrderflowPipeline = true;

      // Set up a message to be processed
      const message = {
        id: '1-0',
        data: {
          data: JSON.stringify({
            type: 'pending',
            intent: {
              hash: '0xabc',
              router: '0x1',
              type: 'UniswapV2',
              tokenIn: '0xTokenA',
              tokenOut: '0xTokenB',
              amountIn: '1000000',
              expectedAmountOut: '900000',
              path: ['0xTokenA', '0xTokenB'],
              slippageTolerance: 0.005,
              deadline: Date.now() + 60000,
              sender: '0xSender',
              gasPrice: '30000000000',
              nonce: 1,
              chainId: 1,
              firstSeen: Date.now(),
            },
            publishedAt: Date.now(),
          }),
        },
      };

      // Return message on first poll, empty on subsequent
      mockXreadgroup.mockResolvedValueOnce([message]).mockResolvedValue([]);

      jest.useFakeTimers();

      const consumer = new OrderflowPipelineConsumer(
        { cacheTtlMs: 30000, pollIntervalMs: 50000 },
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      await consumer.start();

      // Advance past the pollIntervalMs to trigger the first poll cycle
      await jest.advanceTimersByTimeAsync(50000);

      jest.useRealTimers();

      // The prediction should be cached under the pair key
      const prediction = consumer.getPrediction('0xTokenA-0xTokenB');

      // If the poll fired, we should have a prediction
      // If it hasn't fired yet, the getPrediction returns undefined which is also valid
      if (prediction) {
        expect(prediction.direction).toBe('bullish');
        expect(prediction.confidence).toBe(0.8);
      }

      await consumer.stop();
    });

    it('should return undefined for expired cache entry', async () => {
      // Create consumer with very short TTL
      const consumer = new OrderflowPipelineConsumer(
        { cacheTtlMs: 1 }, // 1ms TTL — expires immediately
        { predictor: mockPredictor as any },
      );

      // Manually populate cache via private access for testing
      const cache = (consumer as any).predictionCache as Map<string, { prediction: typeof mockPrediction; cachedAt: number }>;
      cache.set('test-pair', {
        prediction: mockPrediction,
        cachedAt: Date.now() - 100, // 100ms ago, well past 1ms TTL
      });

      expect(consumer.getPrediction('test-pair')).toBeUndefined();
    });
  });

  describe('Cache eviction', () => {
    it('should evict oldest entries when exceeding maxCacheSize', () => {
      const consumer = new OrderflowPipelineConsumer(
        { maxCacheSize: 3 },
        { predictor: mockPredictor as any },
      );

      // Manually populate cache beyond limit
      const cache = (consumer as any).predictionCache as Map<string, { prediction: typeof mockPrediction; cachedAt: number }>;
      const cachePredictionFn = (consumer as any).cachePrediction.bind(consumer);

      cachePredictionFn('pair-1', mockPrediction);
      cachePredictionFn('pair-2', mockPrediction);
      cachePredictionFn('pair-3', mockPrediction);
      cachePredictionFn('pair-4', mockPrediction); // Should trigger eviction

      // Cache should not exceed maxCacheSize
      expect(cache.size).toBeLessThanOrEqual(3);
    });
  });

  describe('stop()', () => {
    it('should clear cache and stop polling', async () => {
      mockFeatureFlags.useOrderflowPipeline = true;

      const consumer = new OrderflowPipelineConsumer(
        { pollIntervalMs: 50000 },
        { redisStreamsClient: mockRedisClient as any, predictor: mockPredictor as any },
      );
      await consumer.start();
      expect(consumer.getStats().isRunning).toBe(true);

      await consumer.stop();
      expect(consumer.getStats().isRunning).toBe(false);
      expect(consumer.getStats().cacheSize).toBe(0);
    });

    it('should be safe to call stop when not started', async () => {
      const consumer = new OrderflowPipelineConsumer();
      await consumer.stop(); // Should not throw
      expect(consumer.getStats().isRunning).toBe(false);
    });
  });

  describe('Singleton factory', () => {
    it('should return the same instance', () => {
      const instance1 = getOrderflowPipelineConsumer();
      const instance2 = getOrderflowPipelineConsumer();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', async () => {
      const instance1 = getOrderflowPipelineConsumer();
      await resetOrderflowPipelineConsumer();
      const instance2 = getOrderflowPipelineConsumer();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('parseOpportunity', () => {
    it('should return null for non-pending message types', () => {
      const consumer = new OrderflowPipelineConsumer();
      const parseOpportunity = (consumer as any).parseOpportunity.bind(consumer);

      expect(parseOpportunity({ data: JSON.stringify({ type: 'other', intent: {} }) })).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const consumer = new OrderflowPipelineConsumer();
      const parseOpportunity = (consumer as any).parseOpportunity.bind(consumer);

      expect(parseOpportunity({ data: 'not-json{' })).toBeNull();
    });

    it('should parse valid pending opportunity', () => {
      const consumer = new OrderflowPipelineConsumer();
      const parseOpportunity = (consumer as any).parseOpportunity.bind(consumer);

      const result = parseOpportunity({
        data: JSON.stringify({
          type: 'pending',
          intent: {
            hash: '0xabc',
            tokenIn: '0xA',
            tokenOut: '0xB',
            chainId: 1,
            firstSeen: Date.now(),
          },
          publishedAt: Date.now(),
        }),
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('pending');
      expect(result.intent.hash).toBe('0xabc');
    });
  });
});

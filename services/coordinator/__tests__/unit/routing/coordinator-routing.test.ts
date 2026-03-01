/**
 * Coordinator Routing Tests
 *
 * Tests for the coordinator routing modules:
 * - OpportunityRouter: Opportunity lifecycle, duplicate detection, forwarding
 * - StreamConsumerManager: Rate limiting, deferred ACK, DLQ, error tracking
 * - StreamRateLimiter: Token bucket rate limiting
 *
 * @see services/coordinator/src/opportunities/opportunity-router.ts
 * @see services/coordinator/src/streaming/stream-consumer-manager.ts
 * @see services/coordinator/src/streaming/rate-limiter.ts
 */

// Mock @arbitrage/core to prevent deep import chain (service-config -> PANCAKESWAP_V3_FACTORIES)
jest.mock('@arbitrage/core', () => ({
  findKSmallest: jest.fn((items: unknown[], k: number, compareFn: (a: unknown, b: unknown) => number) => {
    return [...items].sort(compareFn).slice(0, k);
  }),
}));

import {
  OpportunityRouter,
  type OpportunityRouterLogger,
  type OpportunityStreamsClient,
  type CircuitBreaker,
  type OpportunityAlert,
} from '../../../src/opportunities/opportunity-router';

import {
  StreamConsumerManager,
  type StreamsClient,
  type StreamManagerLogger,
  type StreamAlert,
  type ConsumerGroupConfig,
} from '../../../src/streaming/stream-consumer-manager';

import {
  StreamRateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from '../../../src/streaming/rate-limiter';

import { createMockLogger } from '@arbitrage/test-utils';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockStreamsClient(): OpportunityStreamsClient & StreamsClient {
  return {
    xadd: jest.fn().mockResolvedValue('1-0'),
    xaddWithLimit: jest.fn().mockResolvedValue('1-0'),
    xack: jest.fn().mockResolvedValue(1),
    xpending: jest.fn().mockResolvedValue(null),
    // OP-1 FIX: New interface methods for orphaned PEL recovery
    xclaim: jest.fn().mockResolvedValue([]),
    xpendingRange: jest.fn().mockResolvedValue([]),
  };
}

function createMockCircuitBreaker(): CircuitBreaker {
  return {
    isCurrentlyOpen: jest.fn().mockReturnValue(false),
    recordFailure: jest.fn().mockReturnValue(false),
    recordSuccess: jest.fn().mockReturnValue(false),
    getFailures: jest.fn().mockReturnValue(0),
    getStatus: jest.fn().mockReturnValue({ isOpen: false, failures: 0, resetTimeoutMs: 60000 }),
  };
}

function createMockGroupConfig(): ConsumerGroupConfig {
  return {
    streamName: 'stream:opportunities',
    groupName: 'coordinator-group',
    consumerName: 'coordinator-1',
    startId: '0',
  };
}

// =============================================================================
// OpportunityRouter
// =============================================================================

describe('OpportunityRouter', () => {
  let router: OpportunityRouter;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreams: ReturnType<typeof createMockStreamsClient>;
  let mockCircuitBreaker: ReturnType<typeof createMockCircuitBreaker>;
  let alerts: OpportunityAlert[];

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockStreams = createMockStreamsClient();
    mockCircuitBreaker = createMockCircuitBreaker();
    alerts = [];

    router = new OpportunityRouter(
      mockLogger,
      mockCircuitBreaker,
      mockStreams,
      { maxOpportunities: 100, opportunityTtlMs: 5000, duplicateWindowMs: 1000, startupGracePeriodMs: 0 },
      (alert) => alerts.push(alert),
    );
  });

  // =========================================================================
  // Construction and initial state
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with zero counts', () => {
      expect(router.getPendingCount()).toBe(0);
      expect(router.getTotalOpportunities()).toBe(0);
      expect(router.getTotalExecutions()).toBe(0);
      expect(router.getOpportunitiesDropped()).toBe(0);
    });
  });

  // =========================================================================
  // processOpportunity
  // =========================================================================

  describe('processOpportunity', () => {
    it('should process a valid opportunity and store it', async () => {
      const result = await router.processOpportunity(
        { id: 'opp-1', chain: 'bsc', confidence: 0.9, timestamp: Date.now() },
        false,
      );

      expect(result).toBe(true);
      expect(router.getPendingCount()).toBe(1);
      expect(router.getTotalOpportunities()).toBe(1);
    });

    it('should reject opportunity without id', async () => {
      const result = await router.processOpportunity({ chain: 'bsc' }, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
    });

    it('should reject opportunity with non-string id', async () => {
      const result = await router.processOpportunity(
        { id: 12345 as unknown, chain: 'bsc' },
        false,
      );

      expect(result).toBe(false);
    });

    it('should detect duplicates within window', async () => {
      const now = Date.now();
      await router.processOpportunity({ id: 'dup-1', timestamp: now }, false);
      const second = await router.processOpportunity({ id: 'dup-1', timestamp: now + 100 }, false);

      expect(second).toBe(false);
    });

    it('should allow same id after duplicate window expires', async () => {
      const now = Date.now();
      await router.processOpportunity({ id: 'dup-2', timestamp: now }, false);
      // Timestamp difference exceeds duplicateWindowMs (1000)
      const result = await router.processOpportunity({ id: 'dup-2', timestamp: now + 2000 }, false);

      expect(result).toBe(true);
    });

    it('should reject opportunity with profit below minimum', async () => {
      const result = await router.processOpportunity(
        { id: 'low-profit', profitPercentage: -200 },
        false,
      );

      expect(result).toBe(false);
    });

    it('should reject opportunity with profit above maximum', async () => {
      const result = await router.processOpportunity(
        { id: 'high-profit', profitPercentage: 20000 },
        false,
      );

      expect(result).toBe(false);
    });

    it('should forward to execution engine when leader and pending', async () => {
      await router.processOpportunity(
        { id: 'exec-1', chain: 'ethereum', status: 'pending', timestamp: Date.now() },
        true,
      );

      expect(mockStreams.xadd).toHaveBeenCalled();
      expect(router.getTotalExecutions()).toBe(1);
    });

    it('should not forward when not leader', async () => {
      await router.processOpportunity(
        { id: 'exec-2', chain: 'ethereum', status: 'pending', timestamp: Date.now() },
        false,
      );

      expect(mockStreams.xadd).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // forwardToExecutionEngine
  // =========================================================================

  describe('forwardToExecutionEngine', () => {
    it('should skip forwarding when circuit breaker is open but write to DLQ', async () => {
      (mockCircuitBreaker.isCurrentlyOpen as jest.Mock).mockReturnValue(true);

      await router.processOpportunity(
        { id: 'cb-skip', chain: 'bsc', status: 'pending', timestamp: Date.now() },
        true,
      );

      // OP-2 FIX: xadd is called once for the DLQ write, not for execution stream
      expect(mockStreams.xadd).toHaveBeenCalledTimes(1);
      expect(mockStreams.xadd).toHaveBeenCalledWith(
        'stream:forwarding-dlq',
        expect.objectContaining({
          opportunityId: 'cb-skip',
          error: 'Circuit breaker open',
        }),
      );
      expect(router.getOpportunitiesDropped()).toBe(1);
    });

    it('should skip forwarding when streams client is null', async () => {
      const routerNoStreams = new OpportunityRouter(
        mockLogger,
        mockCircuitBreaker,
        null,
      );

      await routerNoStreams.processOpportunity(
        { id: 'no-stream', chain: 'bsc', status: 'pending', timestamp: Date.now() },
        true,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('streams client not initialized'),
        expect.any(Object),
      );
    });

    it('should record circuit breaker success on forwarding success', async () => {
      await router.processOpportunity(
        { id: 'cb-success', chain: 'bsc', status: 'pending', timestamp: Date.now() },
        true,
      );

      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });

    it('should retry on forwarding failure and eventually move to DLQ', async () => {
      (mockStreams.xadd as jest.Mock).mockRejectedValue(new Error('Redis down'));
      // After all retries fail, circuit breaker still closed
      (mockCircuitBreaker.isCurrentlyOpen as jest.Mock).mockReturnValue(false);
      (mockCircuitBreaker.recordFailure as jest.Mock).mockReturnValue(false);

      await router.processOpportunity(
        { id: 'retry-fail', chain: 'bsc', status: 'pending', timestamp: Date.now() },
        true,
      );

      // Should attempt 3 retries (default maxRetries) + DLQ write (which also fails)
      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalled();
      expect(router.getOpportunitiesDropped()).toBe(1);
    });
  });

  // =========================================================================
  // cleanupExpiredOpportunities
  // =========================================================================

  describe('cleanupExpiredOpportunities', () => {
    it('should remove opportunities that have explicitly expired', async () => {
      const pastTimestamp = Date.now() - 10000;
      await router.processOpportunity(
        { id: 'expired-1', expiresAt: pastTimestamp, timestamp: Date.now() },
        false,
      );

      const removed = router.cleanupExpiredOpportunities();
      expect(removed).toBe(1);
      expect(router.getPendingCount()).toBe(0);
    });

    it('should remove opportunities older than TTL', async () => {
      const oldTimestamp = Date.now() - 10000; // older than 5000ms TTL
      await router.processOpportunity(
        { id: 'old-1', timestamp: oldTimestamp },
        false,
      );

      const removed = router.cleanupExpiredOpportunities();
      expect(removed).toBe(1);
    });

    it('should return 0 when no opportunities are expired', async () => {
      await router.processOpportunity(
        { id: 'fresh-1', timestamp: Date.now() },
        false,
      );

      const removed = router.cleanupExpiredOpportunities();
      expect(removed).toBe(0);
      expect(router.getPendingCount()).toBe(1);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('should clear all state', async () => {
      await router.processOpportunity(
        { id: 'reset-1', timestamp: Date.now() },
        false,
      );

      router.reset();

      expect(router.getPendingCount()).toBe(0);
      expect(router.getTotalOpportunities()).toBe(0);
      expect(router.getTotalExecutions()).toBe(0);
      expect(router.getOpportunitiesDropped()).toBe(0);
    });
  });
});

// =============================================================================
// StreamRateLimiter
// =============================================================================

describe('StreamRateLimiter', () => {
  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create with default config', () => {
      const limiter = new StreamRateLimiter();
      expect(limiter.getTokenCount('any-stream')).toBe(DEFAULT_RATE_LIMITER_CONFIG.maxTokens);
    });

    it('should accept custom config', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 50 });
      expect(limiter.getTokenCount('any-stream')).toBe(50);
    });
  });

  // =========================================================================
  // checkRateLimit
  // =========================================================================

  describe('checkRateLimit', () => {
    it('should allow messages when tokens are available', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 5, tokensPerMessage: 1, refillMs: 1000 });

      expect(limiter.checkRateLimit('stream:test')).toBe(true);
      expect(limiter.checkRateLimit('stream:test')).toBe(true);
    });

    it('should reject messages when tokens are exhausted', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 });

      expect(limiter.checkRateLimit('stream:test')).toBe(true);
      expect(limiter.checkRateLimit('stream:test')).toBe(true);
      expect(limiter.checkRateLimit('stream:test')).toBe(false);
    });

    it('should maintain separate token buckets per stream', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 1, tokensPerMessage: 1, refillMs: 60000 });

      expect(limiter.checkRateLimit('stream:a')).toBe(true);
      expect(limiter.checkRateLimit('stream:b')).toBe(true);
      // Both should now be exhausted
      expect(limiter.checkRateLimit('stream:a')).toBe(false);
      expect(limiter.checkRateLimit('stream:b')).toBe(false);
    });

    it('should respect tokensPerMessage cost', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 5, tokensPerMessage: 3, refillMs: 60000 });

      expect(limiter.checkRateLimit('stream:expensive')).toBe(true);  // 5 -> 2
      expect(limiter.checkRateLimit('stream:expensive')).toBe(false); // 2 < 3
    });
  });

  // =========================================================================
  // getTokenCount
  // =========================================================================

  describe('getTokenCount', () => {
    it('should return maxTokens for untracked stream', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 100 });
      expect(limiter.getTokenCount('untracked')).toBe(100);
    });

    it('should return remaining tokens after consumption', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 10, tokensPerMessage: 1, refillMs: 60000 });
      limiter.checkRateLimit('stream:counted');
      limiter.checkRateLimit('stream:counted');

      expect(limiter.getTokenCount('stream:counted')).toBe(8);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('should reset a specific stream', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 });
      limiter.checkRateLimit('stream:reset-me');
      limiter.checkRateLimit('stream:reset-me');

      limiter.reset('stream:reset-me');

      // After reset, should have full tokens again (returns maxTokens for untracked)
      expect(limiter.getTokenCount('stream:reset-me')).toBe(2);
    });

    it('should reset all streams when called without argument', () => {
      const limiter = new StreamRateLimiter({ maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 });
      limiter.checkRateLimit('stream:a');
      limiter.checkRateLimit('stream:b');

      limiter.reset();

      expect(limiter.getTrackedStreams()).toEqual([]);
    });
  });

  // =========================================================================
  // getTrackedStreams
  // =========================================================================

  describe('getTrackedStreams', () => {
    it('should return empty array initially', () => {
      const limiter = new StreamRateLimiter();
      expect(limiter.getTrackedStreams()).toEqual([]);
    });

    it('should return stream names after rate limit checks', () => {
      const limiter = new StreamRateLimiter();
      limiter.checkRateLimit('stream:alpha');
      limiter.checkRateLimit('stream:beta');

      const tracked = limiter.getTrackedStreams();
      expect(tracked).toContain('stream:alpha');
      expect(tracked).toContain('stream:beta');
      expect(tracked).toHaveLength(2);
    });
  });
});

// =============================================================================
// StreamConsumerManager
// =============================================================================

describe('StreamConsumerManager', () => {
  let manager: StreamConsumerManager;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreams: ReturnType<typeof createMockStreamsClient>;
  let alerts: StreamAlert[];

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockStreams = createMockStreamsClient();
    alerts = [];

    manager = new StreamConsumerManager(
      mockStreams,
      mockLogger,
      { maxStreamErrors: 3, dlqStream: 'stream:test-dlq', instanceId: 'test-instance' },
      (alert) => alerts.push(alert),
    );
  });

  // =========================================================================
  // withDeferredAck
  // =========================================================================

  describe('withDeferredAck', () => {
    it('should ACK message after successful handler execution', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const groupConfig = createMockGroupConfig();

      const wrapped = manager.withDeferredAck(groupConfig, handler);
      await wrapped({ id: 'msg-1', data: { key: 'value' } });

      expect(handler).toHaveBeenCalled();
      expect(mockStreams.xack).toHaveBeenCalledWith(
        groupConfig.streamName,
        groupConfig.groupName,
        'msg-1',
      );
    });

    it('should move to DLQ and ACK on handler failure', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler failed'));
      const groupConfig = createMockGroupConfig();

      const wrapped = manager.withDeferredAck(groupConfig, handler);
      await wrapped({ id: 'msg-fail', data: { key: 'value' } });

      // Should write to DLQ (uses xaddWithLimit for MAXLEN enforcement)
      expect(mockStreams.xaddWithLimit).toHaveBeenCalledWith(
        'stream:test-dlq',
        expect.objectContaining({ originalMessageId: 'msg-fail' }),
      );
      // Should still ACK the message to prevent infinite retries
      expect(mockStreams.xack).toHaveBeenCalledWith(
        groupConfig.streamName,
        groupConfig.groupName,
        'msg-fail',
      );
    });
  });

  // =========================================================================
  // wrapHandler
  // =========================================================================

  describe('wrapHandler', () => {
    it('should combine rate limiting with deferred ACK', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const groupConfig = createMockGroupConfig();

      const wrapped = manager.wrapHandler(groupConfig, handler);
      await wrapped({ id: 'msg-wrap', data: {} });

      expect(handler).toHaveBeenCalled();
      expect(mockStreams.xack).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // trackError / resetErrors
  // =========================================================================

  describe('trackError', () => {
    it('should increment error count', () => {
      manager.trackError('stream:test');
      expect(manager.getErrorCount()).toBe(1);
    });

    it('should send alert when error threshold exceeded', () => {
      manager.trackError('stream:test');
      manager.trackError('stream:test');
      manager.trackError('stream:test');

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('STREAM_CONSUMER_FAILURE');
      expect(alerts[0].severity).toBe('critical');
    });

    it('should not send duplicate alerts for same error burst', () => {
      manager.trackError('stream:test');
      manager.trackError('stream:test');
      manager.trackError('stream:test');
      manager.trackError('stream:test');
      manager.trackError('stream:test');

      // Only one alert for the entire burst
      expect(alerts).toHaveLength(1);
    });
  });

  describe('resetErrors', () => {
    it('should reset error count to zero', () => {
      manager.trackError('stream:test');
      manager.trackError('stream:test');

      manager.resetErrors();

      expect(manager.getErrorCount()).toBe(0);
    });

    it('should allow new alert after reset', () => {
      // Trigger first alert
      for (let i = 0; i < 3; i++) manager.trackError('stream:test');
      expect(alerts).toHaveLength(1);

      // Reset and trigger second alert
      // OP-26 FIX: resetErrors() now emits STREAM_RECOVERED alert (total = 2 after reset)
      manager.resetErrors();
      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toEqual(expect.objectContaining({ type: 'STREAM_RECOVERED' }));

      for (let i = 0; i < 3; i++) manager.trackError('stream:test');
      expect(alerts).toHaveLength(3);
    });
  });

  // =========================================================================
  // recoverPendingMessages
  // =========================================================================

  describe('recoverPendingMessages', () => {
    it('should log pending messages from previous instance', async () => {
      (mockStreams.xpending as jest.Mock).mockResolvedValue({
        total: 5,
        smallestId: '1-0',
        largestId: '5-0',
        consumers: [{ name: 'coordinator-1', pending: 3 }],
      });

      const groupConfig = createMockGroupConfig();
      await manager.recoverPendingMessages([groupConfig]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('pending messages'),
        expect.objectContaining({ pendingCount: 5 }),
      );
    });

    it('should handle xpending returning null gracefully', async () => {
      (mockStreams.xpending as jest.Mock).mockResolvedValue(null);

      const groupConfig = createMockGroupConfig();
      await manager.recoverPendingMessages([groupConfig]);

      // Should not throw and should not log warnings
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should handle xpending errors gracefully', async () => {
      (mockStreams.xpending as jest.Mock).mockRejectedValue(new Error('Redis error'));

      const groupConfig = createMockGroupConfig();
      await manager.recoverPendingMessages([groupConfig]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check pending'),
        expect.any(Object),
      );
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('should reset all internal state', () => {
      manager.trackError('stream:test');
      manager.trackError('stream:test');

      manager.reset();

      expect(manager.getErrorCount()).toBe(0);
    });
  });
});

// @ts-nocheck - Test file with mock objects that don't need strict typing
/**
 * Unit Tests for DlqConsumer
 *
 * Tests the Dead Letter Queue consumer that monitors failed opportunity messages,
 * classifies error types, tracks DLQ depth, and optionally replays messages.
 *
 * @see dlq-consumer.ts
 * @see opportunity.consumer.ts (writes to DLQ)
 * @see types.ts (DLQ_STREAM constant)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mocks — must be declared before imports that use them
// =============================================================================

jest.mock('@arbitrage/core/async', () => ({
  clearIntervalSafe: jest.fn(),
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: jest.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err ?? 'Unknown error'),
  ),
}));

jest.mock('@arbitrage/core/redis', () => ({
  RedisStreamsClient: {
    STREAMS: {
      EXECUTION_REQUESTS: 'stream:execution-requests',
    },
  },
}));

import { clearIntervalSafe } from '@arbitrage/core/async';
import { getErrorMessage } from '@arbitrage/core/resilience';
import {
  DlqConsumer,
  createDlqConsumer,
  type DlqConsumerDeps,
  type DlqMessage,
} from '../../../src/consumers/dlq-consumer';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockStreamsClient = () => ({
  xread: jest.fn().mockResolvedValue([]),
  xadd: jest.fn().mockResolvedValue('msg-id-1'),
  xaddWithLimit: jest.fn().mockResolvedValue('msg-id-1'),
  xlen: jest.fn().mockResolvedValue(0),
});

const createMockLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const createDeps = (overrides: Partial<DlqConsumerDeps> = {}): DlqConsumerDeps => ({
  streamsClient: createMockStreamsClient() as any,
  logger: createMockLogger() as any,
  scanIntervalMs: 1000, // Short interval for testing
  maxMessagesPerScan: 10,
  ...overrides,
});

/**
 * Create mock DLQ messages with alternating error types.
 * Even-indexed messages get VAL_MISSING_ID, odd-indexed get ERR_NO_CHAIN.
 * Each message includes originalPayload for replay capability.
 */
const createDlqMessages = (count: number, baseTimestamp?: number) => {
  const now = baseTimestamp ?? Date.now();
  return Array.from({ length: count }, (_, i) => {
    const originalPayload = {
      id: `opp-${i}`,
      type: 'intra-chain',
      buyChain: 'ethereum',
      sellChain: 'ethereum',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      expectedProfit: '0.05',
      confidence: 0.85,
    };
    return {
      id: `msg-${i}`,
      data: {
        originalMessageId: `orig-${i}`,
        originalStream: 'execution-requests',
        opportunityId: `opp-${i}`,
        opportunityType: 'intra-chain',
        error:
          i % 2 === 0
            ? '[VAL_MISSING_ID] Missing ID field'
            : '[ERR_NO_CHAIN] Chain not configured',
        timestamp: now - i * 60000, // Progressively older
        service: 'execution-engine',
        instanceId: 'inst-1',
        originalPayload: JSON.stringify(originalPayload),
      },
    };
  });
};

// =============================================================================
// Test Suite
// =============================================================================

describe('DlqConsumer', () => {
  let consumer: DlqConsumer;
  let deps: DlqConsumerDeps;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.useFakeTimers();

    // Re-apply mock implementations after clearAllMocks (from setupTests.ts)
    (clearIntervalSafe as jest.Mock).mockImplementation((interval: unknown) => {
      if (interval) {
        clearInterval(interval as NodeJS.Timeout);
      }
      return null;
    });
    (getErrorMessage as jest.Mock).mockImplementation((err: unknown) => {
      if (err instanceof Error) return err.message;
      return String(err);
    });

    mockStreamsClient = createMockStreamsClient();
    mockLogger = createMockLogger();
    deps = createDeps({
      streamsClient: mockStreamsClient as any,
      logger: mockLogger as any,
    });
    consumer = new DlqConsumer(deps);
  });

  afterEach(() => {
    consumer.stop();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create with default config values', () => {
      const defaultDeps: DlqConsumerDeps = {
        streamsClient: mockStreamsClient as any,
        logger: mockLogger as any,
        // No scanIntervalMs or maxMessagesPerScan — use defaults
      };
      const defaultConsumer = new DlqConsumer(defaultDeps);

      // Verify defaults indirectly: default maxMessagesPerScan = 100
      const stats = defaultConsumer.getDlqStats();
      expect(stats.totalCount).toBe(0);
      expect(stats.errorCounts.size).toBe(0);
      expect(stats.oldestEntryAge).toBeNull();
      expect(stats.lastScanAt).toBeNull();

      defaultConsumer.stop();
    });

    it('should use provided config values', () => {
      // Verify the consumer uses the provided maxMessagesPerScan
      // by observing xread call options
      consumer.start();

      // The initial scan should call xread with count: 10 (our provided maxMessagesPerScan)
      expect(mockStreamsClient.xread).toHaveBeenCalledWith(
        expect.any(String), // DLQ_STREAM
        '0',
        { count: 10 },
      );

      consumer.stop();
    });
  });

  // ===========================================================================
  // start() / stop() lifecycle
  // ===========================================================================

  describe('start/stop lifecycle', () => {
    it('should run initial scan immediately on start', () => {
      consumer.start();

      // The initial scan fires immediately (not waiting for interval)
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(1);
    });

    it('should run periodic scans at interval', async () => {
      consumer.start();

      // Initial scan
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(1);

      // Advance one interval (1000ms)
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(2);

      // Advance another interval
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(3);
    });

    it('should stop scanning when stop() is called', async () => {
      consumer.start();
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(1);

      consumer.stop();

      // Advance past multiple intervals — no additional scans should fire
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(1);
    });

    it('should warn on double start and not create duplicate timers', async () => {
      consumer.start();
      expect(mockLogger.warn).not.toHaveBeenCalled();

      consumer.start(); // Second start
      expect(mockLogger.warn).toHaveBeenCalledWith('DLQ consumer already started');

      // Initial call from first start only — second start should not trigger another
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(1);

      // Advance one interval — only one periodic scan (not two)
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(2);
    });

    it('should log info on start with config details', () => {
      consumer.start();

      expect(mockLogger.info).toHaveBeenCalledWith('Starting DLQ consumer', {
        scanIntervalMs: 1000,
        maxMessagesPerScan: 10,
      });
    });

    it('should log info on stop', () => {
      consumer.start();
      consumer.stop();

      expect(mockLogger.info).toHaveBeenCalledWith('Stopping DLQ consumer');
    });

    it('should not log on stop if never started', () => {
      consumer.stop();

      expect(mockLogger.info).not.toHaveBeenCalledWith('Stopping DLQ consumer');
    });

    it('should log error when initial scan fails', async () => {
      const scanError = new Error('Redis connection lost');
      mockStreamsClient.xread.mockRejectedValueOnce(scanError);

      consumer.start();

      // Let the promise rejection propagate through the .catch handler
      await jest.advanceTimersByTimeAsync(0);

      expect(mockLogger.error).toHaveBeenCalledWith('Initial DLQ scan failed', {
        error: 'Redis connection lost',
      });
    });

    it('should log error when periodic scan fails', async () => {
      consumer.start();

      // Make the periodic scan fail
      mockStreamsClient.xread.mockRejectedValueOnce(new Error('Timeout'));

      await jest.advanceTimersByTimeAsync(1000);

      expect(mockLogger.error).toHaveBeenCalledWith('Periodic DLQ scan failed', {
        error: 'Timeout',
      });
    });
  });

  // ===========================================================================
  // scanDlq()
  // ===========================================================================

  describe('scanDlq', () => {
    it('should update stats with message count', async () => {
      const messages = createDlqMessages(4);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);
      mockStreamsClient.xlen.mockResolvedValueOnce(4);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.totalCount).toBe(4);
    });

    it('should classify error types from VAL_* and ERR_* patterns', async () => {
      const messages = createDlqMessages(4);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      // Even indices (0, 2) have VAL_MISSING_ID; odd indices (1, 3) have ERR_NO_CHAIN
      expect(stats.errorCounts.get('VAL_MISSING_ID')).toBe(2);
      expect(stats.errorCounts.get('ERR_NO_CHAIN')).toBe(2);
    });

    it('should track oldest entry age', async () => {
      const now = Date.now();
      const messages = createDlqMessages(3, now);
      // msg-0: timestamp = now, msg-1: timestamp = now - 60000, msg-2: timestamp = now - 120000
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      // Oldest entry is msg-2 at now - 120000
      // oldestEntryAge = Date.now() - (now - 120000) = 120000
      expect(stats.oldestEntryAge).toBe(120000);
    });

    it('should handle empty DLQ with no messages', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([]);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.totalCount).toBe(0);
      expect(stats.errorCounts.size).toBe(0);
      expect(stats.oldestEntryAge).toBeNull();
      expect(stats.lastScanAt).toBe(Date.now());
    });

    it('should handle scan failure by logging error and re-throwing', async () => {
      const scanError = new Error('Redis unavailable');
      mockStreamsClient.xread.mockRejectedValueOnce(scanError);

      await expect(consumer.scanDlq()).rejects.toThrow('Redis unavailable');

      expect(mockLogger.error).toHaveBeenCalledWith('DLQ scan failed', {
        error: 'Redis unavailable',
      });
    });

    it('should log summary when messages are found', async () => {
      const messages = createDlqMessages(2);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);
      mockStreamsClient.xlen.mockResolvedValueOnce(2);

      await consumer.scanDlq();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'DLQ scan complete',
        expect.objectContaining({
          totalCount: 2,
          errorTypes: expect.arrayContaining([
            expect.objectContaining({ type: 'VAL_MISSING_ID', count: 1 }),
            expect.objectContaining({ type: 'ERR_NO_CHAIN', count: 1 }),
          ]),
          oldestEntryAgeMs: expect.any(Number),
        }),
      );
    });

    it('should not log summary when DLQ is empty', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([]);

      await consumer.scanDlq();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'DLQ scan complete',
        expect.anything(),
      );
    });

    it('should set lastScanAt to current time', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([]);
      const now = Date.now();

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.lastScanAt).toBe(now);
    });

    it('should reset stats on each scan (not accumulate)', async () => {
      // First scan: 4 messages
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(4));
      mockStreamsClient.xlen.mockResolvedValueOnce(4);
      await consumer.scanDlq();
      expect(consumer.getDlqStats().totalCount).toBe(4);

      // Second scan: 1 message
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(1));
      mockStreamsClient.xlen.mockResolvedValueOnce(1);
      await consumer.scanDlq();
      expect(consumer.getDlqStats().totalCount).toBe(1);
    });

    it('should pass maxMessagesPerScan as count option to xread', async () => {
      await consumer.scanDlq();

      expect(mockStreamsClient.xread).toHaveBeenCalledWith(
        expect.any(String),
        '0',
        { count: 10 },
      );
    });
  });

  // ===========================================================================
  // getDlqStats()
  // ===========================================================================

  describe('getDlqStats', () => {
    it('should return initial empty stats', () => {
      const stats = consumer.getDlqStats();

      expect(stats.totalCount).toBe(0);
      expect(stats.errorCounts).toBeInstanceOf(Map);
      expect(stats.errorCounts.size).toBe(0);
      expect(stats.oldestEntryAge).toBeNull();
      expect(stats.lastScanAt).toBeNull();
    });

    it('should return copy of errorCounts (not same reference)', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(2));
      await consumer.scanDlq();

      const stats1 = consumer.getDlqStats();
      const stats2 = consumer.getDlqStats();

      expect(stats1.errorCounts).not.toBe(stats2.errorCounts);
      // But contents should be equal
      expect(Array.from(stats1.errorCounts.entries())).toEqual(
        Array.from(stats2.errorCounts.entries()),
      );
    });

    it('should return updated stats after scan', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(6));
      mockStreamsClient.xlen.mockResolvedValueOnce(6);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.totalCount).toBe(6);
      expect(stats.errorCounts.get('VAL_MISSING_ID')).toBe(3);
      expect(stats.errorCounts.get('ERR_NO_CHAIN')).toBe(3);
      expect(stats.oldestEntryAge).toBeGreaterThanOrEqual(0);
      expect(stats.lastScanAt).toBe(Date.now());
    });

    it('should not allow mutation of internal stats via returned object', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(2));
      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      stats.errorCounts.set('INJECTED', 999);

      // Internal state should be unaffected
      const fresh = consumer.getDlqStats();
      expect(fresh.errorCounts.has('INJECTED')).toBe(false);
    });
  });

  // ===========================================================================
  // replayMessage()
  // ===========================================================================

  describe('replayMessage', () => {
    it('should find message and replay to EXECUTION_REQUESTS stream', async () => {
      const messages = createDlqMessages(3);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      const result = await consumer.replayMessage('msg-1');

      expect(result).toBe(true);
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:execution-requests',
        expect.objectContaining({
          id: 'opp-1',
          type: 'intra-chain',
          buyChain: 'ethereum',
          replayed: true,
          originalError: '[ERR_NO_CHAIN] Chain not configured',
          replayedAt: expect.any(Number),
        }),
      );
    });

    it('should log info after successful replay', async () => {
      const messages = createDlqMessages(2);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      await consumer.replayMessage('msg-0');

      expect(mockLogger.info).toHaveBeenCalledWith('DLQ message replayed', {
        messageId: 'msg-0',
        opportunityId: 'opp-0',
      });
    });

    it('should return false when message not found', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(2));

      const result = await consumer.replayMessage('nonexistent-msg');

      expect(result).toBe(false);
      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });

    it('should log warning when message not found', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([]);

      await consumer.replayMessage('missing-id');

      expect(mockLogger.warn).toHaveBeenCalledWith('DLQ message not found for replay', {
        messageId: 'missing-id',
      });
    });

    it('should return false when message has no originalPayload', async () => {
      const messages = [{
        id: 'msg-no-payload',
        data: {
          originalMessageId: 'orig-0',
          originalStream: 'execution-requests',
          opportunityId: 'opp-0',
          opportunityType: 'intra-chain',
          error: '[VAL_MISSING_ID] Missing ID',
          timestamp: Date.now(),
          service: 'execution-engine',
          instanceId: 'inst-1',
          // No originalPayload
        },
      }];
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      const result = await consumer.replayMessage('msg-no-payload');

      expect(result).toBe(false);
      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'DLQ message has no stored payload — cannot replay',
        expect.objectContaining({ messageId: 'msg-no-payload' }),
      );
    });

    it('should return false when originalPayload is corrupt JSON', async () => {
      const messages = [{
        id: 'msg-corrupt',
        data: {
          originalMessageId: 'orig-0',
          originalStream: 'execution-requests',
          opportunityId: 'opp-0',
          opportunityType: 'intra-chain',
          error: '[VAL_MISSING_ID] Missing ID',
          timestamp: Date.now(),
          service: 'execution-engine',
          instanceId: 'inst-1',
          originalPayload: '{corrupt json',
        },
      }];
      mockStreamsClient.xread.mockResolvedValueOnce(messages);

      const result = await consumer.replayMessage('msg-corrupt');

      expect(result).toBe(false);
      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });

    it('should paginate through DLQ to find message beyond first batch', async () => {
      // First page: messages 0-2 (target not here)
      const page1 = createDlqMessages(3);
      // Second page: messages 3-5 (target is msg-4)
      const page2 = createDlqMessages(3).map((m, i) => ({
        ...m,
        id: `msg-${i + 3}`,
        data: { ...m.data, opportunityId: `opp-${i + 3}` },
      }));
      // Third page: empty (end of stream)
      mockStreamsClient.xread
        .mockResolvedValueOnce(page1)    // First read from '0'
        .mockResolvedValueOnce(page2)    // Second read from 'msg-2'
        .mockResolvedValueOnce([]);      // Third read (empty, stops)

      const result = await consumer.replayMessage('msg-4');

      expect(result).toBe(true);
      expect(mockStreamsClient.xread).toHaveBeenCalledTimes(2);
    });

    it('should throw when xadd fails', async () => {
      const messages = createDlqMessages(1);
      mockStreamsClient.xread.mockResolvedValueOnce(messages);
      mockStreamsClient.xaddWithLimit.mockRejectedValueOnce(new Error('Stream write failed'));

      await expect(consumer.replayMessage('msg-0')).rejects.toThrow('Stream write failed');

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to replay DLQ message', {
        messageId: 'msg-0',
        error: 'Stream write failed',
      });
    });

    it('should throw when xread fails during replay', async () => {
      mockStreamsClient.xread.mockRejectedValueOnce(new Error('Read error'));

      await expect(consumer.replayMessage('msg-0')).rejects.toThrow('Read error');

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to replay DLQ message', {
        messageId: 'msg-0',
        error: 'Read error',
      });
    });
  });

  // ===========================================================================
  // extractErrorType (tested indirectly through scanDlq)
  // ===========================================================================

  describe('extractErrorType (via scanDlq)', () => {
    it('should classify messages with [VAL_MISSING_ID] as VAL_MISSING_ID', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([
        {
          id: 'msg-1',
          data: {
            originalMessageId: 'orig-1',
            originalStream: 'execution-requests',
            opportunityId: 'opp-1',
            opportunityType: 'intra-chain',
            error: '[VAL_MISSING_ID] Opportunity ID is missing from message',
            timestamp: Date.now(),
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
      ]);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.errorCounts.get('VAL_MISSING_ID')).toBe(1);
    });

    it('should classify messages with [ERR_NO_CHAIN] as ERR_NO_CHAIN', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([
        {
          id: 'msg-1',
          data: {
            originalMessageId: 'orig-1',
            originalStream: 'execution-requests',
            opportunityId: 'opp-1',
            opportunityType: 'intra-chain',
            error: '[ERR_NO_CHAIN] Chain not configured for this environment',
            timestamp: Date.now(),
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
      ]);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.errorCounts.get('ERR_NO_CHAIN')).toBe(1);
    });

    it('should classify messages without bracket pattern as UNKNOWN', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([
        {
          id: 'msg-1',
          data: {
            originalMessageId: 'orig-1',
            originalStream: 'execution-requests',
            opportunityId: 'opp-1',
            opportunityType: 'intra-chain',
            error: 'Something went wrong without a code',
            timestamp: Date.now(),
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
      ]);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.errorCounts.get('UNKNOWN')).toBe(1);
    });

    it('should classify multiple error types in same scan', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([
        {
          id: 'msg-1',
          data: {
            originalMessageId: 'orig-1',
            originalStream: 'execution-requests',
            opportunityId: 'opp-1',
            opportunityType: 'intra-chain',
            error: '[VAL_EXPIRED] Opportunity expired',
            timestamp: Date.now(),
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
        {
          id: 'msg-2',
          data: {
            originalMessageId: 'orig-2',
            originalStream: 'execution-requests',
            opportunityId: 'opp-2',
            opportunityType: 'cross-chain',
            error: '[ERR_EXECUTION] Execution failed',
            timestamp: Date.now() - 30000,
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
        {
          id: 'msg-3',
          data: {
            originalMessageId: 'orig-3',
            originalStream: 'execution-requests',
            opportunityId: 'opp-3',
            opportunityType: 'intra-chain',
            error: 'No bracketed code here',
            timestamp: Date.now() - 60000,
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
      ]);
      mockStreamsClient.xlen.mockResolvedValueOnce(3);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      expect(stats.errorCounts.get('VAL_EXPIRED')).toBe(1);
      expect(stats.errorCounts.get('ERR_EXECUTION')).toBe(1);
      expect(stats.errorCounts.get('UNKNOWN')).toBe(1);
      expect(stats.totalCount).toBe(3);
    });

    it('should handle error messages with brackets but non-matching prefix', async () => {
      mockStreamsClient.xread.mockResolvedValueOnce([
        {
          id: 'msg-1',
          data: {
            originalMessageId: 'orig-1',
            originalStream: 'execution-requests',
            opportunityId: 'opp-1',
            opportunityType: 'intra-chain',
            error: '[INFO_LOGGED] This is just info, not VAL_ or ERR_',
            timestamp: Date.now(),
            service: 'execution-engine',
            instanceId: 'inst-1',
          },
        },
      ]);

      await consumer.scanDlq();

      const stats = consumer.getDlqStats();
      // [INFO_LOGGED] does not match [VAL_*] or [ERR_*] pattern
      expect(stats.errorCounts.get('UNKNOWN')).toBe(1);
    });
  });

  // ===========================================================================
  // createDlqConsumer factory
  // ===========================================================================

  describe('createDlqConsumer factory', () => {
    it('should create DlqConsumer instance', () => {
      const instance = createDlqConsumer(deps);

      expect(instance).toBeInstanceOf(DlqConsumer);
    });

    it('should create functional instance that can scan', async () => {
      const instance = createDlqConsumer(deps);
      mockStreamsClient.xread.mockResolvedValueOnce(createDlqMessages(2));
      mockStreamsClient.xlen.mockResolvedValueOnce(2);

      await instance.scanDlq();

      const stats = instance.getDlqStats();
      expect(stats.totalCount).toBe(2);
    });
  });
});

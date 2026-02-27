/**
 * Unit Tests for StreamConsumerManager
 *
 * Regression tests covering:
 * - OP-1 FIX: XCLAIM orphaned PEL message recovery
 * - Deferred ACK with DLQ flow
 * - Rate limiting integration
 * - Error tracking and alerting
 *
 * @see services/coordinator/src/streaming/stream-consumer-manager.ts
 * @see OP-1 in docs/reports/CONSOLIDATED_ANALYSIS_SUPPLEMENT.md
 */

import {
  StreamConsumerManager,
} from '../../../src/streaming/stream-consumer-manager';
import type {
  StreamsClient,
  StreamManagerLogger,
  ConsumerGroupConfig,
  StreamAlert,
  StreamConsumerManagerConfig,
} from '../../../src/streaming/stream-consumer-manager';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLogger(): jest.Mocked<StreamManagerLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createMockStreamsClient(): jest.Mocked<StreamsClient> {
  return {
    xack: jest.fn().mockResolvedValue(1),
    xadd: jest.fn().mockResolvedValue('dlq-1-0'),
    xaddWithLimit: jest.fn().mockResolvedValue('dlq-1-0'),
    xpending: jest.fn().mockResolvedValue(null),
    xclaim: jest.fn().mockResolvedValue([]),
    xpendingRange: jest.fn().mockResolvedValue([]),
  };
}

function createGroupConfig(overrides?: Partial<ConsumerGroupConfig>): ConsumerGroupConfig {
  return {
    streamName: 'stream:opportunities',
    groupName: 'coordinator-group',
    consumerName: 'coordinator-new-instance',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('StreamConsumerManager', () => {
  let logger: jest.Mocked<StreamManagerLogger>;
  let streamsClient: jest.Mocked<StreamsClient>;
  let alertCallback: jest.Mock;
  let manager: StreamConsumerManager;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    streamsClient = createMockStreamsClient();
    alertCallback = jest.fn();
    manager = new StreamConsumerManager(
      streamsClient,
      logger,
      {
        maxStreamErrors: 3,
        dlqStream: 'stream:dead-letter-queue',
        instanceId: 'test-coordinator',
        orphanClaimMinIdleMs: 60000,
        orphanClaimBatchSize: 50,
      },
      alertCallback,
    );
  });

  // ===========================================================================
  // OP-1: XCLAIM Orphaned PEL Recovery
  // ===========================================================================

  describe('recoverPendingMessages — OP-1 XCLAIM', () => {
    it('should skip recovery when no pending messages exist', async () => {
      streamsClient.xpending.mockResolvedValue({ total: 0, consumers: [] });

      await manager.recoverPendingMessages([createGroupConfig()]);

      expect(streamsClient.xpendingRange).not.toHaveBeenCalled();
      expect(streamsClient.xclaim).not.toHaveBeenCalled();
    });

    it('should skip recovery when xpending returns null', async () => {
      streamsClient.xpending.mockResolvedValue(null);

      await manager.recoverPendingMessages([createGroupConfig()]);

      expect(streamsClient.xpendingRange).not.toHaveBeenCalled();
      expect(streamsClient.xclaim).not.toHaveBeenCalled();
    });

    it('should claim orphaned messages from stale consumers', async () => {
      const groupConfig = createGroupConfig({ consumerName: 'coordinator-new' });

      // Stale consumer has 3 pending messages
      streamsClient.xpending.mockResolvedValue({
        total: 3,
        smallestId: '100-0',
        largestId: '102-0',
        consumers: [
          { name: 'coordinator-old-crashed', pending: 3 },
        ],
      });

      // Return specific pending entries for the stale consumer
      streamsClient.xpendingRange.mockResolvedValue([
        { id: '100-0', consumer: 'coordinator-old-crashed', idleMs: 120000, deliveryCount: 1 },
        { id: '101-0', consumer: 'coordinator-old-crashed', idleMs: 90000, deliveryCount: 1 },
        { id: '102-0', consumer: 'coordinator-old-crashed', idleMs: 30000, deliveryCount: 1 }, // Not idle enough
      ]);

      // XCLAIM returns the claimed messages
      streamsClient.xclaim.mockResolvedValue([
        { id: '100-0', data: { type: 'opportunity', id: 'opp-1' } },
        { id: '101-0', data: { type: 'opportunity', id: 'opp-2' } },
      ]);

      await manager.recoverPendingMessages([groupConfig]);

      // Should query pending range for the stale consumer
      expect(streamsClient.xpendingRange).toHaveBeenCalledWith(
        'stream:opportunities',
        'coordinator-group',
        '-',
        '+',
        50,
        'coordinator-old-crashed',
      );

      // Should XCLAIM only the messages idle >= 60000ms (100-0 and 101-0, not 102-0)
      expect(streamsClient.xclaim).toHaveBeenCalledWith(
        'stream:opportunities',
        'coordinator-group',
        'coordinator-new',
        60000,
        ['100-0', '101-0'],
      );

      // Should move claimed messages to DLQ
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(2);
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:dead-letter-queue',
        expect.objectContaining({
          originalStream: 'stream:opportunities',
          error: 'Orphaned PEL message recovered via XCLAIM',
        }),
      );

      // Should ACK claimed messages
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '100-0');
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '101-0');

      // Should log recovery
      expect(logger.info).toHaveBeenCalledWith(
        'Recovered orphaned pending messages',
        expect.objectContaining({
          claimedCount: 2,
          staleConsumer: 'coordinator-old-crashed',
        }),
      );
    });

    it('should NOT claim messages from our own consumer', async () => {
      const groupConfig = createGroupConfig({ consumerName: 'coordinator-current' });

      streamsClient.xpending.mockResolvedValue({
        total: 5,
        consumers: [
          { name: 'coordinator-current', pending: 5 }, // Our own consumer
        ],
      });

      await manager.recoverPendingMessages([groupConfig]);

      // Should NOT try to claim our own messages
      expect(streamsClient.xpendingRange).not.toHaveBeenCalled();
      expect(streamsClient.xclaim).not.toHaveBeenCalled();

      // Should log info about our pending messages
      expect(logger.info).toHaveBeenCalledWith(
        'This consumer has pending messages to process',
        expect.objectContaining({ pendingForUs: 5 }),
      );
    });

    it('should skip claiming when no entries are idle long enough', async () => {
      const groupConfig = createGroupConfig();

      streamsClient.xpending.mockResolvedValue({
        total: 2,
        consumers: [
          { name: 'coordinator-other', pending: 2 },
        ],
      });

      // All entries have low idle time (under threshold)
      streamsClient.xpendingRange.mockResolvedValue([
        { id: '100-0', consumer: 'coordinator-other', idleMs: 5000, deliveryCount: 1 },
        { id: '101-0', consumer: 'coordinator-other', idleMs: 10000, deliveryCount: 1 },
      ]);

      await manager.recoverPendingMessages([groupConfig]);

      // Should NOT xclaim (no messages meet idle threshold)
      expect(streamsClient.xclaim).not.toHaveBeenCalled();
    });

    it('should handle multiple stale consumers', async () => {
      const groupConfig = createGroupConfig({ consumerName: 'coordinator-new' });

      streamsClient.xpending.mockResolvedValue({
        total: 5,
        consumers: [
          { name: 'coordinator-crash-1', pending: 2 },
          { name: 'coordinator-crash-2', pending: 3 },
        ],
      });

      // First consumer's pending entries
      streamsClient.xpendingRange
        .mockResolvedValueOnce([
          { id: '100-0', consumer: 'coordinator-crash-1', idleMs: 120000, deliveryCount: 1 },
        ])
        .mockResolvedValueOnce([
          { id: '200-0', consumer: 'coordinator-crash-2', idleMs: 90000, deliveryCount: 1 },
        ]);

      streamsClient.xclaim
        .mockResolvedValueOnce([{ id: '100-0', data: { id: 'opp-1' } }])
        .mockResolvedValueOnce([{ id: '200-0', data: { id: 'opp-2' } }]);

      await manager.recoverPendingMessages([groupConfig]);

      // Should process both stale consumers
      expect(streamsClient.xpendingRange).toHaveBeenCalledTimes(2);
      expect(streamsClient.xclaim).toHaveBeenCalledTimes(2);
    });

    it('should continue processing other streams if one fails', async () => {
      const configs = [
        createGroupConfig({ streamName: 'stream:health' }),
        createGroupConfig({ streamName: 'stream:opportunities' }),
      ];

      streamsClient.xpending
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockResolvedValueOnce({ total: 0, consumers: [] });

      await manager.recoverPendingMessages(configs);

      // Should log error for first stream
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to check pending messages',
        expect.objectContaining({ stream: 'stream:health' }),
      );

      // Should still check second stream
      expect(streamsClient.xpending).toHaveBeenCalledTimes(2);
    });

    it('should handle XCLAIM failure gracefully without throwing', async () => {
      const groupConfig = createGroupConfig();

      streamsClient.xpending.mockResolvedValue({
        total: 1,
        consumers: [{ name: 'coordinator-stale', pending: 1 }],
      });

      streamsClient.xpendingRange.mockResolvedValue([
        { id: '100-0', consumer: 'coordinator-stale', idleMs: 120000, deliveryCount: 1 },
      ]);

      streamsClient.xclaim.mockRejectedValue(new Error('XCLAIM failed'));

      // Should not throw
      await expect(manager.recoverPendingMessages([groupConfig])).resolves.not.toThrow();

      // Should log error
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to claim orphaned messages',
        expect.objectContaining({ staleConsumer: 'coordinator-stale' }),
      );
    });
  });

  // ===========================================================================
  // Deferred ACK + DLQ Flow
  // ===========================================================================

  describe('withDeferredAck', () => {
    it('should ACK message on handler success', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      await wrapped({ id: '1-0', data: { test: true } });

      expect(handler).toHaveBeenCalled();
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '1-0');
      expect(streamsClient.xaddWithLimit).not.toHaveBeenCalled(); // No DLQ
    });

    it('should move to DLQ then ACK on handler failure', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockRejectedValue(new Error('Processing failed'));
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      await wrapped({ id: '1-0', data: { opportunity: 'data' } });

      // Should write to DLQ first
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:dead-letter-queue',
        expect.objectContaining({
          originalStream: 'stream:opportunities',
          error: 'Processing failed',
          service: 'coordinator',
        }),
      );

      // Then ACK to prevent infinite retries
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '1-0');
    });
  });

  // ===========================================================================
  // Error Tracking
  // ===========================================================================

  describe('trackError', () => {
    it('should send alert when error threshold is reached', () => {
      manager.trackError('stream:health');
      manager.trackError('stream:health');
      manager.trackError('stream:health'); // 3rd = threshold

      expect(alertCallback).toHaveBeenCalledTimes(1);
      expect(alertCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'STREAM_CONSUMER_FAILURE',
          severity: 'critical',
        }),
      );
    });

    it('should not send duplicate alerts for same error burst', () => {
      for (let i = 0; i < 10; i++) {
        manager.trackError('stream:health');
      }

      expect(alertCallback).toHaveBeenCalledTimes(1);
    });

    it('should allow new alert after error reset', () => {
      for (let i = 0; i < 3; i++) manager.trackError('stream:health');
      expect(alertCallback).toHaveBeenCalledTimes(1);

      manager.resetErrors();
      // OP-26 FIX: resetErrors() now emits STREAM_RECOVERED alert
      expect(alertCallback).toHaveBeenCalledTimes(2);
      expect(alertCallback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'STREAM_RECOVERED',
          severity: 'warning',
        }),
      );

      for (let i = 0; i < 3; i++) manager.trackError('stream:health');
      expect(alertCallback).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // wrapHandler (rate limiting + deferred ACK)
  // ===========================================================================

  describe('wrapHandler', () => {
    it('should compose rate limiting and deferred ACK', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.wrapHandler(groupConfig, handler);

      await wrapped({ id: '1-0', data: { test: true } });

      expect(handler).toHaveBeenCalled();
      expect(streamsClient.xack).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // H6: Deserialization edge cases (malformed/corrupted message data)
  // ===========================================================================

  describe('deserialization edge cases (H6)', () => {
    it('should handle message with empty data object', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      await wrapped({ id: '1-0', data: {} });

      expect(handler).toHaveBeenCalledWith({ id: '1-0', data: {} });
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '1-0');
    });

    it('should handle message with null-ish field values gracefully', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      await wrapped({ id: '2-0', data: { chain: null, buyDex: undefined, profitPercentage: 'not-a-number' } });

      expect(handler).toHaveBeenCalled();
      expect(streamsClient.xack).toHaveBeenCalled();
    });

    it('should route corrupted message data to DLQ when handler throws parse error', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockRejectedValue(new SyntaxError('Unexpected token in JSON'));
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      await wrapped({ id: '3-0', data: { corrupted: 'yes' } });

      // Should write to DLQ with error info
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:dead-letter-queue',
        expect.objectContaining({
          originalStream: 'stream:opportunities',
          error: 'Unexpected token in JSON',
        }),
      );

      // Should still ACK to prevent infinite redelivery
      expect(streamsClient.xack).toHaveBeenCalledWith('stream:opportunities', 'coordinator-group', '3-0');
    });

    it('should handle message with deeply nested data field', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      const nestedData = {
        type: 'opportunity',
        data: {
          id: 'nested-1',
          chain: 'ethereum',
          nested: { deeper: { value: 42 } },
        },
      };

      await wrapped({ id: '4-0', data: nestedData });

      expect(handler).toHaveBeenCalledWith({ id: '4-0', data: nestedData });
      expect(streamsClient.xack).toHaveBeenCalled();
    });

    it('should handle message where data contains non-string values', async () => {
      const groupConfig = createGroupConfig();
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = manager.withDeferredAck(groupConfig, handler);

      // Redis streams normally return strings, but mocks/tests may produce mixed types
      const mixedData = {
        id: 123,                    // number instead of string
        chain: true,                // boolean instead of string
        profitPercentage: 'abc',    // string instead of number
        timestamp: BigInt(999),     // BigInt (exotic type)
      };

      await wrapped({ id: '5-0', data: mixedData });

      expect(handler).toHaveBeenCalled();
      expect(streamsClient.xack).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // H7: Consumer group state — pending messages and duplicate delivery
  // ===========================================================================

  describe('consumer group state (H7)', () => {
    it('should handle xpending with mixed consumer states (some stale, some active)', async () => {
      const groupConfig = createGroupConfig({ consumerName: 'coordinator-active' });

      streamsClient.xpending.mockResolvedValue({
        total: 5,
        consumers: [
          { name: 'coordinator-active', pending: 2 },   // Our consumer (skip)
          { name: 'coordinator-crashed', pending: 3 },   // Stale (claim)
        ],
      });

      streamsClient.xpendingRange.mockResolvedValue([
        { id: '300-0', consumer: 'coordinator-crashed', idleMs: 120000, deliveryCount: 2 },
      ]);

      streamsClient.xclaim.mockResolvedValue([
        { id: '300-0', data: { id: 'opp-stale' } },
      ]);

      await manager.recoverPendingMessages([groupConfig]);

      // Should only query the stale consumer, not our own
      expect(streamsClient.xpendingRange).toHaveBeenCalledTimes(1);
      expect(streamsClient.xpendingRange).toHaveBeenCalledWith(
        'stream:opportunities',
        'coordinator-group',
        '-',
        '+',
        50,
        'coordinator-crashed',
      );

      // Should log about our own pending messages
      expect(logger.info).toHaveBeenCalledWith(
        'This consumer has pending messages to process',
        expect.objectContaining({ pendingForUs: 2 }),
      );
    });

    it('should handle DLQ write failure during orphan recovery without losing ACK', async () => {
      const groupConfig = createGroupConfig({ consumerName: 'coordinator-new' });

      streamsClient.xpending.mockResolvedValue({
        total: 1,
        consumers: [{ name: 'coordinator-old', pending: 1 }],
      });

      streamsClient.xpendingRange.mockResolvedValue([
        { id: '400-0', consumer: 'coordinator-old', idleMs: 120000, deliveryCount: 1 },
      ]);

      streamsClient.xclaim.mockResolvedValue([
        { id: '400-0', data: { id: 'opp-orphan' } },
      ]);

      // DLQ write fails
      streamsClient.xaddWithLimit.mockRejectedValue(new Error('DLQ write failed'));

      await manager.recoverPendingMessages([groupConfig]);

      // Should still attempt to claim (xclaim succeeded)
      expect(streamsClient.xclaim).toHaveBeenCalled();

      // Error should be logged
      expect(logger.error).toHaveBeenCalled();
    });

    it('should handle recovery across multiple streams independently', async () => {
      const configs = [
        createGroupConfig({ streamName: 'stream:health', groupName: 'cg-health' }),
        createGroupConfig({ streamName: 'stream:opportunities', groupName: 'cg-opps' }),
        createGroupConfig({ streamName: 'stream:whale-alerts', groupName: 'cg-whale' }),
      ];

      // First stream: has pending, second: empty, third: error
      streamsClient.xpending
        .mockResolvedValueOnce({ total: 0, consumers: [] })
        .mockResolvedValueOnce({ total: 0, consumers: [] })
        .mockResolvedValueOnce({ total: 0, consumers: [] });

      await manager.recoverPendingMessages(configs);

      // All three streams should be checked
      expect(streamsClient.xpending).toHaveBeenCalledTimes(3);
    });
  });
});

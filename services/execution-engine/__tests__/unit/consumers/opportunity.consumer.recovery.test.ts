/**
 * Tests for OpportunityConsumer.recoverOrphanedMessages()
 *
 * Verifies the XCLAIM-based crash recovery path that reclaims messages
 * from the PEL (Pending Entry List) when a previous consumer instance
 * has crashed or shut down with in-flight executions.
 *
 * Strategy: Spies on handleStreamMessage to isolate recovery logic
 * from message processing (which is tested separately in
 * opportunity.consumer.test.ts and opportunity.consumer.bugfixes.test.ts).
 *
 * @see opportunity.consumer.ts recoverOrphanedMessages()
 * @see Phase 2 H3: XCLAIM recovery has zero test coverage
 */

import { OpportunityConsumer } from '../../../src/consumers/opportunity.consumer';
import type { Logger, ExecutionStats, QueueService } from '../../../src/types';
import {
  createMockLogger,
  createMockStats,
  createMockQueueService,
} from './consumer-test-helpers';

// =============================================================================
// Extended mock for streams client with xpendingRange + xclaim
// =============================================================================

function createMockStreamsClientWithRecovery() {
  return {
    createConsumerGroup: jest.fn().mockResolvedValue(undefined),
    xack: jest.fn().mockResolvedValue(1),
    xadd: jest.fn().mockResolvedValue('stream-id'),
    xpendingRange: jest.fn().mockResolvedValue([]),
    xclaim: jest.fn().mockResolvedValue([]),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityConsumer - recoverOrphanedMessages', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClientWithRecovery>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;
  let handleStreamMessageSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClientWithRecovery();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });

    // Spy on handleStreamMessage to isolate recovery logic from message processing.
    // Message processing is tested separately in opportunity.consumer.test.ts.
    handleStreamMessageSpy = jest
      .spyOn(consumer as any, 'handleStreamMessage')
      .mockResolvedValue(undefined);
  });

  it('should return 0 when no pending entries exist', async () => {
    mockStreamsClient.xpendingRange.mockResolvedValue([]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(0);
    expect(mockStreamsClient.xpendingRange).toHaveBeenCalledTimes(1);
    expect(mockStreamsClient.xclaim).not.toHaveBeenCalled();
    expect(handleStreamMessageSpy).not.toHaveBeenCalled();
  });

  it('should skip entries owned by the current consumer', async () => {
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'test-instance-1', idleMs: 120000, deliveryCount: 1 },
    ]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(0);
    expect(mockStreamsClient.xclaim).not.toHaveBeenCalled();
  });

  it('should skip entries with idle time below threshold', async () => {
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'other-instance', idleMs: 1000, deliveryCount: 1 },
    ]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(0);
    expect(mockStreamsClient.xclaim).not.toHaveBeenCalled();
  });

  it('should claim and reprocess orphaned messages from other consumers', async () => {
    // idleMs must exceed DEFAULT_CONSUMER_CONFIG.pendingMessageMaxAgeMs (600000ms = 10 min)
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'crashed-instance', idleMs: 700000, deliveryCount: 2 },
    ]);
    mockStreamsClient.xclaim.mockResolvedValue([
      { id: 'msg-1', data: { id: 'orphan-opp-1' } },
    ]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(1);
    expect(mockStreamsClient.xclaim).toHaveBeenCalledWith(
      expect.any(String), // stream name
      expect.any(String), // group name
      'test-instance-1',  // current consumer name
      expect.any(Number), // idle threshold
      ['msg-1'],          // orphaned IDs
    );
    expect(handleStreamMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-1' }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Recovering orphaned PEL messages via XCLAIM',
      expect.objectContaining({ count: 1 }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'XCLAIM recovery complete',
      expect.objectContaining({ claimed: 1, reprocessed: 1 }),
    );
  });

  it('should use custom minIdleMs when provided', async () => {
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'other-instance', idleMs: 5000, deliveryCount: 1 },
    ]);
    mockStreamsClient.xclaim.mockResolvedValue([]);

    await consumer.recoverOrphanedMessages(3000);

    // Should pass 3000 as threshold to xclaim
    expect(mockStreamsClient.xclaim).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'test-instance-1',
      3000,
      ['msg-1'],
    );
  });

  it('should handle multiple orphaned entries in one batch', async () => {
    // idleMs must exceed DEFAULT_CONSUMER_CONFIG.pendingMessageMaxAgeMs (600000ms)
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'crashed-instance-a', idleMs: 700000, deliveryCount: 1 },
      { id: 'msg-2', consumer: 'crashed-instance-b', idleMs: 800000, deliveryCount: 3 },
      { id: 'msg-3', consumer: 'test-instance-1', idleMs: 700000, deliveryCount: 1 }, // self — skip
    ]);

    mockStreamsClient.xclaim.mockResolvedValue([
      { id: 'msg-1', data: { id: 'opp-1' } },
      { id: 'msg-2', data: { id: 'opp-2' } },
    ]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(2);
    expect(handleStreamMessageSpy).toHaveBeenCalledTimes(2);
    expect(mockStreamsClient.xclaim).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'test-instance-1',
      expect.any(Number),
      ['msg-1', 'msg-2'], // Only the non-self entries
    );
  });

  it('should ACK messages that fail reprocessing to prevent infinite loops', async () => {
    // idleMs must exceed DEFAULT_CONSUMER_CONFIG.pendingMessageMaxAgeMs (600000ms)
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-bad', consumer: 'crashed-instance', idleMs: 700000, deliveryCount: 5 },
    ]);
    mockStreamsClient.xclaim.mockResolvedValue([
      { id: 'msg-bad', data: { garbage: 'data' } },
    ]);

    // handleStreamMessage throws → catch block ACKs the message
    handleStreamMessageSpy.mockRejectedValue(new Error('Validation failed'));

    const recovered = await consumer.recoverOrphanedMessages();

    // Should have attempted reprocessing but failed, then ACK'd to prevent infinite retry
    expect(recovered).toBe(0);
    expect(mockStreamsClient.xack).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'msg-bad',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to reprocess recovered message',
      expect.objectContaining({ messageId: 'msg-bad' }),
    );
  });

  it('should return 0 and log warning when xpendingRange fails', async () => {
    mockStreamsClient.xpendingRange.mockRejectedValue(new Error('Redis connection lost'));

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'XCLAIM recovery failed (non-fatal)',
      expect.objectContaining({ error: 'Redis connection lost' }),
    );
  });

  it('should return 0 when xclaim returns empty array', async () => {
    mockStreamsClient.xpendingRange.mockResolvedValue([
      { id: 'msg-1', consumer: 'crashed-instance', idleMs: 120000, deliveryCount: 1 },
    ]);
    mockStreamsClient.xclaim.mockResolvedValue([]);

    const recovered = await consumer.recoverOrphanedMessages();

    expect(recovered).toBe(0);
  });
});

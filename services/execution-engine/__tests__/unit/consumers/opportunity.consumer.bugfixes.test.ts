/**
 * Opportunity Consumer Tests - Bug Fixes & Edge Cases
 *
 * Split from opportunity.consumer.test.ts for maintainability.
 * Tests:
 * - Duplicate pending message handling (Race #2 Fix)
 * - Configurable consumer settings
 * - DLQ data optimization
 * - Atomic duplicate detection (BUG FIX 4.1)
 * - Duplicate pending ACK (BUG FIX 4.2)
 * - isActive method
 * - Backpressure callback (RACE FIX 5.2)
 * - Business rule validation (BUG FIX 4.3)
 * - Pending message cleanup
 * - Exception path stats tracking
 * - Configurable ConsumerConfig
 * - String timestamp validation
 * - Pipeline timestamps (Phase 0 Regression)
 *
 * @see opportunity.consumer.test.ts for core initialization, validation,
 *      message handling, backpressure, and deferred ACK tests
 */

import { OpportunityConsumer, OpportunityConsumerConfig } from '../../../src/consumers/opportunity.consumer';
import type { Logger, ExecutionStats, QueueService } from '../../../src/types';
import { ValidationErrorCode, DLQ_STREAM } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { validateMessageStructure, ValidationFailure, VALID_OPPORTUNITY_TYPES } from '../../../src/consumers/validation';
import {
  createMockLogger,
  createMockStats,
  createMockQueueService,
  createMockStreamsClient,
  createMockOpportunity,
} from './consumer-test-helpers';


// =============================================================================
// Test Suite: Duplicate Pending Message Warning (Race #2 Fix)
// =============================================================================

describe('OpportunityConsumer - Duplicate Pending Warning', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should warn when duplicate opportunity ID arrives before ACK', async () => {
    const opp1 = createMockOpportunity({ id: 'dup-id' });

    // First message
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opp1 });
    expect(consumer.getPendingCount()).toBe(1);

    // Complete the first execution so we can queue another with same ID
    consumer.markComplete('dup-id');

    // Second message with same opportunity ID but different message ID
    const opp2 = createMockOpportunity({ id: 'dup-id' });
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opp2 });

    // Should warn about duplicate and ACK previous (BUG FIX 4.2)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Duplicate opportunity ID in pending messages - ACKing previous',
      expect.objectContaining({
        id: 'dup-id',
        existingMessageId: 'msg-1',
        newMessageId: 'msg-2',
      })
    );
  });
});

// =============================================================================
// Test Suite: Configurable Consumer Config
// =============================================================================

describe('OpportunityConsumer - Configurable Settings', () => {
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();
  });

  it('should use default config when no overrides provided', () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });

    consumer.start();

    // Default batchSize is 10, blockMs is 200
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Stream consumer started with blocking reads',
      expect.objectContaining({
        batchSize: 10,
        blockMs: 200,
      })
    );
  });

  it('should use custom config when overrides provided', () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
      consumerConfig: {
        batchSize: 50,
        blockMs: 2000,
      },
    });

    consumer.start();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Stream consumer started with blocking reads',
      expect.objectContaining({
        batchSize: 50,
        blockMs: 2000,
      })
    );
  });
});

// =============================================================================
// Test Suite: DLQ Data Optimization (Performance Fix)
// =============================================================================

describe('OpportunityConsumer - DLQ Data Optimization', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should store essential fields in DLQ, not full payload', async () => {
    const badOpp = {
      id: 'test-id',
      type: 'invalid-type', // This will trigger DLQ
      tokenIn: '0x123',
      tokenOut: '0x456',
      amountIn: '1000',
      // ... more fields that shouldn't be stored
      largeField: 'x'.repeat(10000),
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    // Verify DLQ was called
    expect(mockStreamsClient.xadd).toHaveBeenCalledWith(
      DLQ_STREAM,
      expect.objectContaining({
        opportunityId: 'test-id',
        opportunityType: 'invalid-type',
        service: 'execution-engine',
        instanceId: 'test-instance-1',
      })
    );

    // Verify full payload is NOT stored
    const dlqCall = mockStreamsClient.xadd.mock.calls[0];
    expect(dlqCall[1]).not.toHaveProperty('data');
    expect(dlqCall[1]).not.toHaveProperty('largeField');
  });
});

// =============================================================================
// Test Suite: BUG FIX 4.2 - Duplicate Pending Message ACK (GAP 8.1)
// =============================================================================

describe('OpportunityConsumer - Duplicate Pending ACK (BUG FIX 4.2)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should ACK the previous message when duplicate ID arrives (BUG FIX 4.2)', async () => {
    // First, we need to mark opp1 complete so it's not in activeExecutions
    // Then send two messages with the same opportunity ID
    const opp1 = createMockOpportunity({ id: 'dup-id' });

    // First message - queued successfully
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opp1 });
    expect(consumer.getPendingCount()).toBe(1);

    // Complete the first execution (removes from activeExecutions)
    consumer.markComplete('dup-id');

    // Second message with same opportunity ID - should ACK msg-1
    const opp2 = createMockOpportunity({ id: 'dup-id' });
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opp2 });

    // Should have ACKed the old message (msg-1) to prevent PEL leak
    expect(mockStreamsClient.xack).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'msg-1'
    );

    // Should warn about the duplicate
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Duplicate opportunity ID in pending messages - ACKing previous',
      expect.objectContaining({
        id: 'dup-id',
        existingMessageId: 'msg-1',
        newMessageId: 'msg-2',
      })
    );
  });

  it('should handle ACK failure for orphaned message gracefully', async () => {
    const opp1 = createMockOpportunity({ id: 'dup-id' });

    // First message
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opp1 });
    consumer.markComplete('dup-id');

    // Make ACK fail for the orphaned message
    mockStreamsClient.xack.mockRejectedValueOnce(new Error('Redis error'));

    // Second message
    const opp2 = createMockOpportunity({ id: 'dup-id' });
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opp2 });

    // Allow multiple event loop ticks to ensure promise rejection is processed
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should have warned about ACK failure (not error - it's cleanup)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to ACK orphaned duplicate message',
      expect.objectContaining({
        messageId: 'msg-1',
      })
    );

    // Processing should continue - pending count should be 1 (new message)
    expect(consumer.getPendingCount()).toBe(1);
  });
});

// =============================================================================
// Test Suite: BUG FIX 4.1 - Atomic Duplicate Detection (GAP 8.2)
// =============================================================================

describe('OpportunityConsumer - Atomic Duplicate Detection (BUG FIX 4.1)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should mark opportunity active immediately after enqueue (BUG FIX 4.1)', async () => {
    const opportunity = createMockOpportunity({ id: 'test-opp' });

    // Before handling - not active
    expect(consumer.isActive('test-opp')).toBe(false);

    // Handle the message
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opportunity });

    // Should be active immediately (not waiting for engine.markActive)
    expect(consumer.isActive('test-opp')).toBe(true);
  });

  it('should reject duplicate ID even before engine processes (BUG FIX 4.1)', async () => {
    const opp1 = createMockOpportunity({ id: 'same-id' });
    const opp2 = createMockOpportunity({ id: 'same-id' });

    // First message - queued
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opp1 });
    expect(consumer.getPendingCount()).toBe(1);
    expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);

    // Second message with same ID - should be rejected before engine sees it
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opp2 });

    // Should NOT have enqueued the second one
    expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    expect(mockStats.opportunitiesRejected).toBe(1);

    // Should have logged rejection
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: already queued or executing',
      expect.objectContaining({ id: 'same-id' })
    );
  });

  it('should rollback activeExecutions if enqueue fails (BUG FIX 4.1)', async () => {
    // Make enqueue fail
    mockQueueService.enqueue = jest.fn().mockReturnValue(false);

    const opportunity = createMockOpportunity({ id: 'test-opp' });

    // Handle the message - enqueue will fail
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opportunity });

    // Should NOT be active after failed enqueue (rollback)
    expect(consumer.isActive('test-opp')).toBe(false);
  });

  it('should rollback activeExecutions on exception (BUG FIX 4.1)', async () => {
    // Make enqueue throw
    mockQueueService.enqueue = jest.fn().mockImplementation(() => {
      throw new Error('Queue error');
    });

    const opportunity = createMockOpportunity({ id: 'test-opp' });

    // Handle the message - enqueue will throw
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opportunity });

    // Should NOT be active after exception (rollback)
    expect(consumer.isActive('test-opp')).toBe(false);
  });

  it('should allow re-processing after markComplete', async () => {
    const opportunity = createMockOpportunity({ id: 'reprocess-id' });

    // First processing
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opportunity });
    expect(consumer.isActive('reprocess-id')).toBe(true);

    // Simulate engine completing execution
    consumer.markComplete('reprocess-id');
    expect(consumer.isActive('reprocess-id')).toBe(false);

    // Clear the mock to track new calls
    (mockQueueService.enqueue as jest.Mock).mockClear();

    // Same ID can now be processed again
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opportunity });
    expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    expect(consumer.isActive('reprocess-id')).toBe(true);
  });
});

// =============================================================================
// Test Suite: isActive Method
// =============================================================================

describe('OpportunityConsumer - isActive Method', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should return false for unknown IDs', () => {
    expect(consumer.isActive('unknown-id')).toBe(false);
  });

  it('should return true for active IDs', () => {
    consumer.markActive('active-id');
    expect(consumer.isActive('active-id')).toBe(true);
  });

  it('should return false after markComplete', () => {
    consumer.markActive('completed-id');
    expect(consumer.isActive('completed-id')).toBe(true);

    consumer.markComplete('completed-id');
    expect(consumer.isActive('completed-id')).toBe(false);
  });
});

// =============================================================================
// Test Suite: Backpressure Callback Race Condition (RACE FIX 5.2)
// =============================================================================

describe('OpportunityConsumer - Backpressure Callback (RACE FIX 5.2)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;
  let pauseCallback: ((isPaused: boolean) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockStats = createMockStats();

    // Capture the pause callback when registered in start()
    mockQueueService = createMockQueueService({
      onPauseStateChange: jest.fn((cb) => {
        pauseCallback = cb;
      }),
    });

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should log debug when backpressure signal received after stop() (RACE FIX 5.2)', async () => {
    // Start the consumer - this registers the callback
    consumer.start();
    expect(pauseCallback).not.toBeNull();

    // Stop the consumer - this sets streamConsumer to null
    await consumer.stop();

    // Clear previous logs
    (mockLogger.debug as jest.Mock).mockClear();

    // Trigger backpressure callback after stop
    pauseCallback!(true);

    // Should log debug (not error) because streamConsumer is null
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Backpressure signal ignored - stream consumer not ready',
      expect.objectContaining({ isPaused: true })
    );
  });

  it('should handle backpressure after start()', () => {
    // Start the consumer
    consumer.start();

    // Trigger backpressure callback
    pauseCallback!(true);

    // Should NOT log the "not ready" message (streamConsumer is active)
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'Backpressure signal ignored - stream consumer not ready',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Business Rule Validation Type (BUG FIX 4.3)
// =============================================================================

describe('OpportunityConsumer - Business Rule Validation (BUG FIX 4.3)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should not redundantly return opportunity in business rule validation', () => {
    // This test verifies the fix by checking the log output
    // The old code returned { valid: true, opportunity } which was redundant
    const validOpp = createMockOpportunity({
      confidence: 0.95,
      expectedProfit: 100,
    });

    const result = (consumer as any).handleArbitrageOpportunity(validOpp);

    // Should succeed
    expect(result).toBe('queued');

    // Log should use the original opportunity (not a copy from validation)
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Added opportunity to execution queue',
      expect.objectContaining({
        id: validOpp.id,
        type: validOpp.type,
      })
    );
  });

  it('should log rejection with business rule code', () => {
    const lowConfidenceOpp = createMockOpportunity({ confidence: 0.1 });

    (consumer as any).handleArbitrageOpportunity(lowConfidenceOpp);

    // Should log with code from BusinessRuleResult (not ValidationResult)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected by business rules',
      expect.objectContaining({
        code: ValidationErrorCode.LOW_CONFIDENCE,
      })
    );
  });
});

// =============================================================================
// BUG FIX 4.1: Pending Message Cleanup Tests
// =============================================================================

describe('Pending Message Cleanup (BUG FIX 4.1)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
    });
  });

  afterEach(async () => {
    await consumer.stop();
  });

  it('should not clean up recent pending messages', async () => {
    // Add a recent pending message (just queued)
    const pendingMessages = (consumer as any).pendingMessages as Map<string, any>;
    pendingMessages.set('opp-1', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '123-0',
      queuedAt: Date.now(), // Just now
    });

    const cleanedCount = await consumer.cleanupStalePendingMessages();

    expect(cleanedCount).toBe(0);
    expect(pendingMessages.size).toBe(1);
    expect(mockStreamsClient.xack).not.toHaveBeenCalled();
  });

  it('should clean up stale pending messages older than max age', async () => {
    const pendingMessages = (consumer as any).pendingMessages as Map<string, any>;
    const activeExecutions = (consumer as any).activeExecutions as Set<string>;

    // Add a stale pending message (11 minutes old, max is 10)
    const staleTimestamp = Date.now() - 11 * 60 * 1000;
    pendingMessages.set('opp-stale', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '100-0',
      queuedAt: staleTimestamp,
    });
    activeExecutions.add('opp-stale');

    // Add a recent message that should not be cleaned
    pendingMessages.set('opp-recent', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '200-0',
      queuedAt: Date.now(),
    });
    activeExecutions.add('opp-recent');

    const cleanedCount = await consumer.cleanupStalePendingMessages();

    expect(cleanedCount).toBe(1);
    expect(pendingMessages.has('opp-stale')).toBe(false);
    expect(pendingMessages.has('opp-recent')).toBe(true);
    expect(activeExecutions.has('opp-stale')).toBe(false);
    expect(activeExecutions.has('opp-recent')).toBe(true);
    expect(mockStreamsClient.xack).toHaveBeenCalledWith(
      'stream:execution-requests',
      'execution-engine-group',
      '100-0'
    );
    expect(mockStreamsClient.xack).toHaveBeenCalledTimes(1);
  });

  it('should handle ACK failures gracefully during cleanup', async () => {
    const pendingMessages = (consumer as any).pendingMessages as Map<string, any>;

    // Add a stale message
    pendingMessages.set('opp-stale', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '100-0',
      queuedAt: Date.now() - 11 * 60 * 1000,
    });

    // Make xack fail
    mockStreamsClient.xack = jest.fn().mockRejectedValue(new Error('Redis unavailable'));

    const cleanedCount = await consumer.cleanupStalePendingMessages();

    // Should return 0 since ACK failed
    expect(cleanedCount).toBe(0);
    // Message should still be in map (will be retried later)
    expect(pendingMessages.has('opp-stale')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to ACK stale pending message',
      expect.objectContaining({ id: 'opp-stale' })
    );
  });

  it('should return stale pending info for monitoring', () => {
    const pendingMessages = (consumer as any).pendingMessages as Map<string, any>;

    // Add a stale message
    const staleAge = 11 * 60 * 1000;
    pendingMessages.set('opp-stale', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '100-0',
      queuedAt: Date.now() - staleAge,
    });

    // Add a recent message
    pendingMessages.set('opp-recent', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '200-0',
      queuedAt: Date.now(),
    });

    const staleInfo = consumer.getStalePendingInfo();

    expect(staleInfo.length).toBe(1);
    expect(staleInfo[0].id).toBe('opp-stale');
    expect(staleInfo[0].ageMs).toBeGreaterThanOrEqual(staleAge);
  });
});

// =============================================================================
// BUG FIX 4.2: Exception Path Stats Tracking
// =============================================================================

describe('Exception Path Stats Tracking (BUG FIX 4.2)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
    });
  });

  afterEach(async () => {
    await consumer.stop();
  });

  it('should increment opportunitiesRejected when handleArbitrageOpportunity throws', () => {
    const validOpp = createMockOpportunity();

    // Make queueService.enqueue throw
    mockQueueService.enqueue = jest.fn().mockImplementation(() => {
      throw new Error('Queue service failure');
    });

    const result = (consumer as any).handleArbitrageOpportunity(validOpp);

    expect(result).toBe('rejected');
    expect(mockStats.opportunitiesRejected).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to handle arbitrage opportunity',
      expect.objectContaining({ id: validOpp.id })
    );
  });
});

// =============================================================================
// Configurable ConsumerConfig Tests
// =============================================================================

describe('Configurable ConsumerConfig', () => {
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();
  });

  it('should use default pendingMessageMaxAgeMs when not configured', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
    });

    // Default is 10 minutes (600000ms)
    expect(consumer.getPendingMessageMaxAgeMs()).toBe(10 * 60 * 1000);
    await consumer.stop();
  });

  it('should use custom pendingMessageMaxAgeMs when configured', async () => {
    const customMaxAgeMs = 5 * 60 * 1000; // 5 minutes

    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
      consumerConfig: {
        pendingMessageMaxAgeMs: customMaxAgeMs,
      },
    });

    expect(consumer.getPendingMessageMaxAgeMs()).toBe(customMaxAgeMs);
    await consumer.stop();
  });

  it('should clean up based on custom pendingMessageMaxAgeMs', async () => {
    const customMaxAgeMs = 2 * 60 * 1000; // 2 minutes

    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
      consumerConfig: {
        pendingMessageMaxAgeMs: customMaxAgeMs,
      },
    });

    const pendingMessages = (consumer as any).pendingMessages as Map<string, any>;

    // Add a message that is 3 minutes old (should be stale with 2min max)
    pendingMessages.set('opp-stale', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '100-0',
      queuedAt: Date.now() - 3 * 60 * 1000,
    });

    // Add a message that is 1 minute old (should NOT be stale with 2min max)
    pendingMessages.set('opp-recent', {
      streamName: 'stream:execution-requests',
      groupName: 'execution-engine-group',
      messageId: '200-0',
      queuedAt: Date.now() - 1 * 60 * 1000,
    });

    const cleanedCount = await consumer.cleanupStalePendingMessages();

    expect(cleanedCount).toBe(1);
    expect(pendingMessages.has('opp-stale')).toBe(false);
    expect(pendingMessages.has('opp-recent')).toBe(true);

    await consumer.stop();
  });
});

// =============================================================================
// String Timestamp Validation Tests
// =============================================================================

describe('String Timestamp Validation (expiresAt)', () => {
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;
  let consumer: OpportunityConsumer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance',
    });
  });

  afterEach(async () => {
    await consumer.stop();
  });

  it('should accept valid numeric string expiresAt', () => {
    const futureTimestamp = Date.now() + 60000; // 1 minute in future

    const result = validateMessageStructure({
      id: 'msg-1',
      data: {
        id: 'opp-1',
        type: 'simple',
        tokenIn: '0xtoken1',
        tokenOut: '0xtoken2',
        amountIn: '1000000000000000000',
        expiresAt: String(futureTimestamp), // String timestamp
      },
    });

    expect(result.valid).toBe(true);
  });

  it('should reject invalid string expiresAt format', () => {
    const result = validateMessageStructure({
      id: 'msg-1',
      data: {
        id: 'opp-1',
        type: 'simple',
        tokenIn: '0xtoken1',
        tokenOut: '0xtoken2',
        amountIn: '1000000000000000000',
        expiresAt: 'invalid-timestamp', // Invalid format
      },
    });

    expect(result.valid).toBe(false);
    expect((result as ValidationFailure).code).toBe(ValidationErrorCode.INVALID_EXPIRES_AT);
  });

  it('should reject expired string timestamp', () => {
    const pastTimestamp = Date.now() - 60000; // 1 minute in past

    const result = validateMessageStructure({
      id: 'msg-1',
      data: {
        id: 'opp-1',
        type: 'simple',
        tokenIn: '0xtoken1',
        tokenOut: '0xtoken2',
        amountIn: '1000000000000000000',
        expiresAt: String(pastTimestamp), // Expired string timestamp
      },
    });

    expect(result.valid).toBe(false);
    expect((result as ValidationFailure).code).toBe(ValidationErrorCode.EXPIRED);
  });

  it('should reject non-numeric non-number expiresAt types', () => {
    const result = validateMessageStructure({
      id: 'msg-1',
      data: {
        id: 'opp-1',
        type: 'simple',
        tokenIn: '0xtoken1',
        tokenOut: '0xtoken2',
        amountIn: '1000000000000000000',
        expiresAt: { timestamp: Date.now() }, // Object instead of number/string
      },
    });

    expect(result.valid).toBe(false);
    expect((result as ValidationFailure).code).toBe(ValidationErrorCode.INVALID_EXPIRES_AT);
  });

  it('should accept valid number expiresAt (existing behavior)', () => {
    const futureTimestamp = Date.now() + 60000;

    const result = validateMessageStructure({
      id: 'msg-1',
      data: {
        id: 'opp-1',
        type: 'simple',
        tokenIn: '0xtoken1',
        tokenOut: '0xtoken2',
        amountIn: '1000000000000000000',
        expiresAt: futureTimestamp, // Number timestamp
      },
    });

    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// Phase 0 Regression: Pipeline Timestamps Deserialization
// =============================================================================

describe('OpportunityConsumer - Pipeline Timestamps (Phase 0 Regression)', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should deserialize JSON string pipelineTimestamps from Redis flat map', async () => {
    const timestamps = {
      wsReceivedAt: 1700000000000,
      publishedAt: 1700000000001,
      consumedAt: 1700000000002,
      coordinatorAt: 1700000000003,
    };

    const opportunity = {
      ...createMockOpportunity(),
      pipelineTimestamps: JSON.stringify(timestamps), // Arrives as string from Redis flat map
    };
    const message = { id: 'msg-ts-1', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    // Should have been queued
    expect(consumer.getPendingCount()).toBe(1);

    // Verify the enqueued opportunity has deserialized timestamps
    const enqueuedOpp = (mockQueueService.enqueue as jest.Mock).mock.calls[0][0] as ArbitrageOpportunity;
    expect(typeof enqueuedOpp.pipelineTimestamps).toBe('object');
    expect(enqueuedOpp.pipelineTimestamps).not.toBeNull();
    expect(enqueuedOpp.pipelineTimestamps!.wsReceivedAt).toBe(1700000000000);
    expect(enqueuedOpp.pipelineTimestamps!.coordinatorAt).toBe(1700000000003);
    // executionReceivedAt should be stamped
    expect(enqueuedOpp.pipelineTimestamps!.executionReceivedAt).toBeGreaterThan(0);
  });

  it('should stamp executionReceivedAt even without existing timestamps', async () => {
    const opportunity = createMockOpportunity();
    // No pipelineTimestamps at all
    const message = { id: 'msg-ts-2', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);

    const enqueuedOpp = (mockQueueService.enqueue as jest.Mock).mock.calls[0][0] as ArbitrageOpportunity;
    expect(enqueuedOpp.pipelineTimestamps).not.toBeUndefined();
    expect(enqueuedOpp.pipelineTimestamps!.executionReceivedAt).toBeGreaterThan(0);
  });

  it('should handle invalid JSON string pipelineTimestamps gracefully', async () => {
    const opportunity = {
      ...createMockOpportunity(),
      pipelineTimestamps: 'not-valid-json{{{',
    };
    const message = { id: 'msg-ts-3', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    // Should still be queued (invalid JSON doesn't reject the opportunity)
    expect(consumer.getPendingCount()).toBe(1);

    const enqueuedOpp = (mockQueueService.enqueue as jest.Mock).mock.calls[0][0] as ArbitrageOpportunity;
    // Should have executionReceivedAt even though original was invalid
    expect(enqueuedOpp.pipelineTimestamps).not.toBeUndefined();
    expect(enqueuedOpp.pipelineTimestamps!.executionReceivedAt).toBeGreaterThan(0);
    // Original invalid timestamps should have been cleared
    expect(enqueuedOpp.pipelineTimestamps!.wsReceivedAt).toBeUndefined();
  });

  it('should preserve object pipelineTimestamps when not a string', async () => {
    const timestamps = {
      wsReceivedAt: 1700000000000,
      publishedAt: 1700000000001,
    };

    const opportunity = {
      ...createMockOpportunity(),
      pipelineTimestamps: timestamps,
    };
    const message = { id: 'msg-ts-4', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);

    const enqueuedOpp = (mockQueueService.enqueue as jest.Mock).mock.calls[0][0] as ArbitrageOpportunity;
    expect(enqueuedOpp.pipelineTimestamps!.wsReceivedAt).toBe(1700000000000);
    expect(enqueuedOpp.pipelineTimestamps!.publishedAt).toBe(1700000000001);
    expect(enqueuedOpp.pipelineTimestamps!.executionReceivedAt).toBeGreaterThan(0);
  });
});

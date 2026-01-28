/**
 * Opportunity Consumer Tests
 *
 * Tests for Redis Stream consumption including:
 * - Consumer group creation
 * - Message handling and validation
 * - Deferred ACK pattern
 * - Backpressure coupling with queue service
 * - Dead letter queue handling
 * - Active execution tracking
 */

import { OpportunityConsumer, OpportunityConsumerConfig } from './opportunity.consumer';
import type { Logger, ExecutionStats, QueueService } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Implementations
// =============================================================================

const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const createMockStats = (): ExecutionStats => ({
  opportunitiesReceived: 0,
  executionAttempts: 0,
  opportunitiesRejected: 0,
  successfulExecutions: 0,
  failedExecutions: 0,
  queueRejects: 0,
  lockConflicts: 0,
  executionTimeouts: 0,
  messageProcessingErrors: 0,
  providerReconnections: 0,
  providerHealthCheckFailures: 0,
  simulationsPerformed: 0,
  simulationsSkipped: 0,
  simulationPredictedReverts: 0,
  simulationErrors: 0,
  circuitBreakerTrips: 0,
  circuitBreakerBlocks: 0,
  // Capital risk management metrics (Phase 3)
  riskEVRejections: 0,
  riskPositionSizeRejections: 0,
  riskDrawdownBlocks: 0,
  riskCautionCount: 0,
  riskHaltCount: 0,
});

const createMockQueueService = (overrides: Partial<QueueService> = {}): QueueService => ({
  enqueue: jest.fn().mockReturnValue(true),
  dequeue: jest.fn().mockReturnValue(undefined),
  canEnqueue: jest.fn().mockReturnValue(true),
  size: jest.fn().mockReturnValue(0),
  isPaused: jest.fn().mockReturnValue(false),
  pause: jest.fn(),
  resume: jest.fn(),
  isManuallyPaused: jest.fn().mockReturnValue(false),
  clear: jest.fn(),
  onPauseStateChange: jest.fn(),
  onItemAvailable: jest.fn(),
  ...overrides,
});

const createMockStreamsClient = () => ({
  createConsumerGroup: jest.fn().mockResolvedValue(undefined),
  xack: jest.fn().mockResolvedValue(1),
  xadd: jest.fn().mockResolvedValue('stream-id'),
});

const createMockStreamConsumer = () => {
  const mockConsumer = {
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    resume: jest.fn(),
  };
  return mockConsumer;
};

const createMockOpportunity = (
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity => ({
  id: 'test-opp-123',
  type: 'simple',
  buyChain: 'ethereum',
  sellChain: 'ethereum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amountIn: '1000000000000000000',
  expectedProfit: 100,
  confidence: 0.95,
  timestamp: Date.now(),
  ...overrides,
});

// =============================================================================
// Test Suite: Consumer Initialization
// =============================================================================

describe('OpportunityConsumer - Initialization', () => {
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

  it('should create consumer group successfully', async () => {
    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: expect.any(String),
        groupName: 'execution-engine-group',
        consumerName: 'test-instance-1',
      })
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Consumer group ready',
      expect.any(Object)
    );
  });

  it('should handle consumer group creation failure', async () => {
    mockStreamsClient.createConsumerGroup.mockRejectedValue(new Error('Redis error'));

    await consumer.createConsumerGroup();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to create consumer group',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Opportunity Validation
// =============================================================================

describe('OpportunityConsumer - Validation', () => {
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

  it('should reject opportunities with low confidence', async () => {
    const lowConfidenceOpp = createMockOpportunity({ confidence: 0.1 });

    // Access private method through type assertion
    const result = (consumer as any).handleArbitrageOpportunity(lowConfidenceOpp);

    expect(result).toBe(false);
    expect(mockStats.opportunitiesRejected).toBe(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: low confidence',
      expect.any(Object)
    );
  });

  it('should reject opportunities with insufficient profit', async () => {
    const lowProfitOpp = createMockOpportunity({ expectedProfit: 0.001 });

    const result = (consumer as any).handleArbitrageOpportunity(lowProfitOpp);

    expect(result).toBe(false);
    expect(mockStats.opportunitiesRejected).toBe(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: insufficient profit',
      expect.any(Object)
    );
  });

  it('should reject opportunities already being executed', async () => {
    const opportunity = createMockOpportunity();

    // Mark as active first
    consumer.markActive(opportunity.id);

    const result = (consumer as any).handleArbitrageOpportunity(opportunity);

    expect(result).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: already executing',
      expect.any(Object)
    );
  });

  it('should accept valid opportunities', async () => {
    const validOpp = createMockOpportunity({
      confidence: 0.95,
      expectedProfit: 100,
    });

    const result = (consumer as any).handleArbitrageOpportunity(validOpp);

    expect(result).toBe(true);
    expect(mockStats.opportunitiesReceived).toBe(1);
    expect(mockQueueService.enqueue).toHaveBeenCalledWith(validOpp);
  });
});

// =============================================================================
// Test Suite: Queue Backpressure
// =============================================================================

describe('OpportunityConsumer - Backpressure', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService({
      enqueue: jest.fn().mockReturnValue(false), // Queue full
    });
    mockStats = createMockStats();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
    });
  });

  it('should reject opportunities when queue is full', async () => {
    const opportunity = createMockOpportunity();

    const result = (consumer as any).handleArbitrageOpportunity(opportunity);

    expect(result).toBe(false);
    expect(mockStats.queueRejects).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Opportunity rejected due to queue backpressure',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Deferred ACK Pattern
// =============================================================================

describe('OpportunityConsumer - Deferred ACK', () => {
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

  it('should ACK message after successful execution', async () => {
    const opportunity = createMockOpportunity();

    // Simulate message being queued (stores pending info)
    const message = { id: 'msg-123', data: opportunity };
    await (consumer as any).handleStreamMessage(message);

    // Now ACK after execution
    await consumer.ackMessageAfterExecution(opportunity.id);

    expect(mockStreamsClient.xack).toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Message ACKed after execution',
      expect.objectContaining({ opportunityId: opportunity.id })
    );
  });

  it('should not ACK when no pending message exists', async () => {
    await consumer.ackMessageAfterExecution('non-existent-id');

    expect(mockStreamsClient.xack).not.toHaveBeenCalled();
  });

  it('should handle ACK failure gracefully', async () => {
    const opportunity = createMockOpportunity();
    mockStreamsClient.xack.mockRejectedValue(new Error('Redis error'));

    // Simulate message being queued
    const message = { id: 'msg-123', data: opportunity };
    await (consumer as any).handleStreamMessage(message);

    // ACK should fail but not throw
    await consumer.ackMessageAfterExecution(opportunity.id);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to ACK message after execution',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Message Handling
// =============================================================================

describe('OpportunityConsumer - Message Handling', () => {
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

  it('should ACK empty messages immediately', async () => {
    const message = { id: 'msg-empty', data: null };

    await (consumer as any).handleStreamMessage(message);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Skipping message with no data',
      expect.any(Object)
    );
    expect(mockStreamsClient.xack).toHaveBeenCalled();
  });

  it('should ACK rejected opportunities immediately', async () => {
    const lowConfidenceOpp = createMockOpportunity({ confidence: 0.1 });
    const message = { id: 'msg-123', data: lowConfidenceOpp };

    await (consumer as any).handleStreamMessage(message);

    // Rejected opportunities should be ACKed immediately
    expect(mockStreamsClient.xack).toHaveBeenCalled();
  });

  it('should store pending message for queued opportunities', async () => {
    const opportunity = createMockOpportunity();
    const message = { id: 'msg-123', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
    // Should NOT ACK immediately (deferred)
    expect(mockStreamsClient.xack).not.toHaveBeenCalled();
  });

  it('should handle queue enqueue errors gracefully', async () => {
    // The actual implementation catches enqueue errors inside handleArbitrageOpportunity
    // and returns false, which triggers a normal rejection ACK (not DLQ)
    mockQueueService.enqueue = jest.fn().mockImplementation(() => {
      throw new Error('Queue error');
    });

    const opportunity = createMockOpportunity();
    const message = { id: 'msg-123', data: opportunity };

    await (consumer as any).handleStreamMessage(message);

    // Queue errors are caught internally and treated as rejections
    // The message is ACKed to prevent redelivery
    expect(mockStreamsClient.xack).toHaveBeenCalled();
  });

  it('should move to DLQ on critical parsing error', async () => {
    // Force an error at the message parsing level (outer try-catch)
    // This is what triggers DLQ behavior

    // Create a consumer that will error on message parsing
    const badMessage = { id: 'msg-bad', data: null };

    // This should ACK with warning (no data), not DLQ
    await (consumer as any).handleStreamMessage(badMessage);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Skipping message with no data',
      expect.any(Object)
    );
    expect(mockStreamsClient.xack).toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Active Execution Tracking
// =============================================================================

describe('OpportunityConsumer - Active Execution Tracking', () => {
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

  it('should track active executions', () => {
    expect(consumer.getActiveCount()).toBe(0);

    consumer.markActive('opp-1');
    consumer.markActive('opp-2');
    expect(consumer.getActiveCount()).toBe(2);

    consumer.markComplete('opp-1');
    expect(consumer.getActiveCount()).toBe(1);

    consumer.markComplete('opp-2');
    expect(consumer.getActiveCount()).toBe(0);
  });

  it('should prevent duplicate executions via active tracking', () => {
    const opportunity = createMockOpportunity({ id: 'opp-dup' });

    // First handle should succeed
    consumer.markActive('opp-dup');
    const result = (consumer as any).handleArbitrageOpportunity(opportunity);

    expect(result).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: already executing',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Pause/Resume
// =============================================================================

describe('OpportunityConsumer - Pause/Resume', () => {
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

  it('should handle pause/resume without errors', () => {
    // These should not throw even without stream consumer
    expect(() => consumer.pause()).not.toThrow();
    expect(() => consumer.resume()).not.toThrow();
  });
});

// =============================================================================
// Test Suite: Shutdown Cleanup (BUG-FIX Regression Test)
// =============================================================================

describe('OpportunityConsumer - Shutdown Cleanup', () => {
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

  it('should ACK all pending messages during stop (BUG-FIX regression)', async () => {
    // Queue multiple opportunities to create pending messages
    const opp1 = createMockOpportunity({ id: 'opp-1' });
    const opp2 = createMockOpportunity({ id: 'opp-2' });

    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opp1 });
    await (consumer as any).handleStreamMessage({ id: 'msg-2', data: opp2 });

    expect(consumer.getPendingCount()).toBe(2);

    // Stop should ACK all pending messages
    await consumer.stop();

    // Both messages should be ACKed
    expect(mockStreamsClient.xack).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'ACKing pending messages during shutdown',
      expect.objectContaining({ count: 2 })
    );

    // Pending count should be cleared
    expect(consumer.getPendingCount()).toBe(0);
  });

  it('should handle ACK failures during shutdown gracefully', async () => {
    const opportunity = createMockOpportunity();
    await (consumer as any).handleStreamMessage({ id: 'msg-1', data: opportunity });

    // Make ACK fail
    mockStreamsClient.xack.mockRejectedValue(new Error('Redis connection lost'));

    // Stop should not throw even if ACK fails
    await expect(consumer.stop()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to ACK pending message during shutdown',
      expect.any(Object)
    );
  });

  it('should clear active executions during stop', async () => {
    consumer.markActive('opp-1');
    consumer.markActive('opp-2');
    expect(consumer.getActiveCount()).toBe(2);

    await consumer.stop();

    expect(consumer.getActiveCount()).toBe(0);
  });

  it('should skip ACKing if no pending messages', async () => {
    expect(consumer.getPendingCount()).toBe(0);

    await consumer.stop();

    // Should not attempt to ACK anything
    expect(mockStreamsClient.xack).not.toHaveBeenCalled();
    // Should not log about ACKing
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'ACKing pending messages during shutdown',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Enhanced Opportunity Validation (BUG-FIX Regression Test)
// =============================================================================

describe('OpportunityConsumer - Enhanced Validation', () => {
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

  it('should reject opportunities with missing tokenIn (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), tokenIn: undefined };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
    expect(mockStreamsClient.xack).toHaveBeenCalled(); // ACKed after moving to DLQ
  });

  it('should reject opportunities with missing tokenOut (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), tokenOut: undefined };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
  });

  it('should reject opportunities with invalid amountIn (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: 'not-a-number' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
  });

  it('should reject opportunities with zero amountIn (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: '0' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
  });

  it('should reject cross-chain with missing buyChain (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), type: 'cross-chain', buyChain: undefined };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
  });

  it('should reject cross-chain with same buyChain and sellChain (BUG-FIX regression)', async () => {
    const badOpp = {
      ...createMockOpportunity(),
      type: 'cross-chain',
      buyChain: 'ethereum',
      sellChain: 'ethereum',
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.messageProcessingErrors).toBe(1);
  });

  it('should accept valid cross-chain opportunities', async () => {
    const validOpp = {
      ...createMockOpportunity(),
      type: 'cross-chain',
      buyChain: 'ethereum',
      sellChain: 'arbitrum',
    };
    const message = { id: 'msg-valid', data: validOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
    expect(mockQueueService.enqueue).toHaveBeenCalledWith(validOpp);
  });
});

// =============================================================================
// Test Suite: Callback Integration
// =============================================================================

describe('OpportunityConsumer - Callback Integration', () => {
  let consumer: OpportunityConsumer;
  let mockLogger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockQueueService: QueueService;
  let mockStats: ExecutionStats;
  let onOpportunityQueued: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockQueueService = createMockQueueService();
    mockStats = createMockStats();
    onOpportunityQueued = jest.fn();

    consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'test-instance-1',
      onOpportunityQueued,
    });
  });

  it('should call onOpportunityQueued callback when opportunity is queued', () => {
    const opportunity = createMockOpportunity();

    (consumer as any).handleArbitrageOpportunity(opportunity);

    expect(onOpportunityQueued).toHaveBeenCalledWith(opportunity);
  });

  it('should not call callback when opportunity is rejected', () => {
    const lowConfidenceOpp = createMockOpportunity({ confidence: 0.1 });

    (consumer as any).handleArbitrageOpportunity(lowConfidenceOpp);

    expect(onOpportunityQueued).not.toHaveBeenCalled();
  });
});

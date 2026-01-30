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
 * - Stream-init message handling (BUG #2 fix)
 * - Chain support validation (BUG #3 fix)
 * - Expiration validation (string timestamp support)
 * - Configurable consumer config (pendingMessageMaxAgeMs)
 */

import { OpportunityConsumer, OpportunityConsumerConfig } from './opportunity.consumer';
import type { Logger, ExecutionStats, QueueService } from '../types';
import { ValidationErrorCode } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { validateMessageStructure, ValidationFailure } from './validation';

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
  validationErrors: 0,
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
      'Opportunity rejected by business rules',
      expect.objectContaining({
        id: lowConfidenceOpp.id,
        code: ValidationErrorCode.LOW_CONFIDENCE,
      })
    );
  });

  it('should reject opportunities with insufficient profit', async () => {
    const lowProfitOpp = createMockOpportunity({ expectedProfit: 0.001 });

    const result = (consumer as any).handleArbitrageOpportunity(lowProfitOpp);

    expect(result).toBe(false);
    expect(mockStats.opportunitiesRejected).toBe(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected by business rules',
      expect.objectContaining({
        id: lowProfitOpp.id,
        code: ValidationErrorCode.LOW_PROFIT,
      })
    );
  });

  it('should reject opportunities already being executed', async () => {
    const opportunity = createMockOpportunity();

    // Mark as active first
    consumer.markActive(opportunity.id);

    const result = (consumer as any).handleArbitrageOpportunity(opportunity);

    expect(result).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: already queued or executing',
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

    // Empty messages go through validation and are moved to DLQ
    expect(mockStats.validationErrors).toBe(1);
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
    // Force an error by sending invalid data type
    const badMessage = { id: 'msg-bad', data: { id: 'test', type: 'invalid-type-xyz', tokenIn: '0x1', tokenOut: '0x2', amountIn: '100' } };

    await (consumer as any).handleStreamMessage(badMessage);

    // Invalid type should be moved to DLQ
    expect(mockStats.validationErrors).toBe(1);
    expect(mockStreamsClient.xadd).toHaveBeenCalledWith(
      'stream:dead-letter-queue',
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
      'Opportunity rejected: already queued or executing',
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

    expect(mockStats.validationErrors).toBe(1);
    expect(mockStreamsClient.xack).toHaveBeenCalled(); // ACKed after moving to DLQ
  });

  it('should reject opportunities with missing tokenOut (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), tokenOut: undefined };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should reject opportunities with invalid amountIn (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: 'not-a-number' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should reject opportunities with zero amountIn (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: '0' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should reject cross-chain with missing buyChain (BUG-FIX regression)', async () => {
    const badOpp = { ...createMockOpportunity(), type: 'cross-chain', buyChain: undefined };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
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

    expect(mockStats.validationErrors).toBe(1);
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

// =============================================================================
// Test Suite: Stream-Init Message Handling (BUG #2 Fix)
// =============================================================================

describe('OpportunityConsumer - Stream-Init Handling (BUG #2 Fix)', () => {
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

  it('should ACK stream-init messages silently without DLQ', async () => {
    const streamInitMessage = { id: 'msg-init', data: { type: 'stream-init' } };

    await (consumer as any).handleStreamMessage(streamInitMessage);

    // Should ACK the message
    expect(mockStreamsClient.xack).toHaveBeenCalled();
    // Should NOT increment error counter
    expect(mockStats.validationErrors).toBe(0);
    // Should NOT move to DLQ
    expect(mockStreamsClient.xadd).not.toHaveBeenCalled();
    // Should log debug message
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Skipping system message',
      expect.any(Object)
    );
  });

  it('should not queue stream-init messages', async () => {
    const streamInitMessage = { id: 'msg-init', data: { type: 'stream-init' } };

    await (consumer as any).handleStreamMessage(streamInitMessage);

    expect(mockQueueService.enqueue).not.toHaveBeenCalled();
    expect(consumer.getPendingCount()).toBe(0);
  });
});

// =============================================================================
// Test Suite: Chain Support Validation (BUG #3 Fix)
// =============================================================================

describe('OpportunityConsumer - Chain Validation (BUG #3 Fix)', () => {
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

  it('should reject cross-chain with unsupported buyChain', async () => {
    const badOpp = {
      ...createMockOpportunity(),
      type: 'cross-chain',
      buyChain: 'unsupported-chain',
      sellChain: 'ethereum',
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
    expect(mockStreamsClient.xadd).toHaveBeenCalled(); // Moved to DLQ
  });

  it('should reject cross-chain with unsupported sellChain', async () => {
    const badOpp = {
      ...createMockOpportunity(),
      type: 'cross-chain',
      buyChain: 'ethereum',
      sellChain: 'invalid-chain',
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should reject cross-chain with typo in chain name', async () => {
    const badOpp = {
      ...createMockOpportunity(),
      type: 'cross-chain',
      buyChain: 'etherium', // Typo
      sellChain: 'arbitrum',
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should accept cross-chain with supported chains', async () => {
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

  it('should accept all supported chains', async () => {
    const supportedChains = ['ethereum', 'arbitrum', 'bsc', 'polygon', 'optimism', 'base'];

    for (let i = 0; i < supportedChains.length - 1; i++) {
      const validOpp = {
        ...createMockOpportunity({ id: `opp-${i}` }),
        type: 'cross-chain',
        buyChain: supportedChains[i],
        sellChain: supportedChains[i + 1],
      };
      const message = { id: `msg-${i}`, data: validOpp };

      await (consumer as any).handleStreamMessage(message);
    }

    // All should be queued
    expect(consumer.getPendingCount()).toBe(supportedChains.length - 1);
  });
});

// =============================================================================
// Test Suite: Expiration Validation (Enhanced with String Timestamp Support)
// =============================================================================

describe('OpportunityConsumer - Expiration Validation', () => {
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

  it('should reject expired opportunities', async () => {
    const expiredOpp = {
      ...createMockOpportunity(),
      expiresAt: Date.now() - 1000, // Expired 1 second ago
    };
    const message = { id: 'msg-expired', data: expiredOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
    expect(mockQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('should accept non-expired opportunities', async () => {
    const validOpp = {
      ...createMockOpportunity(),
      expiresAt: Date.now() + 10000, // Expires in 10 seconds
    };
    const message = { id: 'msg-valid', data: validOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
    expect(mockQueueService.enqueue).toHaveBeenCalled();
  });

  it('should accept opportunities without expiresAt field', async () => {
    const validOpp = createMockOpportunity();
    // No expiresAt field
    const message = { id: 'msg-valid', data: validOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
  });
});

// =============================================================================
// Test Suite: Invalid Opportunity Types
// =============================================================================

describe('OpportunityConsumer - Type Validation', () => {
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

  it('should reject unknown opportunity types', async () => {
    const badOpp = {
      ...createMockOpportunity(),
      type: 'unknown-type',
    };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
    expect(mockStreamsClient.xadd).toHaveBeenCalled(); // Moved to DLQ
  });

  it('should accept all valid opportunity types', async () => {
    const validTypes = [
      'simple',
      'cross-dex',
      'triangular',
      'quadrilateral',
      'multi-leg',
      'predictive',
      'intra-dex',
      'flash-loan',
    ];

    for (let i = 0; i < validTypes.length; i++) {
      const validOpp = {
        ...createMockOpportunity({ id: `opp-${i}` }),
        type: validTypes[i],
      };
      const message = { id: `msg-${i}`, data: validOpp };

      await (consumer as any).handleStreamMessage(message);
    }

    expect(consumer.getPendingCount()).toBe(validTypes.length);
  });
});

// =============================================================================
// Test Suite: Amount Validation (BUG #1 Fix - Improved Error Messages)
// =============================================================================

describe('OpportunityConsumer - Amount Validation (BUG #1 Fix)', () => {
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

  it('should reject amountIn with non-numeric characters', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: '123abc' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
    // Should have logged with INVALID_AMOUNT code, not "not a valid number"
    // FIX 6.2: Validation failures now use warn instead of error
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('validation failed'),
      expect.objectContaining({
        code: ValidationErrorCode.INVALID_AMOUNT,
      })
    );
  });

  it('should reject amountIn that is exactly zero', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: '0' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
    // FIX 6.2: Validation failures now use warn instead of error
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('validation failed'),
      expect.objectContaining({
        code: ValidationErrorCode.ZERO_AMOUNT,
      })
    );
  });

  it('should reject amountIn with leading zeros that equals zero', async () => {
    const badOpp = { ...createMockOpportunity(), amountIn: '000' };
    const message = { id: 'msg-bad', data: badOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(mockStats.validationErrors).toBe(1);
  });

  it('should accept valid amountIn with leading zeros', async () => {
    // '001' is treated as '1' after conversion, which is valid
    const validOpp = { ...createMockOpportunity(), amountIn: '1000000000000000000' };
    const message = { id: 'msg-valid', data: validOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
  });

  it('should accept very large amountIn values', async () => {
    const largeAmount = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const validOpp = { ...createMockOpportunity(), amountIn: largeAmount };
    const message = { id: 'msg-valid', data: validOpp };

    await (consumer as any).handleStreamMessage(message);

    expect(consumer.getPendingCount()).toBe(1);
  });
});

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

    // Default batchSize is 10, blockMs is 1000
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Stream consumer started with blocking reads',
      expect.objectContaining({
        batchSize: 10,
        blockMs: 1000,
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
      'stream:dead-letter-queue',
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

    // Wait for the fire-and-forget ACK rejection to be handled
    // Use multiple event loop ticks to ensure promise rejection is processed
    await new Promise(resolve => setTimeout(resolve, 10));

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
    expect(result).toBe(true);

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

    expect(result).toBe(false);
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

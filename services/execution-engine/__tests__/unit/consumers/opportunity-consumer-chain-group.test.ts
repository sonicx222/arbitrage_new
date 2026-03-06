/**
 * OpportunityConsumer — Chain Group Stream Tests (Phase 2)
 *
 * Verifies that OpportunityConsumer uses the correct stream name when
 * streamName is provided in config (per-group EE instances), and falls
 * back to the default EXECUTION_REQUESTS stream when not provided.
 *
 * @see services/execution-engine/src/consumers/opportunity.consumer.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 2
 */

import { OpportunityConsumer } from '../../../src/consumers/opportunity.consumer';
import type { Logger, ExecutionStats, QueueService } from '../../../src/types';
import {
  createMockLogger,
  createMockStats,
  createMockQueueService,
  createMockStreamsClient,
} from './consumer-test-helpers';
import { RedisStreams } from '@arbitrage/types';

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityConsumer — chain-group stream configuration', () => {
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

  it('should use default EXECUTION_REQUESTS stream when streamName not provided', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-default',
    });

    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: RedisStreams.EXECUTION_REQUESTS,
        groupName: 'execution-engine-group',
        consumerName: 'ee-default',
      })
    );
  });

  it('should use the provided streamName for chain-grouped EE instances', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-fast-1',
      streamName: 'stream:exec-requests-fast',
    });

    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: 'stream:exec-requests-fast',
        groupName: 'execution-engine-group',
        consumerName: 'ee-fast-1',
      })
    );
  });

  it('should use the l2 stream for l2-group EE instances', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-l2-1',
      streamName: 'stream:exec-requests-l2',
    });

    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: 'stream:exec-requests-l2',
      })
    );
  });

  it('should use the premium stream for premium-group EE instances', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-premium-1',
      streamName: 'stream:exec-requests-premium',
    });

    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: 'stream:exec-requests-premium',
      })
    );
  });

  it('should use the solana stream for solana-group EE instances', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-solana-1',
      streamName: 'stream:exec-requests-solana',
    });

    await consumer.createConsumerGroup();

    expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        streamName: 'stream:exec-requests-solana',
      })
    );
  });

  it('should log the correct stream name on consumer group creation', async () => {
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any,
      queueService: mockQueueService,
      stats: mockStats,
      instanceId: 'ee-fast-2',
      streamName: 'stream:exec-requests-fast',
    });

    await consumer.createConsumerGroup();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Consumer group ready',
      expect.objectContaining({
        stream: 'stream:exec-requests-fast',
      })
    );
  });
});

describe('OpportunityConsumer — stream name logging', () => {
  it('should log the correct stream on createConsumerGroup when custom streamName is set', async () => {
    const mockLogger = createMockLogger();
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: createMockStreamsClient() as any,
      queueService: createMockQueueService(),
      stats: createMockStats(),
      instanceId: 'ee-fast-3',
      streamName: 'stream:exec-requests-fast',
    });

    await consumer.createConsumerGroup();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Consumer group ready',
      expect.objectContaining({ stream: 'stream:exec-requests-fast' })
    );
  });

  it('should log the default stream when streamName not set', async () => {
    const mockLogger = createMockLogger();
    const consumer = new OpportunityConsumer({
      logger: mockLogger,
      streamsClient: createMockStreamsClient() as any,
      queueService: createMockQueueService(),
      stats: createMockStats(),
      instanceId: 'ee-default-2',
    });

    await consumer.createConsumerGroup();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Consumer group ready',
      expect.objectContaining({ stream: RedisStreams.EXECUTION_REQUESTS })
    );
  });
});

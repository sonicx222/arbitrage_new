/**
 * Fast Lane Consumer
 *
 * Consumes high-confidence arbitrage opportunities from the fast lane stream
 * (stream:fast-lane) that bypasses the coordinator for lower latency.
 *
 * Key differences from OpportunityConsumer:
 * - Reads from FAST_LANE stream, not EXECUTION_REQUESTS
 * - Simpler ACK pattern (immediate ACK after processing — no deferred ACK)
 * - Dedup guard: skips opportunities already seen via normal path
 * - Feature-gated behind FEATURE_FAST_LANE=true
 *
 * @see opportunity.consumer.ts (normal path consumer)
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { stopAndNullify } from '@arbitrage/core/async';
import { RedisStreamsClient, ConsumerGroupConfig, StreamConsumer } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { ARBITRAGE_CONFIG, FEATURE_FLAGS } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  Logger,
  ExecutionStats,
  QueueService,
  ConsumerConfig,
} from '../types';
import { DEFAULT_CONSUMER_CONFIG } from '../types';

import {
  validateMessageStructure,
  validateBusinessRules as validateBusinessRulesFunc,
} from './validation';
import { recordOpportunityDetected } from '../services/prometheus-metrics';

// =============================================================================
// Configuration
// =============================================================================

export interface FastLaneConsumerConfig {
  logger: Logger;
  streamsClient: RedisStreamsClient;
  queueService: QueueService;
  stats: ExecutionStats;
  instanceId: string;
  /** Callback to check if an opportunity is already being processed via the normal path */
  isAlreadySeen: (opportunityId: string) => boolean;
  /** Consumer configuration overrides */
  consumerConfig?: Partial<ConsumerConfig>;
}

export interface FastLaneConsumerStats {
  /** Total messages received */
  received: number;
  /** Total opportunities enqueued */
  enqueued: number;
  /** Total messages deduplicated (already seen via normal path) */
  deduplicated: number;
  /** Total validation rejections */
  rejected: number;
}

// =============================================================================
// FastLaneConsumer Class
// =============================================================================

export class FastLaneConsumer {
  private readonly logger: Logger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly queueService: QueueService;
  private readonly stats: ExecutionStats;
  private readonly instanceId: string;
  private readonly isAlreadySeen: (opportunityId: string) => boolean;
  private readonly config: ConsumerConfig;

  private streamConsumer: StreamConsumer | null = null;
  private consumerGroup: ConsumerGroupConfig;

  private fastLaneStats: FastLaneConsumerStats = {
    received: 0,
    enqueued: 0,
    deduplicated: 0,
    rejected: 0,
  };

  constructor(config: FastLaneConsumerConfig) {
    this.logger = config.logger;
    this.streamsClient = config.streamsClient;
    this.queueService = config.queueService;
    this.stats = config.stats;
    this.instanceId = config.instanceId;
    this.isAlreadySeen = config.isAlreadySeen;

    this.config = {
      ...DEFAULT_CONSUMER_CONFIG,
      ...config.consumerConfig,
    };

    this.consumerGroup = {
      streamName: RedisStreamsClient.STREAMS.FAST_LANE,
      // P1 Fix CA-005: Standardize on 'execution-engine-group' to match opportunity consumer
      groupName: 'execution-engine-group',
      consumerName: this.instanceId,
      startId: '$',
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async createConsumerGroup(): Promise<void> {
    try {
      await this.streamsClient.createConsumerGroup(this.consumerGroup);
      this.logger.info('Fast lane consumer group ready', {
        stream: this.consumerGroup.streamName,
        group: this.consumerGroup.groupName,
      });
    } catch (error) {
      // BUSYGROUP error is expected if group already exists
      this.logger.debug('Fast lane consumer group creation result', {
        error: getErrorMessage(error),
        stream: this.consumerGroup.streamName,
      });
    }
  }

  start(): void {
    if (!FEATURE_FLAGS.useFastLane) {
      this.logger.info('Fast lane consumer disabled (FEATURE_FAST_LANE not set)');
      return;
    }

    this.streamConsumer = new StreamConsumer(this.streamsClient, {
      config: this.consumerGroup,
      handler: async (message) => {
        await this.handleStreamMessage(message);
      },
      batchSize: this.config.batchSize,
      blockMs: this.config.blockMs,
      autoAck: true, // Immediate ACK — fast lane is best-effort
      // P3 Fix L-4: Zero inter-poll delay for fast lane (latency-sensitive)
      interPollDelayMs: 0,
      logger: {
        error: (msg: string, ctx?: Record<string, unknown>) => this.logger.error(msg, ctx),
        debug: (msg: string, ctx?: Record<string, unknown>) => this.logger.debug(msg, ctx),
      },
    });

    this.streamConsumer.start();
    this.logger.info('Fast lane consumer started', {
      stream: this.consumerGroup.streamName,
      batchSize: this.config.batchSize,
      blockMs: this.config.blockMs,
    });
  }

  async stop(): Promise<void> {
    this.streamConsumer = await stopAndNullify(this.streamConsumer);
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private async handleStreamMessage(
    message: { id: string; data: unknown }
  ): Promise<void> {
    this.fastLaneStats.received++;

    // Validate message structure
    const validation = validateMessageStructure(message);

    if (!validation.valid) {
      if (!validation.isSystemMessage) {
        this.fastLaneStats.rejected++;
        this.logger.debug('Fast lane message validation failed', {
          messageId: message.id,
          code: validation.code,
        });
      }
      return;
    }

    const opportunity = validation.opportunity;

    // Dedup guard: skip if already seen via normal path
    if (this.isAlreadySeen(opportunity.id)) {
      this.fastLaneStats.deduplicated++;
      this.logger.debug('Fast lane opportunity already seen via normal path', {
        id: opportunity.id,
      });
      return;
    }

    // Validate business rules
    const businessValidation = validateBusinessRulesFunc(opportunity, {
      confidenceThreshold: ARBITRAGE_CONFIG.confidenceThreshold,
      minProfitPercentage: ARBITRAGE_CONFIG.minProfitPercentage,
    });

    if (!businessValidation.valid) {
      this.fastLaneStats.rejected++;
      this.logger.debug('Fast lane opportunity rejected by business rules', {
        id: opportunity.id,
        code: businessValidation.code,
      });
      return;
    }

    // Try to enqueue
    if (!this.queueService.enqueue(opportunity)) {
      // P2 Fix F-5: Warn on queue-full drops — fast lane is best-effort but data loss should be visible
      this.logger.warn('Fast lane opportunity dropped: queue full (best-effort, no retry)', {
        id: opportunity.id,
        queueSize: this.queueService.size(),
      });
      return;
    }

    this.fastLaneStats.enqueued++;
    this.stats.opportunitiesReceived++;
    recordOpportunityDetected(
      opportunity.buyChain ?? 'unknown',
      opportunity.type ?? 'unknown',
    );

    this.logger.info('Fast lane opportunity enqueued', {
      id: opportunity.id,
      type: opportunity.type,
      profit: opportunity.expectedProfit,
      queueSize: this.queueService.size(),
    });
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  getStats(): FastLaneConsumerStats {
    return { ...this.fastLaneStats };
  }
}

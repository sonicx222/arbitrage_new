// Dead Letter Queue for Failed Operations
// Prevents data loss and enables manual recovery of failed operations

import { createLogger } from '../logger';
import { getRedisClient } from '../redis';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis-streams';
import { dualPublish as dualPublishUtil } from './dual-publish';

const logger = createLogger('dead-letter-queue');

export interface FailedOperation {
  id: string;
  operation: string;
  payload: any;
  error: {
    message: string;
    code?: string;
    stack?: string;
  };
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  service: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  correlationId?: string;
  tags?: string[];
}

export interface DLQConfig {
  maxSize: number;              // Maximum operations to keep in queue
  retentionPeriod: number;      // How long to keep failed operations (ms)
  retryEnabled: boolean;        // Whether to auto-retry operations
  retryDelay: number;          // Delay between retry attempts
  alertThreshold: number;       // Alert when queue size exceeds this
  batchSize: number;           // How many operations to process at once
}

export interface ProcessingResult {
  processed: number;
  succeeded: number;
  failed: number;
  retryScheduled: number;
}

export class DeadLetterQueue {
  private redis = getRedisClient();
  // P1-18 FIX: Add Redis Streams client for ADR-002 compliance
  private streamsClient: RedisStreamsClient | null = null;
  private config: DLQConfig;
  private processingTimer?: NodeJS.Timeout;
  private isProcessing = false;

  // P0-4 FIX: Operation handler registry for actual operation replay.
  // Services register handlers at startup; processOperation looks up the handler
  // by operation type instead of using simulated Math.random() processing.
  private static operationHandlers = new Map<string, (op: FailedOperation) => Promise<void>>();

  /**
   * P0-4 FIX: Register an operation handler for a given operation type.
   * Consuming services call this at startup to enable real DLQ replay:
   *
   * @example
   * DeadLetterQueue.registerOperationHandler('price_update', async (op) => {
   *   await priceService.processUpdate(op.payload);
   * });
   */
  static registerOperationHandler(
    operationType: string,
    handler: (op: FailedOperation) => Promise<void>
  ): void {
    DeadLetterQueue.operationHandlers.set(operationType, handler);
    logger.info('Registered DLQ operation handler', { operationType });
  }

  /**
   * P0-4 FIX: Unregister an operation handler (for cleanup/testing).
   */
  static unregisterOperationHandler(operationType: string): void {
    DeadLetterQueue.operationHandlers.delete(operationType);
  }

  // P1-6 FIX: Track scheduled retry timers so they can be cancelled on shutdown
  private retryTimers = new Set<NodeJS.Timeout>();

  // P1-10 FIX: Store initialization promise so callers can await streams readiness
  private initPromise: Promise<void>;

  // P1-13 FIX: Maximum payload size in bytes (1MB default)
  private static readonly MAX_PAYLOAD_SIZE = 1024 * 1024;

  constructor(config: Partial<DLQConfig> = {}) {
    // P1-5 FIX: Use ?? instead of || to preserve explicit 0 values
    this.config = {
      maxSize: config.maxSize ?? 10000,
      retentionPeriod: config.retentionPeriod ?? 7 * 24 * 60 * 60 * 1000, // 7 days
      retryEnabled: config.retryEnabled !== false,
      retryDelay: config.retryDelay ?? 60000, // 1 minute
      alertThreshold: config.alertThreshold ?? 1000,
      batchSize: config.batchSize ?? 10
    };
    // P1-10 FIX: Store init promise so dualPublish can await readiness
    this.initPromise = this.initializeStreamsClient();
  }

  /**
   * P1-18 FIX: Initialize Redis Streams client for dual-publish pattern.
   */
  private async initializeStreamsClient(): Promise<void> {
    try {
      this.streamsClient = await getRedisStreamsClient();
    } catch (error) {
      logger.warn('Failed to initialize Redis Streams client, will use Pub/Sub only', { error });
    }
  }

  /**
   * P2-17 FIX: Delegates to shared dualPublishUtil to avoid code duplication.
   * P1-10 FIX: Awaits initPromise to ensure streams client is ready.
   */
  private async dualPublish(
    streamName: string,
    pubsubChannel: string,
    message: Record<string, any>
  ): Promise<void> {
    await this.initPromise;
    const redis = await this.redis;
    await dualPublishUtil(this.streamsClient, redis, streamName, pubsubChannel, message);
  }

  // Add a failed operation to the dead letter queue
  async enqueue(operation: Omit<FailedOperation, 'id' | 'timestamp'>): Promise<string> {
    // P1-13 FIX: Truncate oversized payloads to prevent Redis memory exhaustion
    const sanitizedOp = { ...operation };
    const payloadJson = JSON.stringify(sanitizedOp.payload ?? '');
    if (payloadJson.length > DeadLetterQueue.MAX_PAYLOAD_SIZE) {
      logger.warn('DLQ payload truncated due to size limit', {
        operation: sanitizedOp.operation,
        originalSize: payloadJson.length,
        maxSize: DeadLetterQueue.MAX_PAYLOAD_SIZE
      });
      sanitizedOp.payload = { _truncated: true, _originalSize: payloadJson.length };
    }
    // P1-13 FIX: Truncate error stack to prevent excessive storage
    if (sanitizedOp.error?.stack && sanitizedOp.error.stack.length > 4096) {
      sanitizedOp.error = { ...sanitizedOp.error, stack: sanitizedOp.error.stack.slice(0, 4096) + '\n... [truncated]' };
    }

    const failedOp: FailedOperation = {
      ...sanitizedOp,
      id: this.generateId(),
      timestamp: Date.now()
    };

    try {
      // Check queue size limit
      const currentSize = await this.getQueueSize();
      if (currentSize >= this.config.maxSize) {
        // Remove oldest entries to make room
        await this.evictOldEntries(this.config.maxSize * 0.1); // Remove 10%
        logger.warn('DLQ size limit reached, evicted old entries', { evicted: Math.floor(this.config.maxSize * 0.1) });
      }

      const redis = await this.redis;
      // Store in Redis with TTL
      const key = `dlq:${failedOp.id}`;
      await redis.set(key, failedOp, Math.floor(this.config.retentionPeriod / 1000));

      // Add to priority queue
      const priorityKey = `dlq:priority:${failedOp.priority}`;
      await redis.zadd(priorityKey, failedOp.timestamp, failedOp.id);

      // Add to service-specific queue
      const serviceKey = `dlq:service:${failedOp.service}`;
      await redis.zadd(serviceKey, failedOp.timestamp, failedOp.id);

      // Add tags for filtering
      if (failedOp.tags) {
        for (const tag of failedOp.tags) {
          const tagKey = `dlq:tag:${tag}`;
          await redis.zadd(tagKey, failedOp.timestamp, failedOp.id);
        }
      }

      logger.warn('Operation added to dead letter queue', {
        id: failedOp.id,
        operation: failedOp.operation,
        service: failedOp.service,
        priority: failedOp.priority
      });

      // Check if we should alert
      await this.checkAlertThreshold();

      return failedOp.id;

    } catch (error) {
      logger.error('Failed to enqueue operation to DLQ', { error, operation: failedOp.operation });
      throw error;
    }
  }

  // Process operations from the dead letter queue
  async processBatch(limit?: number): Promise<ProcessingResult> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0, retryScheduled: 0 };
    }

    this.isProcessing = true;
    const batchSize = limit || this.config.batchSize;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let retryScheduled = 0;

    try {
      // Process operations by priority (critical first)
      const priorities: Array<'critical' | 'high' | 'medium' | 'low'> = ['critical', 'high', 'medium', 'low'];

      const redis = await this.redis;
      for (const priority of priorities) {
        if (processed >= batchSize) break;

        const priorityKey = `dlq:priority:${priority}`;
        const operationIds = await redis.zrange(priorityKey, 0, batchSize - processed - 1);

        for (const operationId of operationIds) {
          if (processed >= batchSize) break;

          try {
            const result = await this.processOperation(operationId);
            processed++;

            if (result.success) {
              succeeded++;
              // Remove from all queues
              await this.removeOperation(operationId);
            } else if (result.retry) {
              retryScheduled++;
              // Move to retry queue
              await this.scheduleRetry(operationId);
            } else {
              failed++;
            }
          } catch (error) {
            logger.error('Failed to process DLQ operation', { error, operationId });
            failed++;
          }
        }
      }

    } finally {
      this.isProcessing = false;
    }

    logger.info('DLQ batch processing completed', {
      processed,
      succeeded,
      failed,
      retryScheduled
    });

    return { processed, succeeded, failed, retryScheduled };
  }

  // Get operations by various criteria
  async getOperations(options: {
    priority?: string;
    service?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<FailedOperation[]> {
    const { priority, service, tag, limit = 100, offset = 0 } = options;

    let operationIds: string[] = [];

    const redis = await this.redis;
    if (priority) {
      const key = `dlq:priority:${priority}`;
      operationIds = await redis.zrange(key, offset, offset + limit - 1);
    } else if (service) {
      const key = `dlq:service:${service}`;
      operationIds = await redis.zrange(key, offset, offset + limit - 1);
    } else if (tag) {
      const key = `dlq:tag:${tag}`;
      operationIds = await redis.zrange(key, offset, offset + limit - 1);
    } else {
      // Get all operations (by timestamp)
      // P0-1 FIX: Use SCAN instead of KEYS to avoid blocking Redis
      const keys = await this.scanKeys('dlq:priority:*');
      for (const key of keys) {
        const ids = await redis.zrange(key, offset, offset + limit - 1);
        operationIds.push(...ids);
        if (operationIds.length >= limit) break;
      }
      operationIds = operationIds.slice(0, limit);
    }

    const operations: FailedOperation[] = [];
    for (const id of operationIds) {
      const op = await this.getOperation(id);
      if (op) operations.push(op);
    }

    return operations;
  }

  // Get statistics about the dead letter queue
  async getStats(): Promise<{
    totalOperations: number;
    byPriority: Record<string, number>;
    byService: Record<string, number>;
    byTag: Record<string, number>;
    oldestOperation: number;
    newestOperation: number;
    averageRetries: number;
  }> {
    const stats = {
      totalOperations: await this.getQueueSize(),
      byPriority: {} as Record<string, number>,
      byService: {} as Record<string, number>,
      byTag: {} as Record<string, number>,
      oldestOperation: 0,
      newestOperation: 0,
      averageRetries: 0
    };

    const redis = await this.redis;
    // Count by priority
    const priorities = ['critical', 'high', 'medium', 'low'];
    for (const priority of priorities) {
      const count = await redis.zcard(`dlq:priority:${priority}`);
      stats.byPriority[priority] = count;
    }

    // Count by service
    // P0-1 FIX: Use SCAN instead of KEYS to avoid blocking Redis
    const serviceKeys = await this.scanKeys('dlq:service:*');
    for (const key of serviceKeys) {
      const service = key.replace('dlq:service:', '');
      const count = await redis.zcard(key);
      stats.byService[service] = count;
    }

    // Count by tag
    // P0-1 FIX: Use SCAN instead of KEYS to avoid blocking Redis
    const tagKeys = await this.scanKeys('dlq:tag:*');
    for (const key of tagKeys) {
      const tag = key.replace('dlq:tag:', '');
      const count = await redis.zcard(key);
      stats.byTag[tag] = count;
    }

    // P2-26 FIX: Check ALL priority queues for age stats, not just critical
    if (stats.totalOperations > 0) {
      let oldest = Infinity;
      let newest = 0;
      for (const priority of priorities) {
        const ops = await redis.zrange(`dlq:priority:${priority}`, 0, -1, 'WITHSCORES');
        if (ops.length >= 2) {
          const firstScore = parseInt(ops[1]);
          const lastScore = parseInt(ops[ops.length - 1]);
          if (firstScore < oldest) oldest = firstScore;
          if (lastScore > newest) newest = lastScore;
        }
      }
      stats.oldestOperation = oldest === Infinity ? 0 : oldest;
      stats.newestOperation = newest;
    }

    return stats;
  }

  // P2-21 FIX: Track in-flight retries to prevent duplicate processing
  private retryInFlight = new Set<string>();

  // Manually retry a specific operation
  async retryOperation(operationId: string): Promise<boolean> {
    // P2-21 FIX: Idempotency guard — skip if already being retried
    if (this.retryInFlight.has(operationId)) {
      logger.warn('Operation already being retried, skipping duplicate', { operationId });
      return false;
    }

    this.retryInFlight.add(operationId);
    try {
      const operation = await this.getOperation(operationId);
      if (!operation) {
        logger.warn('Operation not found for retry', { operationId });
        return false;
      }

      const result = await this.processOperation(operationId);

      const redis = await this.redis;
      if (result.success) {
        await this.removeOperation(operationId);
        logger.info('Manual retry succeeded', { operationId });
        return true;
      } else {
        operation.retryCount++;
        await redis.set(`dlq:${operationId}`, operation);
        logger.warn('Manual retry failed', { operationId, retryCount: operation.retryCount });
        return false;
      }
    } catch (error) {
      logger.error('Manual retry failed with error', { error, operationId });
      return false;
    } finally {
      this.retryInFlight.delete(operationId);
    }
  }

  // Clean up expired operations
  async cleanup(): Promise<number> {
    const cutoffTime = Date.now() - this.config.retentionPeriod;
    let cleaned = 0;

    try {
      const redis = await this.redis;
      // P0-1 FIX: Use SCAN instead of KEYS to avoid blocking Redis
      const keys = await this.scanKeys('dlq:*');

      for (const key of keys) {
        if (key.startsWith('dlq:') && !key.includes(':priority:') && !key.includes(':service:') && !key.includes(':tag:')) {
          // This is an operation key
          const operation = await redis.get<FailedOperation>(key);
          if (operation && operation.timestamp < cutoffTime) {
            await this.removeOperation(key.replace('dlq:', ''));
            cleaned++;
          }
        }
      }

      logger.info('DLQ cleanup completed', { cleaned });
    } catch (error) {
      logger.error('DLQ cleanup failed', { error });
    }

    return cleaned;
  }

  // Start automatic processing
  startAutoProcessing(intervalMs: number = 30000): void {
    this.processingTimer = setInterval(async () => {
      try {
        await this.processBatch();
      } catch (error) {
        logger.error('Auto-processing failed', { error });
      }
    }, intervalMs);

    logger.info('DLQ auto-processing started', { intervalMs });
  }

  // Stop automatic processing
  stopAutoProcessing(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = undefined;
    }
    // P1-6 FIX: Cancel all pending retry timers to prevent post-shutdown execution
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    logger.info('DLQ auto-processing stopped');
  }

  private generateId(): string {
    return `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * P0-1 FIX: Non-blocking key enumeration using SCAN instead of KEYS.
   * KEYS is O(n) and blocks the Redis event loop; SCAN iterates incrementally.
   * @see shared/core/src/redis.ts:985-997 for the same pattern used in getAllServiceHealth()
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const redis = await this.redis;
    const allKeys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');
    return allKeys;
  }

  // P2-23 FIX: Sum zcard across the 4 known priority queues instead of SCAN
  private async getQueueSize(): Promise<number> {
    const redis = await this.redis;
    const priorities = ['critical', 'high', 'medium', 'low'];
    let total = 0;
    for (const priority of priorities) {
      total += await redis.zcard(`dlq:priority:${priority}`);
    }
    return total;
  }

  private async evictOldEntries(count: number): Promise<void> {
    // Remove oldest operations across all priorities
    const priorities = ['low', 'medium', 'high', 'critical'];

    for (const priority of priorities) {
      if (count <= 0) break;

      const redis = await this.redis;
      const key = `dlq:priority:${priority}`;
      const oldestIds = await redis.zrange(key, 0, Math.min(count - 1, 100));

      for (const id of oldestIds) {
        await this.removeOperation(id);
        count--;
        if (count <= 0) break;
      }
    }
  }

  private async getOperation(id: string): Promise<FailedOperation | null> {
    const redis = await this.redis;
    return await redis.get(`dlq:${id}`);
  }

  // P0-4 FIX: Replaced simulateOperationProcessing with handler registry lookup.
  // Services register real handlers via DeadLetterQueue.registerOperationHandler();
  // if no handler is registered, the operation fails honestly instead of using Math.random().
  private async processOperation(operationId: string): Promise<{ success: boolean; retry: boolean }> {
    const operation = await this.getOperation(operationId);
    if (!operation) {
      return { success: false, retry: false };
    }

    const handler = DeadLetterQueue.operationHandlers.get(operation.operation);
    if (!handler) {
      logger.warn('No operation handler registered for DLQ operation type, cannot process', {
        operationType: operation.operation,
        operationId: operation.id,
        service: operation.service
      });
      return { success: false, retry: false };
    }

    try {
      await handler(operation);
      return { success: true, retry: false };
    } catch (error) {
      operation.retryCount++;

      const shouldRetry = operation.retryCount < operation.maxRetries && this.shouldRetry(operation, error);
      return { success: false, retry: shouldRetry };
    }
  }

  private shouldRetry(operation: FailedOperation, error: any): boolean {
    // Don't retry certain types of errors
    if (error.message?.includes('Authentication failed')) return false;
    if (error.message?.includes('Invalid input')) return false;
    if (operation.retryCount >= operation.maxRetries) return false;

    return true;
  }

  private async scheduleRetry(operationId: string): Promise<void> {
    // P1-6 FIX: Track the timer so it can be cancelled on shutdown
    const timer = setTimeout(async () => {
      this.retryTimers.delete(timer);
      await this.retryOperation(operationId);
    }, this.config.retryDelay);
    this.retryTimers.add(timer);
  }

  private async removeOperation(operationId: string): Promise<void> {
    const redis = await this.redis;
    const indexKeys = await this.findOperationInIndexes(operationId);

    // Remove from main storage
    await redis.del(`dlq:${operationId}`);

    // Remove from all indexes
    for (const key of indexKeys) {
      await redis.zrem(key, operationId);
    }
  }

  private async findOperationInIndexes(operationId: string): Promise<string[]> {
    const redis = await this.redis;
    const indexKeys: string[] = [];
    const patterns = ['dlq:priority:*', 'dlq:service:*', 'dlq:tag:*'];

    // P0-1 FIX: Use SCAN instead of KEYS to avoid blocking Redis
    for (const pattern of patterns) {
      const keys = await this.scanKeys(pattern);
      for (const key of keys) {
        const exists = await redis.zscore(key, operationId);
        if (exists !== null) {
          indexKeys.push(key);
        }
      }
    }

    return indexKeys;
  }

  private async checkAlertThreshold(): Promise<void> {
    const size = await this.getQueueSize();
    if (size > this.config.alertThreshold) {
      logger.warn('DLQ size exceeded alert threshold', {
        size,
        threshold: this.config.alertThreshold
      });

      // P1-18 FIX: Use dual-publish pattern (Streams + Pub/Sub)
      const alertMessage = {
        type: 'dlq_size_threshold_exceeded',
        data: {
          size,
          threshold: this.config.alertThreshold
        },
        timestamp: Date.now(),
        source: 'dead-letter-queue'
      };

      await this.dualPublish(
        'stream:dlq-alerts',  // Primary: Redis Streams
        'dlq-alert',  // Secondary: Pub/Sub
        alertMessage
      );
    }
  }
}

// Global DLQ instance
let globalDLQ: DeadLetterQueue | null = null;

export function getDeadLetterQueue(config?: Partial<DLQConfig>): DeadLetterQueue {
  if (!globalDLQ) {
    globalDLQ = new DeadLetterQueue(config);
  }
  return globalDLQ;
}

// Convenience function to add failed operations
export async function enqueueFailedOperation(operation: Omit<FailedOperation, 'id' | 'timestamp'>): Promise<string> {
  return await getDeadLetterQueue().enqueue(operation);
}
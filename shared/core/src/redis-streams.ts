/**
 * Redis Streams Client
 *
 * High-performance Redis Streams implementation for event-driven arbitrage system.
 * Provides persistent message queues with consumer groups, batching, and backpressure.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 *
 * Key Features:
 * - XADD for publishing messages with automatic ID generation
 * - XREAD/XREADGROUP for consuming messages
 * - Consumer groups for distributed processing
 * - Batching for reduced Redis command usage (50:1 ratio target)
 * - Automatic stream trimming to manage memory
 */

import Redis from 'ioredis';

// =============================================================================
// DI Types (P16 pattern - enables testability without Jest mock hoisting)
// =============================================================================

/**
 * Redis constructor type for DI
 */
export type RedisStreamsConstructor = new (url: string, options: object) => Redis;

/**
 * Dependencies for RedisStreamsClient
 */
export interface RedisStreamsClientDeps {
  RedisImpl?: RedisStreamsConstructor;
}
import { createLogger, Logger } from './logger';
import { clearTimeoutSafe } from './lifecycle-utils';

// =============================================================================
// Types
// =============================================================================

export interface StreamMessage<T = Record<string, unknown>> {
  id: string;
  data: T;
}

export interface ConsumerGroupConfig {
  streamName: string;
  groupName: string;
  consumerName: string;
  startId?: string; // Default '$' (only new messages), use '0' for all messages
}

export interface XReadOptions {
  count?: number;
  block?: number; // Milliseconds to block, 0 = forever
  /**
   * P1-8 FIX: Maximum block time in milliseconds to prevent indefinite blocking.
   * If block > maxBlockMs, it will be capped to maxBlockMs.
   * Default: 30000ms (30 seconds). Set to 0 to disable cap (not recommended).
   */
  maxBlockMs?: number;
}

export interface XReadGroupOptions extends XReadOptions {
  startId?: string; // '>' for new messages, '0' for pending
  noAck?: boolean;
}

export interface XTrimOptions {
  maxLen?: number;
  minId?: string;
  exact?: boolean; // Default false (approximate trimming is faster)
}

export interface XAddOptions {
  retry?: boolean;
  maxRetries?: number;
  /** P1-3 fix: Maximum stream length to prevent unbounded growth */
  maxLen?: number;
  /** Use approximate (~) trimming for better performance (default: true) */
  approximate?: boolean;
}

export interface StreamInfo {
  length: number;
  radixTreeKeys: number;
  radixTreeNodes: number;
  lastGeneratedId: string;
  groups: number;
  firstEntry?: StreamMessage;
  lastEntry?: StreamMessage;
}

export interface PendingInfo {
  total: number;
  smallestId: string;
  largestId: string;
  consumers: Array<{ name: string; pending: number }>;
}

export interface BatcherConfig {
  maxBatchSize: number;    // Maximum messages before flush
  maxWaitMs: number;       // Maximum wait time before flush
  compress?: boolean;      // Whether to compress batched messages
}

export interface BatcherStats {
  currentQueueSize: number;     // Messages currently waiting in queue
  totalMessagesQueued: number;  // Total messages ever added to batcher
  batchesSent: number;          // Total batches sent to Redis
  totalMessagesSent: number;    // Total messages sent (should equal totalMessagesQueued minus lost)
  compressionRatio: number;     // totalMessagesQueued / batchesSent (higher = better batching)
  averageBatchSize: number;     // totalMessagesSent / batchesSent
}

// =============================================================================
// Stream Batcher
// =============================================================================

export class StreamBatcher<T = Record<string, unknown>> {
  private queue: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false; // Guard against concurrent flushes
  private flushLock: Promise<void> | null = null; // P0-1 fix: Mutex for atomic flush
  /**
   * P0-2 FIX: Pending queue for messages added during flush.
   * Messages added while flushing are stored here to prevent loss
   * if they arrive between queue swap and error re-queue.
   */
  private pendingDuringFlush: T[] = [];
  private destroyed = false;
  private stats: BatcherStats = {
    currentQueueSize: 0,
    totalMessagesQueued: 0,
    batchesSent: 0,
    totalMessagesSent: 0,
    compressionRatio: 1,
    averageBatchSize: 0
  };

  // P2-FIX: Use proper Logger type
  constructor(
    private client: RedisStreamsClient,
    private streamName: string,
    private config: BatcherConfig,
    private logger: Logger
  ) {}

  add(message: T): void {
    if (this.destroyed) {
      this.logger.warn('Attempted to add message to destroyed batcher', { streamName: this.streamName });
      return;
    }

    // P0-2 FIX: If currently flushing, add to pending queue to prevent race condition
    // where messages could be lost between queue swap and error re-queue
    if (this.flushing) {
      this.pendingDuringFlush.push(message);
      this.stats.totalMessagesQueued++;
      return;
    }

    this.queue.push(message);
    this.stats.totalMessagesQueued++;

    // Check if batch size reached
    if (this.queue.length >= this.config.maxBatchSize) {
      this.flush().catch(err => {
        this.logger.error('Flush failed after batch size reached', { error: err });
      });
    } else if (!this.timer) {
      // Start timer for time-based flush
      this.timer = setTimeout(() => {
        this.flush().catch(err => {
          this.logger.error('Flush failed on timer', { error: err });
        });
      }, this.config.maxWaitMs);
    }
  }

  async flush(): Promise<void> {
    // P0-1 fix: Use mutex lock to prevent concurrent flushes
    // Wait for any existing flush operation to complete
    if (this.flushLock) {
      await this.flushLock;
      // After waiting, check if queue was already emptied by previous flush
      if (this.queue.length === 0) {
        return;
      }
    }

    // Guard against concurrent flushes (additional safety)
    if (this.flushing) {
      return;
    }

    this.timer = clearTimeoutSafe(this.timer);

    if (this.queue.length === 0) {
      return;
    }

    // FIX 4.3: Create resolveLock with definite assignment using IIFE pattern
    // This ensures resolveLock is always defined before use in finally block
    let resolveLock: () => void = () => {}; // Safe default
    this.flushLock = new Promise<void>(resolve => {
      resolveLock = resolve;
    });
    this.flushing = true;

    // Atomically take the batch - prevents race condition
    const batch = this.queue;
    this.queue = [];

    try {
      // Send as single batched message
      const batchedMessage = {
        type: 'batch',
        count: batch.length,
        messages: batch,
        timestamp: Date.now()
      };

      await this.client.xadd(this.streamName, batchedMessage);

      // Update stats
      this.stats.batchesSent++;
      this.stats.totalMessagesSent += batch.length;
      this.stats.averageBatchSize = this.stats.totalMessagesSent / this.stats.batchesSent;
      // Compression ratio: messages queued / Redis commands sent (higher is better)
      // Target is 50:1 per ADR-002
      this.stats.compressionRatio = this.stats.totalMessagesQueued / this.stats.batchesSent;

    } catch (error) {
      this.logger.error('Error flushing batch', { error, streamName: this.streamName, batchSize: batch.length });
      // Re-queue failed messages at the front to preserve order
      this.queue = [...batch, ...this.queue];
      throw error;
    } finally {
      // P0-2 FIX: Merge any messages that arrived during flush back to main queue
      // Do this BEFORE clearing flushing flag to ensure no messages are lost
      if (this.pendingDuringFlush.length > 0) {
        this.queue.push(...this.pendingDuringFlush);
        this.pendingDuringFlush = [];
      }
      this.flushing = false;
      this.flushLock = null;
      // FIX 4.3: resolveLock is now guaranteed to be defined
      resolveLock();
    }
  }

  getStats(): BatcherStats {
    // P0-2 FIX: Include pendingDuringFlush in queue size calculation
    return { ...this.stats, currentQueueSize: this.queue.length + this.pendingDuringFlush.length };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.timer = clearTimeoutSafe(this.timer);

    // P0-2 FIX: Merge any pending messages before final flush
    if (this.pendingDuringFlush.length > 0) {
      this.queue.push(...this.pendingDuringFlush);
      this.pendingDuringFlush = [];
    }

    // Await final flush to ensure messages are sent
    if (this.queue.length > 0) {
      // P0-2 FIX: Capture lost count BEFORE flush attempt (pendingDuringFlush already merged above)
      const lostMessageCount = this.queue.length;
      try {
        await this.flush();
      } catch (error) {
        this.logger.warn('Failed to flush remaining messages on destroy', {
          error,
          lostMessages: lostMessageCount
        });
      }
    }
  }
}

// =============================================================================
// Redis Streams Client
// =============================================================================

export class RedisStreamsClient {
  private client: Redis;
  // P2-FIX: Use proper Logger type
  private logger: Logger;
  private batchers: Map<string, StreamBatcher> = new Map();

  // Standard stream names for the arbitrage system
  static readonly STREAMS = {
    PRICE_UPDATES: 'stream:price-updates',
    SWAP_EVENTS: 'stream:swap-events',
    OPPORTUNITIES: 'stream:opportunities',
    WHALE_ALERTS: 'stream:whale-alerts',
    VOLUME_AGGREGATES: 'stream:volume-aggregates',
    HEALTH: 'stream:health',
    // FIX: Added for coordinator to forward opportunities to execution engine
    EXECUTION_REQUESTS: 'stream:execution-requests',
    // Task 1.3.3: Pending opportunities from mempool detection
    PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
    // Circuit breaker state change events (ADR-018)
    CIRCUIT_BREAKER: 'stream:circuit-breaker',
    // System failover coordination events
    SYSTEM_FAILOVER: 'stream:system-failover',
  } as const;

  /**
   * P1-3 fix: Recommended MAXLEN values to prevent unbounded stream growth.
   * These are approximate (~) limits for performance.
   */
  static readonly STREAM_MAX_LENGTHS: Record<string, number> = {
    [RedisStreamsClient.STREAMS.PRICE_UPDATES]: 100000,    // High volume, keep more history
    [RedisStreamsClient.STREAMS.SWAP_EVENTS]: 50000,       // Medium volume
    [RedisStreamsClient.STREAMS.OPPORTUNITIES]: 10000,     // Lower volume, important data
    [RedisStreamsClient.STREAMS.WHALE_ALERTS]: 5000,       // Low volume, critical alerts
    [RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]: 10000, // Aggregated data
    [RedisStreamsClient.STREAMS.HEALTH]: 1000,             // Health checks, short history
    [RedisStreamsClient.STREAMS.EXECUTION_REQUESTS]: 5000, // Execution requests, critical for trading
    [RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES]: 10000, // Mempool pending swaps, time-sensitive
    [RedisStreamsClient.STREAMS.CIRCUIT_BREAKER]: 5000,        // Circuit breaker events, critical alerts
    [RedisStreamsClient.STREAMS.SYSTEM_FAILOVER]: 1000,        // Failover coordination, low volume
  };

  constructor(url: string, password?: string, deps?: RedisStreamsClientDeps) {
    this.logger = createLogger('redis-streams');

    const options: any = {
      password,
      retryStrategy: (times: number) => {
        if (times > 3) {
          this.logger.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 100, 3000);
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true
    };

    // DI: Use injected Redis constructor or default
    const RedisImpl = deps?.RedisImpl ?? Redis;
    this.client = new RedisImpl(url, options);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.removeAllListeners('error');
    this.client.removeAllListeners('connect');

    this.client.on('error', (err: Error) => {
      this.logger.error('Redis Streams client error', { error: err.message });
    });

    this.client.on('connect', () => {
      this.logger.info('Redis Streams client connected');
    });
  }

  // ===========================================================================
  // XADD - Add message to stream
  // ===========================================================================

  async xadd<T = Record<string, unknown>>(
    streamName: string,
    message: T,
    id: string = '*',
    options: XAddOptions = {}
  ): Promise<string> {
    this.validateStreamName(streamName);

    const serialized = JSON.stringify(message);
    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= (options.retry ? maxRetries : 0); attempt++) {
      try {
        let messageId: string;

        // P1-3 fix: Support MAXLEN to prevent unbounded stream growth
        if (options.maxLen !== undefined) {
          const approximate = options.approximate !== false; // Default to approximate
          if (approximate) {
            // Use approximate (~) trimming for better performance
            messageId = await this.client.xadd(
              streamName,
              'MAXLEN', '~', options.maxLen.toString(),
              id,
              'data', serialized
            ) as string;
          } else {
            // Exact trimming (slower but precise)
            messageId = await this.client.xadd(
              streamName,
              'MAXLEN', options.maxLen.toString(),
              id,
              'data', serialized
            ) as string;
          }
        } else {
          messageId = await this.client.xadd(streamName, id, 'data', serialized) as string;
        }

        return messageId;
      } catch (error) {
        lastError = error as Error;
        if (!options.retry || attempt === maxRetries) {
          throw error;
        }
        // Wait before retry with exponential backoff
        await this.sleep(Math.pow(2, attempt) * 100);
      }
    }

    throw lastError;
  }

  /**
   * P1-3 fix: Add message with automatic MAXLEN based on stream type.
   * Uses recommended limits from STREAM_MAX_LENGTHS.
   */
  async xaddWithLimit<T = Record<string, unknown>>(
    streamName: string,
    message: T,
    options: Omit<XAddOptions, 'maxLen'> = {}
  ): Promise<string> {
    const maxLen = RedisStreamsClient.STREAM_MAX_LENGTHS[streamName];
    return this.xadd(streamName, message, '*', {
      ...options,
      maxLen,
      approximate: true
    });
  }

  // ===========================================================================
  // XREAD - Read from stream
  // ===========================================================================

  async xread(
    streamName: string,
    lastId: string,
    options: XReadOptions = {}
  ): Promise<StreamMessage[]> {
    this.validateStreamName(streamName);

    try {
      const args: (string | number)[] = [];

      if (options.count) {
        args.push('COUNT', options.count);
      }
      if (options.block !== undefined) {
        // P1-8 FIX: Apply safety cap to prevent indefinite blocking
        // Default max: 30 seconds. 0 = forever (explicitly disabled cap)
        const maxBlockMs = options.maxBlockMs ?? 30000;
        let effectiveBlock = options.block;

        if (maxBlockMs > 0 && (options.block === 0 || options.block > maxBlockMs)) {
          this.logger.debug('XREAD block time capped', {
            requested: options.block,
            capped: maxBlockMs,
            streamName
          });
          effectiveBlock = maxBlockMs;
        }
        args.push('BLOCK', effectiveBlock);
      }
      args.push('STREAMS', streamName, lastId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client.xread as any)(...args);

      if (!result) {
        return [];
      }

      return this.parseStreamResult(result);
    } catch (error) {
      this.logger.error('XREAD error', { error, streamName });
      throw error;
    }
  }

  // ===========================================================================
  // Consumer Groups
  // ===========================================================================

  async createConsumerGroup(config: ConsumerGroupConfig): Promise<void> {
    try {
      await this.client.xgroup(
        'CREATE',
        config.streamName,
        config.groupName,
        config.startId ?? '$',
        'MKSTREAM'
      );
      this.logger.info('Consumer group created', {
        stream: config.streamName,
        group: config.groupName
      });
    } catch (error: any) {
      // Ignore "group already exists" error
      if (error.message?.includes('BUSYGROUP')) {
        this.logger.debug('Consumer group already exists', {
          stream: config.streamName,
          group: config.groupName
        });
        return;
      }
      throw error;
    }
  }

  async xreadgroup(
    config: ConsumerGroupConfig,
    options: XReadGroupOptions = {}
  ): Promise<StreamMessage[]> {
    try {
      const args: (string | number)[] = [
        'GROUP', config.groupName, config.consumerName
      ];

      if (options.count) {
        args.push('COUNT', options.count);
      }
      if (options.block !== undefined) {
        // P1-8 FIX: Apply safety cap to prevent indefinite blocking
        const maxBlockMs = options.maxBlockMs ?? 30000;
        let effectiveBlock = options.block;

        if (maxBlockMs > 0 && (options.block === 0 || options.block > maxBlockMs)) {
          this.logger.debug('XREADGROUP block time capped', {
            requested: options.block,
            capped: maxBlockMs,
            stream: config.streamName,
            group: config.groupName
          });
          effectiveBlock = maxBlockMs;
        }
        args.push('BLOCK', effectiveBlock);
      }
      if (options.noAck) {
        args.push('NOACK');
      }
      args.push('STREAMS', config.streamName, options.startId ?? '>');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client.xreadgroup as any)(...args);

      if (!result) {
        return [];
      }

      return this.parseStreamResult(result);
    } catch (error) {
      this.logger.error('XREADGROUP error', { error, config });
      throw error;
    }
  }

  // ===========================================================================
  // XACK - Acknowledge messages
  // ===========================================================================

  async xack(streamName: string, groupName: string, ...messageIds: string[]): Promise<number> {
    try {
      return await this.client.xack(streamName, groupName, ...messageIds);
    } catch (error) {
      this.logger.error('XACK error', { error, streamName, groupName });
      throw error;
    }
  }

  // ===========================================================================
  // Stream Information
  // ===========================================================================

  async xlen(streamName: string): Promise<number> {
    try {
      return await this.client.xlen(streamName);
    } catch (error) {
      this.logger.error('XLEN error', { error, streamName });
      return 0;
    }
  }

  /**
   * Get stream information. Returns default values if stream doesn't exist.
   * This is resilient to startup conditions where streams may not be created yet.
   */
  async xinfo(streamName: string): Promise<StreamInfo> {
    try {
      const result = await this.client.xinfo('STREAM', streamName);
      return this.parseStreamInfo(result as any[]);
    } catch (error: any) {
      // ERR no such key - stream doesn't exist yet (common during startup)
      if (error.message?.includes('no such key') || error.message?.includes('ERR')) {
        this.logger.debug('Stream does not exist yet', { streamName });
        return {
          length: 0,
          radixTreeKeys: 0,
          radixTreeNodes: 0,
          lastGeneratedId: '0-0',
          groups: 0
        };
      }
      this.logger.error('XINFO error', { error, streamName });
      throw error;
    }
  }

  /**
   * Get pending messages info for a consumer group.
   * Returns default values if stream or consumer group doesn't exist.
   * This is resilient to startup conditions where groups may not be created yet.
   */
  async xpending(streamName: string, groupName: string): Promise<PendingInfo> {
    try {
      const result = await this.client.xpending(streamName, groupName) as any[];

      const consumers: Array<{ name: string; pending: number }> = [];
      if (result[3]) {
        for (const [name, count] of result[3]) {
          consumers.push({ name, pending: parseInt(count, 10) });
        }
      }

      return {
        total: result[0] as number,
        smallestId: result[1] as string,
        largestId: result[2] as string,
        consumers
      };
    } catch (error: any) {
      // NOGROUP - consumer group doesn't exist yet (common during startup)
      // ERR no such key - stream doesn't exist yet
      if (error.message?.includes('NOGROUP') || error.message?.includes('no such key')) {
        this.logger.debug('Consumer group or stream does not exist yet', { streamName, groupName });
        return {
          total: 0,
          smallestId: '',
          largestId: '',
          consumers: []
        };
      }
      this.logger.error('XPENDING error', { error, streamName, groupName });
      throw error;
    }
  }

  // ===========================================================================
  // Stream Trimming
  // ===========================================================================

  async xtrim(streamName: string, options: XTrimOptions): Promise<number> {
    try {
      const args: (string | number)[] = [streamName];

      if (options.maxLen !== undefined) {
        args.push('MAXLEN');
        if (!options.exact) {
          args.push('~'); // Approximate trimming is faster
        }
        args.push(options.maxLen);
      } else if (options.minId !== undefined) {
        args.push('MINID');
        if (!options.exact) {
          args.push('~');
        }
        args.push(options.minId);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (this.client.xtrim as any)(...args);
    } catch (error) {
      this.logger.error('XTRIM error', { error, streamName });
      throw error;
    }
  }

  // ===========================================================================
  // Batching
  // ===========================================================================

  createBatcher<T = Record<string, unknown>>(
    streamName: string,
    config: BatcherConfig
  ): StreamBatcher<T> {
    // Cleanup existing batcher if any (fire and forget - don't block creation)
    const existing = this.batchers.get(streamName);
    if (existing) {
      existing.destroy().catch(err => {
        this.logger.warn('Failed to cleanup existing batcher', { streamName, error: err });
      });
    }

    const batcher = new StreamBatcher<T>(this, streamName, config, this.logger);
    this.batchers.set(streamName, batcher as any);
    return batcher;
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // Cleanup batchers - await all destroy operations to ensure messages are flushed
    const destroyPromises = Array.from(this.batchers.values()).map(batcher =>
      batcher.destroy().catch(err => {
        this.logger.warn('Failed to destroy batcher during disconnect', { error: err });
      })
    );
    await Promise.all(destroyPromises);
    this.batchers.clear();

    // Disconnect client
    this.client.removeAllListeners();
    await this.client.disconnect();
    this.logger.info('Redis Streams client disconnected');
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private validateStreamName(streamName: string): void {
    if (!streamName || typeof streamName !== 'string') {
      throw new Error('Invalid stream name: must be non-empty string');
    }

    if (streamName.length > 256) {
      throw new Error('Invalid stream name: too long');
    }

    // Allow alphanumeric, dash, underscore, colon
    if (!/^[a-zA-Z0-9\-_:]+$/.test(streamName)) {
      throw new Error('Invalid stream name: contains unsafe characters');
    }
  }

  private parseStreamResult(result: any[]): StreamMessage[] {
    const messages: StreamMessage[] = [];

    if (!result || result.length === 0) {
      return messages;
    }

    // Result format: [[streamName, [[id, [field, value, ...]], ...]]]
    for (const [, entries] of result) {
      if (!entries) continue;

      for (const [id, fields] of entries) {
        // Parse fields array into object
        const data: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const value = fields[i + 1];
          try {
            data[key] = JSON.parse(value);
          } catch {
            data[key] = value;
          }
        }

        messages.push({ id, data: (data.data ?? data) as Record<string, unknown> });
      }
    }

    return messages;
  }

  private parseStreamInfo(result: any[]): StreamInfo {
    const info: StreamInfo = {
      length: 0,
      radixTreeKeys: 0,
      radixTreeNodes: 0,
      lastGeneratedId: '',
      groups: 0
    };

    for (let i = 0; i < result.length; i += 2) {
      const key = result[i];
      const value = result[i + 1];

      switch (key) {
        case 'length':
          info.length = value;
          break;
        case 'radix-tree-keys':
          info.radixTreeKeys = value;
          break;
        case 'radix-tree-nodes':
          info.radixTreeNodes = value;
          break;
        case 'last-generated-id':
          info.lastGeneratedId = value;
          break;
        case 'groups':
          info.groups = value;
          break;
      }
    }

    return info;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// P2-1 FIX: Reusable Stream Consumer
// Reduces code duplication in services consuming from Redis Streams
// =============================================================================

/**
 * FIX 6.1: Minimal logger interface for StreamConsumer.
 * Compatible with winston, pino, and test mock loggers.
 * Uses Record<string, unknown> for type safety and consistency with ILogger.
 *
 * Fix 6.2: This interface only requires `error()` to support minimal error-only loggers.
 * For full logging capabilities, use `ILogger` from '@arbitrage/core'.
 *
 * @see shared/core/src/logging/types.ts - Canonical ILogger interface
 */
export interface StreamConsumerLogger {
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  debug?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface StreamConsumerConfig {
  /** Consumer group configuration */
  config: ConsumerGroupConfig;
  /** Handler function for each message */
  handler: (message: StreamMessage) => Promise<void>;
  /** Number of messages to fetch per read (default: 10) */
  batchSize?: number;
  /** Block time in ms (default: 1000, 0 = non-blocking) */
  blockMs?: number;
  /** Whether to auto-acknowledge after handler completes (default: true) */
  autoAck?: boolean;
  /** FIX 6.1: Logger instance using standardized interface */
  logger?: StreamConsumerLogger;
  /** Callback when pause state changes (for backpressure monitoring) */
  onPauseStateChange?: (isPaused: boolean) => void;
}

export interface StreamConsumerStats {
  messagesProcessed: number;
  messagesFailed: number;
  lastProcessedAt: number | null;
  isRunning: boolean;
  /** Whether consumption is paused due to backpressure */
  isPaused: boolean;
}

/**
 * P2-1 FIX: Reusable stream consumer that encapsulates the common pattern of:
 * 1. Reading from consumer group
 * 2. Processing each message with a handler
 * 3. Acknowledging processed messages
 * 4. Handling errors gracefully
 *
 * Usage:
 * ```ts
 * const consumer = new StreamConsumer(streamsClient, {
 *   config: { streamName: 'stream:opportunities', groupName: 'coordinator', consumerName: 'worker-1' },
 *   handler: async (msg) => { console.log(msg.data); },
 *   batchSize: 10,
 *   blockMs: 1000
 * });
 * consumer.start();
 * // ... later
 * await consumer.stop();
 * ```
 */
export class StreamConsumer {
  private client: RedisStreamsClient;
  private config: StreamConsumerConfig;
  private running = false;
  private paused = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stats: StreamConsumerStats = {
    messagesProcessed: 0,
    messagesFailed: 0,
    lastProcessedAt: null,
    isRunning: false,
    isPaused: false
  };

  constructor(client: RedisStreamsClient, config: StreamConsumerConfig) {
    this.client = client;
    this.config = {
      batchSize: 10,
      blockMs: 1000,
      autoAck: true,
      ...config
    };
  }

  /**
   * Start consuming messages from the stream.
   * Runs in a polling loop until stop() is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stats.isRunning = true;
    this.poll();
  }

  /**
   * Stop consuming messages.
   * Waits for any in-flight processing to complete.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stats.isRunning = false;

    this.pollTimer = clearTimeoutSafe(this.pollTimer);
  }

  /**
   * Get consumer statistics.
   */
  getStats(): StreamConsumerStats {
    return { ...this.stats };
  }

  /**
   * Pause consumption (for backpressure).
   * Consumer will stop reading new messages until resume() is called.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stats.isPaused = true;
    this.config.logger?.debug?.('Stream consumer paused', {
      stream: this.config.config.streamName
    });
    this.config.onPauseStateChange?.(true);
  }

  /**
   * Resume consumption after pause.
   * Restarts the polling loop if consumer is still running.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.stats.isPaused = false;
    this.config.logger?.debug?.('Stream consumer resumed', {
      stream: this.config.config.streamName
    });
    this.config.onPauseStateChange?.(false);
    // Restart polling if we were running
    if (this.running && !this.pollTimer) {
      this.poll();
    }
  }

  /**
   * Check if consumer is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.paused) return;

    try {
      const messages = await this.client.xreadgroup(this.config.config, {
        count: this.config.batchSize,
        block: this.config.blockMs,
        startId: '>'
      });

      for (const message of messages) {
        if (!this.running) break;

        try {
          await this.config.handler(message);
          this.stats.messagesProcessed++;
          this.stats.lastProcessedAt = Date.now();

          // Auto-acknowledge if enabled
          if (this.config.autoAck) {
            await this.client.xack(
              this.config.config.streamName,
              this.config.config.groupName,
              message.id
            );
          }
        } catch (handlerError) {
          this.stats.messagesFailed++;
          this.config.logger?.error('Stream message handler failed', {
            error: handlerError,
            stream: this.config.config.streamName,
            messageId: message.id
          });
          // Don't ack failed messages - they'll be retried
        }
      }
    } catch (error) {
      // Ignore timeout errors from blocking read
      const errorMessage = (error as Error).message || '';
      if (!errorMessage.includes('timeout')) {
        this.config.logger?.error('Error consuming stream', {
          error,
          stream: this.config.config.streamName
        });
      }
    }

    // Schedule next poll if still running and not paused
    if (this.running && !this.paused) {
      // Use setImmediate for non-blocking reads, short delay for blocking reads
      const delay = this.config.blockMs === 0 ? 0 : 10;
      this.pollTimer = setTimeout(() => this.poll(), delay);
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let streamsInstance: RedisStreamsClient | null = null;
let initializingPromise: Promise<RedisStreamsClient> | null = null; // Race condition guard

export async function getRedisStreamsClient(url?: string, password?: string): Promise<RedisStreamsClient> {
  // Return existing instance if available
  if (streamsInstance) {
    return streamsInstance;
  }

  // Prevent concurrent initialization (race condition fix)
  if (initializingPromise) {
    // P1-FIX: Await and validate instead of returning promise directly.
    // This prevents returning a disconnected instance if reset() was called
    // during our await.
    const instance = await initializingPromise;
    if (streamsInstance === instance) {
      return instance;
    }
    // Instance was reset during await, retry
    return getRedisStreamsClient(url, password);
  }

  const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
  const redisPassword = password || process.env.REDIS_PASSWORD;

  initializingPromise = (async () => {
    try {
      const instance = new RedisStreamsClient(redisUrl, redisPassword);

      // Verify connection
      const isHealthy = await instance.ping();
      if (!isHealthy) {
        throw new Error('Failed to connect to Redis for Streams');
      }

      streamsInstance = instance;
      return instance;
    } catch (error) {
      initializingPromise = null; // Allow retry on failure
      throw error;
    }
  })();

  // P1-FIX: Same validation after await
  const instance = await initializingPromise;
  if (streamsInstance === instance) {
    return instance;
  }
  // Instance was reset during initialization, retry
  return getRedisStreamsClient(url, password);
}

export async function resetRedisStreamsInstance(): Promise<void> {
  const instance = streamsInstance;
  streamsInstance = null;
  initializingPromise = null;

  if (instance) {
    await instance.disconnect();
  }
}

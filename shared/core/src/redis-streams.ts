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
import { createLogger } from './logger';

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
  private destroyed = false;
  private stats: BatcherStats = {
    currentQueueSize: 0,
    totalMessagesQueued: 0,
    batchesSent: 0,
    totalMessagesSent: 0,
    compressionRatio: 1,
    averageBatchSize: 0
  };

  constructor(
    private client: RedisStreamsClient,
    private streamName: string,
    private config: BatcherConfig,
    private logger: any
  ) {}

  add(message: T): void {
    if (this.destroyed) {
      this.logger.warn('Attempted to add message to destroyed batcher', { streamName: this.streamName });
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
    // Guard against concurrent flushes (race condition fix)
    if (this.flushing) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

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
      this.flushing = false;
    }
  }

  getStats(): BatcherStats {
    return { ...this.stats, currentQueueSize: this.queue.length };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Await final flush to ensure messages are sent
    if (this.queue.length > 0) {
      try {
        await this.flush();
      } catch (error) {
        this.logger.warn('Failed to flush remaining messages on destroy', {
          error,
          lostMessages: this.queue.length
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
  private logger: any;
  private batchers: Map<string, StreamBatcher> = new Map();

  // Standard stream names for the arbitrage system
  static readonly STREAMS = {
    PRICE_UPDATES: 'stream:price-updates',
    SWAP_EVENTS: 'stream:swap-events',
    OPPORTUNITIES: 'stream:opportunities',
    WHALE_ALERTS: 'stream:whale-alerts',
    VOLUME_AGGREGATES: 'stream:volume-aggregates',
    HEALTH: 'stream:health'
  } as const;

  constructor(url: string, password?: string) {
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

    this.client = new Redis(url, options);
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
        const messageId = await this.client.xadd(streamName, id, 'data', serialized);
        return messageId as string;
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
        args.push('BLOCK', options.block);
      }
      args.push('STREAMS', streamName, lastId);

      const result = await this.client.xread(...args);

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
        args.push('BLOCK', options.block);
      }
      if (options.noAck) {
        args.push('NOACK');
      }
      args.push('STREAMS', config.streamName, options.startId ?? '>');

      const result = await this.client.xreadgroup(...args);

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

  async xinfo(streamName: string): Promise<StreamInfo> {
    try {
      const result = await this.client.xinfo('STREAM', streamName);
      return this.parseStreamInfo(result as any[]);
    } catch (error) {
      this.logger.error('XINFO error', { error, streamName });
      throw error;
    }
  }

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
    } catch (error) {
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

      return await this.client.xtrim(...args);
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

        messages.push({ id, data: data.data ?? data });
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
    return initializingPromise;
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

  return initializingPromise;
}

export async function resetRedisStreamsInstance(): Promise<void> {
  const instance = streamsInstance;
  streamsInstance = null;
  initializingPromise = null;

  if (instance) {
    await instance.disconnect();
  }
}

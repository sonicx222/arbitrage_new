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

import crypto from 'crypto';
import Redis from 'ioredis';
import { RedisStreams } from '@arbitrage/types';

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
  /** HMAC signing key for message authentication (S-5). Omit for dev mode (no signing). */
  signingKey?: string;
  /** OP-17 FIX: Previous signing key accepted during rotation window. */
  previousSigningKey?: string;
}
import { createLogger, Logger } from '../logger';
import { clearTimeoutSafe } from '../async/lifecycle-utils';

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
  /**
   * When true, BUSYGROUP on create triggers XGROUP SETID to startId.
   * This is useful for services that must skip stale backlog on restart.
   */
  resetToStartIdOnExistingGroup?: boolean;
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
  maxQueueSize?: number;   // Maximum queued messages before dropping (default: unbounded)
}

export interface BatcherStats {
  currentQueueSize: number;     // Messages currently waiting in queue
  totalMessagesQueued: number;  // Total messages ever added to batcher
  batchesSent: number;          // Total batches sent to Redis
  totalMessagesSent: number;    // Total messages sent (should equal totalMessagesQueued minus lost)
  compressionRatio: number;     // totalMessagesQueued / batchesSent (higher = better batching)
  averageBatchSize: number;     // totalMessagesSent / batchesSent
  totalBatchFlushes: number;    // Total successful batch flush xadd calls
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
    averageBatchSize: 0,
    totalBatchFlushes: 0
  };

  // P2-FIX: Use proper Logger type
  constructor(
    private client: RedisStreamsClient,
    private streamName: string,
    private config: BatcherConfig,
    private logger: Logger
  ) {}

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  add(message: T): void {
    if (this.destroyed) {
      this.logger.warn('Attempted to add message to destroyed batcher', { streamName: this.streamName });
      return;
    }

    // Enforce maxQueueSize to prevent unbounded memory growth during sustained Redis outages
    const totalQueued = this.queue.length + this.pendingDuringFlush.length;
    if (this.config.maxQueueSize != null && totalQueued >= this.config.maxQueueSize) {
      this.logger.warn('Batcher queue full, dropping message', {
        streamName: this.streamName,
        queueSize: totalQueued,
        maxQueueSize: this.config.maxQueueSize,
      });
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
      this.stats.totalBatchFlushes++;
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

    // Await any in-flight flush before proceeding. If the flush fails,
    // it re-queues its batch back to this.queue. Without this await,
    // destroy() could see an empty queue while flush holds messages in its
    // local batch variable, causing silent message loss on flush failure.
    if (this.flushLock) {
      try {
        await this.flushLock;
      } catch {
        // Flush failure is handled inside flush() — it re-queues messages.
        // We just need to wait for it to finish so the queue is up-to-date.
      }
    }

    // P0-2 FIX: Merge any pending messages before final flush
    if (this.pendingDuringFlush.length > 0) {
      this.queue.push(...this.pendingDuringFlush);
      this.pendingDuringFlush = [];
    }

    // Await final flush to ensure messages are sent
    if (this.queue.length > 0) {
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
  // BUG-006 FIX: Use StreamBatcher<unknown> to accept any generic parameter
  private batchers: Map<string, StreamBatcher<unknown>> = new Map();
  /** S-5: HMAC signing key for message authentication. Null = signing disabled (dev mode). */
  private signingKey: string | null;
  /** OP-17 FIX: Previous signing key for rotation window. Null = no rotation in progress. */
  private previousSigningKey: string | null;
  /** OP-32 FIX: Cached KeyObject instances to avoid per-message crypto.createHmac() overhead */
  private cachedSigningKeyObj: crypto.KeyObject | null = null;
  private cachedPreviousKeyObj: crypto.KeyObject | null = null;

  // Standard stream names — single source of truth from @arbitrage/types (ADR-002)
  static readonly STREAMS = RedisStreams;

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
    [RedisStreamsClient.STREAMS.HEALTH_ALERTS]: 5000,            // P1 FIX #9: Health alerts, critical
    [RedisStreamsClient.STREAMS.SYSTEM_COMMANDS]: 1000,          // P1 FIX #9: System commands, low volume
    // ARCH-006: Previously missing streams now covered by MAXLEN to prevent unbounded growth
    [RedisStreamsClient.STREAMS.SERVICE_HEALTH]: 1000,           // Low volume health checks
    [RedisStreamsClient.STREAMS.SERVICE_EVENTS]: 5000,           // Medium volume service events
    [RedisStreamsClient.STREAMS.COORDINATOR_EVENTS]: 5000,       // Medium volume coordinator events
    [RedisStreamsClient.STREAMS.EXECUTION_RESULTS]: 5000,        // Critical trading result data
    [RedisStreamsClient.STREAMS.DEAD_LETTER_QUEUE]: 10000,       // Failed ops, keep more history
    [RedisStreamsClient.STREAMS.DLQ_ALERTS]: 5000,               // Alert data
    [RedisStreamsClient.STREAMS.FORWARDING_DLQ]: 5000,           // Forwarded failures
    [RedisStreamsClient.STREAMS.FAST_LANE]: 5000,                // Fast lane: high-confidence, coordinator bypass
  };

  constructor(url: string, password?: string, deps?: RedisStreamsClientDeps) {
    this.logger = createLogger('redis-streams');
    this.signingKey = deps?.signingKey ?? null;
    // OP-17 FIX: Accept previous key for dual-key verification during rotation
    this.previousSigningKey = deps?.previousSigningKey ?? null;
    // OP-32 FIX: Pre-cache KeyObject instances to avoid per-message crypto.createHmac() allocation
    if (this.signingKey) {
      this.cachedSigningKeyObj = crypto.createSecretKey(Buffer.from(this.signingKey, 'utf8'));
    }
    if (this.previousSigningKey) {
      this.cachedPreviousKeyObj = crypto.createSecretKey(Buffer.from(this.previousSigningKey, 'utf8'));
    }

    // Enforce HMAC signing in production. Without a signing key, verifySignature()
    // returns true for ALL messages, allowing unsigned/tampered data through.
    // Fail-closed: refuse to start rather than silently accepting unverified messages.
    if (!this.signingKey && process.env.NODE_ENV === 'production') {
      throw new Error(
        'STREAM_SIGNING_KEY is required in production. ' +
        'Without it, all Redis Streams messages are accepted without HMAC verification. ' +
        'Set STREAM_SIGNING_KEY environment variable to enable message signing.'
      );
    }

    const options: Record<string, unknown> = {
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
  // S-5: HMAC Message Signing
  // ===========================================================================

  /**
   * Compute HMAC-SHA256 signature for message data.
   * Returns empty string if signing is disabled (no key configured).
   *
   * OP-18 FIX: Includes stream name in HMAC input to prevent cross-stream replay.
   * A valid signed message from one stream cannot be replayed on another.
   *
   * @param data - Serialized message data
   * @param streamName - Stream name for replay protection (optional for backward compat)
   */
  private signMessage(data: string, streamName?: string): string {
    if (!this.cachedSigningKeyObj) return '';
    const input = streamName ? `${streamName}:${data}` : data;
    // OP-32 FIX: Use cached KeyObject instead of raw string to avoid per-message key setup overhead
    return crypto.createHmac('sha256', this.cachedSigningKeyObj).update(input).digest('hex');
  }

  /**
   * Compute HMAC-SHA256 signature with a specific key (object or string).
   * Uses KeyObject when available for better performance.
   */
  private signMessageWithKey(data: string, key: string | crypto.KeyObject, streamName?: string): string {
    const input = streamName ? `${streamName}:${data}` : data;
    return crypto.createHmac('sha256', key).update(input).digest('hex');
  }

  /**
   * Verify HMAC-SHA256 signature using constant-time comparison.
   * Returns true if signing is disabled (dev mode passthrough).
   *
   * OP-17 FIX: Tries current key first, then previous key for rotation window.
   * OP-18 FIX: Includes stream name in verification for replay protection.
   *
   * @param data - Serialized message data
   * @param signature - Signature to verify
   * @param streamName - Stream name for replay protection (optional for backward compat)
   */
  private verifySignature(data: string, signature: string, streamName?: string): boolean {
    if (!this.signingKey) return true;

    // Try current key first
    const expected = this.signMessage(data, streamName);
    if (expected.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return true;
    }

    // OP-17 FIX: Try previous key during rotation window
    if (this.cachedPreviousKeyObj) {
      const previousExpected = this.signMessageWithKey(data, this.cachedPreviousKeyObj, streamName);
      if (previousExpected.length === signature.length &&
          crypto.timingSafeEqual(Buffer.from(previousExpected), Buffer.from(signature))) {
        return true;
      }
      // Also try previous key WITHOUT stream name (backward compat with pre-OP-18 messages)
      if (streamName) {
        const legacyExpected = this.signMessageWithKey(data, this.cachedPreviousKeyObj);
        if (legacyExpected.length === signature.length &&
            crypto.timingSafeEqual(Buffer.from(legacyExpected), Buffer.from(signature))) {
          return true;
        }
      }
    }

    // Also try current key WITHOUT stream name (backward compat with pre-OP-18 messages)
    if (streamName) {
      const legacyExpected = this.signMessageWithKey(data, this.cachedSigningKeyObj!);
      if (legacyExpected.length === signature.length &&
          crypto.timingSafeEqual(Buffer.from(legacyExpected), Buffer.from(signature))) {
        return true;
      }
    }

    return false;
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
    // S-5: Compute HMAC signature for message authentication
    // OP-18 FIX: Include stream name in HMAC to prevent cross-stream replay
    const signature = this.signMessage(serialized, streamName);
    const sigFields = signature ? ['sig', signature] : [];
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
              'data', serialized,
              ...sigFields
            ) as string;
          } else {
            // Exact trimming (slower but precise)
            messageId = await this.client.xadd(
              streamName,
              'MAXLEN', options.maxLen.toString(),
              id,
              'data', serialized,
              ...sigFields
            ) as string;
          }
        } else {
          messageId = await this.client.xadd(streamName, id, 'data', serialized, ...sigFields) as string;
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
          if (this.logger.isLevelEnabled?.('debug') ?? false) {
            this.logger.debug('XREAD block time capped', {
              requested: options.block,
              capped: maxBlockMs,
              streamName
            });
          }
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
    } catch (error: unknown) {
      // Ignore "group already exists" error
      if ((error as Error).message?.includes('BUSYGROUP')) {
        if (config.resetToStartIdOnExistingGroup) {
          const targetId = config.startId ?? '$';
          await this.client.xgroup(
            'SETID',
            config.streamName,
            config.groupName,
            targetId
          );
          this.logger.info('Consumer group already existed, reset offset to configured startId', {
            stream: config.streamName,
            group: config.groupName,
            startId: targetId
          });
          return;
        }

        if (this.logger.isLevelEnabled?.('debug') ?? false) {
          this.logger.debug('Consumer group already exists', {
            stream: config.streamName,
            group: config.groupName
          });
        }
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
          if (this.logger.isLevelEnabled?.('debug') ?? false) {
            this.logger.debug('XREADGROUP block time capped', {
              requested: options.block,
              capped: maxBlockMs,
              stream: config.streamName,
              group: config.groupName
            });
          }
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

      // OP-9 FIX: Track HMAC-rejected message IDs for ACK to prevent PEL growth
      const rejectedIds: string[] = [];
      const messages = this.parseStreamResult(result, rejectedIds);

      // OP-9 FIX: ACK HMAC-rejected messages to prevent unbounded PEL growth
      if (rejectedIds.length > 0) {
        try {
          await this.client.xack(config.streamName, config.groupName, ...rejectedIds);
          this.logger.warn('ACKed HMAC-rejected messages to prevent PEL growth', {
            stream: config.streamName,
            count: rejectedIds.length,
            messageIds: rejectedIds,
          });
        } catch (ackError) {
          this.logger.error('Failed to ACK rejected messages', { error: ackError });
        }
      }

      return messages;
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
      // BUG-006 FIX: Use unknown[] instead of any[] for type safety
      return this.parseStreamInfo(result as unknown[]);
    } catch (error: unknown) {
      // ERR no such key - stream doesn't exist yet (common during startup)
      const errMsg = getErrorMessage(error);
      if (errMsg.includes('no such key') || errMsg.includes('ERR')) {
        if (this.logger.isLevelEnabled?.('debug') ?? false) {
          this.logger.debug('Stream does not exist yet', { streamName });
        }
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
      // BUG-006 FIX: Use unknown[] instead of any[] for type safety
      const result = await this.client.xpending(streamName, groupName) as unknown[];

      const consumers: Array<{ name: string; pending: number }> = [];
      const consumerList = result[3] as Array<[string, string]> | null;
      if (consumerList) {
        for (const [name, count] of consumerList) {
          consumers.push({ name, pending: parseInt(count, 10) });
        }
      }

      return {
        total: result[0] as number,
        smallestId: result[1] as string,
        largestId: result[2] as string,
        consumers
      };
    } catch (error: unknown) {
      // NOGROUP - consumer group doesn't exist yet (common during startup)
      // ERR no such key - stream doesn't exist yet
      const errMsg = getErrorMessage(error);
      if (errMsg.includes('NOGROUP') || errMsg.includes('no such key')) {
        if (this.logger.isLevelEnabled?.('debug') ?? false) {
          this.logger.debug('Consumer group or stream does not exist yet', { streamName, groupName });
        }
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
  // XCLAIM - Claim pending messages from other consumers
  // ===========================================================================

  /**
   * Claim pending messages from other consumers that have been idle too long.
   *
   * Used during startup to reclaim orphaned messages from a previous coordinator
   * instance that crashed before ACKing them. The coordinator generates unique
   * consumer names per startup, so pending messages from the old consumer name
   * must be claimed by the new consumer.
   *
   * @param streamName - Stream to claim from
   * @param groupName - Consumer group name
   * @param consumerName - New consumer name to claim messages for
   * @param minIdleTimeMs - Only claim messages idle longer than this (ms)
   * @param messageIds - Specific message IDs to claim
   * @returns Claimed messages with their data
   *
   * @see OP-1 fix: Orphaned PEL message recovery
   */
  async xclaim(
    streamName: string,
    groupName: string,
    consumerName: string,
    minIdleTimeMs: number,
    messageIds: string[],
  ): Promise<StreamMessage[]> {
    if (messageIds.length === 0) return [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client as any).xclaim(
        streamName,
        groupName,
        consumerName,
        minIdleTimeMs,
        ...messageIds,
      );

      if (!result || result.length === 0) return [];

      // XCLAIM returns [[id, [field, value, ...]], ...] (same as XRANGE)
      const messages: StreamMessage[] = [];
      for (const entry of result) {
        if (!entry || !Array.isArray(entry) || entry.length < 2) continue;

        const [id, fields] = entry;
        if (!id || !Array.isArray(fields)) continue;

        const data: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i] as string] = fields[i + 1];
        }
        messages.push({ id: id as string, data });
      }

      return messages;
    } catch (error) {
      this.logger.error('XCLAIM error', { error, streamName, groupName });
      throw error;
    }
  }

  /**
   * Get detailed pending entries for a specific consumer or all consumers.
   *
   * Unlike xpending() which returns summary info, this returns individual
   * message IDs with their idle times — needed to build the XCLAIM list.
   *
   * @param streamName - Stream name
   * @param groupName - Consumer group name
   * @param start - Start ID (use '-' for beginning)
   * @param end - End ID (use '+' for end)
   * @param count - Maximum entries to return
   * @param consumerName - Optional: filter to specific consumer
   * @returns Array of pending entry details
   *
   * @see OP-1 fix: Orphaned PEL message recovery
   */
  async xpendingRange(
    streamName: string,
    groupName: string,
    start: string,
    end: string,
    count: number,
    consumerName?: string,
  ): Promise<Array<{ id: string; consumer: string; idleMs: number; deliveryCount: number }>> {
    try {
      const args: (string | number)[] = [streamName, groupName, start, end, count];
      if (consumerName) {
        args.push(consumerName);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client.xpending as any)(...args);

      if (!result || result.length === 0) return [];

      // Result format: [[messageId, consumerName, idleTime, deliveryCount], ...]
      return result.map((entry: unknown[]) => ({
        id: entry[0] as string,
        consumer: entry[1] as string,
        idleMs: entry[2] as number,
        deliveryCount: entry[3] as number,
      }));
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error);
      if (errMsg.includes('NOGROUP') || errMsg.includes('no such key')) {
        return [];
      }
      this.logger.error('XPENDING RANGE error', { error, streamName, groupName });
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
    // Return existing batcher if available and not destroyed
    const existing = this.batchers.get(streamName);
    if (existing && !existing.isDestroyed) {
      return existing as StreamBatcher<T>;
    }

    // Cleanup destroyed batcher entry if present
    if (existing) {
      this.batchers.delete(streamName);
    }

    const batcher = new StreamBatcher<T>(this, streamName, config, this.logger);
    this.batchers.set(streamName, batcher as StreamBatcher<unknown>);
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

  private parseStreamResult(result: unknown[], rejectedIds?: string[]): StreamMessage[] {
    const messages: StreamMessage[] = [];

    if (!result || result.length === 0) {
      return messages;
    }

    // Result format: [[streamName, [[id, [field, value, ...]], ...]]]
    for (const [streamName, entries] of result as Array<[string, Array<[string, string[]]>]>) {
      if (!entries) continue;

      for (const [id, fields] of entries) {
        // First pass: extract raw field values for signature verification
        let rawData: string | undefined;
        let sig: string | undefined;

        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i] as string;
          if (key === 'data') rawData = fields[i + 1] as string;
          if (key === 'sig') sig = fields[i + 1] as string;
        }

        // S-5: Verify HMAC signature when signing is enabled
        // OP-18 FIX: Pass stream name for replay protection
        if (this.signingKey && sig && rawData) {
          if (!this.verifySignature(rawData, sig, streamName as string)) {
            this.logger.warn('Invalid message signature, rejecting', { messageId: id });
            if (rejectedIds) rejectedIds.push(id);
            continue;
          }
        } else if (this.signingKey && !sig) {
          this.logger.warn('Unsigned message received with signing enabled, rejecting', { messageId: id });
          if (rejectedIds) rejectedIds.push(id);
          continue;
        } else if (this.signingKey && sig && !rawData) {
          // S-NEW-3 FIX: Reject malformed messages that have a signature but no data field.
          // Without this branch, such messages would pass through unverified.
          this.logger.warn('Malformed message: signature present but no data field, rejecting', { messageId: id });
          if (rejectedIds) rejectedIds.push(id);
          continue;
        }

        // Second pass: parse fields into object (skip 'sig' field from output)
        const data: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i] as string;
          if (key === 'sig') continue; // Don't include signature in parsed data
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

  // BUG-006 FIX: Use unknown[] instead of any[] for type safety
  private parseStreamInfo(result: unknown[]): StreamInfo {
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
          info.length = value as number;
          break;
        case 'radix-tree-keys':
          info.radixTreeKeys = value as number;
          break;
        case 'radix-tree-nodes':
          info.radixTreeNodes = value as number;
          break;
        case 'last-generated-id':
          info.lastGeneratedId = value as string;
          break;
        case 'groups':
          info.groups = value as number;
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

// StreamConsumer extracted to ./stream-consumer.ts for modularity
export { StreamConsumer } from './stream-consumer';
export type { StreamConsumerLogger, StreamConsumerConfig, StreamConsumerStats } from './stream-consumer';

// =============================================================================
// Batch Unwrap Helper
// =============================================================================

/**
 * Batch envelope shape produced by StreamBatcher.flush().
 * Used by unwrapBatchMessages to detect batched vs non-batched messages.
 */
interface BatchEnvelope<T> {
  type: 'batch';
  count: number;
  messages: T[];
  timestamp: number;
}

/**
 * Check if data is a batch envelope produced by StreamBatcher.
 */
function isBatchEnvelope<T>(data: unknown): data is BatchEnvelope<T> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'batch' &&
    Array.isArray((data as Record<string, unknown>).messages)
  );
}

/**
 * Unwrap batch envelopes from StreamBatcher into individual messages.
 *
 * When StreamBatcher flushes, it produces a batch envelope:
 *   { type: 'batch', count: N, messages: T[], timestamp: number }
 *
 * Consumers need to detect this and iterate over individual messages
 * instead of treating the batch envelope as a single message.
 *
 * This helper transparently handles both batched and non-batched messages:
 * - Batch envelope → returns data.messages (array of T)
 * - Non-batched message → returns [data as T] (single-element array)
 *
 * @param data - Raw message data from Redis stream (may be batch or single)
 * @returns Array of individual messages
 */
export function unwrapBatchMessages<T>(data: unknown): T[] {
  if (isBatchEnvelope<T>(data)) {
    return data.messages;
  }
  return [data as T];
}

// =============================================================================
// Singleton Factory
// =============================================================================

let streamsInstance: RedisStreamsClient | null = null;
let initializingPromise: Promise<RedisStreamsClient> | null = null; // Race condition guard

import { resolveRedisPassword } from './utils';
import { getErrorMessage } from '../resilience/error-handling';
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

  let redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
  // FIX #23: Don't send password to in-memory Redis (see redis.ts for details)
  // FIX #23b: Also strip password from URL — ioredis parses credentials from
  // redis://:password@host:port URLs regardless of the explicit password option.
  let redisPassword: string | undefined;
  if (process.env.REDIS_MEMORY_MODE === 'true') {
    redisPassword = undefined;
    redisUrl = redisUrl.replace(/redis:\/\/:[^@]+@/, 'redis://');
  } else {
    redisPassword = resolveRedisPassword(password);
  }

  // S-5 FIX (SEC-005): Resolve signing key from environment with explicit
  // empty/whitespace detection. Previously used `|| undefined` which silently
  // disabled HMAC signing when STREAM_SIGNING_KEY was set to empty/whitespace.
  const rawSigningKey = process.env.STREAM_SIGNING_KEY;
  let signingKey: string | undefined;
  if (rawSigningKey !== undefined) {
    const trimmed = rawSigningKey.trim();
    if (trimmed.length > 0) {
      signingKey = trimmed;
    } else {
      const factoryLogger = createLogger('redis-streams-factory');
      factoryLogger.warn('STREAM_SIGNING_KEY is set but empty/whitespace — HMAC signing DISABLED');
    }
  }

  // OP-17 FIX: Resolve previous signing key for rotation window
  const rawPreviousKey = process.env.STREAM_SIGNING_KEY_PREVIOUS;
  const previousSigningKey = rawPreviousKey?.trim() || undefined;

  initializingPromise = (async () => {
    try {
      const instance = new RedisStreamsClient(redisUrl, redisPassword, {
        signingKey,
        previousSigningKey,
      });

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

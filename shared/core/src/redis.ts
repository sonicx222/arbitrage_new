// Redis client for message queue and caching
import { Redis } from 'ioredis';
import { MessageEvent, ServiceHealth, PerformanceMetrics } from '../../types';
import { createLogger, Logger } from './logger';

// =============================================================================
// P2-FIX-1: Standardized Redis Error Handling
// =============================================================================
//
// Error Handling Pattern:
// -----------------------
// 1. WRITE operations (set, hset, sadd, zadd, etc.) - THROW on error
//    - Data loss is unacceptable; callers must handle write failures
//    - Returning 0/false masks real errors vs "nothing to write"
//
// 2. READ operations (get, hget, smembers, etc.) - Return null/empty on error
//    - Cache misses are expected; returning null is acceptable
//    - Callers can't distinguish "no data" from "Redis error" but this is
//      acceptable for cache scenarios where missing data triggers a refresh
//
// 3. CRITICAL operations (setNx, exists, eval) - THROW on error
//    - Used for distributed locking where silent failures cause race conditions
//    - Must distinguish "lock held by another" from "Redis unavailable"
//
// All methods log errors before throwing or returning defaults.
// =============================================================================

/**
 * P2-FIX-1: Custom error class for Redis operations.
 * Allows callers to distinguish Redis errors from other errors.
 */
export class RedisOperationError extends Error {
  constructor(
    public readonly operation: string,
    public readonly originalError: Error,
    public readonly key?: string
  ) {
    super(`Redis ${operation} failed${key ? ` for key '${key}'` : ''}: ${originalError.message}`);
    this.name = 'RedisOperationError';
  }
}

// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS: typeof import('../../config/src').SYSTEM_CONSTANTS | undefined;
try {
  SYSTEM_CONSTANTS = require('../../config/src').SYSTEM_CONSTANTS;
} catch {
  // Config not available, will use defaults
}

// P2-2-FIX: Default values for when config is not available
const REDIS_DEFAULTS = {
  maxMessageSize: SYSTEM_CONSTANTS?.redis?.maxMessageSize ?? 1024 * 1024,  // 1MB
  maxChannelNameLength: SYSTEM_CONSTANTS?.redis?.maxChannelNameLength ?? 128,
};

// P1-1 FIX: Define Redis connection options interface
interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  retryDelayOnFailover: number;
  enableReadyCheck: boolean;
  maxRetriesPerRequest: number;
  lazyConnect: boolean;
}

export class RedisClient {
  private client: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  // P2-FIX: Use proper Logger type
  private logger: Logger;

  constructor(url: string, password?: string) {
    this.logger = createLogger('redis-client');

    // P1-1 FIX: Use typed options instead of any
    const options: RedisConnectionOptions = {
      host: this.parseHost(url),
      port: this.parsePort(url),
      password,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3,
      lazyConnect: true
    };

    this.client = new Redis(url, options);
    this.pubClient = new Redis(url, options);
    this.subClient = new Redis(url, options);

    this.setupEventHandlers();
  }

  private parseHost(url: string): string {
    const match = url.match(/redis:\/\/(?:[^:]+:[^@]+@)?([^:]+):/);
    return match ? match[1] : 'localhost';
  }

  private parsePort(url: string): number {
    const match = url.match(/:(\d+)/);
    return match ? parseInt(match[1]) : 6379;
  }

  private setupEventHandlers(): void {
    // Clean up existing listeners to prevent memory leaks
    this.client.removeAllListeners('error');
    this.client.removeAllListeners('connect');
    this.client.removeAllListeners('ready');
    this.client.removeAllListeners('close');

    // P1-1 FIX: Use Error type instead of any
    this.client.on('error', (err: Error) => {
      this.logger?.error('Redis main client error', { error: err });
    });

    this.client.on('connect', () => {
      this.logger?.info('Redis main client connected');
    });

    this.client.on('ready', () => {
      this.logger?.debug('Redis main client ready');
    });

    this.client.on('close', () => {
      this.logger?.info('Redis main client closed');
    });

    // Setup pubClient event handlers
    this.pubClient.removeAllListeners('error');
    // P1-1 FIX: Use Error type instead of any
    this.pubClient.on('error', (err: Error) => {
      this.logger?.error('Redis pub client error', { error: err });
    });

    // Setup subClient event handlers
    this.subClient.removeAllListeners('error');
    this.subClient.removeAllListeners('message');
    // P1-1 FIX: Use Error type instead of any
    this.subClient.on('error', (err: Error) => {
      this.logger?.error('Redis sub client error', { error: err });
    });
  }

  // Message publishing with security validation
  async publish(channel: string, message: MessageEvent): Promise<number> {
    // SECURITY: Validate and sanitize inputs
    this.validateChannelName(channel);
    this.validateMessage(message);

    try {
      const serializedMessage = JSON.stringify({
        ...message,
        timestamp: Date.now()
      });

      // SECURITY: Limit message size to prevent DoS
      // P2-2-FIX: Use configured constant instead of magic number
      if (serializedMessage.length > REDIS_DEFAULTS.maxMessageSize) {
        throw new Error('Message too large');
      }

      return await this.pubClient.publish(channel, serializedMessage);
    } catch (error) {
      this.logger.error('Error publishing message', { error, channel });
      throw error;
    }
  }

  private validateChannelName(channel: string): void {
    // SECURITY: Only allow safe characters in channel names
    if (!channel || typeof channel !== 'string') {
      throw new Error('Invalid channel name: must be non-empty string');
    }

    // P2-2-FIX: Use configured constant instead of magic number
    if (channel.length > REDIS_DEFAULTS.maxChannelNameLength) {
      throw new Error('Channel name too long');
    }

    // Allow only alphanumeric, dash, underscore, and colon
    if (!/^[a-zA-Z0-9\-_:]+$/.test(channel)) {
      throw new Error('Invalid channel name: contains unsafe characters');
    }
  }

  private validateMessage(message: MessageEvent): void {
    // SECURITY: Validate MessageEvent structure
    if (!message || typeof message !== 'object') {
      throw new Error('Invalid message: must be object');
    }

    if (!message.type || typeof message.type !== 'string') {
      throw new Error('Invalid message: missing or invalid type');
    }

    if (message.timestamp && (typeof message.timestamp !== 'number' || message.timestamp < 0)) {
      throw new Error('Invalid message: invalid timestamp');
    }

    if (message.correlationId && typeof message.correlationId !== 'string') {
      throw new Error('Invalid message: invalid correlationId');
    }

    // SECURITY: Sanitize string fields
    if (message.source && typeof message.source === 'string') {
      message.source = message.source.replace(/[^a-zA-Z0-9\-_\.]/g, '');
    }

    if (message.correlationId && typeof message.correlationId === 'string') {
      message.correlationId = message.correlationId.replace(/[^a-zA-Z0-9\-_]/g, '');
    }
  }

  // Message subscription with cleanup tracking
  private subscriptions = new Map<string, { callback: (message: MessageEvent) => void; listener: Function }>();

  async subscribe(channel: string, callback: (message: MessageEvent) => void): Promise<void> {
    try {
      // Check if already subscribed to prevent duplicate listeners
      if (this.subscriptions.has(channel)) {
        this.logger.warn(`Already subscribed to channel ${channel}, replacing callback`);
        // Remove old listener first, then delete from map
        const oldSubscription = this.subscriptions.get(channel)!;
        this.subClient.removeListener('message', oldSubscription.listener as (...args: any[]) => void);
        this.subscriptions.delete(channel);
        // Note: We don't call subClient.unsubscribe() here because we're immediately resubscribing
      }

      // Create the listener BEFORE subscribing to prevent missing messages
      const listener = (receivedChannel: string, message: string) => {
        if (receivedChannel === channel) {
          try {
            const parsedMessage = JSON.parse(message);
            callback(parsedMessage);
          } catch (error) {
            this.logger.error('Error parsing message', { error, channel });
          }
        }
      };

      // Add listener first, then subscribe to channel
      this.subClient.on('message', listener);
      this.subscriptions.set(channel, { callback, listener });

      try {
        await this.subClient.subscribe(channel);
        this.logger.debug(`Subscribed to channel: ${channel}`);
      } catch (subscribeError) {
        // Rollback: remove listener if subscribe fails
        this.subClient.removeListener('message', listener as (...args: any[]) => void);
        this.subscriptions.delete(channel);
        throw subscribeError;
      }

    } catch (error) {
      this.logger.error('Error subscribing to channel', { error, channel });
      throw error;
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    const subscription = this.subscriptions.get(channel);
    if (!subscription) {
      return; // Nothing to unsubscribe
    }

    // Delete from map first to prevent race conditions
    this.subscriptions.delete(channel);

    try {
      // Remove listener
      this.subClient.removeListener('message', subscription.listener as (...args: any[]) => void);
      // Unsubscribe from channel
      await this.subClient.unsubscribe(channel);
      this.logger.debug(`Unsubscribed from channel: ${channel}`);
    } catch (error) {
      this.logger.error('Error unsubscribing from channel', { error, channel });
      // Don't re-add to map - channel is considered unsubscribed even if cleanup failed
    }
  }

  // Caching operations
  // P1-1 FIX: Use unknown instead of any for type safety
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      if (ttl) {
        await this.client.setex(key, ttl, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }
    } catch (error) {
      this.logger.error('Error setting cache', { error });
      throw error;
    }
  }

  async get<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error('Error getting cache', { error });
      return null;
    }
  }

  /**
   * P2-FIX-1: Delete throws on error - callers must know if deletion failed
   */
  async del(...keys: string[]): Promise<number> {
    try {
      if (keys.length === 0) return 0;
      return await this.client.del(...keys);
    } catch (error) {
      this.logger.error('Error deleting cache', { error, keys });
      throw new RedisOperationError('del', error as Error, keys.join(', '));
    }
  }

  /**
   * P2-FIX-1: Expire throws on error - TTL changes must be reliable
   */
  async expire(key: string, seconds: number): Promise<number> {
    try {
      return await this.client.expire(key, seconds);
    } catch (error) {
      this.logger.error('Error setting expire', { error, key });
      throw new RedisOperationError('expire', error as Error, key);
    }
  }

  /**
   * Set key only if it doesn't exist (for leader election)
   *
   * P0-3 FIX: Now throws on Redis errors instead of returning false.
   * This prevents silent failures where Redis being unavailable is
   * indistinguishable from the lock being held by another process.
   *
   * @returns true if the key was set, false if it already exists
   * @throws Error if Redis operation fails (network error, timeout, etc.)
   */
  async setNx(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      let result: string | null;
      if (ttlSeconds) {
        // SET key value NX EX seconds
        result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      } else {
        // SET key value NX
        result = await this.client.set(key, value, 'NX');
      }
      return result === 'OK';
    } catch (error) {
      // P0-3 FIX: Throw instead of returning false to distinguish
      // "lock held by another" from "Redis unavailable"
      this.logger.error('Error setting NX', { error, key });
      throw new Error(`Redis setNx failed: ${(error as Error).message}`);
    }
  }

  /**
   * P1-FIX: Throws on Redis errors to distinguish "key doesn't exist" from "Redis unavailable"
   * @returns true if key exists, false if key doesn't exist
   * @throws Error if Redis operation fails
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error('Error checking existence', { error, key });
      // P1-FIX: Throw instead of returning false to allow callers to distinguish
      // between "key doesn't exist" and "Redis unavailable"
      throw new Error(`Redis exists failed: ${(error as Error).message}`);
    }
  }

  /**
   * Execute a Lua script atomically.
   * Used for atomic operations like conditional delete (check-and-delete).
   *
   * @param script - Lua script to execute
   * @param keys - Array of keys to pass to the script (KEYS[1], KEYS[2], etc.)
   * @param args - Array of arguments to pass to the script (ARGV[1], ARGV[2], etc.)
   * @returns Script result
   */
  async eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T> {
    try {
      const result = await this.client.eval(script, keys.length, ...keys, ...args);
      return result as T;
    } catch (error) {
      this.logger.error('Error executing Lua script', { error });
      throw error;
    }
  }

  /**
   * P0-NEW-5 FIX: Atomic lock renewal using Lua script.
   * Atomically checks if the lock is owned by the given instanceId and extends TTL.
   * This prevents the TOCTOU race condition where another instance could acquire
   * the lock between the check and the TTL extension.
   *
   * @param key - Lock key
   * @param instanceId - Expected owner of the lock
   * @param ttlSeconds - New TTL to set if renewal succeeds
   * @returns true if lock was renewed, false if lock is owned by another instance or doesn't exist
   */
  async renewLockIfOwned(key: string, instanceId: string, ttlSeconds: number): Promise<boolean> {
    // Lua script for atomic compare-and-extend-TTL
    // Returns 1 if successful, 0 if lock doesn't exist or is owned by another instance
    const script = `
      local key = KEYS[1]
      local expected_owner = ARGV[1]
      local ttl_seconds = tonumber(ARGV[2])

      local current_owner = redis.call('GET', key)

      if current_owner == expected_owner then
        redis.call('EXPIRE', key, ttl_seconds)
        return 1
      else
        return 0
      end
    `;

    try {
      const result = await this.eval<number>(script, [key], [instanceId, String(ttlSeconds)]);
      return result === 1;
    } catch (error) {
      this.logger.error('Error renewing lock', { error, key, instanceId });
      return false;
    }
  }

  /**
   * P0-NEW-5 FIX: Atomic lock release using Lua script.
   * Atomically checks if the lock is owned by the given instanceId and deletes it.
   * This prevents releasing a lock that was acquired by another instance.
   *
   * @param key - Lock key
   * @param instanceId - Expected owner of the lock
   * @returns true if lock was released, false if lock is owned by another instance or doesn't exist
   */
  async releaseLockIfOwned(key: string, instanceId: string): Promise<boolean> {
    const script = `
      local key = KEYS[1]
      local expected_owner = ARGV[1]

      local current_owner = redis.call('GET', key)

      if current_owner == expected_owner then
        redis.call('DEL', key)
        return 1
      else
        return 0
      end
    `;

    try {
      const result = await this.eval<number>(script, [key], [instanceId]);
      return result === 1;
    } catch (error) {
      this.logger.error('Error releasing lock', { error, key, instanceId });
      return false;
    }
  }

  // Hash operations for complex data
  /**
   * P2-FIX-1: Hash set throws on error - writes must be reliable
   */
  async hset(key: string, field: string, value: unknown): Promise<number> {
    try {
      const serializedValue = JSON.stringify(value);
      return await this.client.hset(key, field, serializedValue);
    } catch (error) {
      this.logger.error('Error setting hash field', { error, key, field });
      throw new RedisOperationError('hset', error as Error, key);
    }
  }

  async hget<T = any>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.client.hget(key, field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error('Error getting hash field', { error });
      return null;
    }
  }

  async hgetall<T = any>(key: string): Promise<Record<string, T> | null> {
    try {
      const result = await this.client.hgetall(key);
      if (!result || Object.keys(result).length === 0) return null;

      const parsed: Record<string, T> = {};
      for (const [field, value] of Object.entries(result)) {
        parsed[field] = JSON.parse(value as string);
      }
      return parsed;
    } catch (error) {
      this.logger.error('Error getting all hash fields', { error });
      return null;
    }
  }

  // Set operations
  /**
   * P2-FIX-1: Set add throws on error - writes must be reliable
   */
  async sadd(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.sadd(key, ...members);
    } catch (error) {
      this.logger.error('Error sadd', { error, key });
      throw new RedisOperationError('sadd', error as Error, key);
    }
  }

  /**
   * P2-FIX-1: Set remove throws on error - writes must be reliable
   */
  async srem(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.srem(key, ...members);
    } catch (error) {
      this.logger.error('Error srem', { error, key });
      throw new RedisOperationError('srem', error as Error, key);
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      return await this.client.smembers(key);
    } catch (error) {
      this.logger.error('Error smembers', { error });
      return [];
    }
  }

  // Sorted Set operations
  /**
   * P2-FIX-1: Sorted set add throws on error - writes must be reliable
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    try {
      return await this.client.zadd(key, score, member);
    } catch (error) {
      this.logger.error('Error zadd', { error, key });
      throw new RedisOperationError('zadd', error as Error, key);
    }
  }

  async zrange(key: string, start: number, stop: number, withScores: string = ''): Promise<string[]> {
    try {
      if (withScores === 'WITHSCORES') {
        return await this.client.zrange(key, start, stop, 'WITHSCORES');
      }
      return await this.client.zrange(key, start, stop);
    } catch (error) {
      this.logger.error('Error zrange', { error });
      return [];
    }
  }

  /**
   * P2-FIX-1: Sorted set remove throws on error - writes must be reliable
   */
  async zrem(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.zrem(key, ...members);
    } catch (error) {
      this.logger.error('Error zrem', { error, key });
      throw new RedisOperationError('zrem', error as Error, key);
    }
  }

  async zcard(key: string): Promise<number> {
    try {
      return await this.client.zcard(key);
    } catch (error) {
      this.logger.error('Error zcard', { error });
      return 0;
    }
  }

  async zscore(key: string, member: string): Promise<string | null> {
    try {
      return await this.client.zscore(key, member);
    } catch (error) {
      this.logger.error('Error zscore', { error });
      return null;
    }
  }

  /**
   * P0-3 FIX: Remove elements from sorted set by score range.
   * P2-FIX-1: Throws on error - writes must be reliable
   * Used by rate limiter to remove expired entries.
   */
  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    try {
      return await this.client.zremrangebyscore(key, min, max);
    } catch (error) {
      this.logger.error('Error zremrangebyscore', { error, key });
      throw new RedisOperationError('zremrangebyscore', error as Error, key);
    }
  }

  /**
   * P0-3 FIX: Create a multi/transaction for atomic operations.
   * Returns an object that can chain Redis commands and execute atomically.
   */
  multi(): {
    zremrangebyscore: (key: string, min: number, max: number) => any;
    zadd: (key: string, score: number, member: string) => any;
    zcard: (key: string) => any;
    expire: (key: string, seconds: number) => any;
    zrange: (key: string, start: number, stop: number, withScores?: string) => any;
    exec: () => Promise<any[]>;
  } {
    const multi = this.client.multi();
    return {
      zremrangebyscore: (key: string, min: number, max: number) => {
        multi.zremrangebyscore(key, min, max);
        return multi;
      },
      zadd: (key: string, score: number, member: string) => {
        multi.zadd(key, score, member);
        return multi;
      },
      zcard: (key: string) => {
        multi.zcard(key);
        return multi;
      },
      expire: (key: string, seconds: number) => {
        multi.expire(key, seconds);
        return multi;
      },
      zrange: (key: string, start: number, stop: number, withScores?: string) => {
        if (withScores === 'WITHSCORES') {
          multi.zrange(key, start, stop, 'WITHSCORES');
        } else {
          multi.zrange(key, start, stop);
        }
        return multi;
      },
      exec: async () => {
        try {
          const result = await multi.exec();
          return result || [];
        } catch (error) {
          this.logger.error('Error executing multi', { error });
          // P2-FIX-1: Transactions should throw - atomic operations must be reliable
          throw new RedisOperationError('multi.exec', error as Error);
        }
      }
    };
  }

  // Key operations
  async keys(pattern: string): Promise<string[]> {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      this.logger.error('Error keys', { error });
      return [];
    }
  }

  /**
   * P1-3/P1-4 FIX: SCAN iterator for non-blocking key enumeration.
   * Use this instead of KEYS in production to avoid blocking Redis.
   *
   * @param cursor - Cursor position ('0' to start)
   * @param matchArg - 'MATCH' literal
   * @param pattern - Pattern to match keys
   * @param countArg - 'COUNT' literal
   * @param count - Number of keys to return per iteration
   * @returns Tuple of [nextCursor, keys[]]
   */
  async scan(
    cursor: string,
    matchArg: 'MATCH',
    pattern: string,
    countArg: 'COUNT',
    count: number
  ): Promise<[string, string[]]> {
    try {
      const result = await this.client.scan(cursor, matchArg, pattern, countArg, count);
      // Redis returns [cursor, keys[]] - cursor is string, keys is array
      return [result[0], result[1]];
    } catch (error) {
      this.logger.error('Error scan', { error, pattern });
      return ['0', []]; // Return done cursor with empty results on error
    }
  }

  async llen(key: string): Promise<number> {
    try {
      return await this.client.llen(key);
    } catch (error) {
      this.logger.error('Error llen', { error });
      return 0;
    }
  }

  /**
   * P2-FIX-1: List push throws on error - writes must be reliable
   */
  async lpush(key: string, ...values: string[]): Promise<number> {
    try {
      return await this.client.lpush(key, ...values);
    } catch (error) {
      this.logger.error('Error lpush', { error, key });
      throw new RedisOperationError('lpush', error as Error, key);
    }
  }

  async rpop(key: string): Promise<string | null> {
    try {
      return await this.client.rpop(key);
    } catch (error) {
      this.logger.error('Error rpop', { error });
      return null;
    }
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      return await this.client.lrange(key, start, stop);
    } catch (error) {
      this.logger.error('Error lrange', { error });
      return [];
    }
  }

  /**
   * P2-FIX-1: List trim throws on error - writes must be reliable
   */
  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    try {
      return await this.client.ltrim(key, start, stop);
    } catch (error) {
      this.logger.error('Error ltrim', { error, key });
      throw new RedisOperationError('ltrim', error as Error, key);
    }
  }

  // Service health tracking
  async updateServiceHealth(serviceName: string, health: ServiceHealth): Promise<void> {
    const key = `health:${serviceName}`;
    await this.set(key, health, 300); // 5 minute TTL
  }

  async getServiceHealth(serviceName: string): Promise<ServiceHealth | null> {
    const key = `health:${serviceName}`;
    return await this.get<ServiceHealth>(key);
  }

  /**
   * P1-FIX: Use SCAN instead of KEYS to avoid blocking Redis
   * KEYS command blocks on large datasets; SCAN is non-blocking and iterative.
   */
  async getAllServiceHealth(): Promise<Record<string, ServiceHealth>> {
    try {
      const health: Record<string, ServiceHealth> = {};
      let cursor = '0';

      // P1-FIX: Use SCAN iterator for non-blocking key enumeration
      do {
        const [nextCursor, keys] = await this.scan(cursor, 'MATCH', 'health:*', 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          const serviceName = key.replace('health:', '');
          const serviceHealth = await this.get<ServiceHealth>(key);
          if (serviceHealth) {
            health[serviceName] = serviceHealth;
          }
        }
      } while (cursor !== '0');

      return health;
    } catch (error) {
      this.logger.error('Error getting all service health', { error });
      return {};
    }
  }

  // Performance metrics
  async recordMetrics(serviceName: string, metrics: PerformanceMetrics): Promise<void> {
    // Use time-bucketed keys instead of millisecond precision to prevent memory leaks
    const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-minute buckets
    const key = `metrics:${serviceName}:${timeBucket}`;

    // Store metrics in a hash to aggregate within the time bucket
    const field = Date.now().toString();
    await this.hset(key, field, metrics);

    // Set TTL on the hash key (24 hours)
    await this.client.expire(key, 86400);

    // Also maintain a rolling window of recent metrics (limit to prevent unbounded growth)
    const rollingKey = `metrics:${serviceName}:recent`;
    const serialized = JSON.stringify(metrics);

    // Check current list length before adding
    const currentLength = await this.client.llen(rollingKey);
    if (currentLength >= 100) {
      // Remove oldest entry before adding new one
      await this.client.rpop(rollingKey);
    }
    await this.client.lpush(rollingKey, serialized);

    // Set TTL on rolling key as well
    await this.client.expire(rollingKey, 86400);
  }

  async getRecentMetrics(serviceName: string, count: number = 10): Promise<PerformanceMetrics[]> {
    try {
      const rollingKey = `metrics:${serviceName}:recent`;
      const metrics = await this.client.lrange(rollingKey, 0, count - 1);

      return metrics.map((m: string) => JSON.parse(m)).reverse(); // Most recent first
    } catch (error) {
      this.logger.error('Error getting recent metrics', { error });
      return [];
    }
  }

  // Cleanup and maintenance
  async disconnect(): Promise<void> {
    try {
      this.logger.info('Disconnecting Redis clients');

      // Clean up subscriptions to prevent memory leaks
      for (const [channel, subscription] of this.subscriptions) {
        try {
          this.subClient.removeListener('message', subscription.listener as (...args: any[]) => void);
          await this.subClient.unsubscribe(channel);
        } catch (error) {
          this.logger.warn(`Error cleaning up subscription for ${channel}`, { error });
        }
      }
      this.subscriptions.clear();

      // Remove all remaining event listeners to prevent memory leaks
      this.client.removeAllListeners();
      this.pubClient.removeAllListeners();
      this.subClient.removeAllListeners();

      // Disconnect all clients with timeout to prevent hanging
      const disconnectPromises = [
        this.client.disconnect(),
        this.pubClient.disconnect(),
        this.subClient.disconnect()
      ];

      // Add timeout to prevent indefinite waiting
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis disconnect timeout')), 5000);
      });

      await Promise.race([Promise.all(disconnectPromises), timeoutPromise]);

      this.logger.info('Redis clients disconnected successfully');
    } catch (error) {
      this.logger.error('Error during Redis disconnect', { error });
      // Force disconnect even if there were errors
      try {
        this.client.disconnect();
        this.pubClient.disconnect();
        this.subClient.disconnect();
      } catch (forceError) {
        this.logger.error('Force disconnect also failed', { error: forceError });
      }
    }
  }

  // Health check
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }
}

// Thread-safe singleton with proper async initialization
let redisInstance: RedisClient | null = null;
let redisInstancePromise: Promise<RedisClient> | null = null;
let initializationError: Error | null = null;

export async function getRedisClient(url?: string, password?: string): Promise<RedisClient> {
  // If already initialized successfully, return immediately
  if (redisInstance) {
    return redisInstance;
  }

  // If there's a cached error, throw it
  if (initializationError) {
    throw initializationError;
  }

  // If initialization is already in progress, wait for it
  if (redisInstancePromise) {
    try {
      redisInstance = await redisInstancePromise;
      return redisInstance;
    } catch (error) {
      initializationError = error as Error;
      throw error;
    }
  }

  // Start new initialization
  redisInstancePromise = (async (): Promise<RedisClient> => {
    try {
      const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
      const redisPassword = password || process.env.REDIS_PASSWORD;

      const instance = new RedisClient(redisUrl, redisPassword);

      // Wait for initial connection to ensure the client is ready
      await instance.ping();

      redisInstance = instance;
      return instance;
    } catch (error) {
      initializationError = error as Error;
      throw error;
    }
  })();

  try {
    redisInstance = await redisInstancePromise;
    return redisInstance;
  } catch (error) {
    throw error;
  }
}

// Synchronous version - only use after async initialization
export function getRedisClientSync(): RedisClient | null {
  if (initializationError) {
    throw initializationError;
  }
  return redisInstance;
}

// Health check for Redis connectivity
export async function checkRedisHealth(url?: string, password?: string): Promise<boolean> {
  try {
    const client = new RedisClient(url || process.env.REDIS_URL || 'redis://localhost:6379', password || process.env.REDIS_PASSWORD);
    const isHealthy = await client.ping();
    await client.disconnect(); // Clean up test client
    return isHealthy;
  } catch (error) {
    return false;
  }
}

// Reset singleton for testing purposes
// P0-FIX: Made async to properly await disconnect and handle in-flight initialization
export async function resetRedisInstance(): Promise<void> {
  // P0-FIX: If initialization is in progress, wait for it to complete
  // This prevents race conditions during test cleanup
  if (redisInstancePromise && !redisInstance) {
    try {
      await redisInstancePromise;
    } catch {
      // Ignore init errors - we're resetting anyway
    }
  }

  if (redisInstance) {
    try {
      await redisInstance.disconnect();
    } catch {
      // Best effort cleanup - log but don't throw
    }
  }
  redisInstance = null;
  redisInstancePromise = null;
  initializationError = null;
}
/**
 * Redis Client Unit Tests
 *
 * Tests for the Redis client wrapper with pub/sub and caching functionality.
 *
 * @migrated from shared/core/src/__tests__/redis.test.ts
 * @see ADR-009: Test Architecture
 *
 * Uses DI pattern for testability - injects mock Redis constructor
 * instead of relying on Jest mock hoisting (which doesn't work with
 * package alias imports like @arbitrage/core).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Import from package alias (new pattern per ADR-009)
import { RedisClient, getRedisClient, resetRedisInstance } from '@arbitrage/core/redis';
import type { RedisConstructor } from '@arbitrage/core/redis';

// =============================================================================
// Mock Redis Implementation
// =============================================================================

 
type MockRedisInstance = any;

/**
 * Creates a mock Redis instance with all required methods.
 * Each instance tracks its own method calls.
 *
 * Note: Uses `any` type to avoid Jest's strict mock typing issues
 * that arise from the project's TypeScript configuration.
 */
function createMockRedisInstance(): MockRedisInstance {
  // Use EventEmitter for proper event handling
  const emitter = new EventEmitter();

  // Create instance object - use any to avoid Jest mock type issues
  const instance: MockRedisInstance = {};

  // Event methods with proper chaining
  instance.on = jest.fn((event: string, handler: (...args: any[]) => void) => {
    emitter.on(event, handler);
    return instance;
  });

  instance.removeAllListeners = jest.fn((event?: string) => {
    if (event) {
      emitter.removeAllListeners(event);
    } else {
      emitter.removeAllListeners();
    }
    return instance;
  });

  instance.removeListener = jest.fn((event: string, listener: (...args: any[]) => void) => {
    emitter.removeListener(event, listener);
    return instance;
  });

  instance.emit = jest.fn((event: string, ...args: any[]) => {
    return emitter.emit(event, ...args);
  });

  // Connection methods
  instance.connect = jest.fn(() => Promise.resolve());
  instance.disconnect = jest.fn(() => Promise.resolve());
  instance.ping = jest.fn(() => Promise.resolve('PONG'));

  // Basic operations
  instance.set = jest.fn(() => Promise.resolve('OK'));
  instance.get = jest.fn(() => Promise.resolve(null));
  instance.setex = jest.fn(() => Promise.resolve('OK'));
  instance.del = jest.fn(() => Promise.resolve(1));
  instance.exists = jest.fn(() => Promise.resolve(0));
  instance.expire = jest.fn(() => Promise.resolve(1));
  instance.keys = jest.fn(() => Promise.resolve([]));

  // Pub/Sub
  instance.publish = jest.fn(() => Promise.resolve(1));
  instance.subscribe = jest.fn(() => Promise.resolve(1));
  instance.unsubscribe = jest.fn(() => Promise.resolve(1));

  // Hash operations
  instance.hset = jest.fn(() => Promise.resolve(1));
  instance.hget = jest.fn(() => Promise.resolve(null));
  instance.hgetall = jest.fn(() => Promise.resolve({}));

  // List operations
  instance.lpush = jest.fn(() => Promise.resolve(1));
  instance.lrange = jest.fn(() => Promise.resolve([]));
  instance.ltrim = jest.fn(() => Promise.resolve('OK'));
  instance.llen = jest.fn(() => Promise.resolve(0));
  instance.rpop = jest.fn(() => Promise.resolve(null));

  // Sorted set operations
  instance.zadd = jest.fn(() => Promise.resolve(1));
  instance.zrange = jest.fn(() => Promise.resolve([]));
  instance.zrem = jest.fn(() => Promise.resolve(1));
  instance.zcard = jest.fn(() => Promise.resolve(0));
  instance.zscore = jest.fn(() => Promise.resolve(null));
  instance.zremrangebyscore = jest.fn(() => Promise.resolve(0));

  // Set operations
  instance.sadd = jest.fn(() => Promise.resolve(1));
  instance.srem = jest.fn(() => Promise.resolve(1));
  instance.smembers = jest.fn(() => Promise.resolve([]));

  // Scan
  instance.scan = jest.fn(() => Promise.resolve(['0', []]));

  // Eval for Lua scripts
  instance.eval = jest.fn(() => Promise.resolve(1));

  // Multi/transaction
  instance.multi = jest.fn(() => {
    const multiInstance = {
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      zrange: jest.fn().mockReturnThis(),
      exec: jest.fn(() => Promise.resolve([]))
    };
    return multiInstance;
  });

  return instance;
}

/**
 * Creates a mock Redis constructor that returns pre-created instances.
 * This allows us to capture and verify interactions with each instance.
 */
function createMockRedisConstructor() {
  const instances: MockRedisInstance[] = [];

  const MockRedis = jest.fn(() => {
    const instance = createMockRedisInstance();
    instances.push(instance);
    return instance;
  }) as unknown as RedisConstructor;

  return { MockRedis, instances };
}

describe('RedisClient', () => {
  let redisClient: RedisClient;
  let mockInstances: MockRedisInstance[];
  let MockRedis: RedisConstructor;

  // Helper to get the three Redis clients
  const getClients = () => ({
    mainClient: mockInstances[0],
    pubClient: mockInstances[1],
    subClient: mockInstances[2]
  });

  beforeEach(async () => {
    // Reset singleton state
    await resetRedisInstance();

    // Create mock Redis constructor
    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    mockInstances = mocks.instances;

    // Create new instance with injected mock
    redisClient = new RedisClient('redis://localhost:6379', 'password', {
      RedisImpl: MockRedis
    });
  });

  afterEach(async () => {
    // Reset disconnect mocks to prevent cleanup errors
    for (const instance of mockInstances) {
      instance.disconnect.mockResolvedValue(undefined);
    }
    try {
      await redisClient.disconnect();
    } catch {
      // Ignore disconnect errors during cleanup
    }
  });

  describe('initialization', () => {
    it('should initialize with correct options', () => {
      const { mainClient } = getClients();
      expect(mainClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mainClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mainClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(mainClient.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should create three Redis clients (main, pub, sub)', () => {
      expect(mockInstances.length).toBe(3);
      expect(MockRedis).toHaveBeenCalledTimes(3);
    });

    it('should parse host and port correctly', () => {
      // Test is implicit in constructor call
      expect(redisClient).toBeDefined();
    });
  });

  describe('singleton behavior', () => {
    it('should return same instance on multiple calls', async () => {
      const instance1 = await getRedisClient();
      const instance2 = await getRedisClient();

      expect(instance1).toBe(instance2);
    });

    it('should handle concurrent initialization', async () => {
      // Reset for clean test
      await resetRedisInstance();

      // Start multiple concurrent initializations
      const promises = [
        getRedisClient(),
        getRedisClient(),
        getRedisClient()
      ];

      const results = await Promise.all(promises);

      // All should return the same instance
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });

  describe('publish/subscribe', () => {
    it('should publish messages with timestamp', async () => {
      const { pubClient } = getClients();
      const channel = 'test-channel';
      const message = {
        type: 'test',
        data: 'hello',
        timestamp: Date.now(),
        source: 'test'
      };

      pubClient.publish.mockResolvedValue(1);

      const result = await redisClient.publish(channel, message);

      expect(pubClient.publish).toHaveBeenCalledWith(
        channel,
        expect.stringContaining('"timestamp":')
      );
      expect(result).toBe(1);
    });

    it('should handle publish errors', async () => {
      const { pubClient } = getClients();
      pubClient.publish.mockRejectedValue(new Error('Publish failed'));

      await expect(redisClient.publish('test', {
        type: 'test',
        data: 'test',
        timestamp: Date.now(),
        source: 'test'
      }))
        .rejects
        .toThrow('Publish failed');
    });

    it('should subscribe to channels', async () => {
      const { subClient } = getClients();
      const channel = 'test-channel';
      const callback = jest.fn();

      subClient.subscribe.mockResolvedValue(1);

      await redisClient.subscribe(channel, callback);

      expect(subClient.subscribe).toHaveBeenCalledWith(channel);
    });

    it('should prevent duplicate subscriptions', async () => {
      const { subClient } = getClients();
      const channel = 'test-channel';
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      subClient.subscribe.mockResolvedValue(1);

      await redisClient.subscribe(channel, callback1);

      // Second subscription should warn and replace
      await redisClient.subscribe(channel, callback2);

      expect(subClient.subscribe).toHaveBeenCalledTimes(2);
    });

    it('should unsubscribe from channels', async () => {
      const { subClient } = getClients();
      const channel = 'test-channel';
      const callback = jest.fn();

      subClient.subscribe.mockResolvedValue(1);
      await redisClient.subscribe(channel, callback);
      await redisClient.unsubscribe(channel);

      expect(subClient.unsubscribe).toHaveBeenCalledWith(channel);
    });
  });

  describe('caching operations', () => {
    it('should set values with TTL', async () => {
      const { mainClient } = getClients();
      const key = 'test-key';
      const value = { data: 'test' };
      const ttl = 300;

      await redisClient.set(key, value, ttl);

      expect(mainClient.setex).toHaveBeenCalledWith(key, ttl, JSON.stringify(value));
    });

    it('should set values without TTL', async () => {
      const { mainClient } = getClients();
      const key = 'test-key';
      const value = { data: 'test' };

      await redisClient.set(key, value);

      expect(mainClient.set).toHaveBeenCalledWith(key, JSON.stringify(value));
    });

    it('should get and parse values', async () => {
      const { mainClient } = getClients();
      const key = 'test-key';
      const value = { data: 'test' };

      mainClient.get.mockResolvedValue(JSON.stringify(value));

      const result = await redisClient.get(key);

      expect(result).toEqual(value);
      expect(mainClient.get).toHaveBeenCalledWith(key);
    });

    it('should return null for non-existent keys', async () => {
      const { mainClient } = getClients();
      mainClient.get.mockResolvedValue(null);

      const result = await redisClient.get('non-existent');

      expect(result).toBeNull();
    });

    it('should handle JSON parse errors gracefully', async () => {
      const { mainClient } = getClients();
      mainClient.get.mockResolvedValue('invalid json');

      const result = await redisClient.get('test-key');

      expect(result).toBeNull();
    });
  });

  describe('hash operations', () => {
    it('should set hash fields', async () => {
      const { mainClient } = getClients();
      const key = 'hash-key';
      const field = 'field1';
      const value = { nested: 'data' };

      await redisClient.hset(key, field, value);

      expect(mainClient.hset).toHaveBeenCalledWith(key, field, JSON.stringify(value));
    });

    it('should get hash fields', async () => {
      const { mainClient } = getClients();
      const key = 'hash-key';
      const field = 'field1';
      const value = { nested: 'data' };

      mainClient.hget.mockResolvedValue(JSON.stringify(value));

      const result = await redisClient.hget(key, field);

      expect(result).toEqual(value);
    });

    it('should get all hash fields', async () => {
      const { mainClient } = getClients();
      const key = 'hash-key';
      const hashData = {
        field1: JSON.stringify('value1'),
        field2: JSON.stringify({ nested: 'value2' })
      };

      mainClient.hgetall.mockResolvedValue(hashData);

      const result = await redisClient.hgetall(key);

      expect(result).toEqual({
        field1: 'value1',
        field2: { nested: 'value2' }
      });
    });
  });

  describe('health monitoring', () => {
    it('should ping successfully', async () => {
      const result = await redisClient.ping();
      expect(result).toBe(true);
    });

    it('should handle ping failures', async () => {
      const { mainClient } = getClients();
      mainClient.ping.mockRejectedValue(new Error('Connection failed'));

      const result = await redisClient.ping();
      expect(result).toBe(false);
    });
  });

  describe('cleanup and error handling', () => {
    it('should disconnect gracefully', async () => {
      const { mainClient } = getClients();

      await redisClient.disconnect();

      expect(mainClient.disconnect).toHaveBeenCalled();
    });

    it('should clean up subscriptions on disconnect', async () => {
      const { mainClient, subClient } = getClients();
      const callback = jest.fn();

      subClient.subscribe.mockResolvedValue(1);
      await redisClient.subscribe('test-channel', callback);

      await redisClient.disconnect();

      expect(mainClient.removeAllListeners).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle Redis errors gracefully', async () => {
      const { mainClient } = getClients();
      mainClient.get.mockRejectedValue(new Error('Redis error'));

      const result = await redisClient.get('test-key');

      expect(result).toBeNull();
    });

    it('should handle subscription errors', async () => {
      const { subClient } = getClients();
      // Mock the subClient subscribe to reject
      subClient.subscribe.mockRejectedValue(new Error('Subscribe failed'));

      await expect(redisClient.subscribe('test-channel', jest.fn()))
        .rejects
        .toThrow('Subscribe failed');
    });
  });

  // ===========================================================================
  // S4.1.1-FIX-4: Tests for atomic lock operations (renewLockIfOwned, releaseLockIfOwned)
  // ===========================================================================

  describe('renewLockIfOwned', () => {
    it('should return true when lock is owned and renewal succeeds', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 1 (success)
      mainClient.eval.mockResolvedValue(1);

      const result = await redisClient.renewLockIfOwned('lock:test', 'instance-1', 30);

      expect(result).toBe(true);
      expect(mainClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'lock:test',
        'instance-1',
        '30'
      );
    });

    it('should return false when lock is owned by another instance', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 0 (lock owned by another)
      mainClient.eval.mockResolvedValue(0);

      const result = await redisClient.renewLockIfOwned('lock:test', 'instance-1', 30);

      expect(result).toBe(false);
    });

    it('should return false when lock does not exist', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 0 (lock doesn't exist)
      mainClient.eval.mockResolvedValue(0);

      const result = await redisClient.renewLockIfOwned('lock:test', 'instance-1', 30);

      expect(result).toBe(false);
    });

    it('should throw RedisOperationError on Redis failure', async () => {
      const { mainClient } = getClients();
      // Mock eval to reject (Redis unavailable)
      mainClient.eval.mockRejectedValue(new Error('Connection refused'));

      await expect(redisClient.renewLockIfOwned('lock:test', 'instance-1', 30))
        .rejects
        .toThrow('Redis renewLockIfOwned failed');
    });
  });

  describe('releaseLockIfOwned', () => {
    it('should return true when lock is owned and release succeeds', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 1 (success)
      mainClient.eval.mockResolvedValue(1);

      const result = await redisClient.releaseLockIfOwned('lock:test', 'instance-1');

      expect(result).toBe(true);
      expect(mainClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'lock:test',
        'instance-1'
      );
    });

    it('should return false when lock is owned by another instance', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 0 (lock owned by another)
      mainClient.eval.mockResolvedValue(0);

      const result = await redisClient.releaseLockIfOwned('lock:test', 'instance-1');

      expect(result).toBe(false);
    });

    it('should return false when lock does not exist', async () => {
      const { mainClient } = getClients();
      // Mock eval to return 0 (lock doesn't exist)
      mainClient.eval.mockResolvedValue(0);

      const result = await redisClient.releaseLockIfOwned('lock:test', 'instance-1');

      expect(result).toBe(false);
    });

    it('should throw RedisOperationError on Redis failure', async () => {
      const { mainClient } = getClients();
      // Mock eval to reject (Redis unavailable)
      mainClient.eval.mockRejectedValue(new Error('Connection refused'));

      await expect(redisClient.releaseLockIfOwned('lock:test', 'instance-1'))
        .rejects
        .toThrow('Redis releaseLockIfOwned failed');
    });
  });
});

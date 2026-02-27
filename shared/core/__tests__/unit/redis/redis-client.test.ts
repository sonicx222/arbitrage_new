/**
 * Unit Tests for RedisClient
 *
 * M5: Tests connection lifecycle, reconnection strategy, error handling,
 * validation, and command tracking using constructor DI mock.
 *
 * @see shared/core/src/redis/client.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { RedisClient, RedisOperationError } from '../../../src/redis/client';

// =============================================================================
// Mock Redis Implementation
// =============================================================================

class MockRedisInstance extends EventEmitter {
  public connectCalled = false;
  public disconnectCalled = false;
  public lastOptions: any;

  // Command tracking
  public commands: Array<{ name: string; args: any[] }> = [];

  constructor(_url: string, options: any) {
    super();
    this.lastOptions = options;
  }

  async connect(): Promise<void> {
    this.connectCalled = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }

  async ping(): Promise<string> {
    this.commands.push({ name: 'ping', args: [] });
    return 'PONG';
  }

  async set(key: string, value: string): Promise<string> {
    this.commands.push({ name: 'set', args: [key, value] });
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    this.commands.push({ name: 'setex', args: [key, seconds, value] });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.commands.push({ name: 'get', args: [key] });
    return null;
  }

  async getex(key: string, _flag: string, _ttl: number): Promise<string | null> {
    this.commands.push({ name: 'getex', args: [key] });
    return null;
  }

  async del(...keys: string[]): Promise<number> {
    this.commands.push({ name: 'del', args: keys });
    return keys.length;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.commands.push({ name: 'publish', args: [channel, message] });
    return 1;
  }

  async subscribe(channel: string): Promise<void> {
    this.commands.push({ name: 'subscribe', args: [channel] });
  }

  async unsubscribe(channel: string): Promise<void> {
    this.commands.push({ name: 'unsubscribe', args: [channel] });
  }

  // ioredis methods
  removeAllListeners(event?: string): this {
    super.removeAllListeners(event);
    return this;
  }
}

// Track instances created by the mock constructor
let mockInstances: MockRedisInstance[] = [];

function MockRedisConstructor(url: string, options: any): MockRedisInstance {
  const instance = new MockRedisInstance(url, options);
  mockInstances.push(instance);
  return instance;
}

// =============================================================================
// Tests
// =============================================================================

describe('RedisClient', () => {
  let client: RedisClient;

  beforeEach(() => {
    mockInstances = [];
    client = new RedisClient('redis://localhost:6379', undefined, {
      RedisImpl: MockRedisConstructor as any,
    });
  });

  afterEach(async () => {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors in cleanup
    }
  });

  // ---------------------------------------------------------------------------
  // Constructor & Connection Parsing
  // ---------------------------------------------------------------------------

  describe('Constructor', () => {
    it('should create 3 Redis instances (main, pub, sub)', () => {
      expect(mockInstances.length).toBe(3);
    });

    it('should parse host and port from URL', () => {
      const opts = mockInstances[0].lastOptions;
      expect(opts.host).toBe('localhost');
      expect(opts.port).toBe(6379);
    });

    it('should parse custom host and port', () => {
      mockInstances = [];
      new RedisClient('redis://myhost:7777', undefined, {
        RedisImpl: MockRedisConstructor as any,
      });
      expect(mockInstances[0].lastOptions.host).toBe('myhost');
      expect(mockInstances[0].lastOptions.port).toBe(7777);
    });

    it('should pass password to constructor', () => {
      mockInstances = [];
      new RedisClient('redis://localhost:6379', 'secret', {
        RedisImpl: MockRedisConstructor as any,
      });
      expect(mockInstances[0].lastOptions.password).toBe('secret');
    });

    it('should enable lazyConnect', () => {
      expect(mockInstances[0].lastOptions.lazyConnect).toBe(true);
    });

    it('should set maxRetriesPerRequest to 3', () => {
      expect(mockInstances[0].lastOptions.maxRetriesPerRequest).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry Strategy
  // ---------------------------------------------------------------------------

  describe('Retry Strategy', () => {
    it('should use exponential backoff', () => {
      const strategy = mockInstances[0].lastOptions.retryStrategy;
      expect(strategy).toBeDefined();

      // First retry: 200ms
      expect(strategy(1)).toBe(200);
      // Second retry: 400ms
      expect(strategy(2)).toBe(400);
      // Third retry: 800ms
      expect(strategy(3)).toBe(800);
    });

    it('should cap backoff at 30000ms', () => {
      const strategy = mockInstances[0].lastOptions.retryStrategy;
      // Very high attempt number should not exceed 30000ms
      expect(strategy(10)).toBeLessThanOrEqual(30000);
    });

    it('should give up after 15 retries', () => {
      const strategy = mockInstances[0].lastOptions.retryStrategy;
      expect(strategy(16)).toBeNull();
    });

    it('should reconnect on READONLY error', () => {
      const reconnectOnError = mockInstances[0].lastOptions.reconnectOnError;
      expect(reconnectOnError(new Error('READONLY You cannot write against a read only replica'))).toBe(true);
      expect(reconnectOnError(new Error('some other error'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect Lifecycle
  // ---------------------------------------------------------------------------

  describe('disconnect', () => {
    it('should disconnect all 3 clients', async () => {
      await client.disconnect();
      expect(mockInstances[0].disconnectCalled).toBe(true);
      expect(mockInstances[1].disconnectCalled).toBe(true);
      expect(mockInstances[2].disconnectCalled).toBe(true);
    });

    it('should not throw when disconnect is called multiple times', async () => {
      await client.disconnect();
      // Second disconnect should be safe (already disconnected)
      await expect(client.disconnect()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('Channel Validation', () => {
    const validMessage = { type: 'test', data: {}, timestamp: Date.now(), source: 'test' };

    it('should reject empty channel name', async () => {
      await expect(client.publish('', validMessage)).rejects.toThrow('Invalid channel name');
    });

    it('should reject channel name with unsafe characters', async () => {
      await expect(client.publish('chan nel', validMessage)).rejects.toThrow('unsafe characters');
    });

    it('should accept valid channel name with colons, dashes, underscores', async () => {
      await expect(client.publish('stream:price-updates_v2', validMessage)).resolves.toBe(1);
    });
  });

  describe('Message Validation', () => {
    it('should reject null message', async () => {
      await expect(client.publish('test', null as any)).rejects.toThrow('must be object');
    });

    it('should reject message without type', async () => {
      await expect(client.publish('test', { data: {} } as any)).rejects.toThrow('missing or invalid type');
    });

    it('should reject message with negative timestamp', async () => {
      await expect(
        client.publish('test', { type: 'test', data: {}, timestamp: -1, source: 'test' })
      ).rejects.toThrow('invalid timestamp');
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Operations
  // ---------------------------------------------------------------------------

  describe('set / get', () => {
    it('should serialize to JSON on set', async () => {
      await client.set('key', { foo: 'bar' });
      const mainClient = mockInstances[0];
      const setCmd = mainClient.commands.find(c => c.name === 'set');
      expect(setCmd).toBeDefined();
      expect(JSON.parse(setCmd!.args[1])).toEqual({ foo: 'bar' });
    });

    it('should use setex when TTL is provided', async () => {
      await client.set('key', 'value', 60);
      const mainClient = mockInstances[0];
      const setexCmd = mainClient.commands.find(c => c.name === 'setex');
      expect(setexCmd).toBeDefined();
      expect(setexCmd!.args[1]).toBe(60);
    });

    it('should return null for cache miss on get', async () => {
      const result = await client.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should throw on set error (write operation)', async () => {
      mockInstances[0].set = jest.fn().mockRejectedValue(new Error('Connection refused'));
      await expect(client.set('key', 'value')).rejects.toThrow('Connection refused');
    });

    it('should return null on get error (read operation)', async () => {
      mockInstances[0].get = jest.fn().mockRejectedValue(new Error('Connection refused'));
      const result = await client.get('key');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Delete Operation
  // ---------------------------------------------------------------------------

  describe('del', () => {
    it('should return 0 for empty key list', async () => {
      const result = await client.del();
      expect(result).toBe(0);
    });

    it('should throw RedisOperationError on del failure', async () => {
      mockInstances[0].del = jest.fn().mockRejectedValue(new Error('Redis down'));
      await expect(client.del('key1')).rejects.toThrow(RedisOperationError);
    });
  });

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  describe('ping', () => {
    it('should return true when Redis responds PONG', async () => {
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it('should return false on ping failure', async () => {
      mockInstances[0].ping = jest.fn().mockRejectedValue(new Error('timeout'));
      const result = await client.ping();
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Command Tracking
  // ---------------------------------------------------------------------------

  describe('Command Tracking', () => {
    it('should track commands by category and name', () => {
      client.trackCommand('get');
      client.trackCommand('get');
      client.trackCommand('xadd');

      const stats = client.getCommandStats();
      expect(stats.totalCommands).toBe(3);
      expect(stats.byCommand['get']).toBe(2);
      expect(stats.byCommand['xadd']).toBe(1);
      expect(stats.byCategory['cache']).toBe(2);
      expect(stats.byCategory['stream']).toBe(1);
    });

    it('should calculate daily limit percentage', () => {
      for (let i = 0; i < 100; i++) {
        client.trackCommand('get');
      }
      const stats = client.getCommandStats();
      expect(stats.totalCommands).toBe(100);
      expect(stats.dailyLimitPercent).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // RedisOperationError
  // ---------------------------------------------------------------------------

  describe('RedisOperationError', () => {
    it('should include operation name in message', () => {
      const err = new RedisOperationError('set', new Error('fail'), 'mykey');
      expect(err.message).toContain('set');
      expect(err.message).toContain('mykey');
      expect(err.message).toContain('fail');
      expect(err.name).toBe('RedisOperationError');
      expect(err.operation).toBe('set');
      expect(err.key).toBe('mykey');
    });

    it('should work without key', () => {
      const err = new RedisOperationError('ping', new Error('timeout'));
      expect(err.message).toContain('ping');
      expect(err.key).toBeUndefined();
    });
  });
});

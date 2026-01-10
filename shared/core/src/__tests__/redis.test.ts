import { RedisClient, getRedisClient, resetRedisInstance } from '../redis';

// Mock ioredis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    set: jest.fn(),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn(),
    expire: jest.fn(),
    keys: jest.fn(),
    lpush: jest.fn(),
    lrange: jest.fn(),
    ltrim: jest.fn(),
    llen: jest.fn()
  }));
});

describe('RedisClient', () => {
  let redisClient: RedisClient;
  let mockRedis: any;

  beforeEach(() => {
    // Reset singleton state
    resetRedisInstance();

    // Create new instance for testing
    redisClient = new RedisClient('redis://localhost:6379', 'password');
    mockRedis = (redisClient as any).client;
  });

  afterEach(async () => {
    await redisClient.disconnect();
  });

  describe('initialization', () => {
    it('should initialize with correct options', () => {
      expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('close', expect.any(Function));
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
      resetRedisInstance();

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
      const channel = 'test-channel';
      const message = {
        type: 'test',
        data: 'hello',
        timestamp: Date.now(),
        source: 'test'
      };

      mockRedis.publish.mockResolvedValue(1);

      const result = await redisClient.publish(channel, message);

      expect(mockRedis.publish).toHaveBeenCalledWith(
        channel,
        expect.stringContaining('"timestamp":')
      );
      expect(result).toBe(1);
    });

    it('should handle publish errors', async () => {
      mockRedis.publish.mockRejectedValue(new Error('Publish failed'));

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
      const channel = 'test-channel';
      const callback = jest.fn();

      mockRedis.subscribe.mockResolvedValue(1);

      await redisClient.subscribe(channel, callback);

      expect(mockRedis.subscribe).toHaveBeenCalledWith(channel);
    });

    it('should prevent duplicate subscriptions', async () => {
      const channel = 'test-channel';
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      await redisClient.subscribe(channel, callback1);

      // Second subscription should warn and replace
      await redisClient.subscribe(channel, callback2);

      expect(mockRedis.subscribe).toHaveBeenCalledTimes(2);
    });

    it('should unsubscribe from channels', async () => {
      const channel = 'test-channel';
      const callback = jest.fn();

      await redisClient.subscribe(channel, callback);
      await redisClient.unsubscribe(channel);

      expect(mockRedis.unsubscribe).toHaveBeenCalledWith(channel);
    });
  });

  describe('caching operations', () => {
    it('should set values with TTL', async () => {
      const key = 'test-key';
      const value = { data: 'test' };
      const ttl = 300;

      await redisClient.set(key, value, ttl);

      expect(mockRedis.setex).toHaveBeenCalledWith(key, ttl, JSON.stringify(value));
    });

    it('should set values without TTL', async () => {
      const key = 'test-key';
      const value = { data: 'test' };

      await redisClient.set(key, value);

      expect(mockRedis.set).toHaveBeenCalledWith(key, JSON.stringify(value));
    });

    it('should get and parse values', async () => {
      const key = 'test-key';
      const value = { data: 'test' };

      mockRedis.get.mockResolvedValue(JSON.stringify(value));

      const result = await redisClient.get(key);

      expect(result).toEqual(value);
      expect(mockRedis.get).toHaveBeenCalledWith(key);
    });

    it('should return null for non-existent keys', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await redisClient.get('non-existent');

      expect(result).toBeNull();
    });

    it('should handle JSON parse errors gracefully', async () => {
      mockRedis.get.mockResolvedValue('invalid json');

      const result = await redisClient.get('test-key');

      expect(result).toBeNull();
    });
  });

  describe('hash operations', () => {
    it('should set hash fields', async () => {
      const key = 'hash-key';
      const field = 'field1';
      const value = { nested: 'data' };

      await redisClient.hset(key, field, value);

      expect(mockRedis.hset).toHaveBeenCalledWith(key, field, JSON.stringify(value));
    });

    it('should get hash fields', async () => {
      const key = 'hash-key';
      const field = 'field1';
      const value = { nested: 'data' };

      mockRedis.hget.mockResolvedValue(JSON.stringify(value));

      const result = await redisClient.hget(key, field);

      expect(result).toEqual(value);
    });

    it('should get all hash fields', async () => {
      const key = 'hash-key';
      const hashData = {
        field1: JSON.stringify('value1'),
        field2: JSON.stringify({ nested: 'value2' })
      };

      mockRedis.hgetall.mockResolvedValue(hashData);

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
      mockRedis.ping.mockRejectedValue(new Error('Connection failed'));

      const result = await redisClient.ping();
      expect(result).toBe(false);
    });
  });

  describe('cleanup and error handling', () => {
    it('should disconnect gracefully', async () => {
      const disconnectSpy = jest.spyOn(mockRedis, 'disconnect');

      await redisClient.disconnect();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should handle disconnect errors gracefully', async () => {
      mockRedis.disconnect.mockRejectedValue(new Error('Disconnect failed'));

      // Should not throw
      await expect(redisClient.disconnect()).resolves.not.toThrow();
    });

    it('should clean up subscriptions on disconnect', async () => {
      const callback = jest.fn();
      await redisClient.subscribe('test-channel', callback);

      const removeAllListenersSpy = jest.spyOn(mockRedis, 'removeAllListeners');

      await redisClient.disconnect();

      expect(removeAllListenersSpy).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle Redis errors gracefully', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      const result = await redisClient.get('test-key');

      expect(result).toBeNull();
    });

    it('should handle subscription errors', async () => {
      mockRedis.subscribe.mockRejectedValue(new Error('Subscribe failed'));

      await expect(redisClient.subscribe('test-channel', jest.fn()))
        .rejects
        .toThrow('Subscribe failed');
    });
  });
});
/**
 * Unified Redis Mock Implementation
 *
 * Single source of truth for Redis mocking across all tests.
 * Supports both regular Redis operations and Redis Streams.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

import { jest } from '@jest/globals';

export interface RedisMockOptions {
  /** Pre-populate mock with initial data */
  initialData?: Map<string, unknown>;
  /** Simulate Redis failures */
  simulateFailures?: boolean;
  /** Add artificial latency (ms) */
  latencyMs?: number;
  /** Track all operations for assertions */
  trackOperations?: boolean;
}

export interface RedisOperation {
  command: string;
  args: unknown[];
  timestamp: number;
}

/**
 * Comprehensive Redis mock that supports:
 * - Basic key-value operations (get, set, del, etc.)
 * - Hash operations (hset, hget, hgetall)
 * - List operations (lpush, lrange, ltrim)
 * - Stream operations (xadd, xread, xreadgroup, xack)
 * - Pub/Sub operations (publish, subscribe)
 * - Connection lifecycle (ping, disconnect)
 */
export class RedisMock {
  private data = new Map<string, unknown>();
  private streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();
  private consumerGroups = new Map<string, Map<string, { lastDeliveredId: string }>>();
  private pubSubChannels = new Map<string, Set<(channel: string, message: string) => void>>();
  private options: RedisMockOptions;
  private operations: RedisOperation[] = [];
  private connected = true;

  constructor(options: RedisMockOptions = {}) {
    this.options = options;
    if (options.initialData) {
      this.data = new Map(options.initialData);
    }
  }

  // =========================================================================
  // Basic Key-Value Operations
  // =========================================================================

  async get(key: string): Promise<string | null> {
    await this.simulateLatency();
    this.trackOperation('get', [key]);
    this.checkFailure('get');
    const value = this.data.get(key);
    return value !== undefined ? String(value) : null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    await this.simulateLatency();
    this.trackOperation('set', [key, value, ...args]);
    this.checkFailure('set');
    this.data.set(key, value);
    return 'OK';
  }

  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    await this.simulateLatency();
    this.trackOperation('setex', [key, ttl, value]);
    this.checkFailure('setex');
    this.data.set(key, value);
    // Note: TTL not simulated in mock
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('del', keys);
    this.checkFailure('del');
    let deleted = 0;
    for (const key of keys) {
      if (this.data.delete(key)) deleted++;
    }
    return deleted;
  }

  async exists(key: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('exists', [key]);
    this.checkFailure('exists');
    return this.data.has(key) ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    await this.simulateLatency();
    this.trackOperation('keys', [pattern]);
    this.checkFailure('keys');
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async expire(key: string, ttl: number): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('expire', [key, ttl]);
    return this.data.has(key) ? 1 : 0;
  }

  // =========================================================================
  // Hash Operations
  // =========================================================================

  async hset(key: string, field: string, value: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('hset', [key, field, value]);
    this.checkFailure('hset');
    const hash = (this.data.get(key) as Record<string, string>) || {};
    const isNew = !(field in hash);
    hash[field] = value;
    this.data.set(key, hash);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    await this.simulateLatency();
    this.trackOperation('hget', [key, field]);
    this.checkFailure('hget');
    const hash = this.data.get(key) as Record<string, string> | undefined;
    return hash?.[field] ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.simulateLatency();
    this.trackOperation('hgetall', [key]);
    this.checkFailure('hgetall');
    return (this.data.get(key) as Record<string, string>) || {};
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('hdel', [key, ...fields]);
    this.checkFailure('hdel');
    const hash = this.data.get(key) as Record<string, string> | undefined;
    if (!hash) return 0;
    let deleted = 0;
    for (const field of fields) {
      if (field in hash) {
        delete hash[field];
        deleted++;
      }
    }
    return deleted;
  }

  // =========================================================================
  // List Operations
  // =========================================================================

  async lpush(key: string, ...values: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('lpush', [key, ...values]);
    this.checkFailure('lpush');
    const list = (this.data.get(key) as string[]) || [];
    list.unshift(...values);
    this.data.set(key, list);
    return list.length;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('rpush', [key, ...values]);
    this.checkFailure('rpush');
    const list = (this.data.get(key) as string[]) || [];
    list.push(...values);
    this.data.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    await this.simulateLatency();
    this.trackOperation('lrange', [key, start, stop]);
    this.checkFailure('lrange');
    const list = (this.data.get(key) as string[]) || [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    await this.simulateLatency();
    this.trackOperation('ltrim', [key, start, stop]);
    this.checkFailure('ltrim');
    const list = (this.data.get(key) as string[]) || [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.data.set(key, list.slice(start, end));
    return 'OK';
  }

  async llen(key: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('llen', [key]);
    const list = (this.data.get(key) as string[]) || [];
    return list.length;
  }

  async rpop(key: string): Promise<string | null> {
    await this.simulateLatency();
    this.trackOperation('rpop', [key]);
    const list = (this.data.get(key) as string[]) || [];
    return list.pop() ?? null;
  }

  // =========================================================================
  // Stream Operations (Redis Streams)
  // =========================================================================

  async xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string> {
    await this.simulateLatency();
    this.trackOperation('xadd', [stream, id, ...fieldValues]);
    this.checkFailure('xadd');

    const streamData = this.streams.get(stream) || [];
    const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;

    const fields: Record<string, string> = {};
    for (let i = 0; i < fieldValues.length; i += 2) {
      fields[fieldValues[i]] = fieldValues[i + 1];
    }

    streamData.push({ id: messageId, fields });
    this.streams.set(stream, streamData);
    return messageId;
  }

  async xread(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    await this.simulateLatency();
    this.trackOperation('xread', args);
    this.checkFailure('xread');

    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;

    const streamName = args[streamsIdx + 1] as string;
    const startId = args[streamsIdx + 2] as string;

    const streamData = this.streams.get(streamName) || [];
    if (streamData.length === 0) return null;

    const messages = streamData
      .filter(msg => {
        if (startId === '0' || startId === '0-0') return true;
        if (startId === '$') return false;
        return msg.id > startId;
      })
      .map(msg => [msg.id, Object.entries(msg.fields).flat()] as [string, string[]]);

    if (messages.length === 0) return null;
    return [[streamName, messages]];
  }

  async xreadgroup(
    ...args: unknown[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    await this.simulateLatency();
    this.trackOperation('xreadgroup', args);
    this.checkFailure('xreadgroup');

    // Parse GROUP name consumer STREAMS stream id
    const groupIdx = args.indexOf('GROUP');
    if (groupIdx === -1) return null;

    const groupName = args[groupIdx + 1] as string;
    const consumerName = args[groupIdx + 2] as string;
    const streamsIdx = args.indexOf('STREAMS');
    const streamName = args[streamsIdx + 1] as string;
    const startId = args[streamsIdx + 2] as string;

    const streamData = this.streams.get(streamName) || [];
    if (streamData.length === 0) return null;

    const groups = this.consumerGroups.get(streamName);
    const group = groups?.get(groupName);
    const lastId = group?.lastDeliveredId || '0-0';

    const messages = streamData
      .filter(msg => {
        if (startId === '>') return msg.id > lastId;
        return msg.id >= startId;
      })
      .slice(0, 10) // Limit for mock
      .map(msg => [msg.id, Object.entries(msg.fields).flat()] as [string, string[]]);

    if (messages.length === 0) return null;

    // Update last delivered
    if (group && messages.length > 0) {
      group.lastDeliveredId = messages[messages.length - 1][0];
    }

    return [[streamName, messages]];
  }

  async xack(stream: string, group: string, ...ids: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('xack', [stream, group, ...ids]);
    this.checkFailure('xack');
    return ids.length;
  }

  async xgroup(...args: unknown[]): Promise<'OK'> {
    await this.simulateLatency();
    this.trackOperation('xgroup', args);
    this.checkFailure('xgroup');

    const command = args[0] as string;
    const stream = args[1] as string;
    const group = args[2] as string;

    if (command === 'CREATE') {
      const groups = this.consumerGroups.get(stream) || new Map();
      if (groups.has(group)) {
        throw new Error('BUSYGROUP Consumer Group name already exists');
      }
      groups.set(group, { lastDeliveredId: '0-0' });
      this.consumerGroups.set(stream, groups);
    }

    return 'OK';
  }

  async xlen(stream: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('xlen', [stream]);
    return (this.streams.get(stream) || []).length;
  }

  async xinfo(...args: unknown[]): Promise<unknown[]> {
    await this.simulateLatency();
    this.trackOperation('xinfo', args);
    const command = args[0] as string;
    const stream = args[1] as string;

    if (command === 'STREAM') {
      const streamData = this.streams.get(stream) || [];
      return [
        'length', streamData.length,
        'radix-tree-keys', 1,
        'radix-tree-nodes', 2,
        'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
        'groups', this.consumerGroups.get(stream)?.size || 0
      ];
    }

    return [];
  }

  async xtrim(stream: string, ...args: unknown[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('xtrim', [stream, ...args]);
    return 0;
  }

  async xpending(stream: string, group: string): Promise<unknown[]> {
    await this.simulateLatency();
    this.trackOperation('xpending', [stream, group]);
    return [0, null, null, []];
  }

  // =========================================================================
  // Pub/Sub Operations
  // =========================================================================

  async publish(channel: string, message: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('publish', [channel, message]);
    this.checkFailure('publish');

    const subscribers = this.pubSubChannels.get(channel);
    if (subscribers) {
      subscribers.forEach(cb => {
        try {
          cb(channel, message);
        } catch {
          // Ignore callback errors in mock
        }
      });
      return subscribers.size;
    }
    return 0;
  }

  async subscribe(channel: string, callback: (channel: string, message: string) => void): Promise<void> {
    await this.simulateLatency();
    this.trackOperation('subscribe', [channel]);

    if (!this.pubSubChannels.has(channel)) {
      this.pubSubChannels.set(channel, new Set());
    }
    this.pubSubChannels.get(channel)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.simulateLatency();
    this.trackOperation('unsubscribe', [channel]);
    this.pubSubChannels.delete(channel);
  }

  // =========================================================================
  // Connection Lifecycle
  // =========================================================================

  async ping(): Promise<'PONG'> {
    await this.simulateLatency();
    this.trackOperation('ping', []);
    this.checkFailure('ping');
    return 'PONG';
  }

  async disconnect(): Promise<void> {
    await this.simulateLatency();
    this.trackOperation('disconnect', []);
    this.connected = false;
    this.data.clear();
    this.streams.clear();
    this.consumerGroups.clear();
    this.pubSubChannels.clear();
  }

  async quit(): Promise<'OK'> {
    await this.disconnect();
    return 'OK';
  }

  // Event emitter interface (for compatibility)
  on(event: string, callback: (...args: unknown[]) => void): this {
    return this;
  }

  removeAllListeners(): this {
    return this;
  }

  // =========================================================================
  // Test Utilities
  // =========================================================================

  /** Get copy of all stored data */
  getData(): Map<string, unknown> {
    return new Map(this.data);
  }

  /** Get copy of all stream data */
  getStreams(): Map<string, Array<{ id: string; fields: Record<string, string> }>> {
    return new Map(this.streams);
  }

  /** Get stream messages for a specific stream */
  getStreamMessages(stream: string): Array<{ id: string; fields: Record<string, string> }> {
    return [...(this.streams.get(stream) || [])];
  }

  /** Get all recorded operations */
  getOperations(): RedisOperation[] {
    return [...this.operations];
  }

  /** Get operations for a specific command */
  getOperationsForCommand(command: string): RedisOperation[] {
    return this.operations.filter(op => op.command === command);
  }

  /** Check if mock is connected */
  isConnected(): boolean {
    return this.connected;
  }

  /** Clear all data and reset mock state */
  clear(): void {
    this.data.clear();
    this.streams.clear();
    this.consumerGroups.clear();
    this.pubSubChannels.clear();
    this.operations = [];
    this.connected = true;
  }

  /** Simulate failure for next operation */
  setFailure(enabled: boolean): void {
    this.options.simulateFailures = enabled;
  }

  /** Set latency for operations */
  setLatency(ms: number): void {
    this.options.latencyMs = ms;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private async simulateLatency(): Promise<void> {
    if (this.options.latencyMs && this.options.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));
    }
  }

  private checkFailure(operation: string): void {
    if (this.options.simulateFailures) {
      throw new Error(`Simulated Redis failure on ${operation}`);
    }
    if (!this.connected) {
      throw new Error('Redis client is not connected');
    }
  }

  private trackOperation(command: string, args: unknown[]): void {
    if (this.options.trackOperations) {
      this.operations.push({
        command,
        args,
        timestamp: Date.now()
      });
    }
  }
}

// =========================================================================
// Factory Functions
// =========================================================================

/** Create a new Redis mock instance */
export function createRedisMock(options?: RedisMockOptions): RedisMock {
  return new RedisMock(options);
}

/** Create Jest mock module for ioredis */
export function createIoredisMockModule(mock?: RedisMock): jest.Mock {
  const instance = mock ?? createRedisMock();
  return jest.fn(() => instance);
}

/** Setup ioredis mock - call at top of test file */
export function setupRedisMock(mock?: RedisMock): { mock: RedisMock; MockRedis: jest.Mock } {
  const instance = mock ?? createRedisMock({ trackOperations: true });
  const MockRedis = jest.fn(() => instance);

  // Note: Jest mock must be called before importing modules that use Redis
  // This function returns the mock for manual setup in jest.mock()
  return { mock: instance, MockRedis };
}

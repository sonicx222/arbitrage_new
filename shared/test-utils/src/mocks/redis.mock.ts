/**
 * Unified Redis Mock Implementation
 *
 * Single source of truth for Redis mocking across all tests.
 * Supports both regular Redis operations and Redis Streams.
 *
 * @see ADR-009: Test Architecture
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
  private consumerGroups = new Map<string, Map<string, { lastDeliveredId: string; pending: string[] }>>();
  private pubSubChannels = new Map<string, Set<(channel: string, message: string) => void>>();
  private streamSequences = new Map<string, number>(); // Monotonic sequence per stream
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

  /**
   * SET if Not eXists - used by distributed locking
   * Returns true if key was set (did not exist), false otherwise
   */
  async setNx(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    await this.simulateLatency();
    this.trackOperation('setNx', [key, value, ttlSeconds]);
    this.checkFailure('setNx');

    if (this.data.has(key)) {
      return false;
    }

    this.data.set(key, value);
    // Note: TTL not simulated in mock - would need setTimeout to auto-delete
    return true;
  }

  /**
   * Compare-and-delete for lock release (Lua script emulation)
   */
  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    await this.simulateLatency();
    this.trackOperation('compareAndDelete', [key, expectedValue]);
    this.checkFailure('compareAndDelete');

    const currentValue = this.data.get(key);
    if (currentValue === expectedValue) {
      this.data.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Compare-and-extend for lock extension (Lua script emulation)
   */
  async compareAndExtend(key: string, expectedValue: string, ttlSeconds: number): Promise<boolean> {
    await this.simulateLatency();
    this.trackOperation('compareAndExtend', [key, expectedValue, ttlSeconds]);
    this.checkFailure('compareAndExtend');

    const currentValue = this.data.get(key);
    if (currentValue === expectedValue) {
      // In real Redis, this would reset TTL - we just confirm value matches
      return true;
    }
    return false;
  }

  // =========================================================================
  // Hash Operations
  // =========================================================================

  async hset(key: string, ...fieldValues: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('hset', [key, ...fieldValues]);
    this.checkFailure('hset');
    const hash = (this.data.get(key) as Record<string, string>) || {};
    let newFields = 0;

    // Support both hset(key, field, value) and hset(key, field1, value1, field2, value2, ...)
    for (let i = 0; i < fieldValues.length; i += 2) {
      const field = fieldValues[i];
      const value = fieldValues[i + 1];
      if (!(field in hash)) newFields++;
      hash[field] = value;
    }

    this.data.set(key, hash);
    return newFields;
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
  // Sorted Set Operations
  // =========================================================================

  async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('zadd', [key, ...args]);
    this.checkFailure('zadd');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      const existing = sorted.findIndex(e => e.member === member);
      if (existing >= 0) {
        sorted[existing].score = score;
      } else {
        sorted.push({ score, member });
        added++;
      }
    }
    sorted.sort((a, b) => a.score - b.score);
    this.data.set(key, sorted);
    return added;
  }

  async zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]> {
    await this.simulateLatency();
    this.trackOperation('zrange', [key, start, stop, ...args]);
    this.checkFailure('zrange');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    const slice = sorted.slice(start, end);
    if (args.includes('WITHSCORES')) {
      const result: string[] = [];
      for (const entry of slice) {
        result.push(entry.member, String(entry.score));
      }
      return result;
    }
    return slice.map(e => e.member);
  }

  async zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]> {
    await this.simulateLatency();
    this.trackOperation('zrangebyscore', [key, min, max]);
    this.checkFailure('zrangebyscore');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' ? Infinity : Number(max);
    return sorted.filter(e => e.score >= minScore && e.score <= maxScore).map(e => e.member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('zrem', [key, ...members]);
    this.checkFailure('zrem');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    let removed = 0;
    const memberSet = new Set(members);
    const remaining = sorted.filter(e => {
      if (memberSet.has(e.member)) { removed++; return false; }
      return true;
    });
    this.data.set(key, remaining);
    return removed;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    await this.simulateLatency();
    this.trackOperation('zscore', [key, member]);
    this.checkFailure('zscore');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    const entry = sorted.find(e => e.member === member);
    return entry ? String(entry.score) : null;
  }

  async zcard(key: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('zcard', [key]);
    this.checkFailure('zcard');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    return sorted.length;
  }

  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('zcount', [key, min, max]);
    this.checkFailure('zcount');
    const sorted = (this.data.get(key) as Array<{ score: number; member: string }>) || [];
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' ? Infinity : Number(max);
    return sorted.filter(e => e.score >= minScore && e.score <= maxScore).length;
  }

  // =========================================================================
  // Atomic Counter Operations
  // =========================================================================

  async incr(key: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('incr', [key]);
    this.checkFailure('incr');
    const current = Number(this.data.get(key) ?? 0);
    const next = current + 1;
    this.data.set(key, String(next));
    return next;
  }

  async incrby(key: string, increment: number): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('incrby', [key, increment]);
    this.checkFailure('incrby');
    const current = Number(this.data.get(key) ?? 0);
    const next = current + increment;
    this.data.set(key, String(next));
    return next;
  }

  async decr(key: string): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('decr', [key]);
    this.checkFailure('decr');
    const current = Number(this.data.get(key) ?? 0);
    const next = current - 1;
    this.data.set(key, String(next));
    return next;
  }

  async decrby(key: string, decrement: number): Promise<number> {
    await this.simulateLatency();
    this.trackOperation('decrby', [key, decrement]);
    this.checkFailure('decrby');
    const current = Number(this.data.get(key) ?? 0);
    const next = current - decrement;
    this.data.set(key, String(next));
    return next;
  }

  // =========================================================================
  // Multi-key Operations
  // =========================================================================

  async mget(...keys: string[]): Promise<(string | null)[]> {
    await this.simulateLatency();
    this.trackOperation('mget', keys);
    this.checkFailure('mget');
    return keys.map(key => {
      const value = this.data.get(key);
      return value !== undefined ? String(value) : null;
    });
  }

  async mset(...keyValues: string[]): Promise<'OK'> {
    await this.simulateLatency();
    this.trackOperation('mset', keyValues);
    this.checkFailure('mset');
    for (let i = 0; i < keyValues.length; i += 2) {
      this.data.set(keyValues[i], keyValues[i + 1]);
    }
    return 'OK';
  }

  // =========================================================================
  // Scan (Cursor-Based Iteration)
  // =========================================================================

  async scan(cursor: string, ...args: string[]): Promise<[string, string[]]> {
    await this.simulateLatency();
    this.trackOperation('scan', [cursor, ...args]);
    this.checkFailure('scan');
    let pattern = '*';
    let count = 10;
    for (let i = 0; i < args.length; i += 2) {
      if (args[i].toUpperCase() === 'MATCH') pattern = args[i + 1];
      if (args[i].toUpperCase() === 'COUNT') count = Number(args[i + 1]);
    }
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const allKeys = Array.from(this.data.keys()).filter(key => regex.test(key));
    const offset = Number(cursor);
    const batch = allKeys.slice(offset, offset + count);
    const nextCursor = offset + count >= allKeys.length ? '0' : String(offset + count);
    return [nextCursor, batch];
  }

  // =========================================================================
  // Transaction Pipeline (Multi/Exec)
  // =========================================================================

  multi(): RedisMockMulti {
    this.trackOperation('multi', []);
    return new RedisMockMulti(this);
  }

  // =========================================================================
  // Eval (Lua Script Emulation)
  // =========================================================================

  async eval(...args: unknown[]): Promise<unknown> {
    await this.simulateLatency();
    this.trackOperation('eval', args);
    this.checkFailure('eval');
    return null;
  }

  // =========================================================================
  // Stream Operations (Redis Streams)
  // =========================================================================

  async xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string> {
    await this.simulateLatency();
    this.trackOperation('xadd', [stream, id, ...fieldValues]);
    this.checkFailure('xadd');

    const streamData = this.streams.get(stream) || [];

    // Use monotonic sequence number for reliable ID generation
    let messageId: string;
    if (id === '*') {
      const sequence = (this.streamSequences.get(stream) || 0) + 1;
      this.streamSequences.set(stream, sequence);
      messageId = `${Date.now()}-${sequence}`;
    } else {
      messageId = id;
    }

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
      groups.set(group, { lastDeliveredId: '0-0', pending: [] });
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
      // Execute callbacks asynchronously for better isolation (like real Redis pub/sub)
      const callbackPromises = Array.from(subscribers).map(cb =>
        Promise.resolve().then(() => {
          try {
            cb(channel, message);
          } catch {
            // Ignore callback errors in mock
          }
        })
      );
      // Don't await - fire and forget like real Redis
      Promise.all(callbackPromises).catch(() => {});
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
    this.streamSequences.clear();
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
// Multi/Exec Transaction Pipeline
// =========================================================================

class RedisMockMulti {
  private commands: Array<{ method: string; args: unknown[] }> = [];
  private redis: RedisMock;

  constructor(redis: RedisMock) {
    this.redis = redis;
  }

  get(...args: unknown[]): this { this.commands.push({ method: 'get', args }); return this; }
  set(...args: unknown[]): this { this.commands.push({ method: 'set', args }); return this; }
  del(...args: unknown[]): this { this.commands.push({ method: 'del', args }); return this; }
  incr(...args: unknown[]): this { this.commands.push({ method: 'incr', args }); return this; }
  incrby(...args: unknown[]): this { this.commands.push({ method: 'incrby', args }); return this; }
  hset(...args: unknown[]): this { this.commands.push({ method: 'hset', args }); return this; }
  hget(...args: unknown[]): this { this.commands.push({ method: 'hget', args }); return this; }
  zadd(...args: unknown[]): this { this.commands.push({ method: 'zadd', args }); return this; }
  zrem(...args: unknown[]): this { this.commands.push({ method: 'zrem', args }); return this; }
  expire(...args: unknown[]): this { this.commands.push({ method: 'expire', args }); return this; }
  xadd(...args: unknown[]): this { this.commands.push({ method: 'xadd', args }); return this; }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const cmd of this.commands) {
      try {
        const method = (this.redis as any)[cmd.method];
        if (typeof method === 'function') {
          const result = await method.apply(this.redis, cmd.args);
          results.push(result);
        } else {
          results.push(null);
        }
      } catch (error) {
        results.push(error);
      }
    }
    this.commands = [];
    return results;
  }

  async discard(): Promise<'OK'> {
    this.commands = [];
    return 'OK';
  }
}

// =========================================================================
// Factory Functions
// =========================================================================

/** Create a new Redis mock instance */
export function createRedisMock(options?: RedisMockOptions): RedisMock {
  return new RedisMock(options);
}

/**
 * Create an inline jest.fn()-based Redis mock for use in jest.mock() factories.
 *
 * Unlike RedisMock (class with real implementations), this returns a plain object
 * with jest.fn() stubs. Designed for the resilience test pattern where mockRedis
 * is defined at module scope and referenced inside jest.mock() factories.
 *
 * Usage in test files:
 * ```typescript
 * // IMPORTANT: Variable MUST start with 'mock' for jest.mock() hoisting
 * const mockRedis = createInlineRedisMock();
 * jest.mock('../../../src/redis', () => ({
 *   getRedisClient: jest.fn(() => Promise.resolve(mockRedis)),
 * }));
 * ```
 */
export function createInlineRedisMock() {
  return {
    set: jest.fn(() => Promise.resolve(undefined)),
    get: jest.fn(() => Promise.resolve(null)),
    del: jest.fn(() => Promise.resolve(1)),
    publish: jest.fn(() => Promise.resolve(1)),
    subscribe: jest.fn(() => Promise.resolve(undefined)),
    ping: jest.fn(() => Promise.resolve(true)),
    disconnect: jest.fn(() => Promise.resolve(undefined)),
    zadd: jest.fn(() => Promise.resolve(1)),
    zrange: jest.fn(() => Promise.resolve([])),
    zrem: jest.fn(() => Promise.resolve(1)),
    zcard: jest.fn(() => Promise.resolve(0)),
    zscore: jest.fn(() => Promise.resolve(null)),
    scan: jest.fn(() => Promise.resolve(['0', []])),
    exists: jest.fn(() => Promise.resolve(0)),
    hset: jest.fn(() => Promise.resolve(1)),
    hget: jest.fn(() => Promise.resolve(null)),
    hgetall: jest.fn(() => Promise.resolve({})),
  };
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

// =========================================================================
// Shared Mock State (for integration tests that need shared state)
// =========================================================================

/**
 * Centralized mock state manager for Redis-like data in integration tests.
 *
 * This solves the global state leakage problem where module-level Maps
 * persist between tests. Use this singleton instead of creating module-level
 * state in test files.
 *
 * @example
 * // In test file
 * import { RedisMockState } from '@arbitrage/test-utils';
 *
 * const mockState = RedisMockState.getInstance();
 * mockState.data.set('key', 'value');
 * mockState.streams.set('stream', []);
 *
 * // State is automatically cleared between tests by singleton-reset
 */
export class RedisMockState {
  private static instance: RedisMockState | null = null;
  private static initializing = false; // Guard against double initialization

  readonly data = new Map<string, unknown>();
  readonly streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();
  readonly consumerGroups = new Map<string, Map<string, { lastDeliveredId: string; pending: string[] }>>();
  readonly pubSubChannels = new Map<string, Set<(channel: string, message: string) => void>>();
  readonly streamSequences = new Map<string, number>(); // Shared monotonic counters per stream

  private constructor() {
    // Private constructor for singleton pattern
  }

  static getInstance(): RedisMockState {
    // Double-check pattern with initialization guard
    if (!RedisMockState.instance && !RedisMockState.initializing) {
      RedisMockState.initializing = true;
      RedisMockState.instance = new RedisMockState();
      RedisMockState.initializing = false;
    }
    return RedisMockState.instance!;
  }

  /**
   * Reset all state - called automatically between tests
   */
  static reset(): void {
    if (RedisMockState.instance) {
      RedisMockState.instance.data.clear();
      RedisMockState.instance.streams.clear();
      RedisMockState.instance.consumerGroups.clear();
      RedisMockState.instance.pubSubChannels.clear();
      RedisMockState.instance.streamSequences.clear();
    }
  }

  /**
   * Destroy the singleton instance completely
   */
  static destroy(): void {
    RedisMockState.reset();
    RedisMockState.instance = null;
  }

  /**
   * Get next monotonic sequence number for a stream (thread-safe within single process)
   */
  getNextSequence(stream: string): number {
    const current = this.streamSequences.get(stream) || 0;
    const next = current + 1;
    this.streamSequences.set(stream, next);
    return next;
  }

  /**
   * Create a mock Redis object that uses this shared state.
   * Uses 'any' to avoid Jest 29+ strict typing issues.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMockRedis(): any {
    const state = this;

    const mockGet = jest.fn(async (key: string) => state.data.get(key) ?? null);
    const mockSet = jest.fn(async (key: string, value: unknown) => {
      state.data.set(key, value);
      return 'OK';
    });
    const mockDel = jest.fn(async (...keys: string[]) => {
      let count = 0;
      keys.forEach(key => { if (state.data.delete(key)) count++; });
      return count;
    });
    const mockExists = jest.fn(async (key: string) => state.data.has(key) ? 1 : 0);
    const mockHset = jest.fn(async (key: string, ...fieldValues: string[]) => {
      const hash = (state.data.get(key) as Record<string, string>) || {};
      let newFields = 0;
      for (let i = 0; i < fieldValues.length; i += 2) {
        const field = fieldValues[i];
        const value = fieldValues[i + 1];
        if (!(field in hash)) newFields++;
        hash[field] = value;
      }
      state.data.set(key, hash);
      return newFields;
    });
    const mockHget = jest.fn(async (key: string, field: string) => {
      const hash = state.data.get(key) as Record<string, string> | undefined;
      return hash?.[field] ?? null;
    });
    const mockHgetall = jest.fn(async (key: string) => {
      return (state.data.get(key) as Record<string, string>) || {};
    });
    const mockXadd = jest.fn(async (stream: string, id: string, ...fieldValues: string[]) => {
      const streamData = state.streams.get(stream) || [];
      // Use shared monotonic sequence to prevent ID collisions
      const messageId = id === '*' ? `${Date.now()}-${state.getNextSequence(stream)}` : id;
      const fields: Record<string, string> = {};
      for (let i = 0; i < fieldValues.length; i += 2) {
        fields[fieldValues[i]] = fieldValues[i + 1];
      }
      streamData.push({ id: messageId, fields });
      state.streams.set(stream, streamData);
      return messageId;
    });
    const mockXread = jest.fn(async () => null);
    const mockXreadgroup = jest.fn(async () => null);
    const mockXack = jest.fn(async (_stream: string, _group: string, ...ids: string[]) => ids.length);
    const mockXgroup = jest.fn(async () => 'OK');
    const mockXlen = jest.fn(async (stream: string) => (state.streams.get(stream) || []).length);
    const mockPublish = jest.fn(async (channel: string, message: string) => {
      const subs = state.pubSubChannels.get(channel);
      if (subs) {
        // Fire callbacks asynchronously for better isolation
        subs.forEach(cb => Promise.resolve().then(() => {
          try { cb(channel, message); } catch { /* ignore */ }
        }));
        return subs.size;
      }
      return 0;
    });
    const mockSubscribe = jest.fn(async (channel: string, cb: (channel: string, message: string) => void) => {
      if (!state.pubSubChannels.has(channel)) {
        state.pubSubChannels.set(channel, new Set());
      }
      state.pubSubChannels.get(channel)!.add(cb);
    });
    const mockPing = jest.fn(async () => 'PONG');
    const mockQuit = jest.fn(async () => 'OK');
    const mockDisconnect = jest.fn(async () => undefined);
    const mockOn = jest.fn(() => ({}));
    const mockRemoveAllListeners = jest.fn(() => ({}));

    return {
      get: mockGet,
      set: mockSet,
      del: mockDel,
      exists: mockExists,
      hset: mockHset,
      hget: mockHget,
      hgetall: mockHgetall,
      xadd: mockXadd,
      xread: mockXread,
      xreadgroup: mockXreadgroup,
      xack: mockXack,
      xgroup: mockXgroup,
      xlen: mockXlen,
      publish: mockPublish,
      subscribe: mockSubscribe,
      ping: mockPing,
      quit: mockQuit,
      disconnect: mockDisconnect,
      on: mockOn,
      removeAllListeners: mockRemoveAllListeners,
    };
  }
}

/**
 * Reset function for singleton-reset.ts integration
 */
export function resetRedisMockState(): void {
  RedisMockState.reset();
}

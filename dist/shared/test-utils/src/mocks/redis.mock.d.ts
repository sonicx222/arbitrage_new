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
export declare class RedisMock {
    private data;
    private streams;
    private consumerGroups;
    private pubSubChannels;
    private options;
    private operations;
    private connected;
    constructor(options?: RedisMockOptions);
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: unknown[]): Promise<'OK'>;
    setex(key: string, ttl: number, value: string): Promise<'OK'>;
    del(...keys: string[]): Promise<number>;
    exists(key: string): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    expire(key: string, ttl: number): Promise<number>;
    hset(key: string, field: string, value: string): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string>>;
    hdel(key: string, ...fields: string[]): Promise<number>;
    lpush(key: string, ...values: string[]): Promise<number>;
    rpush(key: string, ...values: string[]): Promise<number>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    ltrim(key: string, start: number, stop: number): Promise<'OK'>;
    llen(key: string): Promise<number>;
    rpop(key: string): Promise<string | null>;
    xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string>;
    xread(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
    xreadgroup(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
    xack(stream: string, group: string, ...ids: string[]): Promise<number>;
    xgroup(...args: unknown[]): Promise<'OK'>;
    xlen(stream: string): Promise<number>;
    xinfo(...args: unknown[]): Promise<unknown[]>;
    xtrim(stream: string, ...args: unknown[]): Promise<number>;
    xpending(stream: string, group: string): Promise<unknown[]>;
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string, callback: (channel: string, message: string) => void): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    ping(): Promise<'PONG'>;
    disconnect(): Promise<void>;
    quit(): Promise<'OK'>;
    on(event: string, callback: (...args: unknown[]) => void): this;
    removeAllListeners(): this;
    /** Get copy of all stored data */
    getData(): Map<string, unknown>;
    /** Get copy of all stream data */
    getStreams(): Map<string, Array<{
        id: string;
        fields: Record<string, string>;
    }>>;
    /** Get stream messages for a specific stream */
    getStreamMessages(stream: string): Array<{
        id: string;
        fields: Record<string, string>;
    }>;
    /** Get all recorded operations */
    getOperations(): RedisOperation[];
    /** Get operations for a specific command */
    getOperationsForCommand(command: string): RedisOperation[];
    /** Check if mock is connected */
    isConnected(): boolean;
    /** Clear all data and reset mock state */
    clear(): void;
    /** Simulate failure for next operation */
    setFailure(enabled: boolean): void;
    /** Set latency for operations */
    setLatency(ms: number): void;
    private simulateLatency;
    private checkFailure;
    private trackOperation;
}
/** Create a new Redis mock instance */
export declare function createRedisMock(options?: RedisMockOptions): RedisMock;
/** Create Jest mock module for ioredis */
export declare function createIoredisMockModule(mock?: RedisMock): jest.Mock;
/** Setup ioredis mock - call at top of test file */
export declare function setupRedisMock(mock?: RedisMock): {
    mock: RedisMock;
    MockRedis: jest.Mock;
};
//# sourceMappingURL=redis.mock.d.ts.map
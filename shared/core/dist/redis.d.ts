import { MessageEvent, ServiceHealth, PerformanceMetrics } from '../../types';
export declare class RedisClient {
    private client;
    private pubClient;
    private subClient;
    private logger;
    constructor(url: string, password?: string);
    private parseHost;
    private parsePort;
    private setupEventHandlers;
    publish(channel: string, message: MessageEvent): Promise<number>;
    private validateChannelName;
    private validateMessage;
    private subscriptions;
    subscribe(channel: string, callback: (message: MessageEvent) => void): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    set(key: string, value: unknown, ttl?: number): Promise<void>;
    get<T = any>(key: string): Promise<T | null>;
    del(...keys: string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
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
    setNx(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
    exists(key: string): Promise<boolean>;
    /**
     * Execute a Lua script atomically.
     * Used for atomic operations like conditional delete (check-and-delete).
     *
     * @param script - Lua script to execute
     * @param keys - Array of keys to pass to the script (KEYS[1], KEYS[2], etc.)
     * @param args - Array of arguments to pass to the script (ARGV[1], ARGV[2], etc.)
     * @returns Script result
     */
    eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
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
    renewLockIfOwned(key: string, instanceId: string, ttlSeconds: number): Promise<boolean>;
    /**
     * P0-NEW-5 FIX: Atomic lock release using Lua script.
     * Atomically checks if the lock is owned by the given instanceId and deletes it.
     * This prevents releasing a lock that was acquired by another instance.
     *
     * @param key - Lock key
     * @param instanceId - Expected owner of the lock
     * @returns true if lock was released, false if lock is owned by another instance or doesn't exist
     */
    releaseLockIfOwned(key: string, instanceId: string): Promise<boolean>;
    hset(key: string, field: string, value: unknown): Promise<number>;
    hget<T = any>(key: string, field: string): Promise<T | null>;
    hgetall<T = any>(key: string): Promise<Record<string, T> | null>;
    sadd(key: string, ...members: string[]): Promise<number>;
    srem(key: string, ...members: string[]): Promise<number>;
    smembers(key: string): Promise<string[]>;
    zadd(key: string, score: number, member: string): Promise<number>;
    zrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]>;
    zrem(key: string, ...members: string[]): Promise<number>;
    zcard(key: string): Promise<number>;
    zscore(key: string, member: string): Promise<string | null>;
    /**
     * P0-3 FIX: Remove elements from sorted set by score range.
     * Used by rate limiter to remove expired entries.
     */
    zremrangebyscore(key: string, min: number, max: number): Promise<number>;
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
    };
    keys(pattern: string): Promise<string[]>;
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
    scan(cursor: string, matchArg: 'MATCH', pattern: string, countArg: 'COUNT', count: number): Promise<[string, string[]]>;
    llen(key: string): Promise<number>;
    lpush(key: string, ...values: string[]): Promise<number>;
    rpop(key: string): Promise<string | null>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    ltrim(key: string, start: number, stop: number): Promise<'OK'>;
    updateServiceHealth(serviceName: string, health: ServiceHealth): Promise<void>;
    getServiceHealth(serviceName: string): Promise<ServiceHealth | null>;
    getAllServiceHealth(): Promise<Record<string, ServiceHealth>>;
    recordMetrics(serviceName: string, metrics: PerformanceMetrics): Promise<void>;
    getRecentMetrics(serviceName: string, count?: number): Promise<PerformanceMetrics[]>;
    disconnect(): Promise<void>;
    ping(): Promise<boolean>;
}
export declare function getRedisClient(url?: string, password?: string): Promise<RedisClient>;
export declare function getRedisClientSync(): RedisClient | null;
export declare function checkRedisHealth(url?: string, password?: string): Promise<boolean>;
export declare function resetRedisInstance(): void;
//# sourceMappingURL=redis.d.ts.map
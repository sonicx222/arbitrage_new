/**
 * Redis Test Server Setup
 *
 * Uses redis-memory-server to spin up a real Redis instance for testing.
 * This ensures all Redis-dependent tests can run in isolation.
 */
import { RedisMemoryServer } from 'redis-memory-server';
declare let redisServer: RedisMemoryServer | null;
/**
 * Start the Redis test server
 */
export declare function startRedisServer(): Promise<{
    host: string;
    port: number;
}>;
/**
 * Stop the Redis test server
 */
export declare function stopRedisServer(): Promise<void>;
/**
 * Get the Redis connection URL
 */
export declare function getRedisUrl(): string;
export { redisServer };
//# sourceMappingURL=redis-test-setup.d.ts.map
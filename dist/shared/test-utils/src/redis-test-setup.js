"use strict";
/**
 * Redis Test Server Setup
 *
 * Uses redis-memory-server to spin up a real Redis instance for testing.
 * This ensures all Redis-dependent tests can run in isolation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisServer = void 0;
exports.startRedisServer = startRedisServer;
exports.stopRedisServer = stopRedisServer;
exports.getRedisUrl = getRedisUrl;
const redis_memory_server_1 = require("redis-memory-server");
let redisServer = null;
exports.redisServer = redisServer;
/**
 * Start the Redis test server
 */
async function startRedisServer() {
    if (redisServer) {
        return {
            host: await redisServer.getHost(),
            port: await redisServer.getPort()
        };
    }
    exports.redisServer = redisServer = new redis_memory_server_1.RedisMemoryServer();
    await redisServer.start();
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    // Set environment variables for tests to use
    process.env.REDIS_HOST = host;
    process.env.REDIS_PORT = String(port);
    process.env.REDIS_URL = `redis://${host}:${port}`;
    console.log(`Redis test server started at ${host}:${port}`);
    return { host, port };
}
/**
 * Stop the Redis test server
 */
async function stopRedisServer() {
    if (redisServer) {
        await redisServer.stop();
        exports.redisServer = redisServer = null;
        console.log('Redis test server stopped');
    }
}
/**
 * Get the Redis connection URL
 */
function getRedisUrl() {
    return process.env.REDIS_URL || 'redis://localhost:6379';
}
//# sourceMappingURL=redis-test-setup.js.map
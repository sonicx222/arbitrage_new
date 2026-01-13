/**
 * Redis Test Server Setup
 *
 * Uses redis-memory-server to spin up a real Redis instance for testing.
 * This ensures all Redis-dependent tests can run in isolation.
 */

import { RedisMemoryServer } from 'redis-memory-server';

let redisServer: RedisMemoryServer | null = null;

/**
 * Start the Redis test server
 */
export async function startRedisServer(): Promise<{ host: string; port: number }> {
  if (redisServer) {
    return {
      host: await redisServer.getHost(),
      port: await redisServer.getPort()
    };
  }

  redisServer = new RedisMemoryServer();
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
export async function stopRedisServer(): Promise<void> {
  if (redisServer) {
    await redisServer.stop();
    redisServer = null;
    console.log('Redis test server stopped');
  }
}

/**
 * Get the Redis connection URL
 */
export function getRedisUrl(): string {
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

export { redisServer };

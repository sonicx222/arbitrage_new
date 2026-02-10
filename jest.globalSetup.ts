/**
 * Jest Global Setup
 *
 * Runs once before all test suites.
 * Starts the Redis test server.
 */

import { RedisMemoryServer } from 'redis-memory-server';
import * as fs from 'fs';
import * as path from 'path';

const REDIS_CONFIG_FILE = path.join(__dirname, '.redis-test-config.json');

// Polyfill for BigInt serialization in Jest workers
// This allows Jest to serialize BigInt values during inter-worker communication
// NOTE: Also in shared/test-utils/src/setup/jest-setup.ts - duplication is intentional because:
//   - globalSetup runs in parent process (for Redis setup)
//   - setupFilesAfterEnv runs in each test worker process (for test code)
//   - Both need the polyfill in their respective process contexts
if (typeof (BigInt.prototype as any).toJSON === 'undefined') {
  (BigInt.prototype as any).toJSON = function (this: bigint) {
    return this.toString();
  };
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Jest Global Setup] Starting Redis test server...');

  const redisServer = new RedisMemoryServer();
  await redisServer.start();

  const host = await redisServer.getHost();
  const port = await redisServer.getPort();

  // Store server instance for teardown via file (needed because teardown runs in separate process)
  (global as any).__REDIS_SERVER__ = redisServer;

  // Write config to file so test workers can read it
  const config = {
    host,
    port,
    url: `redis://${host}:${port}`
  };
  fs.writeFileSync(REDIS_CONFIG_FILE, JSON.stringify(config));

  // Set environment variables (for this process)
  process.env.REDIS_HOST = host;
  process.env.REDIS_PORT = String(port);
  process.env.REDIS_URL = config.url;

  console.log(`[Jest Global Setup] Redis test server running at ${host}:${port}\n`);
}

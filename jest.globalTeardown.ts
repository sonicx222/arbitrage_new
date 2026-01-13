/**
 * Jest Global Teardown
 *
 * Runs once after all test suites complete.
 * Stops the Redis test server.
 */

import * as fs from 'fs';
import * as path from 'path';

const REDIS_CONFIG_FILE = path.join(__dirname, '.redis-test-config.json');

export default async function globalTeardown(): Promise<void> {
  console.log('\n[Jest Global Teardown] Stopping Redis test server...');

  // Clean up config file
  if (fs.existsSync(REDIS_CONFIG_FILE)) {
    fs.unlinkSync(REDIS_CONFIG_FILE);
  }

  const redisServer = (global as any).__REDIS_SERVER__;
  if (redisServer) {
    await redisServer.stop();
    console.log('[Jest Global Teardown] Redis test server stopped\n');
  }
}

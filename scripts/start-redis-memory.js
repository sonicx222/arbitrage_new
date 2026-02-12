#!/usr/bin/env node
/**
 * Start Redis using redis-memory-server (Alternative to Docker)
 *
 * Use this when Docker is not available or Docker Hub is blocked.
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:redis:memory
 *   node scripts/start-redis-memory.js
 */

const { RedisMemoryServer } = require('redis-memory-server');
const fs = require('fs');

const {
  log,
  isPortInUse,
  checkTcpConnection,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig,
  REDIS_MEMORY_CONFIG_FILE
} = require('./lib/utils');

const { PORTS } = require('./lib/services-config');

// =============================================================================
// Main Redis Memory Server Logic
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  Redis Memory Server (Docker Alternative)', 'cyan');
  console.log('='.repeat(60) + '\n');

  // Check if already running on the port
  const port = PORTS.REDIS;
  log(`Checking if port ${port} is available...`, 'yellow');

  const portInUse = await isPortInUse(port);

  if (portInUse) {
    log(`Port ${port} is already in use.`, 'yellow');

    // Check if we have a config file that matches this port
    const existingConfig = getRedisMemoryConfig();
    if (existingConfig && existingConfig.port === port) {
      log('An existing Redis configuration was found. Checking if it\'s functional...', 'yellow');

      const functional = await checkTcpConnection('127.0.0.1', port);

      if (functional) {
        log(`Redis is already running and functional at redis://127.0.0.1:${port}`, 'green');
        log(`Using existing process ID: ${existingConfig.pid}`, 'dim');
        process.exit(0);
      } else {
        log('Existing process is not responding. Port may be occupied by another application or stale process.', 'red');
        log('Try running: npm run dev:cleanup', 'yellow');
        process.exit(1);
      }
    }

    log(`Port ${port} is occupied but no valid config was found.`, 'red');
    log('If you have a ghost Redis process, run: npm run dev:cleanup', 'yellow');
    process.exit(1);
  }

  log('Starting Redis in-memory server...', 'yellow');

  try {
    const redisServer = new RedisMemoryServer({
      instance: {
        port: port
      }
    });

    await redisServer.start();

    const host = await redisServer.getHost();
    const actualPort = await redisServer.getPort();

    // Write config to file for other scripts to read
    const config = {
      host,
      port: actualPort,
      url: `redis://${host}:${actualPort}`,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    fs.writeFileSync(REDIS_MEMORY_CONFIG_FILE, JSON.stringify(config, null, 2));

    log(`\nRedis server running at: redis://${host}:${actualPort}`, 'green');
    log(`Process ID: ${process.pid}`, 'dim');
    log(`Config saved to: ${REDIS_MEMORY_CONFIG_FILE}`, 'dim');

    log('\nSet these environment variables:', 'cyan');
    log(`  REDIS_HOST=${host}`, 'dim');
    log(`  REDIS_PORT=${actualPort}`, 'dim');
    log(`  REDIS_URL=redis://${host}:${actualPort}`, 'dim');

    log('\nPress Ctrl+C to stop the server.', 'yellow');

    // Handle shutdown
    const cleanupAndExit = async () => {
      log('\n\nShutting down Redis...', 'yellow');
      try {
        await redisServer.stop();
      } catch {
        // Ignore errors during shutdown
      }

      // Only delete config if it's ours
      const currentConfig = getRedisMemoryConfig();
      if (currentConfig && currentConfig.pid === process.pid) {
        deleteRedisMemoryConfig();
      }

      log('Redis stopped.', 'green');
      process.exit(0);
    };

    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);

    // Keep process alive using stdin instead of empty interval (better practice)
    process.stdin.resume();

  } catch (error) {
    log(`\nFailed to start Redis: ${error.message}`, 'red');

    // Clean up config if it was us
    const currentConfig = getRedisMemoryConfig();
    if (currentConfig && currentConfig.pid === process.pid) {
      deleteRedisMemoryConfig();
    }

    log('\nTroubleshooting:', 'yellow');
    log('  1. Ensure redis-memory-server is installed: npm install', 'dim');
    log('  2. Check if port 6379 is already in use', 'dim');
    log('  3. Run cleanup script: npm run dev:cleanup', 'dim');
    log('  4. Try using Docker instead: npm run dev:redis', 'dim');
    process.exit(1);
  }
}

// =============================================================================
// Entry Point
// =============================================================================

// FIX M10: Add .catch() consistent with other scripts (stop-local.js, status-local.js, etc.)
main().catch(error => {
  console.error(`Redis memory server failed: ${error.message}`);
  process.exit(1);
});

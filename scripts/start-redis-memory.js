#!/usr/bin/env node
/**
 * Start Redis using redis-memory-server (Alternative to Docker)
 *
 * Use this when Docker is not available or Docker Hub is blocked.
 *
 * Usage:
 *   npm run dev:redis:memory
 *   node scripts/start-redis-memory.js
 */

const { RedisMemoryServer } = require('redis-memory-server');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '.redis-memory-config.json');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  Redis Memory Server (Docker Alternative)', 'cyan');
  console.log('='.repeat(60) + '\n');

  log('Starting Redis in-memory server...', 'yellow');

  try {
    const redisServer = new RedisMemoryServer({
      instance: {
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      }
    });

    await redisServer.start();

    const host = await redisServer.getHost();
    const port = await redisServer.getPort();

    // Write config to file for other scripts to read
    const config = {
      host,
      port,
      url: `redis://${host}:${port}`,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    log(`\nRedis server running at: redis://${host}:${port}`, 'green');
    log(`Process ID: ${process.pid}`, 'dim');
    log(`Config saved to: ${CONFIG_FILE}`, 'dim');

    log('\nSet these environment variables:', 'cyan');
    log(`  REDIS_HOST=${host}`, 'dim');
    log(`  REDIS_PORT=${port}`, 'dim');
    log(`  REDIS_URL=redis://${host}:${port}`, 'dim');

    log('\nPress Ctrl+C to stop the server.', 'yellow');

    // Handle shutdown
    process.on('SIGINT', async () => {
      log('\n\nShutting down Redis...', 'yellow');
      await redisServer.stop();
      if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
      }
      log('Redis stopped.', 'green');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await redisServer.stop();
      if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
      }
      process.exit(0);
    });

    // Keep process alive
    setInterval(() => {}, 1000);

  } catch (error) {
    log(`\nFailed to start Redis: ${error.message}`, 'red');
    log('\nTroubleshooting:', 'yellow');
    log('  1. Ensure redis-memory-server is installed: npm install', 'dim');
    log('  2. Check if port 6379 is already in use', 'dim');
    log('  3. Try using Docker instead: npm run dev:redis', 'dim');
    process.exit(1);
  }
}

main();

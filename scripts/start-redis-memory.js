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

  // Check if already running on the port
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  log(`Checking if port ${port} is available...`, 'yellow');

  const net = require('net');
  const portInUse = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    // Listen on all interfaces to match how Redis might be running
    server.listen(port);
  });

  if (portInUse) {
    log(`Port ${port} is already in use.`, 'yellow');

    // Check if we have a config file that matches this port
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (config.port === port) {
          log('An existing Redis configuration was found. Checking if it\'s functional...', 'yellow');

          const functional = await new Promise((resolve) => {
            const client = new net.Socket();
            client.setTimeout(1000);
            client.connect(port, '127.0.0.1', () => {
              client.destroy();
              resolve(true);
            });
            client.on('error', () => {
              client.destroy();
              resolve(false);
            });
            client.on('timeout', () => {
              client.destroy();
              resolve(false);
            });
          });

          if (functional) {
            log(`Redis is already running and functional at redis://127.0.0.1:${port}`, 'green');
            log(`Using existing process ID: ${config.pid}`, 'dim');
            process.exit(0);
          } else {
            log('Existing process is not responding. Port may be occupied by another application or stale process.', 'red');
            log('Try running: node scripts/cleanup-redis.js', 'yellow');
            process.exit(1);
          }
        }
      } catch (e) { }
    }

    log(`Port ${port} is occupied but no valid config was found.`, 'red');
    log('If you have a ghost Redis process, run: node scripts/cleanup-redis.js', 'yellow');
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    log(`\nRedis server running at: redis://${host}:${actualPort}`, 'green');
    log(`Process ID: ${process.pid}`, 'dim');
    log(`Config saved to: ${CONFIG_FILE}`, 'dim');

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
      } catch (e) { }

      if (fs.existsSync(CONFIG_FILE)) {
        try {
          const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          if (config.pid === process.pid) {
            fs.unlinkSync(CONFIG_FILE);
          }
        } catch (e) { }
      }
      log('Redis stopped.', 'green');
      process.exit(0);
    };

    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);

    // Keep process alive
    setInterval(() => { }, 1000);

  } catch (error) {
    log(`\nFailed to start Redis: ${error.message}`, 'red');

    // Clean up config if it was us
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (config.pid === process.pid) {
          fs.unlinkSync(CONFIG_FILE);
        }
      } catch (e) { }
    }

    log('\nTroubleshooting:', 'yellow');
    log('  1. Ensure redis-memory-server is installed: npm install', 'dim');
    log('  2. Check if port 6379 is already in use: lsof -i :6379', 'dim');
    log('  3. Run cleanup script: node scripts/cleanup-redis.js', 'dim');
    log('  4. Try using Docker instead: npm run dev:redis', 'dim');
    process.exit(1);
  }
}

main();

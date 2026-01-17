#!/usr/bin/env node
/**
 * Local Development Startup Script
 *
 * Starts all arbitrage system components for local development.
 * Designed for easy testing on M1 Mac.
 *
 * Usage:
 *   npm run dev:start          # Start all services
 *   npm run dev:simulate       # Start with simulation mode (no real blockchain)
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const ROOT_DIR = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');

// Service configurations
const SERVICES = [
  {
    name: 'Coordinator',
    script: 'services/coordinator/src/index.ts',
    port: process.env.COORDINATOR_PORT || 3000,
    healthEndpoint: '/api/health',
    delay: 0
  },
  {
    name: 'P1 Asia-Fast Detector',
    script: 'services/partition-asia-fast/src/index.ts',
    port: process.env.P1_ASIA_FAST_PORT || 3001,
    healthEndpoint: '/health',
    delay: 2000,
    env: { HEALTH_CHECK_PORT: process.env.P1_ASIA_FAST_PORT || 3001 }
  },
  {
    name: 'P2 L2-Turbo Detector',
    script: 'services/partition-l2-turbo/src/index.ts',
    port: process.env.P2_L2_TURBO_PORT || 3002,
    healthEndpoint: '/health',
    delay: 2500,
    env: { HEALTH_CHECK_PORT: process.env.P2_L2_TURBO_PORT || 3002 }
  },
  {
    name: 'P3 High-Value Detector',
    script: 'services/partition-high-value/src/index.ts',
    port: process.env.P3_HIGH_VALUE_PORT || 3003,
    healthEndpoint: '/health',
    delay: 3000,
    env: { HEALTH_CHECK_PORT: process.env.P3_HIGH_VALUE_PORT || 3003 }
  },
  {
    name: 'Cross-Chain Detector',
    script: 'services/cross-chain-detector/src/index.ts',
    port: process.env.CROSS_CHAIN_DETECTOR_PORT || 3004,
    healthEndpoint: '/health',
    delay: 3500,
    env: { HEALTH_CHECK_PORT: process.env.CROSS_CHAIN_DETECTOR_PORT || 3004 }
  },
  {
    name: 'Execution Engine',
    script: 'services/execution-engine/src/index.ts',
    port: process.env.EXECUTION_ENGINE_PORT || 3005,
    healthEndpoint: '/health',
    delay: 4000,
    env: { HEALTH_CHECK_PORT: process.env.EXECUTION_ENGINE_PORT || 3005 }
  }
];

// Colors for console output
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

function logService(name, message, color = 'cyan') {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${colors[color]}[${name}]${colors.reset} ${message}`);
}

const REDIS_MEMORY_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

async function checkDockerRedis() {
  return new Promise((resolve) => {
    exec('docker ps --filter "name=arbitrage-redis" --format "{{.Status}}"', (error, stdout) => {
      if (error || !stdout.includes('Up')) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

async function checkMemoryRedis() {
  // Check if redis-memory-server config file exists
  if (fs.existsSync(REDIS_MEMORY_CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(REDIS_MEMORY_CONFIG_FILE, 'utf8'));
      // Try to connect to verify it's running
      return new Promise((resolve) => {
        const net = require('net');
        const client = new net.Socket();
        client.setTimeout(1000);
        client.connect(config.port, config.host, () => {
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
    } catch (e) {
      return false;
    }
  }
  return false;
}

async function checkRedis() {
  // First check Docker Redis
  const dockerRunning = await checkDockerRedis();
  if (dockerRunning) {
    return { running: true, type: 'docker' };
  }

  // Then check memory Redis
  const memoryRunning = await checkMemoryRedis();
  if (memoryRunning) {
    return { running: true, type: 'memory' };
  }

  return { running: false };
}

async function waitForRedis(maxAttempts = 30) {
  log('\nChecking Redis connection...', 'yellow');

  for (let i = 0; i < maxAttempts; i++) {
    const status = await checkRedis();
    if (status.running) {
      if (status.type === 'docker') {
        log('Redis is ready! (Docker container)', 'green');
      } else if (status.type === 'memory') {
        log('Redis is ready! (In-memory server)', 'green');
      }
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }

  log('\nRedis is not running. Start it with one of these commands:', 'red');
  log('  npm run dev:redis         # Docker (requires Docker Hub access)', 'yellow');
  log('  npm run dev:redis:memory  # In-memory (no Docker required)', 'yellow');
  return false;
}

async function checkHealth(port, endpoint, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${endpoint}`, { timeout }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startService(service) {
  return new Promise((resolve, reject) => {
    logService(service.name, `Starting on port ${service.port}...`, 'yellow');

    const env = {
      ...process.env,
      ...service.env,
      NODE_ENV: 'development',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    };

    const isWindows = process.platform === 'win32';
    const child = spawn('npx', ['ts-node', '-r', 'dotenv/config', '-r', 'tsconfig-paths/register', service.script], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,  // Don't detach on Windows
      shell: isWindows       // Use shell on Windows for proper command resolution
    });

    // Store PID for later cleanup
    const pids = loadPids();
    pids[service.name] = child.pid;
    savePids(pids);

    // Log output
    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          logService(service.name, line, 'dim');
        }
      });
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim() && !line.includes('ExperimentalWarning')) {
          logService(service.name, line, 'red');
        }
      });
    });

    child.on('error', (error) => {
      logService(service.name, `Failed to start: ${error.message}`, 'red');
      reject(error);
    });

    // Detach the child process (only on non-Windows)
    if (!isWindows) {
      child.unref();
    }

    // Wait for health check
    setTimeout(async () => {
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        const healthy = await checkHealth(service.port, service.healthEndpoint);
        if (healthy) {
          logService(service.name, `Started successfully! (PID: ${child.pid})`, 'green');
          resolve(child.pid);
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }

      logService(service.name, 'Health check timeout - service may still be starting', 'yellow');
      resolve(child.pid);
    }, service.delay);
  });
}

function loadPids() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function savePids(pids) {
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  Arbitrage System - Local Development Startup', 'cyan');
  console.log('='.repeat(60) + '\n');

  // Check simulation modes
  if (process.env.SIMULATION_MODE === 'true') {
    log('Running in PRICE SIMULATION MODE - No real blockchain connections', 'yellow');
  }
  if (process.env.EXECUTION_SIMULATION_MODE === 'true') {
    log('Running in EXECUTION SIMULATION MODE - No real transactions', 'yellow');
  }

  // Check Redis
  const redisReady = await waitForRedis();
  if (!redisReady) {
    process.exit(1);
  }

  // Start services
  log('\nStarting services...\n', 'cyan');

  for (const service of SERVICES) {
    try {
      await startService(service);
      // Small delay between services
      await new Promise(r => setTimeout(r, 1000));
    } catch (error) {
      log(`Failed to start ${service.name}: ${error.message}`, 'red');
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  log('  Services Started!', 'green');
  console.log('='.repeat(60));
  log('\nAccess points:', 'cyan');
  SERVICES.forEach(service => {
    log(`  ${service.name.padEnd(22)} http://localhost:${service.port}${service.healthEndpoint}`, 'green');
  });
  log(`  Redis Commander (debug) http://localhost:8081`, 'dim');
  log('\nCommands:', 'cyan');
  log('  npm run dev:status      Check service status', 'dim');
  log('  npm run dev:stop        Stop all services', 'dim');
  log('  npm run dev:redis:logs  View Redis logs', 'dim');
  console.log('');
}

main().catch(error => {
  log(`\nStartup failed: ${error.message}`, 'red');
  process.exit(1);
});

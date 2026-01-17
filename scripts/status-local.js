#!/usr/bin/env node
/**
 * Local Development Status Script
 *
 * Checks the status of all arbitrage system services.
 *
 * Usage:
 *   npm run dev:status
 */

const http = require('http');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const ROOT_DIR = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');
const REDIS_MEMORY_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

// Service configurations (ports match .env.local defaults)
const SERVICES = [
  {
    name: 'Redis',
    type: 'redis',  // Special type to check both docker and memory
    container: 'arbitrage-redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  },
  {
    name: 'Redis Commander',
    type: 'docker',
    container: 'arbitrage-redis-ui',
    port: 8081,
    optional: true
  },
  {
    name: 'Coordinator',
    type: 'node',
    port: parseInt(process.env.COORDINATOR_PORT || '3000', 10),
    healthEndpoint: '/api/health'
  },
  {
    name: 'P1 Asia-Fast',
    type: 'node',
    port: parseInt(process.env.P1_ASIA_FAST_PORT || '3001', 10),
    healthEndpoint: '/health'
  },
  {
    name: 'P2 L2-Turbo',
    type: 'node',
    port: parseInt(process.env.P2_L2_TURBO_PORT || '3002', 10),
    healthEndpoint: '/health'
  },
  {
    name: 'P3 High-Value',
    type: 'node',
    port: parseInt(process.env.P3_HIGH_VALUE_PORT || '3003', 10),
    healthEndpoint: '/health'
  },
  {
    name: 'Cross-Chain Detector',
    type: 'node',
    port: parseInt(process.env.CROSS_CHAIN_DETECTOR_PORT || '3004', 10),
    healthEndpoint: '/health'
  },
  {
    name: 'Execution Engine',
    type: 'node',
    port: parseInt(process.env.EXECUTION_ENGINE_PORT || '3005', 10),
    healthEndpoint: '/health'
  }
];

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

async function checkDocker(containerName) {
  return new Promise((resolve) => {
    exec(`docker ps --filter "name=${containerName}" --format "{{.Status}}"`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ running: false });
      } else {
        resolve({ running: true, status: stdout.trim() });
      }
    });
  });
}

async function checkMemoryRedis() {
  if (fs.existsSync(REDIS_MEMORY_CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(REDIS_MEMORY_CONFIG_FILE, 'utf8'));
      return new Promise((resolve) => {
        const net = require('net');
        const client = new net.Socket();
        client.setTimeout(1000);
        client.connect(config.port, config.host, () => {
          client.destroy();
          resolve({ running: true, status: 'In-memory server' });
        });
        client.on('error', () => {
          client.destroy();
          resolve({ running: false });
        });
        client.on('timeout', () => {
          client.destroy();
          resolve({ running: false });
        });
      });
    } catch (e) {
      return { running: false };
    }
  }
  return { running: false };
}

async function checkRedisService(service) {
  // First check Docker
  const dockerStatus = await checkDocker(service.container);
  if (dockerStatus.running) {
    return { running: true, status: `Docker: ${dockerStatus.status}` };
  }

  // Then check memory server
  const memoryStatus = await checkMemoryRedis();
  if (memoryStatus.running) {
    return memoryStatus;
  }

  return { running: false };
}

async function checkHealth(port, endpoint, timeout = 3000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = http.get(`http://localhost:${port}${endpoint}`, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        try {
          const json = JSON.parse(data);
          resolve({
            running: true,
            status: json.status || 'ok',
            latency,
            details: json
          });
        } catch {
          resolve({ running: true, status: 'ok', latency });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
  });
}

async function getServiceStatus(service) {
  if (service.type === 'redis') {
    return await checkRedisService(service);
  } else if (service.type === 'docker') {
    return await checkDocker(service.container);
  } else {
    return await checkHealth(service.port, service.healthEndpoint);
  }
}

function formatStatus(status, optional = false) {
  if (status.running) {
    const latency = status.latency ? ` (${status.latency}ms)` : '';
    const detail = status.status ? ` - ${status.status}` : '';
    return `${colors.green}Running${colors.reset}${detail}${latency}`;
  } else if (optional) {
    return `${colors.dim}Not running (optional)${colors.reset}`;
  } else {
    return `${colors.red}Not running${colors.reset}`;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  Arbitrage System - Service Status', 'cyan');
  console.log('='.repeat(60) + '\n');

  // Check environment
  const envFile = fs.existsSync(path.join(ROOT_DIR, '.env'));
  log(`Environment: ${envFile ? 'Configured (.env exists)' : 'Using defaults (.env.local)'}`, 'dim');

  // Check simulation modes
  const priceSimulation = process.env.SIMULATION_MODE === 'true';
  const executionSimulation = process.env.EXECUTION_SIMULATION_MODE === 'true';

  if (priceSimulation || executionSimulation) {
    const modes = [];
    if (priceSimulation) modes.push('PRICE SIMULATION (fake blockchain data)');
    if (executionSimulation) modes.push('EXECUTION SIMULATION (no real transactions)');
    log('Mode: ' + modes.join(' + '), 'yellow');
  }
  console.log('');

  // Check each service
  log('Service Status:', 'cyan');
  console.log('-'.repeat(60));

  let allRunning = true;
  let criticalDown = false;

  for (const service of SERVICES) {
    const status = await getServiceStatus(service);
    const statusStr = formatStatus(status, service.optional);
    const portStr = `(port ${service.port})`.padEnd(12);

    console.log(`  ${service.name.padEnd(20)} ${portStr} ${statusStr}`);

    if (!status.running && !service.optional) {
      allRunning = false;
      if (service.name === 'Redis') {
        criticalDown = true;
      }
    }
  }

  console.log('-'.repeat(60));

  // Summary
  console.log('');
  if (allRunning) {
    log('All services are running!', 'green');
    log('\nDashboard: http://localhost:' + (process.env.COORDINATOR_PORT || 3000), 'cyan');
  } else if (criticalDown) {
    log('Redis is not running. Start it with one of:', 'red');
    log('  npm run dev:redis         # Docker (requires Docker Hub access)', 'yellow');
    log('  npm run dev:redis:memory  # In-memory (no Docker required)', 'yellow');
  } else {
    log('Some services are not running. Start all with:', 'yellow');
    log('  npm run dev:start', 'cyan');
  }

  // Load PIDs if available
  try {
    if (fs.existsSync(PID_FILE)) {
      const pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      if (Object.keys(pids).length > 0) {
        log('\nProcess IDs:', 'dim');
        for (const [name, pid] of Object.entries(pids)) {
          log(`  ${name}: ${pid}`, 'dim');
        }
      }
    }
  } catch (e) {}

  console.log('');
}

main().catch(error => {
  log(`Error: ${error.message}`, 'red');
  process.exit(1);
});

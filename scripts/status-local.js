#!/usr/bin/env node
/**
 * Local Development Status Script
 *
 * Checks the status of all arbitrage system services.
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:status
 */

const fs = require('fs');

const {
  log,
  colors,
  checkHealth,
  checkRedis,
  checkDockerContainer,
  checkTcpConnection,
  loadPids,
  getRedisMemoryConfig,
  ROOT_DIR,
  PID_FILE
} = require('./lib/utils');

const { getStatusServices, PORTS } = require('./lib/services-config');

// =============================================================================
// Service Status Checking
// =============================================================================

/**
 * Check Redis service status (Docker or In-Memory).
 * @param {Object} service - Service configuration
 * @returns {Promise<{running: boolean, status?: string}>}
 */
async function checkRedisService(service) {
  // First check Docker
  const dockerStatus = await checkDockerContainer(service.container);
  if (dockerStatus.running) {
    return { running: true, status: `Docker: ${dockerStatus.status}` };
  }

  // Then check memory server
  const redisConfig = getRedisMemoryConfig();
  if (redisConfig) {
    const isRunning = await checkTcpConnection(redisConfig.host, redisConfig.port);
    if (isRunning) {
      return { running: true, status: 'In-memory server' };
    }
  }

  return { running: false };
}

/**
 * Get status for a service.
 * @param {Object} service - Service configuration
 * @returns {Promise<{running: boolean, status?: string, latency?: number}>}
 */
async function getServiceStatus(service) {
  if (service.type === 'redis') {
    return await checkRedisService(service);
  } else if (service.type === 'docker') {
    return await checkDockerContainer(service.container);
  } else if (service.type === 'node') {
    return await checkHealth(service.port, service.healthEndpoint, 3000);
  }
  return { running: false };
}

/**
 * Format status for display.
 * @param {Object} status - Status object
 * @param {boolean} optional - Whether service is optional
 * @returns {string}
 */
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

// =============================================================================
// Main Status Logic
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  log('  Arbitrage System - Service Status', 'cyan');
  console.log('='.repeat(60) + '\n');

  // Check environment
  const envFile = fs.existsSync(require('path').join(ROOT_DIR, '.env'));
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

  // Get services to check
  const SERVICES = getStatusServices();

  // Check each service
  log('Service Status:', 'cyan');
  console.log('-'.repeat(60));

  let allRunning = true;
  let criticalDown = false;

  // Run all health checks in parallel for performance
  const statusPromises = SERVICES.map(async (service) => {
    const status = await getServiceStatus(service);
    return { service, status };
  });

  const results = await Promise.all(statusPromises);

  for (const { service, status } of results) {
    const statusStr = formatStatus(status, service.optional);
    const portStr = `(port ${service.port})`.padEnd(12);

    console.log(`  ${service.name.padEnd(22)} ${portStr} ${statusStr}`);

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
    log(`\nDashboard: http://localhost:${PORTS.COORDINATOR}`, 'cyan');
  } else if (criticalDown) {
    log('Redis is not running. Start it with one of:', 'red');
    log('  npm run dev:redis         # Docker (requires Docker Hub access)', 'yellow');
    log('  npm run dev:redis:memory  # In-memory (no Docker required)', 'yellow');
  } else {
    log('Some services are not running. Start all with:', 'yellow');
    log('  npm run dev:start', 'cyan');
  }

  // Load PIDs if available
  const pids = loadPids();
  if (Object.keys(pids).length > 0) {
    log('\nProcess IDs:', 'dim');
    for (const [name, pid] of Object.entries(pids)) {
      log(`  ${name}: ${pid}`, 'dim');
    }
  }

  console.log('');
}

// =============================================================================
// Entry Point
// =============================================================================

main().catch(error => {
  log(`Error: ${error.message}`, 'red');
  process.exit(1);
});

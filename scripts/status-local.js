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
  logger,  // Task #5: Use modern logger interface
  log,     // Keep for backward compatibility where needed
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

const { getStatusServices, PORTS, checkAndPrintDeprecations } = require('./lib/services-config');

// Check for deprecated environment variables
checkAndPrintDeprecations();

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
  // Task #5: Use modern logger.header() instead of manual separator
  logger.header('Arbitrage System - Service Status');

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

  // Summary (Task #5: Use semantic logger methods)
  console.log('');
  if (allRunning) {
    logger.success('All services are running!');
    logger.info(`Dashboard: http://localhost:${PORTS.COORDINATOR}`);
  } else if (criticalDown) {
    logger.error('Redis is not running. Start it with one of:');
    logger.warning('  npm run dev:redis         # Docker (requires Docker Hub access)');
    logger.warning('  npm run dev:redis:memory  # In-memory (no Docker required)');
  } else {
    logger.warning('Some services are not running. Start all with:');
    logger.info('  npm run dev:start');
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

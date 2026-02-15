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
  checkDockerContainer,
  checkTcpConnection,
  loadPids,
  savePids,
  deletePidFile,
  processExists,
  getRedisMemoryConfig,
  ROOT_DIR,
} = require('./lib/utils');

const { getStatusServices, PORTS, checkAndPrintDeprecations } = require('./lib/services-config');

// P3-3: Use shared constants
const { STATUS_CHECK_TIMEOUT_MS } = require('./lib/constants');

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
 * Check if a local service port is accepting TCP connections.
 * Tries localhost and IPv4 loopback for cross-platform compatibility.
 *
 * @param {number} port - Port number
 * @returns {Promise<boolean>}
 */
async function checkLocalPortOpen(port) {
  if (await checkTcpConnection('localhost', port)) return true;
  if (await checkTcpConnection('127.0.0.1', port)) return true;
  return false;
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
    // First try HTTP health endpoint.
    // If health is slow/unhealthy but port is open, treat as running with degraded health.
    const health = await checkHealth(service.port, service.healthEndpoint, STATUS_CHECK_TIMEOUT_MS);
    if (health.running) {
      return { ...health, healthy: true };
    }

    // Fallback: process may be running but health endpoint can timeout under load.
    const portOpen = await checkLocalPortOpen(service.port);
    if (portOpen) {
      const healthHint = health.status ? `health: ${health.status}` : 'health check timeout';
      return {
        running: true,
        healthy: false,
        status: healthHint,
        latency: health.latency
      };
    }

    return { running: false, healthy: false };
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
  if (status.running && status.healthy === false) {
    const latency = status.latency ? ` (${status.latency}ms)` : '';
    const detail = status.status ? ` - ${status.status}` : '';
    return `${colors.yellow}Running (degraded)${colors.reset}${detail}${latency}`;
  }

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

/**
 * Remove stale PIDs from .local-services.pid and return only live entries.
 * @param {Object<string, number|string>} pids
 * @param {Array<{name: string, type?: string, port?: number}>} services
 * @returns {Promise<Object<string, number>>}
 */
async function pruneStalePids(pids, services = []) {
  const servicesByName = new Map(services.map((service) => [service.name, service]));
  const live = {};
  let staleCount = 0;

  for (const [name, rawPid] of Object.entries(pids)) {
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      staleCount++;
      continue;
    }

    if (await processExists(pid)) {
      const service = servicesByName.get(name);
      if (service?.type === 'node' && typeof service.port === 'number') {
        if (!await checkLocalPortOpen(service.port)) {
          staleCount++;
          continue;
        }
      }
      live[name] = pid;
    } else {
      staleCount++;
    }
  }

  if (staleCount > 0) {
    if (Object.keys(live).length === 0) {
      deletePidFile();
    } else {
      savePids(live);
    }
    logger.warning(`Removed ${staleCount} stale PID entr${staleCount === 1 ? 'y' : 'ies'} from .local-services.pid`);
  }

  return live;
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
  const SERVICES = getStatusServices()
    .slice()
    .sort((a, b) => {
      if (a.port !== b.port) return a.port - b.port;
      return a.name.localeCompare(b.name);
    });

  // Check each service
  log('Service Status:', 'cyan');
  console.log('-'.repeat(60));

  let allRunning = true;
  let allHealthy = true;
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

    if (status.running && status.healthy === false && !service.optional) {
      allHealthy = false;
    }
  }

  console.log('-'.repeat(60));

  // Summary (Task #5: Use semantic logger methods)
  console.log('');
  if (allRunning && allHealthy) {
    logger.success('All services are running!');
    logger.info(`Dashboard: http://localhost:${PORTS.COORDINATOR}`);
  } else if (allRunning && !allHealthy) {
    logger.warning('All services are running, but some health checks are degraded/slow.');
    logger.info('Increase status timeout if needed: scripts/lib/constants.js -> STATUS_CHECK_TIMEOUT_MS');
  } else if (criticalDown) {
    logger.error('Redis is not running. Start it with one of:');
    logger.warning('  npm run dev:redis         # Docker (requires Docker Hub access)');
    logger.warning('  npm run dev:redis:memory  # In-memory (no Docker required)');
  } else {
    logger.warning('Some services are not running. Start all with:');
    logger.info('  npm run dev:start');
  }

  // Load PIDs if available
  const pids = await pruneStalePids(loadPids(), SERVICES);
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

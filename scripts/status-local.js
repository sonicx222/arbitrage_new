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
  processExists,         // FIX #15/#11: Check PID liveness
  getRedisMemoryConfig,
  deleteRedisMemoryConfig, // FIX #15: Clean stale Redis config
  ROOT_DIR,
  PID_FILE
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
    // FIX #15: Config exists but Redis not responding — check if PID is stale
    const pidAlive = await processExists(redisConfig.pid);
    if (!pidAlive) {
      logger.warning(`Stale Redis config found (PID ${redisConfig.pid} no longer exists). Cleaning up...`);
      deleteRedisMemoryConfig();
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
    // P3-3: Use constant instead of hardcoded timeout
    return await checkHealth(service.port, service.healthEndpoint, STATUS_CHECK_TIMEOUT_MS);
  }
  return { running: false };
}

/**
 * FIX #14: Normalize health status strings to a consistent display.
 * Different services report "ok", "healthy", "degraded", "unhealthy", "error".
 * @param {string} status - Raw status string from health endpoint
 * @returns {string} Normalized status string
 */
function normalizeHealthStatus(status) {
  if (!status) return 'healthy';
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'healthy') return 'healthy';
  if (s === 'degraded') return 'degraded';
  if (s === 'unhealthy' || s === 'error') return 'unhealthy';
  return status; // Unknown status — show as-is
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
    // FIX #14: Normalize status string for consistent display
    const normalized = normalizeHealthStatus(status.status);
    const detail = normalized ? ` - ${normalized}` : '';
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

  // Check simulation modes — prefer metadata file (persists across terminals) over env vars
  // FIX #10: Read from persisted metadata for cross-session visibility
  let priceSimulation = process.env.SIMULATION_MODE === 'true';
  let executionSimulation = process.env.EXECUTION_SIMULATION_MODE === 'true';

  const META_FILE = require('path').join(ROOT_DIR, '.local-services.meta');
  try {
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      priceSimulation = priceSimulation || meta.simulationMode;
      executionSimulation = executionSimulation || meta.executionSimulationMode;
    }
  } catch {
    // Fall back to env vars only
  }

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
  // FIX #11: Cross-reference PIDs with process liveness to identify stale entries
  const pids = loadPids();
  if (Object.keys(pids).length > 0) {
    log('\nProcess IDs:', 'dim');
    for (const [name, pid] of Object.entries(pids)) {
      const alive = await processExists(pid);
      if (alive) {
        log(`  ${name}: ${pid}`, 'dim');
      } else {
        log(`  ${name}: ${pid} ${colors.red}(stale - process not running)${colors.reset}`, 'dim');
      }
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

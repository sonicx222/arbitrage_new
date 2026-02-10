#!/usr/bin/env node
/**
 * Local Development Startup Script
 *
 * Starts all arbitrage system components for local development.
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:start          # Start all services
 *   npm run dev:simulate       # Start with simulation mode (no real blockchain)
 */

const { spawn } = require('child_process');

const {
  logger,      // P3-4: Modern logger interface (preferred)
  log,         // Legacy - kept for formatting/dim output
  logService,  // Service-specific logging (keep for now)
  isWindows,
  checkRedis,
  checkHealth,
  updatePid,
  removePid,
  killProcess,
  processExists,
  ROOT_DIR
} = require('./lib/utils');

const { getStartupServices, PORTS, checkAndPrintDeprecations } = require('./lib/services-config');

// Task P2-2: Use shared constants
const {
  REDIS_STARTUP_TIMEOUT_SEC,
  REDIS_CHECK_INTERVAL_MS,
  SERVICE_STARTUP_MAX_ATTEMPTS,
  HEALTH_CHECK_INTERVAL_MS,
  SERVICE_START_DELAY_MS
} = require('./lib/constants');

// =============================================================================
// Configuration
// =============================================================================

// Check for deprecated environment variables
checkAndPrintDeprecations();

const SERVICES = getStartupServices();

// =============================================================================
// Redis Check
// =============================================================================

async function waitForRedis(maxAttempts = REDIS_STARTUP_TIMEOUT_SEC) {
  // P3-4: Migrated to modern logger
  logger.info('\nChecking Redis connection...');

  for (let i = 0; i < maxAttempts; i++) {
    const status = await checkRedis();
    if (status.running) {
      if (status.type === 'docker') {
        logger.success('Redis is ready! (Docker container)');
      } else if (status.type === 'memory') {
        logger.success('Redis is ready! (In-memory server)');
      }
      return true;
    }
    await new Promise(r => setTimeout(r, REDIS_CHECK_INTERVAL_MS));
    process.stdout.write('.');
  }

  logger.error('\nRedis is not running. Start it with one of these commands:');
  logger.warning('  npm run dev:redis         # Docker (requires Docker Hub access)');
  logger.warning('  npm run dev:redis:memory  # In-memory (no Docker required)');
  return false;
}

// =============================================================================
// Service Startup
// =============================================================================

async function startService(service) {
  return new Promise((resolve, reject) => {
    logService(service.name, `Starting on port ${service.port}...`, 'yellow');

    const env = {
      ...process.env,
      ...service.env,
      NODE_ENV: 'development',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    };

    // Cross-platform process spawning
    let child;
    if (isWindows()) {
      // On Windows, use shell with a single command string
      // FIX: DEP0190 - Avoid deprecation warning
      // FIX: Added detached + windowsHide to prevent process leak on parent exit
      const command = `npx ts-node -r dotenv/config -r tsconfig-paths/register ${service.script}`;
      child = spawn(command, [], {
        cwd: ROOT_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        detached: true,
        windowsHide: true
      });
    } else {
      // On Unix, use array args without shell for better process management
      child = spawn('npx', ['ts-node', '-r', 'dotenv/config', '-r', 'tsconfig-paths/register', service.script], {
        cwd: ROOT_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    }

    // Store PID for later cleanup using atomic update (prevents race conditions)
    // FIX P1-2: Await PID save and kill process if it fails (prevent ghost processes)
    try {
      await updatePid(service.name, child.pid);
    } catch (err) {
      logService(service.name, `CRITICAL: Failed to save PID - killing process to prevent ghost`, 'red');
      await killProcess(child.pid);
      reject(new Error(
        `Cannot track ${service.name} process (PID ${child.pid}).\n` +
        `PID file update failed: ${err.message}\n\n` +
        `This prevents proper cleanup via "npm run dev:stop".\n` +
        `Possible causes:\n` +
        `  - Disk full\n` +
        `  - Permission denied writing to ${ROOT_DIR}/.local-services.pid\n` +
        `  - Lock timeout (another script holding lock)\n\n` +
        `To fix:\n` +
        `  1. Check disk space: df -h (Unix) or dir (Windows)\n` +
        `  2. Check file permissions on .local-services.pid\n` +
        `  3. Run: npm run dev:cleanup (to clear stale locks)\n` +
        `  4. Retry: npm run dev:start`
      ));
      return; // Exit early, don't set up event handlers
    }

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

    // Detach the child process to allow parent to exit independently
    // FIX: Now also applies to Windows (previously caused parent to hang)
    child.unref();

    // Wait for health check after startup delay
    setTimeout(async () => {
      let attempts = 0;
      const maxAttempts = SERVICE_STARTUP_MAX_ATTEMPTS;

      while (attempts < maxAttempts) {
        const healthResult = await checkHealth(service.port, service.healthEndpoint);
        if (healthResult.running) {
          logService(service.name, `Started successfully! (PID: ${child.pid})`, 'green');
          resolve(child.pid);
          return;
        }

        // Check if process is still running
        // FIX P2-1: Use processExists() for Windows compatibility
        const isRunning = await processExists(child.pid);
        if (!isRunning) {
          // FIX P1-2: Process has died - clean up PID entry to prevent ghost processes
          logService(service.name, 'Process terminated unexpectedly', 'red');
          await removePid(service.name).catch(() => {
            // Ignore cleanup errors (PID may not have been saved yet)
          });
          // Task P2-3: Enhanced error message with actionable context
          reject(new Error(
            `${service.name} process died during startup.\n\n` +
            `Possible causes:\n` +
            `  - Missing dependencies (run: npm install)\n` +
            `  - Configuration error in .env file\n` +
            `  - Port ${service.port} already in use\n` +
            `  - TypeScript compilation error\n\n` +
            `To debug:\n` +
            `  1. Check the error output above for details\n` +
            `  2. Try starting the service directly:\n` +
            `     npx ts-node ${service.script}\n` +
            `  3. Check if port ${service.port} is available:\n` +
            `     npx kill-port ${service.port}`
          ));
          return;
        }

        await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
        attempts++;
      }

      // FIX P1-2: Health check timeout - kill the process and clean up to prevent ghost processes
      logService(service.name, 'Health check timeout - killing process', 'red');
      await killProcess(child.pid);
      await removePid(service.name).catch(() => {
        // Ignore cleanup errors (PID may not have been saved yet)
      });
      // Task P2-3: Enhanced error message with actionable context
      const actualTimeoutSec = (maxAttempts * HEALTH_CHECK_INTERVAL_MS) / 1000;
      reject(new Error(
        `${service.name} health check timeout after ${actualTimeoutSec}s (${maxAttempts} attempts).\n\n` +
        `The service started but failed to respond on ${service.healthEndpoint}.\n\n` +
        `Possible causes:\n` +
        `  - Service is still initializing (normal for first start)\n` +
        `  - Health check endpoint incorrect or not implemented\n` +
        `  - Service crashed after starting\n` +
        `  - Firewall blocking port ${service.port}\n\n` +
        `To debug:\n` +
        `  1. Check if service is listening:\n` +
        `     curl http://localhost:${service.port}${service.healthEndpoint}\n` +
        `  2. Increase timeout (currently ${maxAttempts} attempts × ${HEALTH_CHECK_INTERVAL_MS}ms) in scripts/lib/constants.js\n` +
        `  3. Check service logs for startup errors\n` +
        `  4. Try starting service directly to see full output:\n` +
        `     npx ts-node ${service.script}`
      ));
    }, service.delay);
  });
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main() {
  // P3-4: Use modern logger.header() for section headers
  logger.header('Arbitrage System - Local Development Startup');

  // Check simulation modes
  if (process.env.SIMULATION_MODE === 'true') {
    logger.warning('Running in PRICE SIMULATION MODE - No real blockchain connections');
  }
  if (process.env.EXECUTION_SIMULATION_MODE === 'true') {
    logger.warning('Running in EXECUTION SIMULATION MODE - No real transactions');
  }

  // Check Redis
  const redisReady = await waitForRedis();
  if (!redisReady) {
    process.exit(1);
  }

  // Start services
  logger.info('\nStarting services...\n');

  const failedServices = [];
  for (const service of SERVICES) {
    try {
      await startService(service);
      // Small delay between services
      await new Promise(r => setTimeout(r, SERVICE_START_DELAY_MS));
    } catch (error) {
      logger.error(`Failed to start ${service.name}: ${error.message}`);
      // FIX P1-2: Track failed services for summary
      failedServices.push({ name: service.name, error: error.message });
    }
  }

  // FIX P1-2: Show failed services summary
  if (failedServices.length > 0) {
    logger.warning('\n⚠️  Some services failed to start:');
    failedServices.forEach(({ name, error }) => {
      logger.warning(`  • ${name}: ${error}`);
    });
    logger.info('\nTo cleanup and retry:');
    log('  npm run dev:cleanup', 'dim');  // Keep log() for dim formatting
    log('  npm run dev:start', 'dim');
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  logger.success('  Services Started!');
  console.log('='.repeat(60));
  logger.info('\nAccess points:');
  SERVICES.forEach(service => {
    logger.success(`  ${service.name.padEnd(22)} http://localhost:${service.port}${service.healthEndpoint}`);
  });
  log(`  Redis Commander (debug) http://localhost:${PORTS.REDIS_UI}`, 'dim');
  logger.info('\nCommands:');
  log('  npm run dev:status      Check service status', 'dim');
  log('  npm run dev:stop        Stop all services', 'dim');
  log('  npm run dev:redis:logs  View Redis logs', 'dim');
  console.log('');
}

main().catch(error => {
  logger.error(`\nStartup failed: ${error.message}`);
  process.exit(1);
});

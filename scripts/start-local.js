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
  log,
  logService,
  isWindows,
  checkRedis,
  checkHealth,
  updatePid,
  removePid,
  killProcess,
  processExists,
  ROOT_DIR
} = require('./lib/utils');

const { getStartupServices, PORTS } = require('./lib/services-config');

// =============================================================================
// Configuration
// =============================================================================

const SERVICES = getStartupServices();

// =============================================================================
// Redis Check
// =============================================================================

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
    updatePid(service.name, child.pid).catch(err => {
      logService(service.name, `Warning: Failed to save PID: ${err.message}`, 'yellow');
    });

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
      const maxAttempts = 30;

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
          reject(new Error(`${service.name} process died during startup`));
          return;
        }

        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }

      // FIX P1-2: Health check timeout - kill the process and clean up to prevent ghost processes
      logService(service.name, 'Health check timeout - killing process', 'red');
      await killProcess(child.pid);
      await removePid(service.name).catch(() => {
        // Ignore cleanup errors (PID may not have been saved yet)
      });
      reject(new Error(`${service.name} health check timeout after ${maxAttempts} seconds`));
    }, service.delay);
  });
}

// =============================================================================
// Main Entry Point
// =============================================================================

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

  let failedServices = [];
  for (const service of SERVICES) {
    try {
      await startService(service);
      // Small delay between services
      await new Promise(r => setTimeout(r, 1000));
    } catch (error) {
      log(`Failed to start ${service.name}: ${error.message}`, 'red');
      // FIX P1-2: Track failed services for summary
      failedServices.push({ name: service.name, error: error.message });
    }
  }

  // FIX P1-2: Show failed services summary
  if (failedServices.length > 0) {
    log('\n⚠️  Some services failed to start:', 'yellow');
    failedServices.forEach(({ name, error }) => {
      log(`  • ${name}: ${error}`, 'yellow');
    });
    log('\nTo cleanup and retry:', 'cyan');
    log('  npm run dev:cleanup', 'dim');
    log('  npm run dev:start', 'dim');
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  log('  Services Started!', 'green');
  console.log('='.repeat(60));
  log('\nAccess points:', 'cyan');
  SERVICES.forEach(service => {
    log(`  ${service.name.padEnd(22)} http://localhost:${service.port}${service.healthEndpoint}`, 'green');
  });
  log(`  Redis Commander (debug) http://localhost:${PORTS.REDIS_UI}`, 'dim');
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

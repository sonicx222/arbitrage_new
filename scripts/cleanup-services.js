#!/usr/bin/env node
/**
 * Cleanup ALL local services ghost processes and stale config files.
 * Covers Redis, Coordinator, and all Detector services.
 *
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:cleanup
 */

const {
  logger,      // P3-4: Modern logger interface
  log,         // Legacy - kept for dim/detailed output
  killProcess,
  processExists,
  findProcessesByPort,
  findGhostNodeProcesses,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig,
  deletePidFile
} = require('./lib/utils');

const { getCleanupPorts } = require('./lib/services-config');

// =============================================================================
// Main Cleanup Logic
// =============================================================================

async function cleanup() {
  // P3-4: Migrated to modern logger
  logger.header('Local Services Cleanup Utility');

  // 1. Cleanup Redis specifically (config file + process)
  logger.warning('--- Cleaning up Redis ---');
  const redisConfig = getRedisMemoryConfig();
  if (redisConfig) {
    log(`Found stale Redis config for PID ${redisConfig.pid}`, 'dim');
    // FIX P2-1: Use processExists() instead of process.kill(pid, 0) for Windows compatibility
    const exists = await processExists(redisConfig.pid);
    if (exists) {
      log(`Killing Redis process ${redisConfig.pid}...`, 'dim');
      const killed = await killProcess(redisConfig.pid);
      if (killed) {
        logger.success('Redis process killed.');
      } else {
        logger.warning('Could not kill Redis process (may already be stopped).');
      }
    } else {
      log('Redis process not running.', 'dim');
    }
    deleteRedisMemoryConfig();
    logger.success('Deleted Redis config file.');
  } else {
    log('No Redis memory config found.', 'dim');
  }

  // 2. Kill any node/redis processes by port
  logger.warning('\n--- Cleaning up ports ---');
  const ports = getCleanupPorts();

  for (const svc of ports) {
    try {
      const pids = await findProcessesByPort(svc.port);
      if (pids.length > 0) {
        logger.warning(`${svc.name} (port ${svc.port}) is occupied by PIDs: ${pids.join(', ')}`);
        for (const pid of pids) {
          log(`  Killing PID ${pid}...`, 'dim');
          const killed = await killProcess(pid);
          if (killed) {
            logger.success(`  PID ${pid} killed.`);
          } else {
            logger.error(`  Failed to kill PID ${pid}.`);
          }
        }
        logger.success(`  Port ${svc.port} released.`);
      } else {
        log(`${svc.name} (port ${svc.port}) is already free.`, 'dim');
      }
    } catch (e) {
      // Task P2-3: Enhanced error message with actionable context
      log(
        `Error checking port ${svc.port}: ${e.message}\n` +
        `  This may indicate permission issues or network problems.\n` +
        `  Try running with elevated privileges if on Windows.`,
        'red'
      );
    }
  }

  // 3. Cleanup any other ghost node processes related to the project
  logger.warning('\n--- Cleaning up ghost node processes ---');
  try {
    const ghostProcesses = await findGhostNodeProcesses();
    if (ghostProcesses.length > 0) {
      logger.warning(`Found ${ghostProcesses.length} ghost processes.`);
      for (const proc of ghostProcesses) {
        log(`  Killing ghost process ${proc.pid}: ${proc.cmd}...`, 'dim');
        await killProcess(proc.pid);
      }
      logger.success('Ghost processes cleaned up.');
    } else {
      logger.success('No ghost node processes found.');
    }
  } catch (e) {
    // Task P2-3: Enhanced error message with actionable context
    log(
      `Error finding ghost processes: ${e.message}\n` +
      `  This may occur if:\n` +
      `    - Process listing commands (ps/wmic) are unavailable\n` +
      `    - Permission denied to list processes\n` +
      `  Some ghost processes may remain. Check manually with:\n` +
      `    Windows: tasklist | findstr node\n` +
      `    Unix: ps aux | grep node`,
      'red'
    );
  }

  // 4. Cleanup PID file
  logger.warning('\n--- Cleaning up PID file ---');
  try {
    deletePidFile();
    logger.success('PID file cleaned up.');
  } catch {
    log('No PID file to clean up.', 'dim');
  }

  logger.success('\nCleanup complete! Your local environment is now clean.');
  logger.info('You can now start services using:');
  log('  npm run dev:start         # Start all services', 'dim');
  log('  npm run dev:coordinator   # Start only coordinator', 'dim');
  log('  npm run dev:redis:memory  # Start only Redis', 'dim');
  console.log();
}

// =============================================================================
// Entry Point
// =============================================================================

cleanup().catch((error) => {
  logger.error(`Cleanup failed: ${error.message}`);
  process.exit(1);
});

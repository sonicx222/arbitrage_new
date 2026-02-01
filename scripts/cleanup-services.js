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
  log,
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
  log('\n' + '='.repeat(60), 'cyan');
  log('  Local Services Cleanup Utility', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');

  // 1. Cleanup Redis specifically (config file + process)
  log('--- Cleaning up Redis ---', 'yellow');
  const redisConfig = getRedisMemoryConfig();
  if (redisConfig) {
    log(`Found stale Redis config for PID ${redisConfig.pid}`, 'dim');
    // FIX P2-1: Use processExists() instead of process.kill(pid, 0) for Windows compatibility
    const exists = await processExists(redisConfig.pid);
    if (exists) {
      log(`Killing Redis process ${redisConfig.pid}...`, 'dim');
      const killed = await killProcess(redisConfig.pid);
      if (killed) {
        log('Redis process killed.', 'green');
      } else {
        log('Could not kill Redis process (may already be stopped).', 'yellow');
      }
    } else {
      log('Redis process not running.', 'dim');
    }
    deleteRedisMemoryConfig();
    log('Deleted Redis config file.', 'green');
  } else {
    log('No Redis memory config found.', 'dim');
  }

  // 2. Kill any node/redis processes by port
  log('\n--- Cleaning up ports ---', 'yellow');
  const ports = getCleanupPorts();

  for (const svc of ports) {
    try {
      const pids = await findProcessesByPort(svc.port);
      if (pids.length > 0) {
        log(`${svc.name} (port ${svc.port}) is occupied by PIDs: ${pids.join(', ')}`, 'yellow');
        for (const pid of pids) {
          log(`  Killing PID ${pid}...`, 'dim');
          const killed = await killProcess(pid);
          if (killed) {
            log(`  PID ${pid} killed.`, 'green');
          } else {
            log(`  Failed to kill PID ${pid}.`, 'red');
          }
        }
        log(`  Port ${svc.port} released.`, 'green');
      } else {
        log(`${svc.name} (port ${svc.port}) is already free.`, 'dim');
      }
    } catch (e) {
      log(`Error checking port ${svc.port}: ${e.message}`, 'red');
    }
  }

  // 3. Cleanup any other ghost node processes related to the project
  log('\n--- Cleaning up ghost node processes ---', 'yellow');
  try {
    const ghostProcesses = await findGhostNodeProcesses();
    if (ghostProcesses.length > 0) {
      log(`Found ${ghostProcesses.length} ghost processes.`, 'yellow');
      for (const proc of ghostProcesses) {
        log(`  Killing ghost process ${proc.pid}: ${proc.cmd}...`, 'dim');
        await killProcess(proc.pid);
      }
      log('Ghost processes cleaned up.', 'green');
    } else {
      log('No ghost node processes found.', 'green');
    }
  } catch (e) {
    log(`Error finding ghost processes: ${e.message}`, 'red');
  }

  // 4. Cleanup PID file
  log('\n--- Cleaning up PID file ---', 'yellow');
  try {
    deletePidFile();
    log('PID file cleaned up.', 'green');
  } catch {
    log('No PID file to clean up.', 'dim');
  }

  log('\nCleanup complete! Your local environment is now clean.', 'cyan');
  log('You can now start services using:', 'cyan');
  log('  npm run dev:start         # Start all services', 'dim');
  log('  npm run dev:coordinator   # Start only coordinator', 'dim');
  log('  npm run dev:redis:memory  # Start only Redis', 'dim');
  console.log();
}

// =============================================================================
// Entry Point
// =============================================================================

cleanup().catch((error) => {
  log(`Cleanup failed: ${error.message}`, 'red');
  process.exit(1);
});

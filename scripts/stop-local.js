#!/usr/bin/env node
/**
 * Local Development Stop Script
 *
 * Stops all running arbitrage system services.
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:stop
 */

const {
  logger,      // P3-4: Modern logger interface
  log,         // Legacy - kept for dim output
  killProcess,
  killAllPids,
  killTsNodeProcesses,
  findProcessesByPort,
  findGhostNodeProcesses,
  loadPids,
  deletePidFile,
  ROOT_DIR       // FIX #10: Needed for metadata file cleanup
} = require('./lib/utils');

const { getCleanupPorts } = require('./lib/services-config');

// =============================================================================
// Main Stop Logic
// =============================================================================

async function main() {
  // P3-4: Migrated to modern logger
  logger.header('Stopping Arbitrage System Services');

  // Load PIDs
  const pids = loadPids();

  if (Object.keys(pids).length === 0) {
    logger.warning('No PID file found or no services registered.');
  } else {
    // FIX #10 + #9: Kill all services in parallel using shared killAllPids
    const results = await killAllPids(pids);
    for (const r of results) {
      if (!r.existed) {
        log(`  ${r.name} was not running (PID ${r.pid} no longer exists)`, 'dim');
      } else if (r.killed) {
        logger.success(`  ${r.name} stopped`);
      } else {
        log(`  ${r.name} could not be stopped (PID: ${r.pid})`, 'dim');
      }
    }
  }

  // Also kill any ts-node/tsx processes running our services
  logger.info('\nCleaning up any remaining processes...');
  await killTsNodeProcesses();

  // Port-based cleanup: kill anything still listening on service ports
  // This catches child processes that survived PID-based kill (e.g., ts-node→node chain)
  const ports = getCleanupPorts();
  let portOrphans = 0;
  for (const svc of ports) {
    try {
      const portPids = await findProcessesByPort(svc.port);
      for (const portPid of portPids) {
        log(`  Killing orphan on port ${svc.port} (PID ${portPid})...`, 'dim');
        await killProcess(portPid);
        portOrphans++;
      }
    } catch (err) {
      console.warn(`Warning: port check for ${svc.port} failed:`, err?.message ?? err);
    }
  }
  if (portOrphans > 0) {
    logger.info(`  Cleaned up ${portOrphans} orphan process(es) by port.`);
  }

  // Ghost process cleanup: catch any remaining node processes
  try {
    const ghosts = await findGhostNodeProcesses();
    for (const ghost of ghosts) {
      log(`  Killing ghost process ${ghost.pid}: ${ghost.cmd}`, 'dim');
      await killProcess(ghost.pid);
    }
    if (ghosts.length > 0) {
      logger.info(`  Cleaned up ${ghosts.length} ghost process(es).`);
    }
  } catch (err) {
    console.warn('Warning: ghost process detection failed:', err?.message ?? err);
  }

  // Clean up PID file
  deletePidFile();

  // FIX #10: Clean up metadata file
  try { require('fs').unlinkSync(require('path').join(ROOT_DIR, '.local-services.meta')); } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Warning: metadata file cleanup failed:', err?.message ?? err);
  }

  logger.success('\nAll services stopped.');
  logger.info('\nTo also stop Redis:');
  log('  npm run dev:redis:down', 'dim');
  console.log('');
}

// =============================================================================
// Entry Point
// =============================================================================

main().catch(error => {
  logger.error(`Error: ${error.message}`);
  process.exit(1);
});

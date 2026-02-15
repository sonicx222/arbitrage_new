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
  killTsNodeProcesses,
  loadPids,
  deletePidFile
} = require('./lib/utils');

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
    // Stop each service
    for (const [name, pid] of Object.entries(pids)) {
      logger.info(`Stopping ${name} (PID: ${pid})...`);
      const killed = await killProcess(pid);
      if (killed) {
        logger.success(`  ${name} stopped`);
      } else {
        log(`  ${name} was not running`, 'dim');  // Keep dim for subtle info
      }
    }
  }

  // Also kill any ts-node processes running our services
  logger.info('\nCleaning up any remaining processes...');
  await killTsNodeProcesses();

  // Clean up PID file
  deletePidFile();

  logger.success('\nAll services stopped.');
  logger.info('\nTo stop Redis separately (if still running):');
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

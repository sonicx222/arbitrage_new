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
  log,
  killProcess,
  killTsNodeProcesses,
  loadPids,
  deletePidFile
} = require('./lib/utils');

// =============================================================================
// Main Stop Logic
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(50));
  log('  Stopping Arbitrage System Services', 'cyan');
  console.log('='.repeat(50) + '\n');

  // Load PIDs
  const pids = loadPids();

  if (Object.keys(pids).length === 0) {
    log('No PID file found or no services registered.', 'yellow');
  } else {
    // Stop each service
    for (const [name, pid] of Object.entries(pids)) {
      log(`Stopping ${name} (PID: ${pid})...`, 'yellow');
      const killed = await killProcess(pid);
      if (killed) {
        log(`  ${name} stopped`, 'green');
      } else {
        log(`  ${name} was not running`, 'dim');
      }
    }
  }

  // Also kill any ts-node processes running our services
  log('\nCleaning up any remaining processes...', 'yellow');
  await killTsNodeProcesses();

  // Clean up PID file
  deletePidFile();

  log('\nAll services stopped.', 'green');
  log('\nTo also stop Redis:', 'cyan');
  log('  npm run dev:redis:down', 'dim');
  console.log('');
}

// =============================================================================
// Entry Point
// =============================================================================

main().catch(error => {
  log(`Error: ${error.message}`, 'red');
  process.exit(1);
});

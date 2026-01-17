#!/usr/bin/env node
/**
 * Local Development Stop Script
 *
 * Stops all running arbitrage system services.
 *
 * Usage:
 *   npm run dev:stop
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function killProcess(pid) {
  return new Promise((resolve) => {
    // Cross-platform process kill
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? `taskkill /PID ${pid} /F /T 2>nul` : `kill -9 ${pid} 2>/dev/null`;

    exec(cmd, (error) => {
      resolve(!error);
    });
  });
}

async function main() {
  console.log('\n' + '='.repeat(50));
  log('  Stopping Arbitrage System Services', 'cyan');
  console.log('='.repeat(50) + '\n');

  // Load PIDs
  let pids = {};
  try {
    if (fs.existsSync(PID_FILE)) {
      pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    }
  } catch (e) {
    log('No PID file found', 'yellow');
  }

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

  // Also kill any ts-node processes running our services
  log('\nCleaning up any remaining processes...', 'yellow');

  const isWindows = process.platform === 'win32';
  if (isWindows) {
    exec('taskkill /F /IM "ts-node.exe" 2>nul', () => {});
    exec('taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq ts-node*" 2>nul', () => {});
  } else {
    exec('pkill -f "ts-node.*services" 2>/dev/null', () => {});
  }

  // Clean up PID file
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }

  log('\nAll services stopped.', 'green');
  log('\nTo also stop Redis:', 'cyan');
  log('  npm run dev:redis:down', 'dim');
  console.log('');
}

main().catch(error => {
  log(`Error: ${error.message}`, 'red');
  process.exit(1);
});

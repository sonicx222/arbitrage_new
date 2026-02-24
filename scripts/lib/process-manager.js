#!/usr/bin/env node
/**
 * Cross-Platform Process Management Utilities
 *
 * Handles process detection, termination, and management across
 * Windows, macOS, and Linux platforms.
 *
 * Extracted from utils.js as part of Task #1 refactoring.
 *
 * @see scripts/lib/utils.js (original implementation)
 */

const { exec } = require('child_process');

// =============================================================================
// Cross-Platform Detection
// =============================================================================

/**
 * Check if running on Windows.
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

// =============================================================================
// Shell Execution Helper
// =============================================================================

/**
 * FIX M8: Shared exec() wrapper that eliminates duplicated callback patterns.
 * Executes a shell command and returns stdout, or null if the command fails
 * or produces no output.
 *
 * @param {string} cmd - Shell command to execute
 * @returns {Promise<string|null>} Trimmed stdout, or null on error/empty output
 */
function execCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
      if (error || !stdout || !stdout.trim()) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// =============================================================================
// Process Management
// =============================================================================

/**
 * Kill a process and its entire process tree (cross-platform).
 *
 * On Windows: taskkill /F /T already kills the full tree.
 * On Unix: Services are spawned with detached:true, creating new process groups.
 *   Phase 1: SIGTERM to the process group (graceful shutdown).
 *   Phase 2: SIGKILL to the process group if SIGTERM didn't work within timeout.
 *   Fallback: SIGKILL to the individual PID (in case PGID kill fails, e.g. not group leader).
 *
 * @param {number} pid - Process ID to kill
 * @param {{ graceful?: boolean, gracefulTimeoutMs?: number }} [options] - Kill options
 * @param {boolean} [options.graceful=true] - Attempt SIGTERM before SIGKILL
 * @param {number} [options.gracefulTimeoutMs=3000] - Max wait for graceful shutdown
 * @returns {Promise<boolean>} - True if killed successfully
 */
async function killProcess(pid, options = {}) {
  // FIX M12: Validate PID is a positive integer before interpolating into shell command
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return false;
  }

  // Guardrail: do not signal process groups if the target PID does not exist.
  // This avoids false positives from `kill -9 -<pgid>` and accidental kills of
  // unrelated process groups that happen to share the numeric ID.
  if (!(await processExists(safePid))) {
    return false;
  }

  const { graceful = true, gracefulTimeoutMs = 3000 } = options;

  if (isWindows()) {
    // taskkill /F /T already kills the process tree
    return new Promise((resolve) => {
      exec(`taskkill /PID ${safePid} /F /T 2>nul`, (error) => resolve(!error));
    });
  }

  // Unix: Two-phase kill targeting the process group
  // Services are spawned with detached:true so PID == PGID
  if (graceful) {
    // Phase 1: SIGTERM to process group (negative PID = process group)
    await new Promise((resolve) => {
      exec(`kill -15 -${safePid} 2>/dev/null`, () => resolve(undefined));
    });

    // Wait for graceful shutdown with polling
    const pollInterval = 200;
    const maxPolls = Math.ceil(gracefulTimeoutMs / pollInterval);
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollInterval));
      if (!(await processExists(safePid))) {
        return true;
      }
    }
  }

  // Phase 2: SIGKILL to process group (force kill entire tree)
  await new Promise((resolve) => {
    exec(`kill -9 -${safePid} 2>/dev/null`, () => resolve(undefined));
  });
  await new Promise((r) => setTimeout(r, 100));
  if (!(await processExists(safePid))) {
    return true;
  }

  // Fallback: SIGKILL individual PID (in case it's not a process group leader)
  await new Promise((resolve) => {
    exec(`kill -9 ${safePid} 2>/dev/null`, () => resolve(undefined));
  });
  await new Promise((r) => setTimeout(r, 100));
  return !(await processExists(safePid));
}

/**
 * Check if a process exists (cross-platform).
 * FIX P2-1: On Windows, process.kill(pid, 0) is unreliable per Node.js docs.
 * Use tasklist instead for reliable Windows process existence check.
 *
 * @param {number} pid - Process ID to check
 * @returns {Promise<boolean>} - True if process exists
 */
async function processExists(pid) {
  // FIX M12: Validate PID before interpolating into shell command
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return false;
  }
  if (isWindows()) {
    const output = await execCommand(`tasklist /FI "PID eq ${safePid}" /NH`);
    if (!output) return false;
    // Check if PID appears in output as a complete column value
    // Use word boundary regex to avoid false positives (e.g., PID 123 matching 1234)
    const pidPattern = new RegExp(`\\b${safePid}\\b`);
    return pidPattern.test(output);
  }
  // Unix: signal 0 is reliable (doesn't actually send signal, just checks existence)
  try {
    process.kill(safePid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find processes using a specific port (cross-platform).
 * @param {number} port - Port number
 * @returns {Promise<number[]>} - Array of PIDs using the port
 */
async function findProcessesByPort(port) {
  // FIX M12: Validate port before interpolating into shell command
  const safePort = parseInt(port, 10);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    return [];
  }
  if (isWindows()) {
    const output = await execCommand(`netstat -ano | findstr :${safePort} | findstr LISTENING`);
    if (!output) return [];
    const pids = new Set();
    output.split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      // FIX #17: Validate port matches exactly — findstr :300 also matches :3000
      // Netstat format: PROTO LOCAL_ADDR FOREIGN_ADDR STATE PID
      // LOCAL_ADDR is like 0.0.0.0:3000 or [::]:3000
      const localAddr = parts[1] || '';
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch || parseInt(portMatch[1], 10) !== safePort) return;
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(pid) && pid > 0) {
        pids.add(pid);
      }
    });
    return Array.from(pids);
  }
  // Unix: use lsof filtered to LISTEN state only
  // Without -sTCP:LISTEN, lsof returns ALL connection states (ESTABLISHED, TIME_WAIT, etc.)
  const output = await execCommand(`lsof -t -i :${safePort} -sTCP:LISTEN 2>/dev/null || true`);
  if (!output) return [];
  return output.split('\n')
    .map(p => parseInt(p, 10))
    .filter(p => !isNaN(p) && p > 0);
}

/**
 * Parse process lines from command output into {pid, cmd} objects.
 * @param {string} output - Raw command output
 * @param {function} lineParser - Function that extracts {pid, cmd} from a line, or null to skip
 * @returns {Array<{pid: number, cmd: string}>}
 */
function parseProcessLines(output, lineParser) {
  const processes = [];
  output.split('\n').forEach(line => {
    const result = lineParser(line);
    if (result && !isNaN(result.pid) && result.pid > 0) {
      processes.push(result);
    }
  });
  return processes;
}

/**
 * Find ghost node processes related to the project (cross-platform).
 * Matches ts-node, tsx, and direct node processes running arbitrage services.
 *
 * Windows: Uses PowerShell Get-Process (wmic is deprecated since Windows 11 24H2).
 * Unix: Uses ps aux with grep filtering.
 *
 * @returns {Promise<Array<{pid: number, cmd: string}>>} - Array of ghost processes
 */
async function findGhostNodeProcesses() {
  if (isWindows()) {
    // Use PowerShell instead of deprecated wmic
    const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.CommandLine }" 2>nul';
    const output = await execCommand(psCmd);
    if (!output) return [];
    return parseProcessLines(output, (line) => {
      // FIX P3-1: Tighten matching to prevent killing unrelated projects
      const hasArbitrage = line.includes('arbitrage');
      const hasTsNode = line.includes('ts-node');
      const hasTsx = line.includes('tsx');
      const hasServices = line.includes('services') && line.includes('index.ts');
      if (!hasArbitrage || !(hasTsNode || hasTsx || hasServices)) return null;
      const sepIdx = line.indexOf('|');
      if (sepIdx < 0) return null;
      return {
        pid: parseInt(line.substring(0, sepIdx), 10),
        cmd: line.substring(sepIdx + 1).substring(0, 80)
      };
    });
  }
  // Unix: use ps
  // FIX P3-1: Require "arbitrage" in command line to avoid matching unrelated projects
  // Also match tsx and direct node processes, not just ts-node
  const output = await execCommand('ps aux 2>/dev/null | grep arbitrage | grep -E "ts-node|tsx|node.*services/.*/src/index" | grep -v grep || true');
  if (!output) return [];
  return parseProcessLines(output, (line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 2) return null;
    return {
      pid: parseInt(parts[1], 10),
      cmd: parts.slice(10).join(' ').substring(0, 80)
    };
  });
}

/**
 * Kill ts-node/tsx/node processes related to arbitrage project (cross-platform).
 * FIX P3-1: Tightened matching to avoid killing unrelated projects.
 * Matches: ts-node, tsx, and direct node processes running arbitrage services.
 *
 * Windows: Uses PowerShell (wmic deprecated since Windows 11 24H2).
 * Unix: Uses pkill with broader pattern matching.
 *
 * @returns {Promise<void>}
 */
async function killTsNodeProcesses() {
  if (isWindows()) {
    // Use PowerShell instead of deprecated wmic
    const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\' AND commandline LIKE \'%arbitrage%\'\\" | Where-Object { $_.CommandLine -match \'ts-node|tsx|services.*index\\.ts\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul';
    await execCommand(psCmd);
  } else {
    // Kill ts-node and tsx processes related to arbitrage
    await execCommand('pkill -f "ts-node.*arbitrage" 2>/dev/null');
    await execCommand('pkill -f "tsx.*arbitrage" 2>/dev/null');
    // Also kill direct node processes running our service entry points
    await execCommand('pkill -f "node.*arbitrage.*services/.*/src/index" 2>/dev/null');
  }
}

/**
 * FIX #10 + #9: Kill all services by PID in parallel.
 * Extracted from stop-local.js and start-local.js to eliminate duplication.
 * Uses Promise.all for parallel kills (Fix #9) in a shared function (Fix #10).
 *
 * @param {Object<string, number>} pids - Map of service name to PID
 * @returns {Promise<Array<{ name: string, pid: number, killed: boolean, existed: boolean }>>}
 */
async function killAllPids(pids) {
  const entries = Object.entries(pids);
  if (entries.length === 0) return [];

  return Promise.all(
    entries.map(async ([name, pid]) => {
      const existed = await processExists(pid);
      if (!existed) {
        return { name, pid, killed: false, existed: false };
      }
      const killed = await killProcess(pid);
      return { name, pid, killed, existed: true };
    })
  );
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  isWindows,
  execCommand,
  killProcess,
  processExists,
  findProcessesByPort,
  parseProcessLines,
  findGhostNodeProcesses,
  killTsNodeProcesses,
  killAllPids
};

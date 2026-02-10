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
// Process Management
// =============================================================================

/**
 * Kill a process by PID (cross-platform).
 * @param {number} pid - Process ID to kill
 * @returns {Promise<boolean>} - True if killed successfully
 */
function killProcess(pid) {
  return new Promise((resolve) => {
    const cmd = isWindows()
      ? `taskkill /PID ${pid} /F /T 2>nul`
      : `kill -9 ${pid} 2>/dev/null`;

    exec(cmd, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Check if a process exists (cross-platform).
 * FIX P2-1: On Windows, process.kill(pid, 0) is unreliable per Node.js docs.
 * Use tasklist instead for reliable Windows process existence check.
 *
 * @param {number} pid - Process ID to check
 * @returns {Promise<boolean>} - True if process exists
 */
function processExists(pid) {
  return new Promise((resolve) => {
    if (isWindows()) {
      // Windows: use tasklist to check if PID exists
      exec(`tasklist /FI "PID eq ${pid}" /NH`, (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        // Check if PID appears in output (tasklist returns the process row if exists)
        resolve(stdout.includes(String(pid)));
      });
    } else {
      // Unix: signal 0 is reliable (doesn't actually send signal, just checks existence)
      try {
        process.kill(pid, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

/**
 * Find processes using a specific port (cross-platform).
 * @param {number} port - Port number
 * @returns {Promise<number[]>} - Array of PIDs using the port
 */
function findProcessesByPort(port) {
  return new Promise((resolve) => {
    if (isWindows()) {
      // Windows: use netstat
      exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const pids = new Set();
        stdout.trim().split('\n').forEach(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0) {
            pids.add(pid);
          }
        });
        resolve(Array.from(pids));
      });
    } else {
      // Unix: use lsof
      exec(`lsof -t -i :${port} 2>/dev/null || true`, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const pids = stdout.trim().split('\n')
          .map(p => parseInt(p, 10))
          .filter(p => !isNaN(p) && p > 0);
        resolve(pids);
      });
    }
  });
}

/**
 * Find ghost node processes related to the project (cross-platform).
 * @returns {Promise<Array<{pid: number, cmd: string}>>} - Array of ghost processes
 */
function findGhostNodeProcesses() {
  return new Promise((resolve) => {
    if (isWindows()) {
      // Windows: use wmic to find node processes
      exec('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv 2>nul', (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const processes = [];
        stdout.trim().split('\n').forEach(line => {
          // FIX: Added explicit parentheses for clarity (operator precedence)
          if (line.includes('ts-node') || (line.includes('services') && line.includes('index.ts'))) {
            const parts = line.split(',');
            if (parts.length >= 3) {
              const pid = parseInt(parts[parts.length - 1], 10);
              const cmd = parts.slice(1, -1).join(',');
              if (!isNaN(pid) && pid > 0) {
                processes.push({ pid, cmd: cmd.substring(0, 80) });
              }
            }
          }
        });
        resolve(processes);
      });
    } else {
      // Unix: use ps
      exec('ps aux 2>/dev/null | grep -E "ts-node|services/.*/src/index.ts" | grep -v grep || true', (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const processes = [];
        stdout.trim().split('\n').forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const pid = parseInt(parts[1], 10);
            const cmd = parts.slice(10).join(' ');
            if (!isNaN(pid) && pid > 0) {
              processes.push({ pid, cmd: cmd.substring(0, 80) });
            }
          }
        });
        resolve(processes);
      });
    }
  });
}

/**
 * Kill ts-node processes (cross-platform).
 * @returns {Promise<void>}
 */
function killTsNodeProcesses() {
  return new Promise((resolve) => {
    if (isWindows()) {
      // Windows: kill node processes running ts-node
      exec('wmic process where "commandline like \'%ts-node%\' and name=\'node.exe\'" call terminate 2>nul', () => {
        resolve();
      });
    } else {
      // Unix: use pkill
      exec('pkill -f "ts-node.*services" 2>/dev/null', () => {
        resolve();
      });
    }
  });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  isWindows,
  killProcess,
  processExists,
  findProcessesByPort,
  findGhostNodeProcesses,
  killTsNodeProcesses
};

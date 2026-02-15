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
 * Kill a process by PID (cross-platform).
 * @param {number} pid - Process ID to kill
 * @returns {Promise<boolean>} - True if killed successfully
 */
async function killProcess(pid) {
  // FIX M12: Validate PID is a positive integer before interpolating into shell command
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return false;
  }
  const cmd = isWindows()
    ? `taskkill /PID ${safePid} /F /T 2>nul`
    : `kill -9 ${safePid} 2>/dev/null`;

  // Kill commands produce no stdout on success — use raw exec for error-based success check
  return new Promise((resolve) => {
    exec(cmd, (error) => resolve(!error));
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
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(pid) && pid > 0) {
        pids.add(pid);
      }
    });
    return Array.from(pids);
  }
  // Unix: use lsof (LISTEN sockets only to avoid matching client connections)
  const output = await execCommand(`lsof -nP -t -iTCP:${safePort} -sTCP:LISTEN 2>/dev/null || true`);
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
 * Parse PowerShell JSON output for Win32_Process query results.
 * @param {string} jsonOutput - JSON from ConvertTo-Json
 * @returns {Array<{ProcessId?: number, CommandLine?: string}>}
 */
function parsePowerShellProcessJson(jsonOutput) {
  if (!jsonOutput) return [];

  try {
    const parsed = JSON.parse(jsonOutput);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [];
  }
}

/**
 * Find ghost node processes related to the project (cross-platform).
 * @returns {Promise<Array<{pid: number, cmd: string}>>} - Array of ghost processes
 */
async function findGhostNodeProcesses() {
  if (isWindows()) {
    // Try WMIC first for backward compatibility.
    const wmicOutput = await execCommand('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv 2>nul');
    if (wmicOutput) {
      return parseProcessLines(wmicOutput, (line) => {
        // FIX P3-1: Tighten matching to prevent killing unrelated projects
        const hasArbitrage = line.includes('arbitrage');
        const hasTsNode = line.includes('ts-node');
        const hasServices = line.includes('services') && line.includes('index.ts');
        if (!hasArbitrage || !(hasTsNode || hasServices)) return null;
        const parts = line.split(',');
        if (parts.length < 3) return null;
        return {
          pid: parseInt(parts[parts.length - 1], 10),
          cmd: parts.slice(1, -1).join(',').substring(0, 80)
        };
      });
    }

    // WMIC may be unavailable on newer Windows installs; fallback to PowerShell.
    const psCommand = 'powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine; $p | ConvertTo-Json -Compress"';
    const psOutput = await execCommand(psCommand);
    if (!psOutput) return [];

    const processes = parsePowerShellProcessJson(psOutput);
    return processes
      .map((p) => ({
        pid: parseInt(String(p.ProcessId || ''), 10),
        cmd: String(p.CommandLine || '')
      }))
      .filter((p) => {
        if (isNaN(p.pid) || p.pid <= 0 || !p.cmd) return false;
        const hasArbitrage = p.cmd.includes('arbitrage');
        const hasTsNode = p.cmd.includes('ts-node');
        const hasServices = p.cmd.includes('services') && p.cmd.includes('index.ts');
        return hasArbitrage && (hasTsNode || hasServices);
      })
      .map((p) => ({
        pid: p.pid,
        cmd: p.cmd.substring(0, 80)
      }));
  }
  // Unix: use ps
  // FIX P3-1: Require "arbitrage" in command line to avoid matching unrelated projects
  const output = await execCommand('ps aux 2>/dev/null | grep arbitrage | grep -E "ts-node|services/.*/src/index.ts" | grep -v grep || true');
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
 * Kill ts-node processes related to arbitrage project (cross-platform).
 * FIX P3-1: Tightened matching to avoid killing unrelated projects.
 * @returns {Promise<void>}
 */
async function killTsNodeProcesses() {
  const processes = await findGhostNodeProcesses();
  for (const proc of processes) {
    await killProcess(proc.pid);
  }
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
  findGhostNodeProcesses,
  killTsNodeProcesses,
  parsePowerShellProcessJson
};

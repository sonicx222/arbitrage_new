#!/usr/bin/env node
/**
 * Shared Utilities for Development Scripts
 *
 * Consolidates common functionality used across all scripts:
 * - Console colors and logging
 * - Cross-platform process management
 * - Health check utilities
 * - PID file management
 *
 * @see ADR-009: Test Architecture
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { exec, execSync } = require('child_process');

// =============================================================================
// Constants
// =============================================================================

const ROOT_DIR = path.join(__dirname, '..', '..');
const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');
const REDIS_MEMORY_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

// =============================================================================
// Console Colors
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

/**
 * Log a message with optional color.
 * @param {string} message - Message to log
 * @param {'reset'|'green'|'yellow'|'red'|'cyan'|'dim'} [color='reset'] - Color name
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Log a service-specific message with timestamp.
 * @param {string} name - Service name
 * @param {string} message - Message to log
 * @param {'reset'|'green'|'yellow'|'red'|'cyan'|'dim'} [color='cyan'] - Color name
 */
function logService(name, message, color = 'cyan') {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${colors[color]}[${name}]${colors.reset} ${message}`);
}

// =============================================================================
// Cross-Platform Process Management
// =============================================================================

/**
 * Check if running on Windows.
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

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
// Health Check Utilities
// =============================================================================

/**
 * Check health of an HTTP endpoint.
 * @param {number} port - Port number
 * @param {string} endpoint - Health endpoint path
 * @param {number} [timeout=5000] - Timeout in milliseconds
 * @returns {Promise<{running: boolean, status?: string, latency?: number, details?: object}>}
 */
function checkHealth(port, endpoint, timeout = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = http.get(`http://localhost:${port}${endpoint}`, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        try {
          const json = JSON.parse(data);
          resolve({
            running: res.statusCode >= 200 && res.statusCode < 400,
            status: json.status || 'ok',
            latency,
            details: json
          });
        } catch {
          resolve({
            running: res.statusCode >= 200 && res.statusCode < 400,
            status: 'ok',
            latency
          });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
  });
}

/**
 * Check if a port is in use.
 * @param {number} port - Port number
 * @returns {Promise<boolean>}
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

/**
 * Check TCP connectivity to a host:port.
 * @param {string} host - Host address
 * @param {number} port - Port number
 * @param {number} [timeout=1000] - Timeout in milliseconds
 * @returns {Promise<boolean>}
 */
function checkTcpConnection(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(timeout);
    client.connect(port, host, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      client.destroy();
      resolve(false);
    });
    client.on('timeout', () => {
      client.destroy();
      resolve(false);
    });
  });
}

// =============================================================================
// Docker Utilities
// =============================================================================

/**
 * Check if a Docker container is running.
 * @param {string} containerName - Container name
 * @returns {Promise<{running: boolean, status?: string}>}
 */
function checkDockerContainer(containerName) {
  return new Promise((resolve) => {
    exec(`docker ps --filter "name=${containerName}" --format "{{.Status}}"`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ running: false });
      } else {
        resolve({ running: true, status: stdout.trim() });
      }
    });
  });
}

// =============================================================================
// Redis Utilities
// =============================================================================

/**
 * Check if Docker Redis is running.
 * @returns {Promise<boolean>}
 */
async function checkDockerRedis() {
  const status = await checkDockerContainer('arbitrage-redis');
  return status.running && (status.status?.includes('Up') ?? false);
}

/**
 * Check if memory Redis is running.
 * @returns {Promise<boolean>}
 */
async function checkMemoryRedis() {
  if (!fs.existsSync(REDIS_MEMORY_CONFIG_FILE)) {
    return false;
  }

  try {
    const config = JSON.parse(fs.readFileSync(REDIS_MEMORY_CONFIG_FILE, 'utf8'));
    return await checkTcpConnection(config.host, config.port);
  } catch {
    return false;
  }
}

/**
 * Check Redis status (Docker or Memory).
 * @returns {Promise<{running: boolean, type?: 'docker'|'memory'}>}
 */
async function checkRedis() {
  if (await checkDockerRedis()) {
    return { running: true, type: 'docker' };
  }
  if (await checkMemoryRedis()) {
    return { running: true, type: 'memory' };
  }
  return { running: false };
}

/**
 * Get Redis memory config if available.
 * @returns {{host: string, port: number, pid: number} | null}
 */
function getRedisMemoryConfig() {
  if (!fs.existsSync(REDIS_MEMORY_CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(REDIS_MEMORY_CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Delete Redis memory config file.
 */
function deleteRedisMemoryConfig() {
  if (fs.existsSync(REDIS_MEMORY_CONFIG_FILE)) {
    fs.unlinkSync(REDIS_MEMORY_CONFIG_FILE);
  }
}

// =============================================================================
// PID File Management
// =============================================================================

const PID_LOCK_FILE = PID_FILE + '.lock';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * Acquire a file lock for PID operations.
 * Uses a simple .lock file approach with retries.
 * @returns {Promise<boolean>} - True if lock acquired
 */
async function acquirePidLock() {
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // O_EXCL flag ensures atomic create - fails if file exists
      fs.writeFileSync(PID_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock file exists, check if it's stale (holder process dead)
        try {
          const lockPid = parseInt(fs.readFileSync(PID_LOCK_FILE, 'utf8'), 10);
          if (lockPid && !isNaN(lockPid)) {
            // FIX P2-1: Use processExists() for Windows compatibility
            const lockHolderExists = await processExists(lockPid);
            if (lockHolderExists) {
              // Process exists, wait and retry
            } else {
              // Process doesn't exist, lock is stale - remove it
              fs.unlinkSync(PID_LOCK_FILE);
              continue; // Try again immediately
            }
          }
        } catch {
          // Can't read lock file, try to remove it
          try { fs.unlinkSync(PID_LOCK_FILE); } catch { /* ignore */ }
          continue;
        }
        // Wait before retry
        await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
      } else {
        throw err;
      }
    }
  }
  return false;
}

/**
 * Release the PID file lock.
 */
function releasePidLock() {
  try {
    fs.unlinkSync(PID_LOCK_FILE);
  } catch {
    // Ignore - lock may already be released
  }
}

/**
 * Load PIDs from the PID file.
 * @returns {Object<string, number>}
 */
function loadPids() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    }
  } catch {
    // Ignore errors
  }
  return {};
}

/**
 * Save PIDs to the PID file.
 * Uses atomic write to prevent partial writes.
 * @param {Object<string, number>} pids
 */
function savePids(pids) {
  const tempFile = PID_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(pids, null, 2));
  fs.renameSync(tempFile, PID_FILE);
}

/**
 * Atomically update a single PID entry.
 * Uses file locking to prevent race conditions when multiple services start concurrently.
 * @param {string} serviceName - The service name
 * @param {number} pid - The process ID
 * @returns {Promise<boolean>} - True if update succeeded
 */
async function updatePid(serviceName, pid) {
  const lockAcquired = await acquirePidLock();
  if (!lockAcquired) {
    // FIX P1-1: Throw error instead of proceeding without lock to prevent race conditions
    // See: bug-hunt analysis - race condition in concurrent service startup PID writes
    throw new Error(
      `Could not acquire PID lock for ${serviceName} after ${LOCK_TIMEOUT_MS}ms. ` +
      `Another process may be holding the lock. Try stopping services first: npm run dev:stop`
    );
  }

  try {
    const pids = loadPids();
    pids[serviceName] = pid;
    savePids(pids);
    return true;
  } finally {
    // Lock is always acquired if we reach here, so always release
    releasePidLock();
  }
}

/**
 * Atomically remove a single PID entry.
 * @param {string} serviceName - The service name to remove
 * @returns {Promise<boolean>} - True if removal succeeded
 */
async function removePid(serviceName) {
  const lockAcquired = await acquirePidLock();
  if (!lockAcquired) {
    // FIX P1-1: Throw error instead of proceeding without lock to prevent race conditions
    throw new Error(
      `Could not acquire PID lock for removing ${serviceName} after ${LOCK_TIMEOUT_MS}ms. ` +
      `Another process may be holding the lock.`
    );
  }

  try {
    const pids = loadPids();
    delete pids[serviceName];
    if (Object.keys(pids).length === 0) {
      deletePidFile();
    } else {
      savePids(pids);
    }
    return true;
  } finally {
    // Lock is always acquired if we reach here, so always release
    releasePidLock();
  }
}

/**
 * Delete the PID file.
 */
function deletePidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    // Also clean up lock file
    if (fs.existsSync(PID_LOCK_FILE)) {
      fs.unlinkSync(PID_LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Constants
  ROOT_DIR,
  PID_FILE,
  REDIS_MEMORY_CONFIG_FILE,
  colors,

  // Logging
  log,
  logService,

  // Cross-platform
  isWindows,
  killProcess,
  processExists,
  findProcessesByPort,
  findGhostNodeProcesses,
  killTsNodeProcesses,

  // Health checks
  checkHealth,
  isPortInUse,
  checkTcpConnection,

  // Docker
  checkDockerContainer,

  // Redis
  checkDockerRedis,
  checkMemoryRedis,
  checkRedis,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig,

  // PID management
  loadPids,
  savePids,
  updatePid,
  removePid,
  deletePidFile
};

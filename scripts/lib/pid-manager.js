#!/usr/bin/env node
/**
 * PID File Management Utilities
 *
 * Provides atomic PID file management with file locking to prevent
 * race conditions during concurrent service startup.
 *
 * Extracted from utils.js as part of Task #1 refactoring.
 *
 * @see scripts/lib/utils.js (original implementation)
 */

const fs = require('fs');
const path = require('path');

// Task P2-2: Use shared constants
const { LOCK_TIMEOUT_MS, LOCK_RETRY_INTERVAL_MS } = require('./constants');

// Import process utilities (moved from inline require to prevent potential circular deps)
const { processExists } = require('./process-manager');

// =============================================================================
// Constants
// =============================================================================

const ROOT_DIR = path.join(__dirname, '..', '..');
const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');
const PID_LOCK_FILE = PID_FILE + '.lock';

// =============================================================================
// Security Helpers
// =============================================================================

/**
 * FIX L3: Check that a path is not a symlink before writing.
 * Prevents symlink attacks where a malicious symlink at the PID file
 * path could redirect writes to an arbitrary file on shared systems.
 *
 * @param {string} filePath - Path to check
 * @throws {Error} If the path is a symlink
 */
function assertNotSymlink(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Security: ${filePath} is a symlink. ` +
        `PID files must not be symlinks to prevent path traversal attacks. ` +
        `Remove the symlink and retry.`
      );
    }
  } catch (err) {
    // ENOENT means file doesn't exist yet — safe to create
    if (err.code === 'ENOENT') return;
    // Re-throw symlink errors and other unexpected errors
    if (err.message.startsWith('Security:')) throw err;
    // Permission errors etc — let the caller handle when they try to write
  }
}

// =============================================================================
// File Locking
// =============================================================================

/**
 * Acquire a file lock for PID operations.
 * Uses a simple .lock file approach with retries.
 * @returns {Promise<boolean>} - True if lock acquired
 */
async function acquirePidLock() {
  // FIX L3: Check lock file is not a symlink before writing
  assertNotSymlink(PID_LOCK_FILE);
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
            // Check if lock holder process still exists
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

// =============================================================================
// PID File Operations
// =============================================================================

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
  // FIX L3: Check PID file is not a symlink before writing
  assertNotSymlink(PID_FILE);
  const tempFile = PID_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(pids, null, 2));
  fs.renameSync(tempFile, PID_FILE);
}

/**
 * FIX L5: Execute an operation while holding the PID file lock.
 * Acquires the lock, runs the operation, and always releases the lock.
 * Eliminates duplicated lock-acquire/try/finally/release in updatePid and removePid.
 *
 * @param {string} context - Context for error message (e.g., "updating Coordinator")
 * @param {function} operation - Async function to execute while holding the lock
 * @returns {Promise<*>} - Result of the operation
 * @throws {Error} If lock cannot be acquired within timeout
 */
async function withPidLock(context, operation) {
  const lockAcquired = await acquirePidLock();
  if (!lockAcquired) {
    throw new Error(
      `Could not acquire PID lock for ${context} after ${LOCK_TIMEOUT_MS}ms. ` +
      `Another process may be holding the lock. Try stopping services first: npm run dev:stop`
    );
  }
  try {
    return await operation();
  } finally {
    releasePidLock();
  }
}

/**
 * Atomically update a single PID entry.
 * Uses file locking to prevent race conditions when multiple services start concurrently.
 * @param {string} serviceName - The service name
 * @param {number} pid - The process ID
 * @returns {Promise<boolean>} - True if update succeeded
 */
async function updatePid(serviceName, pid) {
  return withPidLock(`updating ${serviceName}`, () => {
    const pids = loadPids();
    pids[serviceName] = pid;
    savePids(pids);
    return true;
  });
}

/**
 * Atomically remove a single PID entry.
 * @param {string} serviceName - The service name to remove
 * @returns {Promise<boolean>} - True if removal succeeded
 */
async function removePid(serviceName) {
  return withPidLock(`removing ${serviceName}`, () => {
    const pids = loadPids();
    delete pids[serviceName];
    if (Object.keys(pids).length === 0) {
      deletePidFile();
    } else {
      savePids(pids);
    }
    return true;
  });
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
  PID_FILE,

  // PID management
  loadPids,
  savePids,
  updatePid,
  removePid,
  deletePidFile
};

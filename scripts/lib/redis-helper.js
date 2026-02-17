#!/usr/bin/env node
/**
 * Redis Service Utilities
 *
 * Provides utilities for managing and checking Redis instances,
 * including Docker containers and in-memory servers.
 *
 * Extracted from utils.js as part of Task #1 refactoring.
 *
 * @see scripts/lib/utils.js (original implementation)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { ROOT_DIR } = require('./constants');

// =============================================================================
// Constants
// =============================================================================

const REDIS_MEMORY_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

// =============================================================================
// Docker Utilities
// =============================================================================

/**
 * Check if a Docker container is running.
 * @param {string} containerName - Container name
 * @returns {Promise<{running: boolean, status?: string}>}
 */
function checkDockerContainer(containerName) {
  // Validate container name to prevent shell injection
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerName)) {
    return Promise.resolve({ running: false });
  }
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
// Redis-Specific Utilities
// =============================================================================

/**
 * Check if Docker Redis is running.
 * @returns {Promise<boolean>}
 */
async function checkDockerRedis() {
  const status = await checkDockerContainer('arbitrage-redis');
  // FIX P1-3: Type-safe check - ensure status.status is string before calling .includes()
  return status.running && typeof status.status === 'string' && status.status.includes('Up');
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
    // P3-2: Use checkTcpConnection from network-utils (avoids circular dependency with health-checker)
    const { checkTcpConnection } = require('./network-utils');
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
  try {
    fs.unlinkSync(REDIS_MEMORY_CONFIG_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Constants
  REDIS_MEMORY_CONFIG_FILE,

  // Docker utility
  checkDockerContainer,

  // Redis utilities
  checkDockerRedis,
  checkMemoryRedis,
  checkRedis,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig
};

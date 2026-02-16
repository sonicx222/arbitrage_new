#!/usr/bin/env node
/**
 * Shared Utilities for Development Scripts (Re-export Module)
 *
 * This module re-exports from focused utility modules for backward compatibility.
 * Prefer importing directly from focused modules for new code:
 * - ./logger.js - Console logging
 * - ./process-manager.js - Process management
 * - ./health-checker.js - Health checks
 * - ./redis-helper.js - Redis utilities
 * - ./pid-manager.js - PID file management
 *
 * Refactored in Task #1: Split God Module into focused modules
 * @see ADR-009: Test Architecture
 */

const { ROOT_DIR } = require('./constants');

// =============================================================================
// Re-exports from Focused Modules
// =============================================================================

const logger = require('./logger');
const processManager = require('./process-manager');
const healthChecker = require('./health-checker');
const redisHelper = require('./redis-helper');
const pidManager = require('./pid-manager');

// =============================================================================
// Exports (Backward Compatibility)
// =============================================================================

module.exports = {
  // Constants
  ROOT_DIR,
  PID_FILE: pidManager.PID_FILE,
  REDIS_MEMORY_CONFIG_FILE: redisHelper.REDIS_MEMORY_CONFIG_FILE,

  // Logging (from logger.js)
  logger: logger.logger,           // Modern logger instance (Task #5)
  ScriptLogger: logger.ScriptLogger, // Logger class (Task #5)
  colors: logger.colors,
  log: logger.log,
  logService: logger.logService,

  // Cross-platform (from process-manager.js)
  isWindows: processManager.isWindows,
  killProcess: processManager.killProcess,
  processExists: processManager.processExists,
  findProcessesByPort: processManager.findProcessesByPort,
  findGhostNodeProcesses: processManager.findGhostNodeProcesses,
  killTsNodeProcesses: processManager.killTsNodeProcesses,
  killAllPids: processManager.killAllPids,

  // Health checks (from health-checker.js)
  checkHealth: healthChecker.checkHealth,
  isPortInUse: healthChecker.isPortInUse,
  checkTcpConnection: healthChecker.checkTcpConnection,

  // Docker (from redis-helper.js)
  checkDockerContainer: redisHelper.checkDockerContainer,

  // Redis (from redis-helper.js)
  checkDockerRedis: redisHelper.checkDockerRedis,
  checkMemoryRedis: redisHelper.checkMemoryRedis,
  checkRedis: redisHelper.checkRedis,
  getRedisMemoryConfig: redisHelper.getRedisMemoryConfig,
  deleteRedisMemoryConfig: redisHelper.deleteRedisMemoryConfig,

  // PID management (from pid-manager.js)
  loadPids: pidManager.loadPids,
  savePids: pidManager.savePids,
  updatePid: pidManager.updatePid,
  removePid: pidManager.removePid,
  deletePidFile: pidManager.deletePidFile
};

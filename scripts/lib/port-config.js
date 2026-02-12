#!/usr/bin/env node
/**
 * Port Configuration
 *
 * Single source of truth for service port numbers.
 * Reads from shared constants with environment variable overrides.
 *
 * FIX M3: Extracted from services-config.js God Module.
 *
 * @see shared/constants/service-ports.json (default values)
 */

const path = require('path');

// =============================================================================
// Shared Configuration (Single Source of Truth)
// =============================================================================
const portConfig = require('../../shared/constants/service-ports.json');

// =============================================================================
// Port Parsing
// =============================================================================

/**
 * Parse and validate a port number from environment variable or default value.
 * Fails fast with actionable error message if invalid.
 *
 * @param {string | undefined} envValue - Environment variable value
 * @param {number} defaultValue - Default port from config
 * @param {string} envVarName - Name of environment variable (for error messages)
 * @returns {number} Validated port number
 * @throws {Error} If port is NaN or out of range
 */
function parsePort(envValue, defaultValue, envVarName) {
  const rawValue = envValue || String(defaultValue);
  const port = parseInt(rawValue, 10);

  if (isNaN(port)) {
    throw new Error(
      `Invalid port configuration for ${envVarName}.\n` +
      `  Value: "${rawValue}"\n` +
      `  Expected: A number between 1-65535\n` +
      `  Fix: Check your .env file or environment variables`
    );
  }

  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid port ${port} for ${envVarName}.\n` +
      `  Port must be between 1 and 65535\n` +
      `  Fix: Update ${envVarName} in your .env file`
    );
  }

  return port;
}

// =============================================================================
// PORTS Constant
// =============================================================================

/**
 * Build PORTS object from shared config + env overrides.
 * Called after dotenv has been loaded by the orchestrator (services-config.js).
 *
 * @returns {Object} Port mappings for all services
 */
function buildPorts() {
  return {
    // Infrastructure (from shared config)
    REDIS: parsePort(process.env.REDIS_PORT, portConfig.infrastructure.redis, 'REDIS_PORT'),
    REDIS_UI: portConfig.infrastructure['redis-ui'],
    // Core services (from shared config)
    COORDINATOR: parsePort(process.env.COORDINATOR_PORT, portConfig.services.coordinator, 'COORDINATOR_PORT'),
    // Partition detectors (from shared config)
    P1_ASIA_FAST: parsePort(process.env.P1_ASIA_FAST_PORT, portConfig.services['partition-asia-fast'], 'P1_ASIA_FAST_PORT'),
    P2_L2_TURBO: parsePort(process.env.P2_L2_TURBO_PORT, portConfig.services['partition-l2-turbo'], 'P2_L2_TURBO_PORT'),
    P3_HIGH_VALUE: parsePort(process.env.P3_HIGH_VALUE_PORT, portConfig.services['partition-high-value'], 'P3_HIGH_VALUE_PORT'),
    P4_SOLANA: parsePort(process.env.P4_SOLANA_PORT, portConfig.services['partition-solana'], 'P4_SOLANA_PORT'),
    // Other services (from shared config)
    EXECUTION_ENGINE: parsePort(process.env.EXECUTION_ENGINE_PORT, portConfig.services['execution-engine'], 'EXECUTION_ENGINE_PORT'),
    CROSS_CHAIN: parsePort(process.env.CROSS_CHAIN_DETECTOR_PORT, portConfig.services['cross-chain-detector'], 'CROSS_CHAIN_DETECTOR_PORT'),
    UNIFIED_DETECTOR: parsePort(process.env.UNIFIED_DETECTOR_PORT, portConfig.services['unified-detector'], 'UNIFIED_DETECTOR_PORT')
  };
}

module.exports = {
  parsePort,
  buildPorts
};

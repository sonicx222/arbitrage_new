#!/usr/bin/env node
/**
 * Centralized Service Configuration for Development Scripts
 *
 * FIX M3: Refactored from God Module (526 lines) into focused modules:
 *   - port-config.js — Port parsing + PORTS constant
 *   - service-definitions.js — Service arrays + helper functions
 *   - service-validator.js — ServiceConfig class + validateAllServices()
 *   - services-config.js (this file) — Slim orchestrator + re-exports
 *
 * FIX M5: Validation no longer runs on module import. Call validateAllServices()
 *   explicitly in startup scripts. Tests no longer need SKIP_SERVICE_VALIDATION.
 *
 * Environment Variables:
 * - COORDINATOR_PORT: Coordinator service port (default: 3000)
 * - P1_ASIA_FAST_PORT: Asia-Fast partition port (default: 3001)
 * - P2_L2_TURBO_PORT: L2-Turbo partition port (default: 3002)
 * - P3_HIGH_VALUE_PORT: High-Value partition port (default: 3003)
 * - P4_SOLANA_PORT: Solana partition port (default: 3004)
 * - EXECUTION_ENGINE_PORT: Execution engine port (default: 3005)
 * - CROSS_CHAIN_DETECTOR_PORT: Cross-chain detector port (default: 3006)
 * - UNIFIED_DETECTOR_PORT: Unified detector port (default: 3007, deprecated)
 * - REDIS_PORT: Redis port (default: 6379)
 * - SKIP_SERVICE_VALIDATION: Skip startup validation (default: false)
 *   Set to "true" to disable service config validation at module load.
 *   Useful for: tests, development, CI/CD that imports before services exist.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

const path = require('path');

// =============================================================================
// Environment Loading
// =============================================================================

const dotenv = require('dotenv');
const ROOT_DIR = path.join(__dirname, '..', '..');

// IMPORTANT: Load order matters!
// .env.local is loaded AFTER .env with override: true
// This means .env.local values ALWAYS win over .env values
// See docs/local-development.md for full explanation

// Load base .env first
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// Then override with .env.local (explicit override: true)
const localEnvResult = dotenv.config({
  path: path.join(ROOT_DIR, '.env.local'),
  override: true
});

// If .env.local doesn't exist, that's okay for production
if (localEnvResult.error && localEnvResult.error.code !== 'ENOENT') {
  console.warn('Warning: Error loading .env.local:', localEnvResult.error.message);
}

// =============================================================================
// Deprecation Checking
// =============================================================================

const { checkForDeprecatedEnvVars, printWarnings } = require('./deprecation-checker');

/**
 * Check for deprecated environment variables and print warnings.
 * Call this explicitly in startup scripts that should show warnings.
 *
 * @returns {boolean} - True if any deprecations were found
 */
function checkAndPrintDeprecations() {
  const envWarnings = checkForDeprecatedEnvVars();
  if (envWarnings.length > 0) {
    printWarnings(envWarnings);
  }
  return envWarnings.length > 0;
}

// =============================================================================
// Build Configuration (from focused modules)
// =============================================================================

const { buildPorts } = require('./port-config');
const { buildServiceDefinitions, getServiceByName: _getByName, getServiceByPort: _getByPort, getStartupServices: _getStartup } = require('./service-definitions');
const { ServiceConfig, validateAllServices } = require('./service-validator');

// Build ports (env vars are now loaded)
const PORTS = buildPorts();

// Build service definitions from ports
const {
  CORE_SERVICES,
  OPTIONAL_SERVICES,
  INFRASTRUCTURE_SERVICES,
  ALL_SERVICES,
  LOCAL_DEV_SERVICES,
  ALL_PORTS
} = buildServiceDefinitions(PORTS);

// =============================================================================
// Helper Function Wrappers (bind ALL_SERVICES for backward-compatible API)
// =============================================================================

/** Get a service by name. */
function getServiceByName(name) {
  return _getByName(ALL_SERVICES, name);
}

/** Get a service by port. */
function getServiceByPort(port) {
  return _getByPort(ALL_SERVICES, port);
}

/** Get services for status monitoring (includes infrastructure). */
function getStatusServices() {
  return ALL_SERVICES;
}

/** Get services for startup (node services only). */
function getStartupServices(includeOptional = false) {
  return _getStartup(CORE_SERVICES, OPTIONAL_SERVICES, includeOptional);
}

/** Get all ports for cleanup. */
function getCleanupPorts() {
  return ALL_PORTS;
}

// =============================================================================
// Validation at Module Load
// FIX M5: Can be skipped via SKIP_SERVICE_VALIDATION=true for testing/development.
// In production startup scripts, validateAllServices() is called explicitly.
// =============================================================================

if (process.env.SKIP_SERVICE_VALIDATION !== 'true') {
  validateAllServices({ CORE_SERVICES, OPTIONAL_SERVICES, INFRASTRUCTURE_SERVICES });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Constants
  ROOT_DIR,
  PORTS,

  // Service arrays
  CORE_SERVICES,
  OPTIONAL_SERVICES,
  INFRASTRUCTURE_SERVICES,
  ALL_SERVICES,
  LOCAL_DEV_SERVICES,
  ALL_PORTS,

  // Helper functions
  getServiceByName,
  getServiceByPort,
  getStatusServices,
  getStartupServices,
  getCleanupPorts,
  checkAndPrintDeprecations,

  // Validation (FIX M5: now explicitly callable)
  ServiceConfig,
  validateAllServices
};

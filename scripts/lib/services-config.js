#!/usr/bin/env node
/**
 * Centralized Service Configuration for Development Scripts
 *
 * Single source of truth for all service configurations.
 * Includes:
 * - 6 core services (Coordinator, 4 partition detectors, Execution engine)
 * - 1 cross-chain detector
 * - 1 deprecated optional service (Unified detector)
 * - 2 infrastructure services (Redis, Redis Commander)
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
 * - SKIP_SERVICE_VALIDATION: Skip module-load validation (default: false)
 *   Set to "true" to disable service config validation at module load.
 *   Useful for: tests, development, CI/CD that imports before services exist.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

const path = require('path');

// Load environment variables (with correct override order)
// .env.local should override .env for local development
const dotenv = require('dotenv');
const ROOT_DIR = path.join(__dirname, '..', '..');

// =============================================================================
// Shared Configuration (Single Source of Truth)
// =============================================================================
const portConfig = require('../../shared/constants/service-ports.json');
const deprecationConfig = require('../../shared/constants/deprecation-patterns.json');

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
// Deprecation Checker (Task 1.1)
// =============================================================================
const { checkForDeprecatedEnvVars, printWarnings } = require('./deprecation-checker');

// =============================================================================
// Service Startup Constants (Task P2-2)
// =============================================================================
const {
  COORDINATOR_STARTUP_DELAY_MS,
  P1_STARTUP_DELAY_MS,
  P2_STARTUP_DELAY_MS,
  P3_STARTUP_DELAY_MS,
  CROSS_CHAIN_STARTUP_DELAY_MS,
  EXECUTION_ENGINE_STARTUP_DELAY_MS,
  UNIFIED_DETECTOR_STARTUP_DELAY_MS,
  P4_STARTUP_DELAY_MS
} = require('./constants');

// =============================================================================
// Service Config Validation (Task P2-1, P2-3 Refactoring)
// =============================================================================

const fs = require('fs');
const { validatePort, validateEnum, validateString, validateOptionalString } = require('./validators');

/**
 * Validates and creates a service configuration.
 * Catches configuration errors at module load time instead of runtime.
 *
 * @class ServiceConfig
 */
class ServiceConfig {
  /**
   * Create and validate a service configuration.
   * @param {Object} config - Service configuration object
   * @throws {Error} If validation fails
   */
  constructor(config) {
    this.config = config;
    this.validate();
    Object.assign(this, config);
  }

  /**
   * Validate the service configuration.
   * Uses reusable validators from lib/validators.js (P2-3 refactoring).
   * @throws {Error} If validation fails with actionable message
   */
  validate() {
    const { name, port, type, script, healthEndpoint } = this.config;

    // Validate name (required, non-empty string)
    try {
      validateString(name, 'Service name');
    } catch (error) {
      throw new Error(`Service configuration error: ${error.message}`);
    }

    // Validate type (required enum)
    try {
      validateEnum(type, ['node', 'docker', 'redis'], `Service "${name}" type`);
    } catch (error) {
      throw new Error(error.message);
    }

    // Validate port (required, valid port number)
    try {
      validatePort(port, `Service "${name}"`);
    } catch (error) {
      throw new Error(error.message);
    }

    // Validate script path for node services
    if (type === 'node') {
      try {
        validateString(script, `Service "${name}" script`);
      } catch (error) {
        throw new Error(error.message);
      }

      const scriptPath = path.join(ROOT_DIR, script);
      if (!fs.existsSync(scriptPath)) {
        throw new Error(
          `Service "${name}": Script not found at ${script}\n` +
          `  Full path: ${scriptPath}\n` +
          `  Make sure the service exists and the path is correct.`
        );
      }
    }

    // Validate healthEndpoint format (optional, must start with /)
    if (type === 'node') {
      try {
        const validated = validateOptionalString(healthEndpoint, `Service "${name}" healthEndpoint`);
        if (validated && !validated.startsWith('/')) {
          throw new Error(
            `Service "${name}": Invalid healthEndpoint "${healthEndpoint}". ` +
            `Must start with "/" (e.g., "/health", "/api/health")`
          );
        }
      } catch (error) {
        throw new Error(error.message);
      }
    }

    // All validations passed
    return true;
  }

  /**
   * Convert to plain object (for backward compatibility).
   * @returns {Object}
   */
  toObject() {
    return this.config;
  }
}

// =============================================================================
// Port Configuration (from environment with defaults)
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

  // Check for NaN (parseInt returns NaN for invalid strings)
  if (isNaN(port)) {
    throw new Error(
      `Invalid port configuration for ${envVarName}.\n` +
      `  Value: "${rawValue}"\n` +
      `  Expected: A number between 1-65535\n` +
      `  Fix: Check your .env file or environment variables`
    );
  }

  // Check port range
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid port ${port} for ${envVarName}.\n` +
      `  Port must be between 1 and 65535\n` +
      `  Fix: Update ${envVarName} in your .env file`
    );
  }

  return port;
}

const PORTS = {
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

// =============================================================================
// Service Definitions
// =============================================================================

/**
 * @typedef {Object} ServiceConfig
 * @property {string} name - Display name
 * @property {string} script - Path to entry point (relative to ROOT_DIR)
 * @property {number} port - Port number
 * @property {string} healthEndpoint - Health check endpoint
 * @property {number} delay - Startup delay in ms
 * @property {Object<string, string|number>} [env] - Additional environment variables
 * @property {string} [type] - Service type ('node', 'docker', 'redis')
 * @property {string} [container] - Docker container name (for docker type)
 * @property {boolean} [optional] - Whether service is optional
 * @property {boolean} [enabled] - Whether service is enabled for local dev
 */

/**
 * Core services that should always be started for local development.
 * Order matters - services are started in this order.
 * @type {ServiceConfig[]}
 */
const CORE_SERVICES = [
  {
    name: 'Coordinator',
    script: 'services/coordinator/src/index.ts',
    port: PORTS.COORDINATOR,
    healthEndpoint: '/api/health',
    delay: COORDINATOR_STARTUP_DELAY_MS, // Use constant from constants.js
    type: 'node',
    enabled: true
  },
  {
    name: 'P1 Asia-Fast Detector',
    script: 'services/partition-asia-fast/src/index.ts',
    port: PORTS.P1_ASIA_FAST,
    healthEndpoint: '/health',
    delay: P1_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.P1_ASIA_FAST },
    type: 'node',
    enabled: true
  },
  {
    name: 'P2 L2-Turbo Detector',
    script: 'services/partition-l2-turbo/src/index.ts',
    port: PORTS.P2_L2_TURBO,
    healthEndpoint: '/health',
    delay: P2_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.P2_L2_TURBO },
    type: 'node',
    enabled: true
  },
  {
    name: 'P3 High-Value Detector',
    script: 'services/partition-high-value/src/index.ts',
    port: PORTS.P3_HIGH_VALUE,
    healthEndpoint: '/health',
    delay: P3_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.P3_HIGH_VALUE },
    type: 'node',
    enabled: true
  },
  {
    name: 'Cross-Chain Detector',
    script: 'services/cross-chain-detector/src/index.ts',
    port: PORTS.CROSS_CHAIN,
    healthEndpoint: '/health',
    delay: CROSS_CHAIN_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.CROSS_CHAIN },
    type: 'node',
    enabled: true
  },
  {
    name: 'Execution Engine',
    script: 'services/execution-engine/src/index.ts',
    port: PORTS.EXECUTION_ENGINE,
    healthEndpoint: '/health',
    delay: EXECUTION_ENGINE_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.EXECUTION_ENGINE },
    type: 'node',
    enabled: true
  }
];

/**
 * Optional services that can be started separately.
 * These are not started by default in local dev.
 * @type {ServiceConfig[]}
 */
const OPTIONAL_SERVICES = [
  {
    name: 'Unified Detector',
    script: 'services/unified-detector/src/index.ts',
    port: PORTS.UNIFIED_DETECTOR,
    healthEndpoint: '/health',
    delay: UNIFIED_DETECTOR_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.UNIFIED_DETECTOR },
    type: 'node',
    enabled: false,
    optional: true
  },
  {
    name: 'P4 Solana Detector',
    script: 'services/partition-solana/src/index.ts',
    port: PORTS.P4_SOLANA,
    healthEndpoint: '/health',
    delay: P4_STARTUP_DELAY_MS, // Use constant from constants.js
    env: { HEALTH_CHECK_PORT: PORTS.P4_SOLANA },
    type: 'node',
    enabled: false,
    optional: true
  }
];

/**
 * Infrastructure services (Redis, monitoring).
 * @type {ServiceConfig[]}
 */
const INFRASTRUCTURE_SERVICES = [
  {
    name: 'Redis',
    type: 'redis',
    container: 'arbitrage-redis',
    port: PORTS.REDIS,
    healthEndpoint: '',
    delay: 0,
    script: '',
    enabled: true
  },
  {
    name: 'Redis Commander',
    type: 'docker',
    container: 'arbitrage-redis-ui',
    port: PORTS.REDIS_UI,
    healthEndpoint: '',
    delay: 0,
    script: '',
    optional: true,
    enabled: false
  }
];

/**
 * All services combined (for status checking).
 * @type {ServiceConfig[]}
 */
const ALL_SERVICES = [
  ...INFRASTRUCTURE_SERVICES,
  ...CORE_SERVICES,
  ...OPTIONAL_SERVICES
];

/**
 * Services to start in local development mode.
 * @type {ServiceConfig[]}
 */
const LOCAL_DEV_SERVICES = CORE_SERVICES.filter(s => s.enabled);

/**
 * All ports used by services (for cleanup).
 * @type {Array<{name: string, port: number}>}
 */
const ALL_PORTS = ALL_SERVICES.map(s => ({
  name: s.name,
  port: s.port
}));

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a service by name.
 * @param {string} name - Service name
 * @returns {ServiceConfig | undefined}
 */
function getServiceByName(name) {
  return ALL_SERVICES.find(s => s.name === name);
}

/**
 * Get a service by port.
 * @param {number} port - Port number
 * @returns {ServiceConfig | undefined}
 */
function getServiceByPort(port) {
  return ALL_SERVICES.find(s => s.port === port);
}

/**
 * Get services for status monitoring (includes infrastructure).
 * @returns {ServiceConfig[]}
 */
function getStatusServices() {
  return ALL_SERVICES;
}

/**
 * Get services for startup (node services only).
 * @param {boolean} [includeOptional=false] - Include optional services
 * @returns {ServiceConfig[]}
 */
function getStartupServices(includeOptional = false) {
  if (includeOptional) {
    return [...CORE_SERVICES, ...OPTIONAL_SERVICES];
  }
  return LOCAL_DEV_SERVICES;
}

/**
 * Get all ports for cleanup.
 * @returns {Array<{name: string, port: number}>}
 */
function getCleanupPorts() {
  return ALL_PORTS;
}

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
// Validation at Module Load (Task P2-1)
// =============================================================================

/**
 * Validate all service configurations at module load.
 * Catches configuration errors early, before services are started.
 */
function validateAllServices() {
  const servicesToValidate = [...CORE_SERVICES, ...OPTIONAL_SERVICES, ...INFRASTRUCTURE_SERVICES];

  for (const service of servicesToValidate) {
    try {
      new ServiceConfig(service);
    } catch (error) {
      // Fail fast with clear error message
      console.error('\n❌ SERVICE CONFIGURATION ERROR:');
      console.error(error.message);
      console.error('\nFix the configuration in scripts/lib/services-config.js and try again.\n');
      process.exit(1);
    }
  }
}

// Run validation at module load (fail fast)
// Can be skipped via SKIP_SERVICE_VALIDATION=true for testing/development
if (process.env.SKIP_SERVICE_VALIDATION !== 'true') {
  validateAllServices();
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

  // Service config validation (Task P2-1)
  ServiceConfig
};

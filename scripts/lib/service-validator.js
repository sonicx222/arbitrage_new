#!/usr/bin/env node
/**
 * Service Configuration Validator
 *
 * Validates service configurations with actionable error messages.
 * Catches configuration errors early, before services are started.
 *
 * FIX M3: Extracted from services-config.js God Module.
 * FIX M5: Validation is no longer triggered at module load — callers use
 *         validateAllServices() explicitly in startup scripts.
 *
 * @see scripts/lib/validators.js (reusable validation primitives)
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const { validatePort, validateEnum, validateString, validateOptionalString } = require('./validators');

// =============================================================================
// ServiceConfig Class
// =============================================================================

/**
 * Validates and creates a service configuration.
 * Catches configuration errors at construction time instead of runtime.
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
// Validation Runner
// =============================================================================

/**
 * Validate all service configurations.
 * FIX M5: This is now an explicitly-called function, not a module-load side effect.
 * Call this in startup scripts (start-local.js, etc.) before starting services.
 *
 * @param {Object} serviceLists - Object containing service arrays to validate
 * @param {Array} serviceLists.CORE_SERVICES
 * @param {Array} serviceLists.OPTIONAL_SERVICES
 * @param {Array} serviceLists.INFRASTRUCTURE_SERVICES
 */
function validateAllServices({ CORE_SERVICES, OPTIONAL_SERVICES, INFRASTRUCTURE_SERVICES }) {
  const servicesToValidate = [...CORE_SERVICES, ...OPTIONAL_SERVICES, ...INFRASTRUCTURE_SERVICES];

  for (const service of servicesToValidate) {
    try {
      new ServiceConfig(service);
    } catch (error) {
      console.error('\nSERVICE CONFIGURATION ERROR:');
      console.error(error.message);
      console.error('\nFix the configuration in scripts/lib/services-config.js and try again.\n');
      process.exit(1);
    }
  }
}

module.exports = {
  ServiceConfig,
  validateAllServices
};

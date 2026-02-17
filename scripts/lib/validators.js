#!/usr/bin/env node
/**
 * Validation Utilities for Development Scripts
 *
 * Provides reusable validation functions with consistent error messages.
 * Extracted from services-config.js as part of P2 refactoring.
 *
 * @see scripts/lib/services-config.js (original port validation)
 */

// =============================================================================
// Port Validation
// =============================================================================

/**
 * Validate a port number.
 * Throws descriptive error if invalid.
 *
 * @param {number} port - Port number to validate
 * @param {string} context - Context for error message (e.g., "Service Coordinator")
 * @throws {Error} If port is invalid
 * @returns {number} The validated port (for chaining)
 *
 * @example
 * const port = validatePort(3000, 'Coordinator');
 * // Returns: 3000
 *
 * validatePort(99999, 'Redis');
 * // Throws: Error: Invalid port for Redis: 99999...
 */
function validatePort(port, context) {
  // Check type
  if (typeof port !== 'number') {
    throw new Error(
      `Invalid port for ${context}: expected number, got ${typeof port}\n` +
      `  Value: ${port}\n` +
      `  Fix: Ensure port configuration is a valid number`
    );
  }

  // Check for NaN
  if (isNaN(port)) {
    throw new Error(
      `Invalid port for ${context}: NaN (Not a Number)\n` +
      `  This usually indicates a parsing error in configuration.\n` +
      `  Fix: Check environment variables or config files for invalid port values`
    );
  }

  // Check range
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid port for ${context}: ${port}\n` +
      `  Port must be between 1 and 65535 (valid TCP port range)\n` +
      `  Fix: Update port configuration to use a valid port number`
    );
  }

  return port;
}

// =============================================================================
// String Validation
// =============================================================================

/**
 * Validate that a value is a non-empty string.
 *
 * @param {any} value - Value to validate
 * @param {string} fieldName - Field name for error message
 * @param {Object} [options] - Validation options
 * @param {number} [options.minLength] - Minimum length (default: 1)
 * @param {number} [options.maxLength] - Maximum length (no default)
 * @param {RegExp} [options.pattern] - Pattern to match
 * @throws {Error} If validation fails
 * @returns {string} The validated string
 */
function validateString(value, fieldName, options = {}) {
  const { minLength = 1, maxLength, pattern } = options;

  if (typeof value !== 'string') {
    throw new Error(
      `Invalid ${fieldName}: expected string, got ${typeof value}\n` +
      `  Value: ${value}`
    );
  }

  if (value.length < minLength) {
    throw new Error(
      `Invalid ${fieldName}: too short\n` +
      `  Length: ${value.length}\n` +
      `  Minimum: ${minLength}`
    );
  }

  if (maxLength && value.length > maxLength) {
    throw new Error(
      `Invalid ${fieldName}: too long\n` +
      `  Length: ${value.length}\n` +
      `  Maximum: ${maxLength}`
    );
  }

  if (pattern && !pattern.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: does not match required pattern\n` +
      `  Value: ${value}\n` +
      `  Pattern: ${pattern}`
    );
  }

  return value;
}

/**
 * Validate that a value is a non-empty string or undefined/null.
 * Useful for optional fields.
 *
 * @param {any} value - Value to validate
 * @param {string} fieldName - Field name for error message
 * @param {Object} [options] - Validation options (same as validateString)
 * @throws {Error} If validation fails
 * @returns {string | undefined} The validated string or undefined
 */
function validateOptionalString(value, fieldName, options = {}) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return validateString(value, fieldName, options);
}

// =============================================================================
// Enum Validation
// =============================================================================

/**
 * Validate that a value is one of allowed values.
 *
 * @param {any} value - Value to validate
 * @param {Array<any>} allowedValues - Array of allowed values
 * @param {string} fieldName - Field name for error message
 * @throws {Error} If value not in allowedValues
 * @returns {any} The validated value
 */
function validateEnum(value, allowedValues, fieldName) {
  if (!allowedValues.includes(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}"\n` +
      `  Allowed values: ${allowedValues.join(', ')}\n` +
      `  Fix: Use one of the allowed values`
    );
  }
  return value;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Port validation
  validatePort,

  // String validation
  validateString,
  validateOptionalString,

  // Enum validation
  validateEnum
};

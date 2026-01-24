#!/usr/bin/env node
/**
 * Deprecation Checker for Service Patterns
 *
 * Warns when deprecated patterns are detected in scripts or configs.
 * This module helps maintain a clean codebase by flagging usage of
 * deprecated service names and environment variables.
 *
 * @see Task 1.1: Deprecation Warning System
 * @see ADR-003: Partitioned Chain Detectors (deprecated per-chain detectors)
 * @see ADR-002: Redis Streams (deprecated pub/sub patterns)
 */

/**
 * Deprecated patterns registry.
 * Imported from shared JSON config (single source of truth).
 *
 * Services: Maps old per-chain detector names to new partition-based services.
 * EnvVars: Maps deprecated environment variables to their status/replacement.
 *
 * @see shared/constants/deprecation-patterns.json
 */
const DEPRECATED_PATTERNS = require('../../shared/constants/deprecation-patterns.json');

/**
 * Check for deprecated service names.
 *
 * @param {string[]} serviceNames - Array of service names to check
 * @returns {Array<{type: string, name: string, replacement: string, since: string}>}
 */
function checkForDeprecatedServices(serviceNames) {
  const warnings = [];

  for (const name of serviceNames) {
    const info = DEPRECATED_PATTERNS.services[name];
    if (info) {
      warnings.push({
        type: 'deprecated_service',
        name,
        replacement: info.replacement,
        since: info.since,
        reason: info.reason
      });
    }
  }

  return warnings;
}

/**
 * Check for deprecated environment variables.
 * Scans process.env for any deprecated variables that are set.
 *
 * @returns {Array<{type: string, name: string, replacement: string, since: string}>}
 */
function checkForDeprecatedEnvVars() {
  const warnings = [];

  for (const [key, info] of Object.entries(DEPRECATED_PATTERNS.envVars)) {
    if (process.env[key] !== undefined) {
      warnings.push({
        type: 'deprecated_env',
        name: key,
        replacement: info.replacement,
        since: info.since,
        reason: info.reason
      });
    }
  }

  return warnings;
}

/**
 * Check all deprecations (services and env vars).
 *
 * @param {string[]} serviceNames - Array of service names to check
 * @returns {Array<{type: string, name: string, replacement: string, since: string}>}
 */
function checkAllDeprecations(serviceNames = []) {
  const serviceWarnings = checkForDeprecatedServices(serviceNames);
  const envWarnings = checkForDeprecatedEnvVars();
  return [...serviceWarnings, ...envWarnings];
}

/**
 * Print deprecation warnings to console.
 *
 * @param {Array<{type: string, name: string, replacement: string, since: string}>} warnings
 */
function printWarnings(warnings) {
  if (warnings.length === 0) return;

  console.warn('\n\u26A0\uFE0F  DEPRECATION WARNINGS \u26A0\uFE0F');
  console.warn('\u2550'.repeat(50));

  for (const w of warnings) {
    console.warn(`\u2022 ${w.name} (deprecated since ${w.since})`);
    console.warn(`  \u2192 Use: ${w.replacement}`);
    if (w.reason) {
      console.warn(`  Reason: ${w.reason}`);
    }
  }

  console.warn('\u2550'.repeat(50) + '\n');
}

/**
 * Integration function for use in startup scripts.
 * Checks for deprecations and prints warnings.
 *
 * @param {string[]} serviceNames - Array of service names to check
 * @returns {boolean} - True if any deprecations were found
 */
function checkAndWarn(serviceNames = []) {
  const warnings = checkAllDeprecations(serviceNames);
  printWarnings(warnings);
  return warnings.length > 0;
}

module.exports = {
  DEPRECATED_PATTERNS,
  checkForDeprecatedServices,
  checkForDeprecatedEnvVars,
  checkAllDeprecations,
  printWarnings,
  checkAndWarn
};

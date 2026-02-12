#!/usr/bin/env node
/**
 * Console Logging Utilities for Development Scripts
 *
 * Provides colored console output with consistent formatting.
 * Offers both a modern class-based interface and legacy functions.
 *
 * Refactored in Task #1: Extracted from utils.js
 * Enhanced in Task #5: Added standardized interface with semantic logging methods
 *
 * @example Modern interface (recommended for new code)
 * const { logger } = require('./lib/logger');
 * logger.info('Starting service...');
 * logger.success('Service started successfully');
 * logger.warning('Configuration incomplete');
 * logger.error('Failed to connect');
 *
 * @example Legacy interface (for existing code)
 * const { log, logService } = require('./lib/logger');
 * log('Message', 'green');
 * logService('ServiceName', 'Message', 'cyan');
 *
 * @see scripts/lib/utils.js (original implementation)
 */

// =============================================================================
// Console Colors (ANSI Escape Codes)
// =============================================================================

/**
 * ANSI escape codes for terminal colors.
 * Can be concatenated for combined effects (e.g., colors.bold + colors.cyan)
 */
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
};

// =============================================================================
// ScriptLogger Class (Modern Interface)
// =============================================================================

/**
 * Standardized logger for development scripts.
 * Provides semantic logging methods with consistent formatting.
 *
 * @example
 * const { logger } = require('./lib/logger');
 * logger.info('Processing files...');
 * logger.success('All files processed');
 * logger.warning('Some files skipped');
 * logger.error('Processing failed');
 * logger.service('WebSocket', 'Connected to endpoint');
 * logger.header('Build Validation');
 */
class ScriptLogger {
  /**
   * Log an informational message (cyan).
   * Use for general status updates and progress messages.
   *
   * @param {string} message - Message to log
   * @example logger.info('Starting validation...')
   */
  info(message) {
    console.log(`${colors.cyan}${message}${colors.reset}`);
  }

  /**
   * Log a success message (green with checkmark).
   * Use when operations complete successfully.
   *
   * @param {string} message - Message to log
   * @example logger.success('Validation passed')
   */
  success(message) {
    console.log(`${colors.green}✓ ${message}${colors.reset}`);
  }

  /**
   * Log a warning message (yellow with warning symbol).
   * Use for non-critical issues that should be noted.
   *
   * @param {string} message - Message to log
   * @example logger.warning('Using default configuration')
   */
  warning(message) {
    console.warn(`${colors.yellow}⚠ ${message}${colors.reset}`);
  }

  /**
   * Log an error message (red with X symbol).
   * Use for failures and critical errors.
   *
   * @param {string} message - Message to log
   * @example logger.error('Connection failed')
   */
  error(message) {
    console.error(`${colors.red}✗ ${message}${colors.reset}`);
  }

  /**
   * Log a service-specific message with timestamp.
   * Use for multi-service logging where source identification is important.
   *
   * @param {string} name - Service name
   * @param {string} message - Message to log
   * @param {'info'|'success'|'warning'|'error'|'dim'} [level='info'] - Log level
   * @example logger.service('Coordinator', 'Processing event', 'info')
   * @example logger.service('Detector', 'Opportunity found', 'success')
   */
  service(name, message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const levelColor = this._getLevelColor(level);
    console.log(
      `${colors.dim}[${timestamp}]${colors.reset} ` +
      `${levelColor}[${name}]${colors.reset} ${message}`
    );
  }

  /**
   * Log a section header with separator lines.
   * Use to clearly separate different sections of output.
   *
   * @param {string} title - Header title
   * @param {number} [width=60] - Width of separator line
   * @example logger.header('Build Validation')
   * // Output:
   * // ============================================================
   * //   Build Validation
   * // ============================================================
   */
  header(title, width = 60) {
    const separator = '='.repeat(width);
    console.log(`\n${separator}`);
    console.log(`${colors.cyan}  ${title}${colors.reset}`);
    console.log(`${separator}\n`);
  }

  /**
   * Get ANSI color code for a log level.
   * @private
   * @param {'info'|'success'|'warning'|'error'|'dim'} level - Log level
   * @returns {string} ANSI color code
   */
  _getLevelColor(level) {
    const levelColors = {
      info: colors.cyan,
      success: colors.green,
      warning: colors.yellow,
      error: colors.red,
      dim: colors.dim
    };
    return levelColors[level] || colors.cyan;
  }

  /**
   * Legacy log function for backward compatibility.
   * Prefer semantic methods (info, success, warning, error) for new code.
   *
   * @param {string} message - Message to log
   * @param {'reset'|'green'|'yellow'|'red'|'cyan'|'blue'|'dim'|'bold'} [color='reset'] - Color name
   * @deprecated Use semantic methods instead (info, success, warning, error)
   * @example logger.log('Message', 'green') // Old way
   * @example logger.success('Message')      // New way (preferred)
   */
  log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  /**
   * Legacy service log function for backward compatibility.
   * Prefer service() method with level parameter for new code.
   *
   * @param {string} name - Service name
   * @param {string} message - Message to log
   * @param {'reset'|'green'|'yellow'|'red'|'cyan'|'blue'|'dim'|'bold'} [color='cyan'] - Color name
   * @deprecated Use service(name, message, level) instead
   * @example logger.logService('Service', 'Message', 'green') // Old way
   * @example logger.service('Service', 'Message', 'success')  // New way (preferred)
   */
  logService(name, message, color = 'cyan') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `${colors.dim}[${timestamp}]${colors.reset} ` +
      `${colors[color]}[${name}]${colors.reset} ${message}`
    );
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Singleton logger instance.
 * Use this for the modern interface.
 */
const logger = new ScriptLogger();

// =============================================================================
// Legacy Function Exports (Backward Compatibility)
// =============================================================================

/**
 * Legacy log function for backward compatibility.
 * @see ScriptLogger#log
 */
const log = logger.log.bind(logger);

/**
 * Legacy service log function for backward compatibility.
 * @see ScriptLogger#logService
 */
const logService = logger.logService.bind(logger);

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Modern interface (recommended)
  logger,
  ScriptLogger,

  // ANSI color codes (for custom formatting)
  colors,

  // Legacy interface (backward compatibility)
  log,
  logService
};

// =============================================================================
// MIGRATION GUIDE
// =============================================================================

/**
 * MIGRATION GUIDE: Legacy → Modern Interface
 *
 * Old Pattern                          | New Pattern (Recommended)
 * -------------------------------------|----------------------------------
 * log('Message', 'cyan')               | logger.info('Message')
 * log('Success!', 'green')             | logger.success('Success!')
 * log('Warning!', 'yellow')            | logger.warning('Warning!')
 * log('Error!', 'red')                 | logger.error('Error!')
 * logService(name, msg, 'cyan')        | logger.service(name, msg, 'info')
 * logService(name, msg, 'green')       | logger.service(name, msg, 'success')
 * logService(name, msg, 'dim')         | logger.service(name, msg, 'dim')
 * console.log('='.repeat(60))          | logger.header('Title')
 *
 * BENEFITS OF NEW INTERFACE:
 * - Semantic methods (intent is clear from method name)
 * - Consistent symbols (✓ for success, ⚠ for warning, ✗ for error)
 * - No magic strings ('green', 'red', etc.)
 * - Better IDE autocomplete
 * - Self-documenting code
 *
 * WHEN TO USE COLORS DIRECTLY:
 * For custom formatting that doesn't fit semantic methods:
 *   const { colors } = require('./lib/logger');
 *   console.log(colors.bold + colors.cyan + 'Custom' + colors.reset);
 *
 * BACKWARD COMPATIBILITY:
 * Old code using log() and logService() continues to work unchanged.
 * No breaking changes - migration is optional but recommended.
 *
 * FIX L7: LOGGING CONVENTION (Emoji vs ANSI)
 * ─────────────────────────────────────────────
 * JS scripts (CommonJS):
 *   Use ScriptLogger semantic methods — they output ANSI symbols (✓, ⚠, ✗)
 *   which render correctly in all terminals.
 *     const { logger } = require('./lib/logger');
 *     logger.success('Done');  // outputs: ✓ Done
 *
 * TS scripts (ESM/ts-node):
 *   TS scripts under scripts/ cannot easily import the JS logger.
 *   Use emoji prefixes for visual consistency:
 *     console.log('✅ Done');
 *     console.error('❌ Failed');
 *     console.warn('⚠️  Warning');
 *
 * Both approaches produce visually similar output. The key rule is:
 * NEVER mix raw ANSI escape codes with emoji in the same script.
 * Pick one style per file and be consistent.
 */

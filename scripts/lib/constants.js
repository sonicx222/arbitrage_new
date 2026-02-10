#!/usr/bin/env node
/**
 * Shared Constants for Development Scripts
 *
 * Consolidates magic numbers and configuration values.
 * Created in Task P2-2 (Phase 2 refactoring).
 *
 * @see Phase 2: Structural Improvements
 */

// =============================================================================
// Timeout Constants
// =============================================================================

/**
 * Default timeout for HTTP health checks (milliseconds).
 * Used when checking if services are responding.
 * @type {number}
 */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Default timeout for TCP connection checks (milliseconds).
 * Used for low-level port connectivity tests.
 * @type {number}
 */
const TCP_CONNECTION_TIMEOUT_MS = 1000;

/**
 * Maximum time to wait for Redis to be ready (seconds).
 * Converted to attempts: REDIS_STARTUP_TIMEOUT_SEC / retry interval.
 * @type {number}
 */
const REDIS_STARTUP_TIMEOUT_SEC = 30;

/**
 * Maximum time to wait for a service to start (seconds).
 * Converted to attempts: SERVICE_STARTUP_TIMEOUT_SEC / retry interval.
 * @type {number}
 */
const SERVICE_STARTUP_TIMEOUT_SEC = 30;

/**
 * Timeout for unit test execution (milliseconds).
 * @type {number}
 */
const UNIT_TEST_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Timeout for integration test execution (milliseconds).
 * @type {number}
 */
const INTEGRATION_TEST_TIMEOUT_MS = 180000; // 3 minutes

/**
 * Timeout for performance test execution (milliseconds).
 * @type {number}
 */
const PERFORMANCE_TEST_TIMEOUT_MS = 240000; // 4 minutes

// =============================================================================
// PID File Locking Constants
// =============================================================================

/**
 * Maximum time to wait for PID file lock acquisition (milliseconds).
 * If lock cannot be acquired within this time, operation fails.
 * @type {number}
 */
const LOCK_TIMEOUT_MS = 5000;

/**
 * Retry interval for PID file lock acquisition (milliseconds).
 * How long to wait between lock acquisition attempts.
 * @type {number}
 */
const LOCK_RETRY_INTERVAL_MS = 50;

// =============================================================================
// Delay Constants
// =============================================================================

/**
 * Delay between checking Redis readiness (milliseconds).
 * @type {number}
 */
const REDIS_CHECK_INTERVAL_MS = 1000;

/**
 * Delay between service health check attempts (milliseconds).
 * @type {number}
 */
const HEALTH_CHECK_INTERVAL_MS = 1000;

/**
 * Delay between starting different services (milliseconds).
 * Prevents overwhelming the system with concurrent startups.
 * @type {number}
 */
const SERVICE_START_DELAY_MS = 1000;

// =============================================================================
// Service Startup Constants (from services-config.js)
// =============================================================================

/**
 * Startup delay for Coordinator service (milliseconds).
 * @type {number}
 */
const COORDINATOR_STARTUP_DELAY_MS = 0;

/**
 * Startup delay for P1 Asia-Fast Detector (milliseconds).
 * @type {number}
 */
const P1_STARTUP_DELAY_MS = 2000;

/**
 * Startup delay for P2 L2-Turbo Detector (milliseconds).
 * @type {number}
 */
const P2_STARTUP_DELAY_MS = 2500;

/**
 * Startup delay for P3 High-Value Detector (milliseconds).
 * @type {number}
 */
const P3_STARTUP_DELAY_MS = 3000;

/**
 * Startup delay for Cross-Chain Detector (milliseconds).
 * @type {number}
 */
const CROSS_CHAIN_STARTUP_DELAY_MS = 3500;

/**
 * Startup delay for Execution Engine (milliseconds).
 * @type {number}
 */
const EXECUTION_ENGINE_STARTUP_DELAY_MS = 4000;

/**
 * Startup delay for Unified Detector (milliseconds).
 * @type {number}
 */
const UNIFIED_DETECTOR_STARTUP_DELAY_MS = 4500;

/**
 * Startup delay for P4 Solana Detector (milliseconds).
 * @type {number}
 */
const P4_STARTUP_DELAY_MS = 5000;

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Timeouts
  HEALTH_CHECK_TIMEOUT_MS,
  TCP_CONNECTION_TIMEOUT_MS,
  REDIS_STARTUP_TIMEOUT_SEC,
  SERVICE_STARTUP_TIMEOUT_SEC,
  UNIT_TEST_TIMEOUT_MS,
  INTEGRATION_TEST_TIMEOUT_MS,
  PERFORMANCE_TEST_TIMEOUT_MS,

  // Locking
  LOCK_TIMEOUT_MS,
  LOCK_RETRY_INTERVAL_MS,

  // Delays
  REDIS_CHECK_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
  SERVICE_START_DELAY_MS,

  // Service-specific startup delays
  COORDINATOR_STARTUP_DELAY_MS,
  P1_STARTUP_DELAY_MS,
  P2_STARTUP_DELAY_MS,
  P3_STARTUP_DELAY_MS,
  CROSS_CHAIN_STARTUP_DELAY_MS,
  EXECUTION_ENGINE_STARTUP_DELAY_MS,
  UNIFIED_DETECTOR_STARTUP_DELAY_MS,
  P4_STARTUP_DELAY_MS
};

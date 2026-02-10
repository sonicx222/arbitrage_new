#!/usr/bin/env node
/**
 * Health Check Utilities for Services
 *
 * Provides HTTP and TCP health checking functionality for monitoring
 * service status and connectivity.
 *
 * Extracted from utils.js as part of Task #1 refactoring.
 * Network primitives moved to network-utils.js (P3-2: resolve circular dependency).
 *
 * @see scripts/lib/utils.js (original implementation)
 * @see scripts/lib/network-utils.js (TCP connection checks)
 */

const http = require('http');

// Task P2-2: Use shared constants
const { HEALTH_CHECK_TIMEOUT_MS } = require('./constants');

// P3-2: Import network primitives from dedicated module (avoids circular dependency)
const { checkTcpConnection, isPortInUse } = require('./network-utils');

// =============================================================================
// Health Check Functions
// =============================================================================

/**
 * Check health of an HTTP endpoint.
 * @param {number} port - Port number
 * @param {string} endpoint - Health endpoint path
 * @param {number} [timeout] - Timeout in milliseconds (default: HEALTH_CHECK_TIMEOUT_MS)
 * @returns {Promise<{running: boolean, status?: string, latency?: number, details?: object}>}
 */
function checkHealth(port, endpoint, timeout = HEALTH_CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = http.get(`http://localhost:${port}${endpoint}`, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        const statusOk = res.statusCode >= 200 && res.statusCode < 400;

        // Try to parse JSON response
        try {
          const json = JSON.parse(data);
          resolve({
            running: statusOk,
            status: json.status || 'ok',
            latency,
            details: json
          });
        } catch (parseError) {
          // Non-JSON response: only consider healthy if status code is OK
          // Log parse error for debugging but don't fail health check if HTTP 200
          resolve({
            running: statusOk,
            status: statusOk ? 'non-json-response' : 'error',
            latency
          });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
  });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // HTTP health check (implemented here)
  checkHealth,

  // Network utilities (re-exported from network-utils for backward compatibility)
  isPortInUse,
  checkTcpConnection
};

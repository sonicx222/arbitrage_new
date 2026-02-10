#!/usr/bin/env node
/**
 * Network Utilities for Development Scripts
 *
 * Provides low-level network connectivity checks.
 * Extracted from health-checker.js to resolve circular dependency with redis-helper.js.
 *
 * Circular dependency issue (P3-2):
 * - redis-helper.js imported checkTcpConnection from health-checker.js
 * - If health-checker needed redis-helper, we'd have a cycle
 * - Solution: Extract network primitives to this standalone module
 *
 * @see scripts/lib/health-checker.js (original location)
 * @see scripts/lib/redis-helper.js (consumer)
 */

const net = require('net');

// Task P2-2: Use shared constants
const { TCP_CONNECTION_TIMEOUT_MS } = require('./constants');

// =============================================================================
// Network Connectivity Checks
// =============================================================================

/**
 * Check TCP connectivity to a host:port.
 * Low-level socket connection test - doesn't send any protocol-specific data.
 *
 * @param {string} host - Host address (e.g., 'localhost', '127.0.0.1')
 * @param {number} port - Port number
 * @param {number} [timeout] - Timeout in milliseconds (default: TCP_CONNECTION_TIMEOUT_MS)
 * @returns {Promise<boolean>} True if connection succeeds
 *
 * @example
 * const isRedisUp = await checkTcpConnection('localhost', 6379);
 * if (isRedisUp) {
 *   console.log('Redis is listening on port 6379');
 * }
 */
function checkTcpConnection(host, port, timeout = TCP_CONNECTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(timeout);

    client.connect(port, host, () => {
      client.destroy();
      resolve(true);
    });

    client.on('error', () => {
      client.destroy();
      resolve(false);
    });

    client.on('timeout', () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Check if a port is in use (port is occupied).
 * Attempts to bind a server to the port - if it fails with EADDRINUSE, port is occupied.
 *
 * @param {number} port - Port number
 * @returns {Promise<boolean>} True if port is in use
 *
 * @example
 * const isBusy = await isPortInUse(3000);
 * if (isBusy) {
 *   console.log('Port 3000 is already in use');
 * }
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });

    server.once('listening', () => {
      server.close();
      resolve(false);
    });

    server.listen(port);
  });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  checkTcpConnection,
  isPortInUse
};

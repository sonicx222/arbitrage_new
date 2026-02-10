#!/usr/bin/env node
/**
 * Health Check Utilities for Services
 *
 * Provides HTTP and TCP health checking functionality for monitoring
 * service status and connectivity.
 *
 * Extracted from utils.js as part of Task #1 refactoring.
 *
 * @see scripts/lib/utils.js (original implementation)
 */

const http = require('http');
const net = require('net');

// Task P2-2: Use shared constants
const { HEALTH_CHECK_TIMEOUT_MS, TCP_CONNECTION_TIMEOUT_MS } = require('./constants');

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
        try {
          const json = JSON.parse(data);
          resolve({
            running: res.statusCode >= 200 && res.statusCode < 400,
            status: json.status || 'ok',
            latency,
            details: json
          });
        } catch {
          resolve({
            running: res.statusCode >= 200 && res.statusCode < 400,
            status: 'ok',
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

/**
 * Check if a port is in use.
 * @param {number} port - Port number
 * @returns {Promise<boolean>}
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

/**
 * Check TCP connectivity to a host:port.
 * @param {string} host - Host address
 * @param {number} port - Port number
 * @param {number} [timeout] - Timeout in milliseconds (default: TCP_CONNECTION_TIMEOUT_MS)
 * @returns {Promise<boolean>}
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

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  checkHealth,
  isPortInUse,
  checkTcpConnection
};

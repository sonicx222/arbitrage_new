/**
 * Unit tests for network-utils.js
 *
 * Tests low-level TCP connectivity and port-in-use checks.
 * Uses real localhost sockets for accuracy over mocking.
 *
 * @see scripts/lib/network-utils.js
 */

const net = require('net');
const { checkTcpConnection, isPortInUse } = require('../network-utils');

/**
 * Helper: start a TCP server on a random port and return { server, port }.
 * The caller must close the server when done.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

/**
 * Helper: find a free port by briefly binding and immediately closing.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('network-utils', () => {
  describe('checkTcpConnection', () => {
    it('should return true when a server is listening on the port', async () => {
      const { server, port } = await startServer();
      try {
        const result = await checkTcpConnection('127.0.0.1', port, 2000);
        expect(result).toBe(true);
      } finally {
        server.close();
      }
    });

    it('should return false when no server is listening on the port', async () => {
      const freePort = await findFreePort();
      const result = await checkTcpConnection('127.0.0.1', freePort, 2000);
      expect(result).toBe(false);
    });

    it('should return false when connection times out', async () => {
      // Use a non-routable IP to force a timeout (RFC 5737 TEST-NET)
      const result = await checkTcpConnection('192.0.2.1', 1, 200);
      expect(result).toBe(false);
    });

    it('should use default timeout from constants when none provided', async () => {
      const freePort = await findFreePort();
      // Should not throw and should return false (no server)
      const result = await checkTcpConnection('127.0.0.1', freePort);
      expect(result).toBe(false);
    });
  });

  describe('isPortInUse', () => {
    it('should return false for a free port', async () => {
      const freePort = await findFreePort();
      const result = await isPortInUse(freePort);
      expect(result).toBe(false);
    });

    it('should return true for a port already in use', async () => {
      const { server, port } = await startServer();
      try {
        const result = await isPortInUse(port);
        expect(result).toBe(true);
      } finally {
        server.close();
      }
    });

    it('should return false after the server is closed', async () => {
      const { server, port } = await startServer();
      // Close the server first
      await new Promise((resolve) => server.close(resolve));
      const result = await isPortInUse(port);
      expect(result).toBe(false);
    });
  });
});

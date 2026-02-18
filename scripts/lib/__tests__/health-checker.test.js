/**
 * Unit tests for health-checker.js
 *
 * Tests HTTP health check functionality and re-exports from network-utils.
 *
 * @see scripts/lib/health-checker.js
 */

const http = require('http');
const { checkHealth, isPortInUse, checkTcpConnection } = require('../health-checker');

/**
 * Helper: start an HTTP server that responds with the given status code and body.
 * Returns { server, port }. The caller must close the server.
 */
function startHttpServer(statusCode, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': contentType });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

/**
 * Helper: find a free port.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('health-checker', () => {
  describe('checkHealth', () => {
    it('should return running: true for a healthy JSON endpoint', async () => {
      const { server, port } = await startHttpServer(200, { status: 'healthy' });
      try {
        const result = await checkHealth(port, '/health', 3000);
        expect(result.running).toBe(true);
        expect(result.reachable).toBe(true);
        expect(result.status).toBe('healthy');
        expect(result.details).toEqual({ status: 'healthy' });
        expect(typeof result.latency).toBe('number');
      } finally {
        server.close();
      }
    });

    it('should return running: false when no server is listening', async () => {
      const freePort = await findFreePort();
      const result = await checkHealth(freePort, '/health', 1000);
      expect(result.running).toBe(false);
    });

    it('should handle non-JSON responses with 200 status', async () => {
      const { server, port } = await startHttpServer(200, 'OK plain text', 'text/plain');
      try {
        const result = await checkHealth(port, '/health', 3000);
        expect(result.running).toBe(true);
        expect(result.reachable).toBe(true);
        expect(result.status).toBe('non-json-response');
      } finally {
        server.close();
      }
    });

    it('should return running: false for a 500 error with JSON body', async () => {
      const { server, port } = await startHttpServer(500, { status: 'error', message: 'internal' });
      try {
        const result = await checkHealth(port, '/health', 3000);
        expect(result.running).toBe(false);
        expect(result.reachable).toBe(true);
      } finally {
        server.close();
      }
    });

    it('should return running: false for a 500 error with non-JSON body', async () => {
      const { server, port } = await startHttpServer(500, 'Internal Server Error', 'text/plain');
      try {
        const result = await checkHealth(port, '/health', 3000);
        expect(result.running).toBe(false);
        expect(result.reachable).toBe(true);
        expect(result.status).toBe('error');
      } finally {
        server.close();
      }
    });

    it('should default status to ok when JSON has no status field', async () => {
      const { server, port } = await startHttpServer(200, { uptime: 12345 });
      try {
        const result = await checkHealth(port, '/health', 3000);
        expect(result.running).toBe(true);
        expect(result.status).toBe('ok');
      } finally {
        server.close();
      }
    });

    it('should use default timeout when none provided', async () => {
      const freePort = await findFreePort();
      // Should not throw - uses HEALTH_CHECK_TIMEOUT_MS from constants
      const result = await checkHealth(freePort, '/health');
      expect(result.running).toBe(false);
    });
  });

  describe('re-exports', () => {
    it('should re-export isPortInUse from network-utils', () => {
      expect(typeof isPortInUse).toBe('function');
    });

    it('should re-export checkTcpConnection from network-utils', () => {
      expect(typeof checkTcpConnection).toBe('function');
    });
  });
});

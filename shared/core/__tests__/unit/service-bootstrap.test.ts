/**
 * Tests for Service Bootstrap Utilities
 *
 * Validates shutdown setup, health server, service runner, and server close.
 *
 * @see shared/core/src/service-bootstrap.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import {
  setupServiceShutdown,
  runServiceMain,
  closeHealthServer,
  createSimpleHealthServer,
} from '../../src/service-bootstrap';

// Minimal mock logger
function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  } as any;
}

describe('service-bootstrap', () => {
  // ===========================================================================
  // setupServiceShutdown
  // ===========================================================================

  describe('setupServiceShutdown', () => {
    it('returns a cleanup function', () => {
      const logger = createMockLogger();
      const cleanup = setupServiceShutdown({
        logger,
        onShutdown: async () => {},
        serviceName: 'test-service',
      });

      expect(typeof cleanup).toBe('function');
      cleanup(); // remove handlers
    });

    it('cleanup removes registered process handlers', () => {
      const logger = createMockLogger();
      const before = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
        uncaught: process.listenerCount('uncaughtException'),
        rejection: process.listenerCount('unhandledRejection'),
      };

      const cleanup = setupServiceShutdown({
        logger,
        onShutdown: async () => {},
        serviceName: 'test-service',
      });

      // Listeners should have increased by 1
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
      expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);

      cleanup();

      // Listeners should be back to original count
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('uncaughtException')).toBe(before.uncaught);
      expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
    });

    it('registers handlers for all four events', () => {
      const logger = createMockLogger();
      const before = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
        uncaught: process.listenerCount('uncaughtException'),
        rejection: process.listenerCount('unhandledRejection'),
      };

      const cleanup = setupServiceShutdown({
        logger,
        onShutdown: async () => {},
        serviceName: 'test-service',
      });

      expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before.sigterm);
      expect(process.listenerCount('SIGINT')).toBeGreaterThan(before.sigint);
      expect(process.listenerCount('uncaughtException')).toBeGreaterThan(before.uncaught);
      expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(before.rejection);

      cleanup();
    });
  });

  // ===========================================================================
  // runServiceMain
  // ===========================================================================

  describe('runServiceMain', () => {
    it('skips execution when JEST_WORKER_ID is set', () => {
      // JEST_WORKER_ID is always set in Jest environment
      const mainFn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      runServiceMain({
        main: mainFn,
        serviceName: 'test-service',
        logger: createMockLogger(),
      });
      expect(mainFn).not.toHaveBeenCalled();
    });

    it('calls main when JEST_WORKER_ID is not set', async () => {
      const originalJestWorkerId = process.env.JEST_WORKER_ID;
      delete process.env.JEST_WORKER_ID;

      const mainFn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const logger = createMockLogger();

      // Mock process.exit to prevent actual exit
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      try {
        runServiceMain({
          main: mainFn,
          serviceName: 'test-service',
          logger,
        });

        // Need to flush the microtask queue
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mainFn).toHaveBeenCalledTimes(1);
      } finally {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
        exitSpy.mockRestore();
      }
    });

    it('catches errors from main and logs them', async () => {
      const originalJestWorkerId = process.env.JEST_WORKER_ID;
      delete process.env.JEST_WORKER_ID;

      const logger = createMockLogger();
      const mainFn = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('startup failed'));

      // Mock process.exit to prevent actual exit
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      try {
        runServiceMain({
          main: mainFn,
          serviceName: 'test-service',
          logger,
        });

        // Flush the microtask/promise queue
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Unhandled error in test-service'),
          expect.objectContaining({ error: expect.any(Error) })
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
        exitSpy.mockRestore();
      }
    });

    it('uses console.error when no logger is provided and main fails', async () => {
      const originalJestWorkerId = process.env.JEST_WORKER_ID;
      delete process.env.JEST_WORKER_ID;

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const mainFn = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('no logger'));

      try {
        runServiceMain({
          main: mainFn,
          serviceName: 'test-service',
          // no logger provided
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Unhandled error in test-service'),
          expect.any(Error)
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
        consoleSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // closeHealthServer
  // ===========================================================================

  describe('closeHealthServer', () => {
    it('resolves immediately with null server', async () => {
      await expect(closeHealthServer(null)).resolves.toBeUndefined();
    });

    it('closes a real server', async () => {
      const server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, resolve));

      const address = server.address();
      expect(address).not.toBeNull();

      await closeHealthServer(server);

      // Server should be closed
      expect(server.listening).toBe(false);
    });
  });

  // ===========================================================================
  // createSimpleHealthServer
  // ===========================================================================

  describe('createSimpleHealthServer', () => {
    let server: http.Server;

    afterEach(async () => {
      if (server && server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    function makeRequest(port: number, path: string): Promise<{ statusCode: number; body: any }> {
      return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode!,
                body: JSON.parse(data),
              });
            } catch (e) {
              resolve({ statusCode: res.statusCode!, body: data });
            }
          });
        });
        req.on('error', reject);
      });
    }

    async function createTestServer(overrides: Partial<Parameters<typeof createSimpleHealthServer>[0]> = {}) {
      const logger = createMockLogger();
      server = createSimpleHealthServer({
        port: 0, // random port
        serviceName: 'test-service',
        logger,
        healthCheck: () => ({ status: 'healthy' }),
        ...overrides,
      });

      // Wait for the server to start listening
      await new Promise<void>((resolve) => {
        if (server.listening) {
          resolve();
        } else {
          server.on('listening', resolve);
        }
      });

      const address = server.address() as { port: number };
      return { port: address.port, logger };
    }

    it('returns an http.Server instance', async () => {
      const { port } = await createTestServer();
      expect(server).toBeInstanceOf(http.Server);
      expect(server.listening).toBe(true);
    });

    it('/health returns correct JSON for healthy status', async () => {
      const { port } = await createTestServer();
      const { statusCode, body } = await makeRequest(port, '/health');

      expect(statusCode).toBe(200);
      expect(body.service).toBe('test-service');
      expect(body.status).toBe('healthy');
      expect(body.timestamp).toBeDefined();
    });

    it('/health returns 200 for degraded status', async () => {
      const { port } = await createTestServer({
        healthCheck: () => ({ status: 'degraded' }),
      });
      const { statusCode, body } = await makeRequest(port, '/health');

      expect(statusCode).toBe(200);
      expect(body.status).toBe('degraded');
    });

    it('/health returns 503 for unhealthy status', async () => {
      const { port } = await createTestServer({
        healthCheck: () => ({ status: 'unhealthy' }),
      });
      const { statusCode, body } = await makeRequest(port, '/health');

      expect(statusCode).toBe(503);
      expect(body.status).toBe('unhealthy');
    });

    it('/health respects explicit statusCode in health check result', async () => {
      const { port } = await createTestServer({
        healthCheck: () => ({ status: 'custom', statusCode: 418 }),
      });
      const { statusCode, body } = await makeRequest(port, '/health');

      expect(statusCode).toBe(418);
      expect(body.status).toBe('custom');
      // statusCode should not appear in the response body
      expect(body.statusCode).toBeUndefined();
    });

    it('/ready returns ready=true when readyCheck is not provided', async () => {
      const { port } = await createTestServer();
      const { statusCode, body } = await makeRequest(port, '/ready');

      expect(statusCode).toBe(200);
      expect(body.service).toBe('test-service');
      expect(body.ready).toBe(true);
    });

    it('/ready returns 503 when not ready', async () => {
      const { port } = await createTestServer({
        readyCheck: () => false,
      });
      const { statusCode, body } = await makeRequest(port, '/ready');

      expect(statusCode).toBe(503);
      expect(body.ready).toBe(false);
    });

    it('/ returns service info with endpoint list', async () => {
      const { port } = await createTestServer();
      const { statusCode, body } = await makeRequest(port, '/');

      expect(statusCode).toBe(200);
      expect(body.service).toBe('test-service');
      expect(body.endpoints).toContain('/health');
      expect(body.endpoints).toContain('/ready');
    });

    it('/ uses default description when none provided', async () => {
      const { port } = await createTestServer();
      const { statusCode, body } = await makeRequest(port, '/');

      expect(statusCode).toBe(200);
      expect(body.description).toBe('test-service Service');
    });

    it('/ uses custom description when provided', async () => {
      const { port } = await createTestServer({
        description: 'Custom Description',
      });
      const { statusCode, body } = await makeRequest(port, '/');

      expect(statusCode).toBe(200);
      expect(body.description).toBe('Custom Description');
    });

    it('returns 404 for unknown routes', async () => {
      const { port } = await createTestServer();
      const { statusCode, body } = await makeRequest(port, '/nonexistent');

      expect(statusCode).toBe(404);
      expect(body.error).toBe('Not found');
    });

    it('additional routes are served correctly', async () => {
      const { port } = await createTestServer({
        additionalRoutes: {
          '/stats': (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ totalTrades: 42 }));
          },
        },
      });

      const { statusCode, body } = await makeRequest(port, '/stats');
      expect(statusCode).toBe(200);
      expect(body.totalTrades).toBe(42);
    });

    it('/ endpoint lists additional routes', async () => {
      const { port } = await createTestServer({
        additionalRoutes: {
          '/stats': (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({}));
          },
        },
      });

      const { statusCode, body } = await makeRequest(port, '/');
      expect(statusCode).toBe(200);
      expect(body.endpoints).toContain('/stats');
      expect(body.endpoints).toContain('/health');
      expect(body.endpoints).toContain('/ready');
    });
  });
});

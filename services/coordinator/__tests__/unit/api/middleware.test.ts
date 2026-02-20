/**
 * Unit Tests for Middleware Configuration
 *
 * Tests the Express middleware stack configured in api/middleware/index.ts:
 * - Production guard: ALLOWED_ORIGINS required in production
 * - CORS: Case-insensitive origin matching, allowed methods/headers
 * - Security headers: CSP, X-Content-Type-Options, X-Frame-Options, HSTS
 * - Rate limiting: Standard headers present
 * - Request logging: Logs method, URL, status, duration
 *
 * @see services/coordinator/src/api/middleware/index.ts
 * @see C3 in docs/reports/COORDINATOR_DEEP_ANALYSIS_2026-02-20.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Request, Response } from 'express';
import http from 'http';
import type { MinimalLogger } from '../../../src/api/types';
import { configureMiddleware } from '../../../src/api/middleware';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger(): jest.Mocked<MinimalLogger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

/**
 * Creates a test Express app with middleware applied and a simple echo route.
 * Returns the app and a cleanup function to close the server.
 */
function createTestApp(logger: MinimalLogger) {
  const app = express();
  configureMiddleware(app, logger);

  // Simple echo route for testing middleware effects
  app.get('/test', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // OPTIONS route handled by CORS middleware (before reaching this)
  app.options('/test', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

/**
 * Make an HTTP request to a running server.
 * Returns { statusCode, headers, body }.
 */
function makeRequest(
  server: http.Server,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const { method = 'GET', path = '/test', headers = {} } = options;
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Server not listening on a port');
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('configureMiddleware', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    process.env = { ...originalEnv };
  });

  // ---------------------------------------------------------------------------
  // S-12: Production guard — ALLOWED_ORIGINS required
  // ---------------------------------------------------------------------------

  describe('production CORS guard (S-12)', () => {
    it('should throw when NODE_ENV=production and ALLOWED_ORIGINS is not set', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOWED_ORIGINS;

      const app = express();
      const logger = createMockLogger();

      expect(() => configureMiddleware(app, logger)).toThrow(
        'CORS MISCONFIGURATION: ALLOWED_ORIGINS environment variable is required in production'
      );
    });

    it('should NOT throw when NODE_ENV=production and ALLOWED_ORIGINS is set', () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_ORIGINS = 'https://dashboard.example.com';

      const app = express();
      const logger = createMockLogger();

      expect(() => configureMiddleware(app, logger)).not.toThrow();
    });

    it('should NOT throw in development without ALLOWED_ORIGINS', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ALLOWED_ORIGINS;

      const app = express();
      const logger = createMockLogger();

      expect(() => configureMiddleware(app, logger)).not.toThrow();
    });

    it('should NOT throw in test without ALLOWED_ORIGINS', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.ALLOWED_ORIGINS;

      const app = express();
      const logger = createMockLogger();

      expect(() => configureMiddleware(app, logger)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // CORS origin matching
  // ---------------------------------------------------------------------------

  describe('CORS configuration', () => {
    let server: http.Server;
    let logger: jest.Mocked<MinimalLogger>;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      logger = createMockLogger();
    });

    afterEach((done) => {
      if (server?.listening) {
        server.close(done);
      } else {
        done();
      }
    });

    it('should set Access-Control-Allow-Origin for whitelisted origin', (done) => {
      process.env.ALLOWED_ORIGINS = 'https://dashboard.example.com,https://admin.example.com';
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server, {
          headers: { Origin: 'https://dashboard.example.com' },
        });
        expect(res.headers['access-control-allow-origin']).toBe('https://dashboard.example.com');
        done();
      });
    });

    it('should perform case-insensitive origin matching (RFC 3986)', (done) => {
      process.env.ALLOWED_ORIGINS = 'https://dashboard.example.com';
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server, {
          headers: { Origin: 'HTTPS://DASHBOARD.EXAMPLE.COM' },
        });
        // Should match despite case difference; response preserves original case
        expect(res.headers['access-control-allow-origin']).toBe('HTTPS://DASHBOARD.EXAMPLE.COM');
        done();
      });
    });

    it('should NOT set Access-Control-Allow-Origin for non-whitelisted origin', (done) => {
      process.env.ALLOWED_ORIGINS = 'https://dashboard.example.com';
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server, {
          headers: { Origin: 'https://evil.attacker.com' },
        });
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        done();
      });
    });

    it('should use localhost defaults when ALLOWED_ORIGINS is not set', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server, {
          headers: { Origin: 'http://localhost:3000' },
        });
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        done();
      });
    });

    it('should include standard CORS headers on every response', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        expect(res.headers['access-control-allow-methods']).toBe(
          'GET, POST, PUT, DELETE, OPTIONS'
        );
        expect(res.headers['access-control-allow-headers']).toBe(
          'Content-Type, Authorization, X-Requested-With'
        );
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        done();
      });
    });

    it('should respond 200 to OPTIONS preflight requests', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        const res = await makeRequest(server, {
          method: 'OPTIONS',
          path: '/test',
          headers: { Origin: 'http://localhost:3000' },
        });
        expect(res.statusCode).toBe(200);
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Security headers (Helmet)
  // ---------------------------------------------------------------------------

  describe('security headers', () => {
    let server: http.Server;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    afterEach((done) => {
      if (server?.listening) {
        server.close(done);
      } else {
        done();
      }
    });

    it('should set Content-Security-Policy header', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        const csp = res.headers['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        done();
      });
    });

    it('should set X-Content-Type-Options: nosniff', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        done();
      });
    });

    it('should set X-Frame-Options: DENY', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        expect(res.headers['x-frame-options']).toBe('DENY');
        done();
      });
    });

    it('should set Strict-Transport-Security header', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        const hsts = res.headers['strict-transport-security'];
        expect(hsts).toBeDefined();
        expect(hsts).toContain('max-age=31536000');
        expect(hsts).toContain('includeSubDomains');
        expect(hsts).toContain('preload');
        done();
      });
    });

    it('should set X-XSS-Protection: 1; mode=block', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        expect(res.headers['x-xss-protection']).toBe('1; mode=block');
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  describe('rate limiting', () => {
    let server: http.Server;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    afterEach((done) => {
      if (server?.listening) {
        server.close(done);
      } else {
        done();
      }
    });

    it('should include RateLimit standard headers in responses', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        // express-rate-limit with standardHeaders: true sets these
        expect(res.headers['ratelimit-limit']).toBeDefined();
        expect(res.headers['ratelimit-remaining']).toBeDefined();
        expect(res.headers['ratelimit-reset']).toBeDefined();
        done();
      });
    });

    it('should NOT include legacy X-RateLimit headers', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const app = createTestApp(createMockLogger());
      server = app.listen(0, async () => {
        const res = await makeRequest(server);
        // legacyHeaders: false means no X-RateLimit-* headers
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
        done();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Request logging
  // ---------------------------------------------------------------------------

  describe('request logging', () => {
    let server: http.Server;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    afterEach((done) => {
      if (server?.listening) {
        server.close(done);
      } else {
        done();
      }
    });

    it('should log API requests with method, url, status, and duration', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const logger = createMockLogger();
      const app = createTestApp(logger);
      server = app.listen(0, async () => {
        await makeRequest(server);

        // Wait a tick for the 'finish' event handler to fire
        setTimeout(() => {
          expect(logger.info).toHaveBeenCalledWith(
            'API Request',
            expect.objectContaining({
              method: 'GET',
              url: '/test',
              status: 200,
              duration: expect.any(Number),
              ip: expect.any(String),
            })
          );
          done();
        }, 50);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // JSON parsing
  // ---------------------------------------------------------------------------

  describe('JSON body parsing', () => {
    let server: http.Server;

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    afterEach((done) => {
      if (server?.listening) {
        server.close(done);
      } else {
        done();
      }
    });

    it('should reject payloads exceeding 1mb limit', (done) => {
      delete process.env.ALLOWED_ORIGINS;
      const logger = createMockLogger();
      const app = express();
      configureMiddleware(app, logger);
      app.post('/test', (req: Request, res: Response) => {
        res.json({ received: true });
      });

      server = app.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          done(new Error('Server not listening'));
          return;
        }

        // Create a payload slightly over 1MB
        const largeBody = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) });

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: '/test',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(largeBody).toString(),
            },
          },
          (res) => {
            expect(res.statusCode).toBe(413);
            done();
          }
        );
        req.on('error', done);
        req.write(largeBody);
        req.end();
      });
    });
  });
});

// =============================================================================
// Dashboard auth production guard (C4 fix)
// =============================================================================

describe('createDashboardRoutes — production guard (C4)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should throw when NODE_ENV=production and DASHBOARD_AUTH_TOKEN is not set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_AUTH_TOKEN;

    // Import inline to pick up env changes
    const { createDashboardRoutes } = require('../../../src/api/routes/dashboard.routes');
    const mockState = {
      getIsLeader: () => true,
      getSystemMetrics: () => ({}),
      getServiceHealthMap: () => new Map(),
      getInstanceId: () => 'test',
    };

    expect(() => createDashboardRoutes(mockState)).toThrow(
      'DASHBOARD_AUTH_TOKEN is required in production'
    );
  });

  it('should NOT throw when NODE_ENV=production and DASHBOARD_AUTH_TOKEN is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_AUTH_TOKEN = 'test-secret-token';

    const { createDashboardRoutes } = require('../../../src/api/routes/dashboard.routes');
    const mockState = {
      getIsLeader: () => true,
      getSystemMetrics: () => ({}),
      getServiceHealthMap: () => new Map(),
      getInstanceId: () => 'test',
    };

    expect(() => createDashboardRoutes(mockState)).not.toThrow();
  });

  it('should NOT throw in development without DASHBOARD_AUTH_TOKEN', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DASHBOARD_AUTH_TOKEN;

    const { createDashboardRoutes } = require('../../../src/api/routes/dashboard.routes');
    const mockState = {
      getIsLeader: () => true,
      getSystemMetrics: () => ({}),
      getServiceHealthMap: () => new Map(),
      getInstanceId: () => 'test',
    };

    expect(() => createDashboardRoutes(mockState)).not.toThrow();
  });

  it('should NOT throw in test without DASHBOARD_AUTH_TOKEN', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DASHBOARD_AUTH_TOKEN;

    const { createDashboardRoutes } = require('../../../src/api/routes/dashboard.routes');
    const mockState = {
      getIsLeader: () => true,
      getSystemMetrics: () => ({}),
      getServiceHealthMap: () => new Map(),
      getInstanceId: () => 'test',
    };

    expect(() => createDashboardRoutes(mockState)).not.toThrow();
  });
});

/**
 * Proxy Routes Unit Tests (H-02)
 *
 * Tests for proxyToEE() via the /ee/health and /circuit-breaker endpoints:
 * - Happy path: successful proxy to execution engine
 * - Error path 1: Execution engine unreachable (ECONNREFUSED)
 * - Error path 2: Execution engine timeout (5s)
 * - Error path 3: Response too large (>1MB)
 * - Error path 4: Invalid JSON response
 * - Error path 5: Connection lost mid-response (ECONNRESET)
 * - M-03: NaN guard for EXECUTION_ENGINE_PORT
 *
 * Uses direct route handler invocation (not supertest) to avoid
 * http.request spy conflicts with supertest internals.
 *
 * @see services/coordinator/src/api/routes/index.ts (proxyToEE, setupAllRoutes)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';
import type { CoordinatorStateProvider, SystemMetrics } from '../../../../src/api/types';

// =============================================================================
// Mocks
// =============================================================================

// Mock route factories that setupAllRoutes imports (we only test proxy routes)
jest.mock('../../../../src/api/routes/health.routes', () => ({
  createHealthRoutes: jest.fn(() => require('express').Router()),
}));
jest.mock('../../../../src/api/routes/metrics.routes', () => ({
  createMetricsRoutes: jest.fn(() => require('express').Router()),
}));
jest.mock('../../../../src/api/routes/dashboard.routes', () => ({
  createDashboardRoutes: jest.fn(() => require('express').Router()),
}));
jest.mock('../../../../src/api/routes/admin.routes', () => ({
  createAdminRoutes: jest.fn(() => require('express').Router()),
}));
jest.mock('../../../../src/api/routes/sse.routes', () => ({
  createSSERoutes: jest.fn(() => require('express').Router()),
}));
jest.mock('@arbitrage/core/monitoring', () => ({
  getStreamHealthMonitor: jest.fn(() => ({
    getPrometheusMetrics: jest.fn(() => Promise.resolve('')),
    checkStreamHealth: jest.fn(() => Promise.resolve({ streams: {} })),
  })),
}));
jest.mock('@arbitrage/security', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    apiAuth: jest.fn(() => passthrough),
    apiAuthorize: jest.fn(() => passthrough),
  };
});

// =============================================================================
// Test Helpers
// =============================================================================

const DEFAULT_METRICS: SystemMetrics = {
  totalOpportunities: 100,
  totalExecutions: 50,
  successfulExecutions: 45,
  totalProfit: 1234.56,
  averageLatency: 15,
  averageMemory: 256,
  systemHealth: 95,
  activeServices: 5,
  lastUpdate: Date.now(),
  whaleAlerts: 10,
  pendingOpportunities: 5,
  totalSwapEvents: 1000,
  totalVolumeUsd: 500000,
  volumeAggregatesProcessed: 200,
  activePairsTracked: 50,
  priceUpdatesReceived: 5000,
  opportunitiesDropped: 0,
};

function createMockStateProvider(): CoordinatorStateProvider {
  return {
    getIsLeader: jest.fn(() => true),
    getIsRunning: jest.fn(() => true),
    getInstanceId: jest.fn(() => 'coordinator-test-123'),
    getLockKey: jest.fn(() => 'coordinator:leader:lock'),
    getSystemMetrics: jest.fn(() => ({ ...DEFAULT_METRICS })),
    getServiceHealthMap: jest.fn(() => new Map([
      ['partition-asia-fast', { status: 'healthy', lastSeen: Date.now() }],
    ])),
    getOpportunities: jest.fn(() => new Map()),
    getAlertCooldowns: jest.fn(() => new Map()),
    deleteAlertCooldown: jest.fn(() => true),
    getLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
    getAlertHistory: jest.fn(() => []),
    checkRedisConnectivity: jest.fn(async () => true),
    subscribeSSE: jest.fn(() => () => {}),
    getCircuitBreakerSnapshot: jest.fn(() => ({
      state: 'CLOSED' as const,
      consecutiveFailures: 0,
      lastFailureTime: null,
      cooldownRemainingMs: 0,
      timestamp: Date.now(),
    })),
  };
}

/** Mock IncomingMessage (proxy response) backed by EventEmitter */
class MockProxyResponse extends EventEmitter {
  statusCode: number;
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
}

/** Mock ClientRequest (outgoing proxy request) backed by EventEmitter */
class MockProxyRequest extends EventEmitter {
  destroyed = false;
  writtenData: string[] = [];

  write(data: string) { this.writtenData.push(data); return true; }
  end() { /* noop */ }
  destroy() { this.destroyed = true; }
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  const { setupAllRoutes } = require('../../../../src/api/routes/index');
  setupAllRoutes(app, createMockStateProvider());
  return app;
}

/**
 * Helper: makes a request via supertest, while http.request is spied
 * to intercept the OUTBOUND proxy call to EE.
 *
 * Returns the supertest response plus the mock proxy objects.
 */
async function proxyRequest(
  app: express.Application,
  method: 'get' | 'post',
  path: string,
  mockBehavior: (mockReq: MockProxyRequest, mockRes: MockProxyResponse) => void,
  options?: { headers?: Record<string, string> },
): Promise<supertest.Response> {
  const mockReq = new MockProxyRequest();
  const mockRes = new MockProxyResponse(200);
  let capturedOptions: any;

  // Spy on http.request — but let the original through for non-proxy calls
  const originalRequest = http.request.bind(http);
  const spy = jest.spyOn(http, 'request').mockImplementation((...args: any[]) => {
    // Check if this is a proxy call (has hostname/port in options object)
    const opts = args[0];
    if (opts && typeof opts === 'object' && opts.hostname) {
      // This is the proxy call to EE
      capturedOptions = opts;
      const callback = typeof args[1] === 'function' ? args[1] : undefined;
      if (callback) {
        process.nextTick(() => callback(mockRes));
      }
      // Trigger mock behavior asynchronously
      process.nextTick(() => mockBehavior(mockReq, mockRes));
      return mockReq as any;
    }
    // Not a proxy call — pass through to real http.request
    return originalRequest(...args);
  });

  try {
    let req = method === 'get'
      ? supertest(app).get(path)
      : supertest(app).post(path).send({});

    if (options?.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        req = req.set(k, v);
      }
    }

    const res = await req;
    return Object.assign(res, { capturedOptions });
  } finally {
    spy.mockRestore();
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Proxy Routes (proxyToEE)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Happy Path
  // ===========================================================================

  describe('successful proxy', () => {
    it('should proxy GET /ee/health to execution engine /health', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        const data = JSON.stringify({ status: 'healthy', simulationMode: true });
        mockRes.emit('data', Buffer.from(data));
        mockRes.emit('end');
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'healthy', simulationMode: true });
    });

    it('should proxy GET /circuit-breaker to execution engine', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/circuit-breaker', (_mockReq, mockRes) => {
        const data = JSON.stringify({ state: 'CLOSED', failures: 0 });
        mockRes.emit('data', Buffer.from(data));
        mockRes.emit('end');
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'CLOSED', failures: 0 });
    });

    it('should forward EE status code', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        mockRes.statusCode = 503;
        const data = JSON.stringify({ error: 'service unavailable' });
        mockRes.emit('data', Buffer.from(data));
        mockRes.emit('end');
      });

      expect(res.status).toBe(503);
    });
  });

  // ===========================================================================
  // Error Path 1: Execution engine unreachable
  // ===========================================================================

  describe('EE unreachable', () => {
    it('should return 503 when execution engine is unreachable', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (mockReq) => {
        mockReq.emit('error', new Error('ECONNREFUSED'));
      });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Execution engine unreachable' });
    });
  });

  // ===========================================================================
  // Error Path 2: Timeout
  // ===========================================================================

  describe('EE timeout', () => {
    it('should return 504 when execution engine times out', async () => {
      const app = createApp();
      let capturedMockReq: MockProxyRequest | null = null;

      const res = await proxyRequest(app, 'get', '/ee/health', (mockReq) => {
        capturedMockReq = mockReq;
        mockReq.emit('timeout');
      });

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: 'Execution engine timeout' });
      expect(capturedMockReq!.destroyed).toBe(true);
    });
  });

  // ===========================================================================
  // Error Path 3: Response too large
  // ===========================================================================

  describe('EE response too large', () => {
    it('should return 502 when response exceeds 1MB', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        // Send >1MB of data
        const bigChunk = Buffer.alloc(512 * 1024, 'x');
        mockRes.emit('data', bigChunk);
        mockRes.emit('data', bigChunk);       // 1MB total
        mockRes.emit('data', Buffer.from('x')); // push over limit
        mockRes.emit('end');
      });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Execution engine response too large' });
    });
  });

  // ===========================================================================
  // Error Path 4: Invalid JSON response
  // ===========================================================================

  describe('EE invalid JSON', () => {
    it('should return 502 when EE returns non-JSON response', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        mockRes.emit('data', Buffer.from('this is not valid JSON'));
        mockRes.emit('end');
      });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Invalid response from execution engine' });
    });
  });

  // ===========================================================================
  // Error Path 5: Connection lost mid-response
  // ===========================================================================

  describe('EE connection lost', () => {
    it('should return 502 when connection drops mid-response', async () => {
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        mockRes.emit('data', Buffer.from('{"partial":'));
        mockRes.emit('error', new Error('ECONNRESET'));
        mockRes.emit('end');
      });

      // Either 502 from proxyRes error or from JSON parse failure
      expect(res.status).toBe(502);
    });
  });

  // ===========================================================================
  // Request Forwarding
  // ===========================================================================

  describe('request forwarding', () => {
    it('should forward X-API-Key header to execution engine', async () => {
      const app = createApp();

      const res = await proxyRequest(
        app, 'get', '/ee/health',
        (_mockReq, mockRes) => {
          mockRes.emit('data', Buffer.from(JSON.stringify({ ok: true })));
          mockRes.emit('end');
        },
        { headers: { 'X-API-Key': 'test-api-key-123' } },
      );

      expect(res.status).toBe(200);
      expect((res as any).capturedOptions.headers['x-api-key']).toBe('test-api-key-123');
    });
  });

  // ===========================================================================
  // M-03: NaN guard for EXECUTION_ENGINE_PORT
  // ===========================================================================

  describe('EXECUTION_ENGINE_PORT validation', () => {
    it('should throw on non-numeric EXECUTION_ENGINE_PORT', () => {
      process.env.EXECUTION_ENGINE_PORT = 'not-a-number';

      expect(() => createApp()).toThrow("Invalid EXECUTION_ENGINE_PORT: 'not-a-number'");
    });

    it('should use default port 3005 when env var is unset', async () => {
      delete process.env.EXECUTION_ENGINE_PORT;
      const app = createApp();

      const res = await proxyRequest(app, 'get', '/ee/health', (_mockReq, mockRes) => {
        mockRes.emit('data', Buffer.from(JSON.stringify({ ok: true })));
        mockRes.emit('end');
      });

      expect(res.status).toBe(200);
      expect((res as any).capturedOptions.port).toBe(3005);
    });
  });

  // ===========================================================================
  // M-05: POST circuit-breaker auth tests
  // ===========================================================================

  describe('POST /circuit-breaker auth middleware', () => {
    it('should return 401 when unauthenticated (apiAuth rejects)', async () => {
      // Override apiAuth to return a middleware that sends 401
      const security = require('@arbitrage/security');
      (security.apiAuth as jest.Mock).mockReturnValue(
        (_req: any, res: any, _next: any) => res.status(401).json({ error: 'Unauthorized' }),
      );

      const app = createApp();

      const openRes = await supertest(app)
        .post('/circuit-breaker/open')
        .send({});
      expect(openRes.status).toBe(401);
      expect(openRes.body).toEqual({ error: 'Unauthorized' });

      const closeRes = await supertest(app)
        .post('/circuit-breaker/close')
        .send({});
      expect(closeRes.status).toBe(401);
      expect(closeRes.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 403 when authenticated but unauthorized (apiAuthorize rejects)', async () => {
      // apiAuth passes, but apiAuthorize rejects with 403
      const security = require('@arbitrage/security');
      const passthrough = (_req: any, _res: any, next: any) => next();
      (security.apiAuth as jest.Mock).mockReturnValue(passthrough);
      (security.apiAuthorize as jest.Mock).mockReturnValue(
        (_req: any, res: any, _next: any) => res.status(403).json({ error: 'Forbidden' }),
      );

      const app = createApp();

      const openRes = await supertest(app)
        .post('/circuit-breaker/open')
        .send({});
      expect(openRes.status).toBe(403);
      expect(openRes.body).toEqual({ error: 'Forbidden' });

      const closeRes = await supertest(app)
        .post('/circuit-breaker/close')
        .send({});
      expect(closeRes.status).toBe(403);
      expect(closeRes.body).toEqual({ error: 'Forbidden' });
    });

    it('should proxy through when authenticated and authorized', async () => {
      // Both auth middlewares pass through (default mock behavior)
      const security = require('@arbitrage/security');
      const passthrough = (_req: any, _res: any, next: any) => next();
      (security.apiAuth as jest.Mock).mockReturnValue(passthrough);
      (security.apiAuthorize as jest.Mock).mockReturnValue(passthrough);

      const app = createApp();

      const res = await proxyRequest(app, 'post', '/circuit-breaker/open', (_mockReq, mockRes) => {
        mockRes.emit('data', Buffer.from(JSON.stringify({ state: 'OPEN' })));
        mockRes.emit('end');
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'OPEN' });
    });

    it('should NOT require auth for GET /circuit-breaker (read-only)', async () => {
      // Even with apiAuth returning 401, GET should still work (no auth middleware)
      const security = require('@arbitrage/security');
      (security.apiAuth as jest.Mock).mockReturnValue(
        (_req: any, res: any, _next: any) => res.status(401).json({ error: 'Unauthorized' }),
      );

      const app = createApp();

      const res = await proxyRequest(app, 'get', '/circuit-breaker', (_mockReq, mockRes) => {
        mockRes.emit('data', Buffer.from(JSON.stringify({ state: 'CLOSED' })));
        mockRes.emit('end');
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'CLOSED' });
    });
  });
});

/**
 * SSE Routes Unit Tests (H-02)
 *
 * Tests for the Server-Sent Events endpoint:
 * - Authentication enforcement (token required, timing-safe compare)
 * - Connection limit (MAX_SSE_CONNECTIONS = 50)
 * - Initial state push (metrics, services, circuit-breaker)
 * - Cleanup on disconnect (intervals cleared, counter decremented)
 * - Production auth guard (H-01)
 *
 * @see services/coordinator/src/api/routes/sse.routes.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import type { CoordinatorStateProvider, SystemMetrics } from '../../../../src/api/types';

// =============================================================================
// Mock: @arbitrage/core/monitoring (stream health monitor)
// =============================================================================

jest.mock('@arbitrage/core/monitoring', () => ({
  getStreamHealthMonitor: jest.fn(() => ({
    checkStreamHealth: jest.fn(() => Promise.resolve({ streams: {} })),
  })),
}));

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

const CB_SNAPSHOT = {
  state: 'CLOSED' as const,
  consecutiveFailures: 0,
  lastFailureTime: null,
  cooldownRemainingMs: 0,
  timestamp: Date.now(),
};

function createMockStateProvider(overrides?: Partial<CoordinatorStateProvider>): CoordinatorStateProvider {
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
    subscribeSSE: jest.fn((listener) => {
      return () => { /* unsubscribe */ };
    }),
    getCircuitBreakerSnapshot: jest.fn(() => ({ ...CB_SNAPSHOT })),
    ...overrides,
  };
}

/** Creates a mock Express Request backed by EventEmitter (for 'close' event) */
function createMockReq(query: Record<string, string> = {}): EventEmitter & { query: Record<string, string>; method: string; headers: Record<string, string> } {
  const req = new EventEmitter() as EventEmitter & { query: Record<string, string>; method: string; headers: Record<string, string> };
  req.query = query;
  req.method = 'GET';
  req.headers = {};
  return req;
}

/** Creates a mock Express Response that captures SSE writes */
function createMockRes(): {
  status: jest.Mock;
  json: jest.Mock;
  writeHead: jest.Mock;
  write: jest.Mock;
  writtenData: string[];
  statusCode: number;
} {
  const res: any = {
    writtenData: [] as string[],
    statusCode: 200,
    status: jest.fn(function (this: any, code: number) { this.statusCode = code; return this; }),
    json: jest.fn().mockReturnThis(),
    writeHead: jest.fn(),
    write: jest.fn(function (this: any, data: string) { this.writtenData.push(data); return true; }),
  };
  return res;
}

// =============================================================================
// Tests
// =============================================================================

describe('SSE Routes', () => {
  let mockState: CoordinatorStateProvider;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    mockState = createMockStateProvider();
    delete process.env.DASHBOARD_AUTH_TOKEN;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...originalEnv };
  });

  // Helper: import fresh module (resets module-level activeSSEConnections)
  function importSSERoutes() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../../src/api/routes/sse.routes') as typeof import('../../../../src/api/routes/sse.routes');
  }

  // Helper: get the route handler from the router
  function getEventsHandler(router: any): (req: any, res: any) => void {
    // Express Router stores routes in router.stack
    const layer = router.stack.find((l: any) => l.route?.path === '/events');
    return layer.route.stack[0].handle;
  }

  // ===========================================================================
  // H-01: Production Auth Guard
  // ===========================================================================

  describe('production auth guard', () => {
    it('should throw if DASHBOARD_AUTH_TOKEN is unset in production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DASHBOARD_AUTH_TOKEN;

      const { createSSERoutes } = importSSERoutes();
      expect(() => createSSERoutes(mockState)).toThrow('DASHBOARD_AUTH_TOKEN is required in production');
    });

    it('should not throw if DASHBOARD_AUTH_TOKEN is set in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.DASHBOARD_AUTH_TOKEN = 'prod-secret-token';

      const { createSSERoutes } = importSSERoutes();
      expect(() => createSSERoutes(mockState)).not.toThrow();
    });

    it('should not throw in non-production even without token', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.DASHBOARD_AUTH_TOKEN;

      const { createSSERoutes } = importSSERoutes();
      expect(() => createSSERoutes(mockState)).not.toThrow();
    });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe('authentication', () => {
    it('should return 401 when token is required but missing', () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'my-secret-token';
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token required' });
    });

    it('should return 401 when token is invalid', () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'my-secret-token';
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({ token: 'wrong-token' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    });

    it('should accept valid token and establish SSE connection', () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'my-secret-token';
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({ token: 'my-secret-token' });
      const res = createMockRes();

      handler(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));
    });

    it('should allow connection without token when DASHBOARD_AUTH_TOKEN is unset', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));
    });
  });

  // ===========================================================================
  // Connection Limit
  // ===========================================================================

  describe('connection limit', () => {
    it('should return 503 when at maximum SSE connections', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      // Open 50 connections (the max)
      const connections: EventEmitter[] = [];
      for (let i = 0; i < 50; i++) {
        const req = createMockReq({});
        const res = createMockRes();
        handler(req, res);
        connections.push(req);
      }

      // 51st connection should be rejected
      const req51 = createMockReq({});
      const res51 = createMockRes();
      handler(req51, res51);

      expect(res51.status).toHaveBeenCalledWith(503);
      expect(res51.json).toHaveBeenCalledWith({ error: 'Too many SSE connections' });

      // Cleanup: close all connections
      for (const req of connections) {
        req.emit('close');
      }
    });

    it('should allow new connections after existing ones disconnect', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      // Open 50 connections
      const connections: EventEmitter[] = [];
      for (let i = 0; i < 50; i++) {
        const req = createMockReq({});
        const res = createMockRes();
        handler(req, res);
        connections.push(req);
      }

      // Disconnect one
      connections[0].emit('close');

      // New connection should succeed
      const reqNew = createMockReq({});
      const resNew = createMockRes();
      handler(reqNew, resNew);

      expect(resNew.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));

      // Cleanup
      for (let i = 1; i < connections.length; i++) {
        connections[i].emit('close');
      }
      reqNew.emit('close');
    });
  });

  // ===========================================================================
  // Initial State Push
  // ===========================================================================

  describe('initial state', () => {
    it('should send metrics, services, and circuit-breaker on connect', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      // Should have sent 3 initial events
      expect(res.write).toHaveBeenCalledTimes(3);

      // Verify SSE format: "id: N\nevent: type\ndata: json\n\n"
      const events = res.writtenData;
      expect(events[0]).toMatch(/^id: 1\nevent: metrics\ndata: /);
      expect(events[1]).toMatch(/^id: 2\nevent: services\ndata: /);
      expect(events[2]).toMatch(/^id: 3\nevent: circuit-breaker\ndata: /);

      // Verify data is valid JSON
      const metricsData = JSON.parse(events[0].split('data: ')[1].trim());
      expect(metricsData.systemHealth).toBe(95);
      expect(metricsData.totalOpportunities).toBe(100);

      // Cleanup
      req.emit('close');
    });

    it('should subscribe to SSE events from state provider', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      expect(mockState.subscribeSSE).toHaveBeenCalledWith(expect.any(Function));

      // Cleanup
      req.emit('close');
    });

    it('should forward SSE subscription events to client', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      let capturedListener: ((event: string, data: unknown) => void) | null = null;
      const state = createMockStateProvider({
        subscribeSSE: jest.fn((listener) => {
          capturedListener = listener;
          return () => {};
        }),
      });
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(state);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      // 3 initial events sent
      expect(res.write).toHaveBeenCalledTimes(3);

      // Push a real-time event through the subscription
      capturedListener!('execution-result', { opportunityId: 'opp-1', success: true });

      expect(res.write).toHaveBeenCalledTimes(4);
      expect(res.writtenData[3]).toContain('event: execution-result');
      expect(res.writtenData[3]).toContain('"opportunityId":"opp-1"');

      // Cleanup
      req.emit('close');
    });
  });

  // ===========================================================================
  // Periodic Pushes
  // ===========================================================================

  describe('periodic pushes', () => {
    it('should push metrics every 2s', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);
      const initialWrites = res.write.mock.calls.length; // 3 initial

      jest.advanceTimersByTime(2000);
      expect(res.write.mock.calls.length).toBe(initialWrites + 1);
      expect(res.writtenData[initialWrites]).toContain('event: metrics');

      jest.advanceTimersByTime(2000);
      expect(res.write.mock.calls.length).toBe(initialWrites + 2);

      // Cleanup
      req.emit('close');
    });

    it('should send keepalive comment every 15s', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      jest.advanceTimersByTime(15000);

      const lastWrite = res.writtenData[res.writtenData.length - 1];
      expect(lastWrite).toBe(': keepalive\n\n');

      // Cleanup
      req.emit('close');
    });
  });

  // ===========================================================================
  // Cleanup on Disconnect
  // ===========================================================================

  describe('cleanup on disconnect', () => {
    it('should call unsubscribe when client disconnects', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const unsubscribe = jest.fn();
      const state = createMockStateProvider({
        subscribeSSE: jest.fn(() => unsubscribe),
      });
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(state);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);
      expect(unsubscribe).not.toHaveBeenCalled();

      req.emit('close');
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('should stop periodic pushes after disconnect', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);
      const initialWrites = res.write.mock.calls.length;

      // Disconnect
      req.emit('close');

      // Advance timers — no new writes should happen
      jest.advanceTimersByTime(30000);
      expect(res.write.mock.calls.length).toBe(initialWrites);
    });
  });

  // ===========================================================================
  // SSE Message Format
  // ===========================================================================

  describe('message format', () => {
    it('should use monotonically increasing message IDs', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      // Extract IDs from all written events
      const ids = res.writtenData
        .filter((d: string) => d.startsWith('id: '))
        .map((d: string) => parseInt(d.match(/^id: (\d+)/)![1], 10));

      expect(ids).toEqual([1, 2, 3]);
      // Verify monotonically increasing
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }

      // Cleanup
      req.emit('close');
    });

    it('should use correct SSE format with double newline terminator', () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const { createSSERoutes } = importSSERoutes();
      const router = createSSERoutes(mockState);
      const handler = getEventsHandler(router);

      const req = createMockReq({});
      const res = createMockRes();

      handler(req, res);

      for (const event of res.writtenData) {
        // Each event block must end with \n\n
        expect(event).toMatch(/\n\n$/);
      }

      // Cleanup
      req.emit('close');
    });
  });
});

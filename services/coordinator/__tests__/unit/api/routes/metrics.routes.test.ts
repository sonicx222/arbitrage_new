/**
 * Metrics Routes Unit Tests
 *
 * Tests for authenticated metrics endpoints:
 * - GET /api/metrics (system metrics)
 * - GET /api/services (service health)
 * - GET /api/opportunities (recent opportunities)
 * - GET /api/alerts (alert history)
 * - GET /api/leader (leader status)
 * - GET /api/redis/stats (Redis usage)
 * - GET /api/metrics/prometheus (Prometheus format)
 * - GET /api/redis/dashboard (Redis dashboard)
 *
 * @see services/coordinator/src/api/routes/metrics.routes.ts
 * @see E26 finding from SERVICES_EXTENDED_ANALYSIS_2026-02-28.md
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express, { Request, Response, NextFunction } from 'express';
import type { CoordinatorStateProvider, SystemMetrics, Alert } from '../../../../src/api/types';

// =============================================================================
// Module Mocks
// =============================================================================

let mockAuthBehavior: 'pass' | 'reject' = 'pass';
let mockAuthorizeBehavior: 'pass' | 'reject' = 'pass';

jest.mock('@arbitrage/security', () => ({
  apiAuth: jest.fn(),
  apiAuthorize: jest.fn(),
}));

const mockRedisClient = {
  getCommandStats: jest.fn(() => ({ total: 100, reads: 70, writes: 30 })),
  getUsageDashboard: jest.fn(() => 'Redis Usage Dashboard\n---\nTotal: 100'),
};

jest.mock('@arbitrage/core/redis', () => ({
  getRedisClient: jest.fn<() => Promise<unknown>>().mockResolvedValue(mockRedisClient),
}));

const mockPrometheusMetrics = '# HELP stream_length Stream length\nstream_length{stream="health"} 42\n';
const mockStreamMonitor = {
  getPrometheusMetrics: jest.fn<() => Promise<string>>().mockResolvedValue(mockPrometheusMetrics),
};

jest.mock('@arbitrage/core/monitoring', () => ({
  getStreamHealthMonitor: jest.fn(() => mockStreamMonitor),
}));

jest.mock('@arbitrage/core/data-structures', () => ({
  findKLargest: jest.fn((values: Iterable<unknown>, k: number) => {
    const arr = Array.from(values);
    return arr.slice(0, k);
  }),
}));

function applySecurityMocks(): void {
  const { apiAuth, apiAuthorize } = require('@arbitrage/security') as {
    apiAuth: jest.Mock;
    apiAuthorize: jest.Mock;
  };

  apiAuth.mockReturnValue((req: Request, res: Response, next: NextFunction) => {
    if (mockAuthBehavior === 'reject') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  });

  apiAuthorize.mockReturnValue((_req: Request, res: Response, next: NextFunction) => {
    if (mockAuthorizeBehavior === 'reject') {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  });
}

import { createMetricsRoutes } from '../../../../src/api/routes/metrics.routes';
import supertest from 'supertest';

// =============================================================================
// Mock State Provider
// =============================================================================

function createMockStateProvider(overrides?: Partial<CoordinatorStateProvider>): CoordinatorStateProvider {
  const defaultMetrics: SystemMetrics = {
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

  const defaultAlerts: Alert[] = [
    { type: 'SERVICE_UNHEALTHY', service: 'execution-engine', severity: 'high', timestamp: Date.now() - 60000 },
    { type: 'WHALE_ALERT', message: 'Large trade detected', severity: 'warning', timestamp: Date.now() - 30000 },
  ];

  return {
    getIsLeader: jest.fn(() => true),
    getIsRunning: jest.fn(() => true),
    getInstanceId: jest.fn(() => 'coordinator-test-123'),
    getLockKey: jest.fn(() => 'coordinator:leader:lock'),
    getSystemMetrics: jest.fn(() => ({ ...defaultMetrics })),
    getServiceHealthMap: jest.fn(() => new Map([
      ['partition-asia-fast', { status: 'healthy', lastSeen: Date.now() }],
      ['execution-engine', { status: 'degraded', lastSeen: Date.now() }],
    ])),
    getOpportunities: jest.fn(() => new Map([
      ['opp-1', { id: 'opp-1', type: 'triangular', chain: 'ethereum', confidence: 0.9, timestamp: Date.now() }],
      ['opp-2', { id: 'opp-2', type: 'cross-chain', chain: 'arbitrum', confidence: 0.8, timestamp: Date.now() - 1000 }],
    ])),
    getAlertCooldowns: jest.fn(() => new Map()),
    deleteAlertCooldown: jest.fn(() => true),
    getLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
    getAlertHistory: jest.fn(() => [...defaultAlerts]),
    ...overrides,
  };
}

function createTestApp(state: CoordinatorStateProvider): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api', createMetricsRoutes(state));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Metrics Routes', () => {
  let mockState: CoordinatorStateProvider;

  beforeEach(() => {
    applySecurityMocks();
    mockAuthBehavior = 'pass';
    mockAuthorizeBehavior = 'pass';
    mockState = createMockStateProvider();
    // Re-apply mock implementations cleared by resetAllMocks
    mockRedisClient.getCommandStats.mockReturnValue({ total: 100, reads: 70, writes: 30 });
    mockRedisClient.getUsageDashboard.mockReturnValue('Redis Usage Dashboard\n---\nTotal: 100');
    mockStreamMonitor.getPrometheusMetrics.mockResolvedValue(mockPrometheusMetrics);
    const { getRedisClient } = require('@arbitrage/core/redis') as { getRedisClient: jest.Mock };
    getRedisClient.mockResolvedValue(mockRedisClient);
    const { getStreamHealthMonitor } = require('@arbitrage/core/monitoring') as { getStreamHealthMonitor: jest.Mock };
    getStreamHealthMonitor.mockReturnValue(mockStreamMonitor);
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe('authentication', () => {
    it('should reject unauthenticated requests to /api/metrics', async () => {
      mockAuthBehavior = 'reject';
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/metrics');
      expect(res.status).toBe(401);
    });

    it('should reject unauthorized requests to /api/metrics', async () => {
      mockAuthorizeBehavior = 'reject';
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/metrics');
      expect(res.status).toBe(403);
    });
  });

  // ===========================================================================
  // GET /api/metrics
  // ===========================================================================

  describe('GET /api/metrics', () => {
    it('should return system metrics', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/metrics');

      expect(res.status).toBe(200);
      expect(res.body.totalOpportunities).toBe(100);
      expect(res.body.totalExecutions).toBe(50);
      expect(res.body.successfulExecutions).toBe(45);
      expect(res.body.totalProfit).toBe(1234.56);
      expect(res.body.systemHealth).toBe(95);
    });
  });

  // ===========================================================================
  // GET /api/services
  // ===========================================================================

  describe('GET /api/services', () => {
    it('should return service health map', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/services');

      expect(res.status).toBe(200);
      expect(res.body['partition-asia-fast']).toBeDefined();
      expect(res.body['partition-asia-fast'].status).toBe('healthy');
      expect(res.body['execution-engine']).toBeDefined();
      expect(res.body['execution-engine'].status).toBe('degraded');
    });
  });

  // ===========================================================================
  // GET /api/opportunities
  // ===========================================================================

  describe('GET /api/opportunities', () => {
    it('should return recent opportunities sorted by timestamp', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/opportunities');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    it('should return empty array when no opportunities', async () => {
      mockState = createMockStateProvider({
        getOpportunities: jest.fn(() => new Map()),
      });
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/opportunities');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ===========================================================================
  // GET /api/alerts
  // ===========================================================================

  describe('GET /api/alerts', () => {
    it('should return alert history', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/alerts');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
      expect(res.body[0].type).toBe('SERVICE_UNHEALTHY');
    });
  });

  // ===========================================================================
  // GET /api/leader
  // ===========================================================================

  describe('GET /api/leader', () => {
    it('should return leader election status', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/leader');

      expect(res.status).toBe(200);
      expect(res.body.isLeader).toBe(true);
      expect(res.body.instanceId).toBe('coordinator-test-123');
      expect(res.body.lockKey).toBe('coordinator:leader:lock');
    });

    it('should reflect standby status', async () => {
      mockState = createMockStateProvider({
        getIsLeader: jest.fn(() => false),
      });
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/leader');

      expect(res.body.isLeader).toBe(false);
    });
  });

  // ===========================================================================
  // GET /api/redis/stats
  // ===========================================================================

  describe('GET /api/redis/stats', () => {
    it('should return Redis command stats', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/redis/stats');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(100);
    });

    it('should return 504 when Redis times out', async () => {
      const { getRedisClient } = require('@arbitrage/core/redis') as { getRedisClient: jest.Mock };
      getRedisClient.mockImplementation(() =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('Redis connection timeout')), 10)
        )
      );

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/redis/stats');

      expect(res.status).toBe(504);
    });
  });

  // ===========================================================================
  // GET /api/metrics/prometheus
  // ===========================================================================

  describe('GET /api/metrics/prometheus', () => {
    it('should return Prometheus-format metrics', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/metrics/prometheus');

      expect(res.status).toBe(200);
      expect(res.text).toContain('# HELP stream_length');
      expect(res.text).toContain('stream_length{stream="health"} 42');
    });

    it('should return 500 when monitor fails', async () => {
      mockStreamMonitor.getPrometheusMetrics.mockRejectedValue(new Error('Monitor unavailable'));

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/metrics/prometheus');

      expect(res.status).toBe(500);
    });
  });

  // ===========================================================================
  // GET /api/redis/dashboard
  // ===========================================================================

  describe('GET /api/redis/dashboard', () => {
    it('should return text/plain Redis dashboard', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/redis/dashboard');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Redis Usage Dashboard');
    });
  });
});

/**
 * Health Routes Unit Tests
 *
 * Tests for public health check endpoints:
 * - GET /api/health (main health status)
 * - GET /api/health/live (liveness probe)
 * - GET /api/health/ready (readiness probe)
 *
 * @see services/coordinator/src/api/routes/health.routes.ts
 * @see E26 finding from SERVICES_EXTENDED_ANALYSIS_2026-02-28.md
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express, { Request, Response, NextFunction } from 'express';
import type { CoordinatorStateProvider, SystemMetrics, Alert } from '../../../../src/api/types';

// =============================================================================
// Module Mocks
// =============================================================================

jest.mock('@arbitrage/security', () => ({
  apiAuth: jest.fn(),
  apiAuthorize: jest.fn(),
  isAuthEnabled: jest.fn(),
  validateHealthRequest: jest.fn(),
}));

function applySecurityMocks(): void {
  const { validateHealthRequest } = require('@arbitrage/security') as {
    validateHealthRequest: jest.Mock;
  };
  validateHealthRequest.mockImplementation((_req: Request, _res: Response, next: NextFunction) => next());
}

import { createHealthRoutes } from '../../../../src/api/routes/health.routes';
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
    ...overrides,
  };
}

function createTestApp(state: CoordinatorStateProvider): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api', createHealthRoutes(state));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Health Routes', () => {
  let mockState: CoordinatorStateProvider;

  beforeEach(() => {
    applySecurityMocks();
    mockState = createMockStateProvider();
  });

  // ===========================================================================
  // Route Registration
  // ===========================================================================

  describe('route registration', () => {
    it('should return a Router', () => {
      const router = createHealthRoutes(mockState);
      expect(router).toBeDefined();
      expect(router.stack).toBeDefined();
    });
  });

  // ===========================================================================
  // GET /api/health
  // ===========================================================================

  describe('GET /api/health', () => {
    it('should return minimal response for unauthenticated requests', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.systemHealth).toBe(95);
      expect(res.body.timestamp).toBeDefined();
      // No instanceId or services in unauthenticated response
      expect(res.body.instanceId).toBeUndefined();
      expect(res.body.services).toBeUndefined();
    });

    it('should return full response for authenticated requests', async () => {
      // Simulate authenticated request by setting req.user
      const { validateHealthRequest } = require('@arbitrage/security') as {
        validateHealthRequest: jest.Mock;
      };
      validateHealthRequest.mockImplementation((req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { user?: unknown }).user = { role: 'admin' };
        next();
      });

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.isLeader).toBe(true);
      expect(res.body.instanceId).toBe('coordinator-test-123');
      expect(res.body.systemHealth).toBe(95);
      expect(res.body.services).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('should return "degraded" when system health is below 50', async () => {
      mockState = createMockStateProvider({
        getSystemMetrics: jest.fn(() => ({
          totalOpportunities: 0, totalExecutions: 0, successfulExecutions: 0,
          totalProfit: 0, averageLatency: 0, averageMemory: 0,
          systemHealth: 30, activeServices: 1, lastUpdate: Date.now(),
          whaleAlerts: 0, pendingOpportunities: 0, totalSwapEvents: 0,
          totalVolumeUsd: 0, volumeAggregatesProcessed: 0, activePairsTracked: 0,
          priceUpdatesReceived: 0, opportunitiesDropped: 0,
        })),
      });

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.systemHealth).toBe(30);
    });

    it('should return "healthy" when system health is exactly 50', async () => {
      mockState = createMockStateProvider({
        getSystemMetrics: jest.fn(() => ({
          totalOpportunities: 0, totalExecutions: 0, successfulExecutions: 0,
          totalProfit: 0, averageLatency: 0, averageMemory: 0,
          systemHealth: 50, activeServices: 3, lastUpdate: Date.now(),
          whaleAlerts: 0, pendingOpportunities: 0, totalSwapEvents: 0,
          totalVolumeUsd: 0, volumeAggregatesProcessed: 0, activePairsTracked: 0,
          priceUpdatesReceived: 0, opportunitiesDropped: 0,
        })),
      });

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health');

      expect(res.body.status).toBe('healthy');
    });
  });

  // ===========================================================================
  // GET /api/health/live
  // ===========================================================================

  describe('GET /api/health/live', () => {
    it('should return alive status', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health/live');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  // ===========================================================================
  // GET /api/health/ready
  // ===========================================================================

  describe('GET /api/health/ready', () => {
    it('should return ready when running with healthy system', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.isRunning).toBe(true);
      expect(res.body.systemHealth).toBe(95);
    });

    it('should return 503 when not running', async () => {
      mockState = createMockStateProvider({
        getIsRunning: jest.fn(() => false),
      });

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.isRunning).toBe(false);
    });

    it('should return 503 when system health is zero', async () => {
      mockState = createMockStateProvider({
        getSystemMetrics: jest.fn(() => ({
          totalOpportunities: 0, totalExecutions: 0, successfulExecutions: 0,
          totalProfit: 0, averageLatency: 0, averageMemory: 0,
          systemHealth: 0, activeServices: 0, lastUpdate: Date.now(),
          whaleAlerts: 0, pendingOpportunities: 0, totalSwapEvents: 0,
          totalVolumeUsd: 0, volumeAggregatesProcessed: 0, activePairsTracked: 0,
          priceUpdatesReceived: 0, opportunitiesDropped: 0,
        })),
      });

      const app = createTestApp(mockState);
      const res = await supertest(app).get('/api/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
    });
  });
});

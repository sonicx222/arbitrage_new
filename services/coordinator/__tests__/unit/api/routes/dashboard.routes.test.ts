/**
 * Dashboard Routes Unit Tests
 *
 * Tests for the HTML dashboard endpoint:
 * - GET / (main dashboard)
 * - Authentication enforcement (DASHBOARD_AUTH_TOKEN)
 * - Response caching behavior
 * - Production token requirement
 *
 * @see services/coordinator/src/api/routes/dashboard.routes.ts
 * @see E26 finding from SERVICES_EXTENDED_ANALYSIS_2026-02-28.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import type { CoordinatorStateProvider, SystemMetrics } from '../../../../src/api/types';
import { createDashboardRoutes } from '../../../../src/api/routes/dashboard.routes';
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
  app.use('/', createDashboardRoutes(state));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Dashboard Routes', () => {
  let mockState: CoordinatorStateProvider;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockState = createMockStateProvider();
    delete process.env.DASHBOARD_AUTH_TOKEN;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // GET / (Dashboard)
  // ===========================================================================

  describe('GET /', () => {
    it('should return HTML dashboard', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.status).toBe(200);
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain('Arbitrage System Dashboard');
    });

    it('should include system metrics in HTML', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).toContain('95.0%'); // systemHealth
      expect(res.text).toContain('5 services active'); // activeServices
      expect(res.text).toContain('$1234.56'); // totalProfit
    });

    it('should show LEADER badge when leader', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).toContain('LEADER');
    });

    it('should show STANDBY badge when not leader', async () => {
      mockState = createMockStateProvider({
        getIsLeader: jest.fn(() => false),
      });
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).toContain('STANDBY');
    });

    it('should include service health status', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).toContain('partition-asia-fast');
      expect(res.text).toContain('healthy');
    });

    it('should escape HTML in instance ID', async () => {
      mockState = createMockStateProvider({
        getInstanceId: jest.fn(() => '<script>alert("xss")</script>'),
      });
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).not.toContain('<script>alert("xss")</script>');
      expect(res.text).toContain('&lt;script&gt;');
    });

    it('should include auto-refresh script', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.text).toContain('setTimeout');
      expect(res.text).toContain('window.location.reload()');
    });
  });

  // ===========================================================================
  // Dashboard Authentication
  // ===========================================================================

  describe('authentication', () => {
    it('should allow unauthenticated access when no DASHBOARD_AUTH_TOKEN', async () => {
      const app = createTestApp(mockState);
      const res = await supertest(app).get('/');

      expect(res.status).toBe(200);
    });

    it('should require Bearer token when DASHBOARD_AUTH_TOKEN is set', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-secret-token';
      const app = createTestApp(mockState);

      const res = await supertest(app).get('/');
      expect(res.status).toBe(401);
    });

    it('should accept valid Bearer token', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-secret-token';
      const app = createTestApp(mockState);

      const res = await supertest(app)
        .get('/')
        .set('Authorization', 'Bearer test-secret-token');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Arbitrage System Dashboard');
    });

    it('should reject invalid Bearer token', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-secret-token';
      const app = createTestApp(mockState);

      const res = await supertest(app)
        .get('/')
        .set('Authorization', 'Bearer wrong-token-value');

      expect(res.status).toBe(401);
    });

    it('should reject non-Bearer auth header', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-secret-token';
      const app = createTestApp(mockState);

      const res = await supertest(app)
        .get('/')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // Production Token Requirement
  // ===========================================================================

  describe('production environment', () => {
    it('should throw when NODE_ENV=production and no DASHBOARD_AUTH_TOKEN', () => {
      process.env.NODE_ENV = 'production';
      expect(() => createDashboardRoutes(mockState)).toThrow('DASHBOARD_AUTH_TOKEN is required in production');
    });

    it('should not throw when NODE_ENV=production and DASHBOARD_AUTH_TOKEN is set', () => {
      process.env.NODE_ENV = 'production';
      process.env.DASHBOARD_AUTH_TOKEN = 'prod-secret';
      expect(() => createDashboardRoutes(mockState)).not.toThrow();
    });
  });
});

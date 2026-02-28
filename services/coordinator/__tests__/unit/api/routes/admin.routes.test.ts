/**
 * Admin Routes Unit Tests
 *
 * Comprehensive tests for security-sensitive admin endpoints:
 * - POST /services/:service/restart (leader-only, auth required)
 * - POST /alerts/:alert/acknowledge (auth required)
 *
 * Tests cover:
 * - Authentication enforcement (mocked apiAuth)
 * - Authorization enforcement (mocked apiAuthorize)
 * - Leader-only guards on service restart
 * - Input validation (service name, alert ID format and allowlist)
 * - Success and error response shapes
 * - Rate limiting middleware integration
 *
 * @see services/coordinator/src/api/routes/admin.routes.ts
 * @see E8 finding from SERVICES_EXTENDED_ANALYSIS_2026-02-28.md
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express, { Request, Response, NextFunction } from 'express';
import type { CoordinatorStateProvider, SystemMetrics, Alert } from '../../../../src/api/types';

// =============================================================================
// Mock Control Variables
// =============================================================================

/**
 * Controls whether the mocked apiAuth middleware calls next() (authenticated)
 * or returns 401 (unauthenticated). Override per-test to simulate auth failure.
 */
let mockAuthBehavior: 'pass' | 'reject' = 'pass';

/**
 * Controls whether the mocked apiAuthorize middleware calls next() (authorized)
 * or returns 403 (insufficient permissions). Override per-test to simulate authz failure.
 */
let mockAuthorizeBehavior: 'pass' | 'reject' = 'pass';

// =============================================================================
// Module Mocks (hoisted by Jest)
// =============================================================================

// Mock @arbitrage/security to control auth behavior per-test
jest.mock('@arbitrage/security', () => ({
  apiAuth: jest.fn(),
  apiAuthorize: jest.fn(),
  isAuthEnabled: jest.fn(),
  validateHealthRequest: jest.fn(),
}));

// Mock express-rate-limit to bypass rate limiting in unit tests
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: jest.fn(),
}));

/**
 * Re-apply mock implementations. Required because setupTests.ts calls
 * jest.resetAllMocks() in afterEach, which clears mockReturnValue set
 * in jest.mock() factory functions. Must be called in beforeEach.
 */
function applySecurityMocks(): void {
  const { apiAuth, apiAuthorize, isAuthEnabled, validateHealthRequest } =
    require('@arbitrage/security') as {
      apiAuth: jest.Mock;
      apiAuthorize: jest.Mock;
      isAuthEnabled: jest.Mock;
      validateHealthRequest: jest.Mock;
    };

  apiAuth.mockReturnValue((req: Request, res: Response, next: NextFunction) => {
    if (mockAuthBehavior === 'reject') {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Provide a valid API key (X-API-Key header) or JWT token (Authorization: Bearer)',
      });
      return;
    }
    next();
  });

  apiAuthorize.mockReturnValue((req: Request, res: Response, next: NextFunction) => {
    if (mockAuthorizeBehavior === 'reject') {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: 'write:services',
      });
      return;
    }
    next();
  });

  isAuthEnabled.mockReturnValue(false);
  validateHealthRequest.mockImplementation((_req: Request, _res: Response, next: NextFunction) => next());

  const rateLimit = require('express-rate-limit').default as jest.Mock;
  rateLimit.mockReturnValue((_req: Request, _res: Response, next: NextFunction) => next());
}

// Import the module under test AFTER mocks are established
import { createAdminRoutes } from '../../../../src/api/routes/admin.routes';
import { apiAuth, apiAuthorize } from '@arbitrage/security';
import supertest from 'supertest';

// =============================================================================
// Mock State Provider Factory
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

  const defaultAlertHistory: Alert[] = [
    { type: 'SERVICE_UNHEALTHY', service: 'partition-l2-turbo', severity: 'high', timestamp: Date.now() - 60000 },
  ];

  return {
    getIsLeader: jest.fn(() => true),
    getIsRunning: jest.fn(() => true),
    getInstanceId: jest.fn(() => 'coordinator-test-123'),
    getLockKey: jest.fn(() => 'coordinator:leader:lock'),
    getSystemMetrics: jest.fn(() => ({ ...defaultMetrics })),
    getServiceHealthMap: jest.fn(() => new Map()),
    getOpportunities: jest.fn(() => new Map()),
    getAlertCooldowns: jest.fn(() => new Map()),
    deleteAlertCooldown: jest.fn(() => true),
    getLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
    getAlertHistory: jest.fn(() => [...defaultAlertHistory]),
    ...overrides,
  };
}

/**
 * Creates a test Express app with admin routes mounted at /api.
 * JSON parsing is enabled so the route handlers can read req.body if needed.
 */
function createTestApp(state: CoordinatorStateProvider): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api', createAdminRoutes(state));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Admin Routes', () => {
  let mockState: CoordinatorStateProvider;

  beforeEach(() => {
    // Re-apply mock implementations (cleared by global resetAllMocks in afterEach)
    applySecurityMocks();
    // Reset mock behaviors to default (all pass)
    mockAuthBehavior = 'pass';
    mockAuthorizeBehavior = 'pass';
    mockState = createMockStateProvider();
  });

  // ===========================================================================
  // Route Registration
  // ===========================================================================

  describe('route registration', () => {
    it('should return a Router with registered routes', () => {
      const router = createAdminRoutes(mockState);
      expect(router).toBeDefined();
      expect(router.stack).toBeDefined();
    });

    it('should register POST /services/:service/restart route', () => {
      const router = createAdminRoutes(mockState);
      const routes = router.stack.filter((layer: any) => layer.route);
      const restartRoute = routes.find(
        (r: any) => r.route.path === '/services/:service/restart'
      ) as any;

      expect(restartRoute).toBeDefined();
      expect(restartRoute?.route?.methods?.post).toBe(true);
    });

    it('should register POST /alerts/:alert/acknowledge route', () => {
      const router = createAdminRoutes(mockState);
      const routes = router.stack.filter((layer: any) => layer.route);
      const acknowledgeRoute = routes.find(
        (r: any) => r.route.path === '/alerts/:alert/acknowledge'
      ) as any;

      expect(acknowledgeRoute).toBeDefined();
      expect(acknowledgeRoute?.route?.methods?.post).toBe(true);
    });

    it('should apply rate limiting middleware', () => {
      const rateLimit = require('express-rate-limit').default;
      createAdminRoutes(mockState);

      expect(rateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          windowMs: 15 * 60 * 1000,
          max: 5,
          message: expect.objectContaining({
            error: 'Too many control actions',
            retryAfter: 900,
          }),
        })
      );
    });

    it('should apply apiAuth middleware', () => {
      createAdminRoutes(mockState);
      expect(apiAuth).toHaveBeenCalled();
    });

    it('should apply apiAuthorize middleware with correct permissions', () => {
      createAdminRoutes(mockState);
      // Both routes call apiAuthorize with their respective resource/action
      expect(apiAuthorize).toHaveBeenCalledWith('services', 'write');
      expect(apiAuthorize).toHaveBeenCalledWith('alerts', 'write');
    });
  });

  // ===========================================================================
  // POST /services/:service/restart
  // ===========================================================================

  describe('POST /api/services/:service/restart', () => {
    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    describe('authentication', () => {
      it('should return 401 when authentication fails', async () => {
        mockAuthBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(401);

        expect(response.body.error).toBe('Authentication required');
      });

      it('should proceed past auth when authenticated', async () => {
        mockAuthBehavior = 'pass';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    describe('authorization', () => {
      it('should return 403 when authorization fails', async () => {
        mockAuthorizeBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(403);

        expect(response.body.error).toBe('Insufficient permissions');
      });
    });

    // -------------------------------------------------------------------------
    // Leader-Only Guard
    // -------------------------------------------------------------------------

    describe('leader-only guard', () => {
      it('should return 403 when coordinator is not the leader', async () => {
        mockState = createMockStateProvider({
          getIsLeader: jest.fn(() => false),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(403);

        expect(response.body.error).toBe('Only leader can restart services');
      });

      it('should allow restart when coordinator is the leader', async () => {
        // Default mock is leader=true
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Input Validation: Service Name Format
    // -------------------------------------------------------------------------

    describe('service name validation', () => {
      it('should return 400 for service name with special characters', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/service%20name!@%23/restart')
          .expect(400);

        expect(response.body.error).toBe('Invalid service name');
      });

      it('should return 400 for service name with dots', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/service.name/restart')
          .expect(400);

        expect(response.body.error).toBe('Invalid service name');
      });

      it('should return 400 for service name with slashes', async () => {
        const app = createTestApp(mockState);

        // URL-encoded forward slash
        const response = await supertest(app)
          .post('/api/services/a%2Fb/restart')
          .expect(400);

        expect(response.body.error).toBe('Invalid service name');
      });

      it('should return 400 for service name with spaces', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/my%20service/restart')
          .expect(400);

        expect(response.body.error).toBe('Invalid service name');
      });

      it('should accept service names with hyphens', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(200);

        expect(response.body.success).toBe(true);
      });

      it('should accept service names with underscores', async () => {
        // Underscores are valid per the regex but none of the ALLOWED_SERVICES use them
        // The regex allows [a-zA-Z0-9_-]+ but the allowlist check will reject unknown services
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/my_service/restart');

        // Valid format but not in allowlist -> 404
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Service not found');
      });
    });

    // -------------------------------------------------------------------------
    // Input Validation: ALLOWED_SERVICES Allowlist
    // -------------------------------------------------------------------------

    describe('service allowlist', () => {
      it('should return 404 for service not in ALLOWED_SERVICES', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/unknown-service/restart')
          .expect(404);

        expect(response.body.error).toBe('Service not found');
      });

      it('should accept partition services (ADR-003 partitioned architecture)', async () => {
        const app = createTestApp(mockState);

        const partitionServices = [
          'partition-asia-fast',
          'partition-l2-turbo',
          'partition-high-value',
          'partition-solana',
        ];

        for (const service of partitionServices) {
          const response = await supertest(app)
            .post(`/api/services/${service}/restart`)
            .expect(200);

          expect(response.body.success).toBe(true);
          expect(response.body.message).toBe(`Restart requested for ${service}`);
        }
      });

      it('should accept core services', async () => {
        const app = createTestApp(mockState);

        const coreServices = [
          'unified-detector',
          'cross-chain-detector',
          'execution-engine',
          'execution-engine-backup',
          'coordinator',
          'coordinator-standby',
        ];

        for (const service of coreServices) {
          const response = await supertest(app)
            .post(`/api/services/${service}/restart`)
            .expect(200);

          expect(response.body.success).toBe(true);
        }
      });

      it('should accept analysis layer services', async () => {
        const app = createTestApp(mockState);

        const analysisServices = [
          'ml-predictor',
          'volume-aggregator',
          'multi-leg-path-finder',
          'whale-activity-tracker',
          'liquidity-depth-analyzer',
        ];

        for (const service of analysisServices) {
          const response = await supertest(app)
            .post(`/api/services/${service}/restart`)
            .expect(200);

          expect(response.body.success).toBe(true);
        }
      });

      it('should accept decision layer services', async () => {
        const app = createTestApp(mockState);

        const decisionServices = [
          'opportunity-scorer',
          'mev-analyzer',
          'execution-planner',
        ];

        for (const service of decisionServices) {
          const response = await supertest(app)
            .post(`/api/services/${service}/restart`)
            .expect(200);

          expect(response.body.success).toBe(true);
        }
      });

      it('should accept legacy detector service names', async () => {
        const app = createTestApp(mockState);

        const legacyServices = [
          'bsc-detector',
          'ethereum-detector',
          'polygon-detector',
          'arbitrum-detector',
          'optimism-detector',
          'base-detector',
          'avalanche-detector',
          'fantom-detector',
          'zksync-detector',
          'linea-detector',
          'solana-detector',
        ];

        for (const service of legacyServices) {
          const response = await supertest(app)
            .post(`/api/services/${service}/restart`)
            .expect(200);

          expect(response.body.success).toBe(true);
        }
      });
    });

    // -------------------------------------------------------------------------
    // Success Response
    // -------------------------------------------------------------------------

    describe('success response', () => {
      it('should return JSON with success=true and message', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(200)
          .expect('Content-Type', /json/);

        expect(response.body).toEqual({
          success: true,
          message: 'Restart requested for execution-engine',
        });
      });

      it('should log the restart request', async () => {
        const mockLogger = {
          info: jest.fn(),
          error: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
        };
        mockState = createMockStateProvider({
          getLogger: jest.fn(() => mockLogger),
        });
        const app = createTestApp(mockState);

        await supertest(app)
          .post('/api/services/coordinator/restart')
          .expect(200);

        expect(mockLogger.info).toHaveBeenCalledWith('Restarting service: coordinator');
      });
    });

    // -------------------------------------------------------------------------
    // Error Handling: Internal Server Error
    // -------------------------------------------------------------------------

    describe('internal server error handling', () => {
      it('should return 500 when logger.info throws', async () => {
        const throwingLogger = {
          info: jest.fn(() => { throw new Error('Log write failed'); }),
          error: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
        };
        mockState = createMockStateProvider({
          getLogger: jest.fn(() => throwingLogger),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(500);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('Internal server error');
      });
    });

    // -------------------------------------------------------------------------
    // Middleware Ordering
    // -------------------------------------------------------------------------

    describe('middleware ordering', () => {
      it('should reject auth before checking leader status', async () => {
        // Auth rejects, but also not the leader
        mockAuthBehavior = 'reject';
        mockState = createMockStateProvider({
          getIsLeader: jest.fn(() => false),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(401);

        // Auth rejection takes priority over leader check
        expect(response.body.error).toBe('Authentication required');
        // getIsLeader should NOT have been called because auth was rejected first
        expect(mockState.getIsLeader).not.toHaveBeenCalled();
      });

      it('should reject authorization before checking leader status', async () => {
        mockAuthorizeBehavior = 'reject';
        mockState = createMockStateProvider({
          getIsLeader: jest.fn(() => false),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/services/execution-engine/restart')
          .expect(403);

        // Authorization rejection takes priority over leader check
        expect(response.body.error).toBe('Insufficient permissions');
        expect(mockState.getIsLeader).not.toHaveBeenCalled();
      });

      it('should validate service name format before checking allowlist', async () => {
        const app = createTestApp(mockState);

        // Invalid format (dots) should be caught by regex before allowlist check
        const response = await supertest(app)
          .post('/api/services/bad.name/restart')
          .expect(400);

        expect(response.body.error).toBe('Invalid service name');
      });

      it('should check allowlist before leader status', async () => {
        mockState = createMockStateProvider({
          getIsLeader: jest.fn(() => false),
        });
        const app = createTestApp(mockState);

        // Valid format but not in allowlist -> 404, not 403 (leader check)
        const response = await supertest(app)
          .post('/api/services/nonexistent-service/restart')
          .expect(404);

        expect(response.body.error).toBe('Service not found');
        // getIsLeader should NOT have been called because allowlist check failed first
        expect(mockState.getIsLeader).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // POST /alerts/:alert/acknowledge
  // ===========================================================================

  describe('POST /api/alerts/:alert/acknowledge', () => {
    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    describe('authentication', () => {
      it('should return 401 when authentication fails', async () => {
        mockAuthBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY_partition-l2-turbo/acknowledge')
          .expect(401);

        expect(response.body.error).toBe('Authentication required');
      });

      it('should proceed when authenticated', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY_partition-l2-turbo/acknowledge')
          .expect(200);

        expect(response.body).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    describe('authorization', () => {
      it('should return 403 when authorization fails', async () => {
        mockAuthorizeBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY/acknowledge')
          .expect(403);

        expect(response.body.error).toBe('Insufficient permissions');
      });
    });

    // -------------------------------------------------------------------------
    // Input Validation: Alert ID Format
    // -------------------------------------------------------------------------

    describe('alert ID validation', () => {
      it('should return 400 for alert ID with special characters', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/alert!@%23/acknowledge')
          .expect(400);

        expect(response.body.error).toBe('Invalid alert ID');
      });

      it('should return 400 for alert ID with dots', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/alert.id/acknowledge')
          .expect(400);

        expect(response.body.error).toBe('Invalid alert ID');
      });

      it('should return 400 for alert ID with spaces', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/alert%20id/acknowledge')
          .expect(400);

        expect(response.body.error).toBe('Invalid alert ID');
      });

      it('should accept alert ID with hyphens', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY_partition-l2-turbo/acknowledge')
          .expect(200);

        expect(response.body).toBeDefined();
      });

      it('should accept alert ID with underscores', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY/acknowledge')
          .expect(200);

        expect(response.body).toBeDefined();
      });

      it('should accept alert ID with numbers', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/alert123/acknowledge')
          .expect(200);

        expect(response.body).toBeDefined();
      });

      it('should accept purely alphanumeric alert ID', async () => {
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/CRITICAL/acknowledge')
          .expect(200);

        expect(response.body).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    // Successful Acknowledgment (exact key match)
    // -------------------------------------------------------------------------

    describe('successful acknowledgment (exact key match)', () => {
      it('should return success=true when cooldown is found and deleted', async () => {
        mockState = createMockStateProvider({
          deleteAlertCooldown: jest.fn(() => true),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY_partition-l2-turbo/acknowledge')
          .expect(200)
          .expect('Content-Type', /json/);

        expect(response.body).toEqual({
          success: true,
          message: 'Alert acknowledged',
        });
      });

      it('should call deleteAlertCooldown with the exact alert key', async () => {
        const deleteFn = jest.fn(() => true);
        mockState = createMockStateProvider({
          deleteAlertCooldown: deleteFn,
        });
        const app = createTestApp(mockState);

        await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY_partition-l2-turbo/acknowledge')
          .expect(200);

        expect(deleteFn).toHaveBeenCalledWith('SERVICE_UNHEALTHY_partition-l2-turbo');
      });
    });

    // -------------------------------------------------------------------------
    // Fallback to _system Suffix
    // -------------------------------------------------------------------------

    describe('_system suffix fallback', () => {
      it('should try _system suffix when exact key is not found', async () => {
        // First call (exact) returns false, second call (_system) returns true
        const deleteFn = jest.fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true) as jest.Mock<(key: string) => boolean>;

        mockState = createMockStateProvider({
          deleteAlertCooldown: deleteFn,
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/HIGH_GAS_PRICE/acknowledge')
          .expect(200);

        expect(deleteFn).toHaveBeenCalledTimes(2);
        expect(deleteFn).toHaveBeenNthCalledWith(1, 'HIGH_GAS_PRICE');
        expect(deleteFn).toHaveBeenNthCalledWith(2, 'HIGH_GAS_PRICE_system');
        expect(response.body).toEqual({
          success: true,
          message: 'Alert acknowledged',
        });
      });
    });

    // -------------------------------------------------------------------------
    // Alert Not Found in Cooldowns
    // -------------------------------------------------------------------------

    describe('alert not found in cooldowns', () => {
      it('should return success=false when alert is not in cooldowns', async () => {
        // Both exact and _system lookups return false
        const deleteFn = jest.fn(() => false);
        mockState = createMockStateProvider({
          deleteAlertCooldown: deleteFn,
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/NONEXISTENT_ALERT/acknowledge')
          .expect(200);

        expect(response.body).toEqual({
          success: false,
          message: 'Alert not found in cooldowns',
        });
      });

      it('should call deleteAlertCooldown twice (exact + _system) when not found', async () => {
        const deleteFn = jest.fn(() => false);
        mockState = createMockStateProvider({
          deleteAlertCooldown: deleteFn,
        });
        const app = createTestApp(mockState);

        await supertest(app)
          .post('/api/alerts/MISSING/acknowledge')
          .expect(200);

        expect(deleteFn).toHaveBeenCalledTimes(2);
        expect(deleteFn).toHaveBeenNthCalledWith(1, 'MISSING');
        expect(deleteFn).toHaveBeenNthCalledWith(2, 'MISSING_system');
      });
    });

    // -------------------------------------------------------------------------
    // No Leader Check Required for Alert Acknowledge
    // -------------------------------------------------------------------------

    describe('no leader-only guard', () => {
      it('should allow non-leader to acknowledge alerts', async () => {
        mockState = createMockStateProvider({
          getIsLeader: jest.fn(() => false),
          deleteAlertCooldown: jest.fn(() => true),
        });
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/SERVICE_UNHEALTHY/acknowledge')
          .expect(200);

        // Alert acknowledge does NOT have a leader-only guard (unlike restart)
        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('Alert acknowledged');
      });
    });

    // -------------------------------------------------------------------------
    // Middleware Ordering for Alert Acknowledge
    // -------------------------------------------------------------------------

    describe('middleware ordering', () => {
      it('should reject auth before checking alert ID validity', async () => {
        mockAuthBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/valid-alert-id/acknowledge')
          .expect(401);

        expect(response.body.error).toBe('Authentication required');
        // deleteAlertCooldown should NOT have been called
        expect(mockState.deleteAlertCooldown).not.toHaveBeenCalled();
      });

      it('should reject authz before processing alert acknowledge', async () => {
        mockAuthorizeBehavior = 'reject';
        const app = createTestApp(mockState);

        const response = await supertest(app)
          .post('/api/alerts/valid-alert-id/acknowledge')
          .expect(403);

        expect(response.body.error).toBe('Insufficient permissions');
        expect(mockState.deleteAlertCooldown).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // Cross-Cutting Concerns
  // ===========================================================================

  describe('cross-cutting concerns', () => {
    it('should return 404 for unregistered routes under admin router', async () => {
      const app = createTestApp(mockState);

      await supertest(app)
        .get('/api/nonexistent')
        .expect(404);
    });

    it('should return 404 for GET on restart endpoint (only POST allowed)', async () => {
      const app = createTestApp(mockState);

      await supertest(app)
        .get('/api/services/execution-engine/restart')
        .expect(404);
    });

    it('should return 404 for GET on acknowledge endpoint (only POST allowed)', async () => {
      const app = createTestApp(mockState);

      await supertest(app)
        .get('/api/alerts/SERVICE_UNHEALTHY/acknowledge')
        .expect(404);
    });

    it('should return 404 for PUT on restart endpoint', async () => {
      const app = createTestApp(mockState);

      await supertest(app)
        .put('/api/services/execution-engine/restart')
        .expect(404);
    });

    it('should return 404 for DELETE on acknowledge endpoint', async () => {
      const app = createTestApp(mockState);

      await supertest(app)
        .delete('/api/alerts/SERVICE_UNHEALTHY/acknowledge')
        .expect(404);
    });
  });
});

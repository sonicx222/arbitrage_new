/**
 * Health Check Routes
 *
 * Public endpoints for load balancer health checks and system status.
 * No authentication required - must be accessible for orchestration.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import type { RequestHandler } from 'express';
import { validateHealthRequest } from '@arbitrage/security';
import type { CoordinatorStateProvider } from '../types';

/**
 * Create health check router.
 *
 * @param state - Coordinator state provider
 * @returns Express router with health endpoints
 */
export function createHealthRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  /**
   * GET /api/health
   * Returns system health status for load balancer checks.
   *
   * P2 FIX #18: Return minimal response for unauthenticated requests.
   * Load balancers only need status + systemHealth. Full service topology
   * (service names, instance ID) is only included if the request has
   * an authenticated user (req.user is set by upstream auth middleware).
   */
  router.get(
    '/health',
    // Cast needed: security package has its own @types/express installation
    validateHealthRequest as unknown as RequestHandler,
    (req: Request, res: Response) => {
      const systemHealth = state.getSystemMetrics().systemHealth;
      // FIX #24: Use 'healthy'/'degraded' to match other services.
      // Coordinator used 'ok' while all others used 'healthy', breaking
      // uniform monitoring (status === 'healthy' checks would miss coordinator).
      const status = systemHealth >= 50 ? 'healthy' : 'degraded';

      // Minimal response for unauthenticated requests (load balancer probes)
      if (!(req as Request & { user?: unknown }).user) {
        res.json({
          status,
          systemHealth,
          timestamp: Date.now()
        });
        return;
      }

      // Full response for authenticated requests
      const serviceHealth = state.getServiceHealthMap();
      res.json({
        status,
        isLeader: state.getIsLeader(),
        instanceId: state.getInstanceId(),
        systemHealth,
        services: Object.fromEntries(serviceHealth),
        timestamp: Date.now()
      });
    }
  );

  /**
   * GET /api/health/live
   * Liveness probe - returns 200 if the process is running.
   * Used by orchestrators (k8s, Fly.io) to detect hung processes.
   *
   * @see OP-12: Readiness vs liveness probe distinction
   */
  router.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'alive', timestamp: Date.now() });
  });

  /**
   * GET /api/health/ready
   * Readiness probe - returns 200 only if the service is fully operational.
   * Checks that the coordinator is running and system health is above zero.
   *
   * @see OP-12: Readiness vs liveness probe distinction
   */
  router.get('/health/ready', (_req: Request, res: Response) => {
    const isRunning = state.getIsRunning();
    const systemHealth = state.getSystemMetrics().systemHealth;
    const isReady = isRunning && systemHealth > 0;

    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json({
      status: isReady ? 'ready' : 'not_ready',
      isRunning,
      systemHealth,
      timestamp: Date.now(),
    });
  });

  return router;
}

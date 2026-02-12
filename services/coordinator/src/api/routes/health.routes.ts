/**
 * Health Check Routes
 *
 * Public endpoints for load balancer health checks and system status.
 * No authentication required - must be accessible for orchestration.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import { ValidationMiddleware } from '@arbitrage/core';
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
    ValidationMiddleware.validateHealthCheck,
    (req: Request, res: Response) => {
      const systemHealth = state.getSystemMetrics().systemHealth;
      const status = systemHealth >= 50 ? 'ok' : 'degraded';

      // Minimal response for unauthenticated requests (load balancer probes)
      if (!(req as any).user) {
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

  return router;
}

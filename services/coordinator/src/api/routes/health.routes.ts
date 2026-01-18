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
   */
  router.get(
    '/health',
    ValidationMiddleware.validateHealthCheck,
    (_req: Request, res: Response) => {
      const serviceHealth = state.getServiceHealthMap();

      res.json({
        status: 'ok',
        isLeader: state.getIsLeader(),
        instanceId: state.getInstanceId(),
        systemHealth: state.getSystemMetrics().systemHealth,
        services: Object.fromEntries(serviceHealth),
        timestamp: Date.now()
      });
    }
  );

  return router;
}

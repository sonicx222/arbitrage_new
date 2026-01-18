/**
 * Metrics Routes
 *
 * Protected endpoints for system metrics, services, opportunities, and alerts.
 * Requires authentication with read permissions.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import { apiAuth, apiAuthorize } from '@shared/security';
import type { CoordinatorStateProvider } from '../types';

/**
 * Create metrics router.
 *
 * @param state - Coordinator state provider
 * @returns Express router with metrics endpoints
 */
export function createMetricsRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  // Authentication middleware for all metrics routes (required: true is the default)
  const readAuth = apiAuth();

  /**
   * GET /api/metrics
   * Returns system-wide metrics.
   */
  router.get(
    '/metrics',
    readAuth,
    apiAuthorize('metrics', 'read'),
    (_req: Request, res: Response) => {
      res.json(state.getSystemMetrics());
    }
  );

  /**
   * GET /api/services
   * Returns health status of all services.
   */
  router.get(
    '/services',
    readAuth,
    apiAuthorize('services', 'read'),
    (_req: Request, res: Response) => {
      res.json(Object.fromEntries(state.getServiceHealthMap()));
    }
  );

  /**
   * GET /api/opportunities
   * Returns recent arbitrage opportunities (last 100).
   */
  router.get(
    '/opportunities',
    readAuth,
    apiAuthorize('opportunities', 'read'),
    (_req: Request, res: Response) => {
      const opportunities = Array.from(state.getOpportunities().values())
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 100);
      res.json(opportunities);
    }
  );

  /**
   * GET /api/alerts
   * Returns recent alerts (placeholder - in production, store in database).
   */
  router.get(
    '/alerts',
    readAuth,
    apiAuthorize('alerts', 'read'),
    (_req: Request, res: Response) => {
      res.json([]);
    }
  );

  /**
   * GET /api/leader
   * Returns leader election status.
   */
  router.get(
    '/leader',
    readAuth,
    apiAuthorize('leader', 'read'),
    (_req: Request, res: Response) => {
      res.json({
        isLeader: state.getIsLeader(),
        instanceId: state.getInstanceId(),
        lockKey: state.getLockKey()
      });
    }
  );

  return router;
}

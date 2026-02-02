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
import { findKLargest } from '@arbitrage/core';
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
   * FIX: Performance optimization - partial sort using heap-like selection
   * instead of sorting all opportunities when we only need top 100.
   */
  router.get(
    '/opportunities',
    readAuth,
    apiAuthorize('opportunities', 'read'),
    (_req: Request, res: Response) => {
      const limit = 100;
      const opportunitiesMap = state.getOpportunities();

      // FIX: Performance optimization for large opportunity sets
      // If we have <= limit opportunities, no need to sort
      if (opportunitiesMap.size <= limit) {
        const opportunities = Array.from(opportunitiesMap.values())
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(opportunities);
        return;
      }

      // For larger sets, use partial selection (more efficient than full sort)
      // findKLargest is O(n log k) vs O(n log n) for full sort
      // Returns K largest timestamps (most recent) in descending order
      const result = findKLargest(
        opportunitiesMap.values(),
        limit,
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
      );
      res.json(result);
    }
  );

  /**
   * GET /api/alerts
   * Returns recent alerts from alert history.
   * FIX: Now returns actual alert history instead of empty array.
   */
  router.get(
    '/alerts',
    readAuth,
    apiAuthorize('alerts', 'read'),
    (_req: Request, res: Response) => {
      res.json(state.getAlertHistory(100));
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

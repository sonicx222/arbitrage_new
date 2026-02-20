/**
 * Metrics Routes
 *
 * Protected endpoints for system metrics, services, opportunities, and alerts.
 * Requires authentication with read permissions.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import { apiAuth, apiAuthorize } from '@arbitrage/security';
import { findKLargest, getRedisClient, getStreamHealthMonitor } from '@arbitrage/core';
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
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        res.json(opportunities);
        return;
      }

      // For larger sets, use partial selection (more efficient than full sort)
      // findKLargest is O(n log k) vs O(n log n) for full sort
      // Returns K largest timestamps (most recent) in descending order
      const result = findKLargest(
        opportunitiesMap.values(),
        limit,
        (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
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

  /**
   * Phase 4: GET /api/redis/stats
   * Returns Redis command usage statistics.
   *
   * Provides visibility into Redis usage for free-tier optimization.
   * Helps monitor Upstash 10,000 commands/day limit.
   *
   * @see ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 4 - Redis Usage Optimization
   */
  router.get(
    '/redis/stats',
    readAuth,
    apiAuthorize('metrics', 'read'),
    async (_req: Request, res: Response) => {
      try {
        // P1 FIX #13: Add timeout guard to prevent hanging if Redis is unavailable
        const redis = await Promise.race([
          getRedisClient(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
          ),
        ]);
        const stats = redis.getCommandStats();
        res.json(stats);
      } catch (error) {
        const isTimeout = error instanceof Error && error.message === 'Redis connection timeout';
        res.status(isTimeout ? 504 : 500).json({
          error: isTimeout ? 'Redis connection timeout' : 'Failed to get Redis stats',
        });
      }
    }
  );

  /**
   * OP-20 FIX: GET /api/metrics/prometheus
   * Returns stream health metrics in Prometheus text exposition format.
   *
   * Exposes the StreamHealthMonitor.getPrometheusMetrics() data that was
   * previously built but never served. Provides stream_length, stream_pending,
   * stream_consumer_groups, and stream_health_status gauges.
   */
  router.get(
    '/metrics/prometheus',
    readAuth,
    apiAuthorize('metrics', 'read'),
    async (_req: Request, res: Response) => {
      try {
        const monitor = getStreamHealthMonitor();
        const metrics = await monitor.getPrometheusMetrics();
        res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics);
      } catch (error) {
        res.status(500).type('text/plain').send('Failed to get Prometheus metrics');
      }
    }
  );

  /**
   * Phase 4: GET /api/redis/dashboard
   * Returns formatted Redis usage dashboard (text/plain).
   *
   * Useful for terminal display and quick diagnostics.
   */
  router.get(
    '/redis/dashboard',
    readAuth,
    apiAuthorize('metrics', 'read'),
    async (_req: Request, res: Response) => {
      try {
        // P1 FIX #13: Add timeout guard to prevent hanging if Redis is unavailable
        const redis = await Promise.race([
          getRedisClient(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
          ),
        ]);
        const dashboard = redis.getUsageDashboard();
        res.type('text/plain').send(dashboard);
      } catch (error) {
        // Phase 4 FIX: Include error details for debugging (consistent with text/plain response type)
        const isTimeout = error instanceof Error && error.message === 'Redis connection timeout';
        const statusCode = isTimeout ? 504 : 500;
        res.status(statusCode).type('text/plain').send(
          isTimeout ? 'Failed to get Redis dashboard: connection timeout' : 'Failed to get Redis dashboard'
        );
      }
    }
  );

  return router;
}

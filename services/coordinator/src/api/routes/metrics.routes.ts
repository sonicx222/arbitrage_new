/**
 * Metrics Routes
 *
 * Protected endpoints for system metrics, services, opportunities, and alerts.
 * Requires authentication with read permissions.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { apiAuth, apiAuthorize } from '@arbitrage/security';
import { findKLargest } from '@arbitrage/core/data-structures';
import { getStreamHealthMonitor, getRuntimeMonitor, getProviderLatencyTracker } from '@arbitrage/core/monitoring';
import { getRedisClient } from '@arbitrage/core/redis';
import type { CoordinatorStateProvider } from '../types';

/**
 * Create metrics router.
 *
 * @param state - Coordinator state provider
 * @returns Express router with metrics endpoints
 */
export function createMetricsRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  // CD-003 FIX: Configurable timeouts for Redis/stream health operations
  const redisTimeoutMs = parseInt(process.env.METRICS_REDIS_TIMEOUT_MS ?? '5000', 10) || 5000;
  const streamHealthTimeoutMs = parseInt(process.env.METRICS_STREAM_HEALTH_TIMEOUT_MS ?? '3000', 10) || 3000;

  // Authentication middleware for all metrics routes (required: true is the default)
  const readAuth = apiAuth();

  /**
   * GET /api/metrics
   * Returns system-wide metrics.
   */
  router.get(
    '/metrics',
    readAuth as unknown as RequestHandler,
    apiAuthorize('metrics', 'read') as unknown as RequestHandler,
    ((_req: Request, res: Response) => {
      res.json(state.getSystemMetrics());
    }) as RequestHandler
  );

  /**
   * GET /api/services
   * Returns health status of all services.
   */
  router.get(
    '/services',
    readAuth as unknown as RequestHandler,
    apiAuthorize('services', 'read') as unknown as RequestHandler,
    ((_req: Request, res: Response) => {
      res.json(Object.fromEntries(state.getServiceHealthMap()));
    }) as RequestHandler
  );

  /**
   * GET /api/opportunities
   * Returns recent arbitrage opportunities (last 100).
   * FIX: Performance optimization - partial sort using heap-like selection
   * instead of sorting all opportunities when we only need top 100.
   */
  router.get(
    '/opportunities',
    readAuth as unknown as RequestHandler,
    apiAuthorize('opportunities', 'read') as unknown as RequestHandler,
    ((_req: Request, res: Response) => {
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
    }) as RequestHandler
  );

  /**
   * GET /api/alerts
   * Returns recent alerts from alert history.
   * FIX: Now returns actual alert history instead of empty array.
   */
  router.get(
    '/alerts',
    readAuth as unknown as RequestHandler,
    apiAuthorize('alerts', 'read') as unknown as RequestHandler,
    ((_req: Request, res: Response) => {
      res.json(state.getAlertHistory(100));
    }) as RequestHandler
  );

  /**
   * GET /api/leader
   * Returns leader election status.
   */
  router.get(
    '/leader',
    readAuth as unknown as RequestHandler,
    apiAuthorize('leader', 'read') as unknown as RequestHandler,
    ((_req: Request, res: Response) => {
      res.json({
        isLeader: state.getIsLeader(),
        instanceId: state.getInstanceId(),
        lockKey: state.getLockKey()
      });
    }) as RequestHandler
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
    readAuth as unknown as RequestHandler,
    apiAuthorize('metrics', 'read') as unknown as RequestHandler,
    (async (_req: Request, res: Response) => {
      try {
        // P1 FIX #13: Add timeout guard to prevent hanging if Redis is unavailable
        const redis = await Promise.race([
          getRedisClient(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), redisTimeoutMs)
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
    }) as RequestHandler
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
    readAuth as unknown as RequestHandler,
    apiAuthorize('metrics', 'read') as unknown as RequestHandler,
    (async (_req: Request, res: Response) => {
      try {
        // DV-005 FIX: Wrap stream health in timeout to prevent hanging on Redis XINFO
        const monitor = getStreamHealthMonitor();
        let streamMetrics: string;
        try {
          streamMetrics = await Promise.race([
            monitor.getPrometheusMetrics(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Stream health timeout')), streamHealthTimeoutMs)
            ),
          ]);
        } catch {
          streamMetrics = '# stream_health_monitor timed out\n';
        }
        const runtimeMetrics = getRuntimeMonitor().getPrometheusMetrics();
        // P2-004 FIX: Include coordinator system metrics (dropped opportunities, totals)
        const sys = state.getSystemMetrics();
        const coordinatorMetrics = [
          '# HELP arbitrage_opportunities_dropped_total Total opportunities dropped (all reasons)',
          '# TYPE arbitrage_opportunities_dropped_total counter',
          `arbitrage_opportunities_dropped_total ${sys.opportunitiesDropped}`,
          '# HELP arbitrage_opportunities_total Total opportunities received',
          '# TYPE arbitrage_opportunities_total counter',
          `arbitrage_opportunities_total ${sys.totalOpportunities}`,
          '# HELP arbitrage_executions_total Total executions attempted',
          '# TYPE arbitrage_executions_total counter',
          `arbitrage_executions_total ${sys.totalExecutions}`,
          '# HELP arbitrage_executions_successful_total Total successful executions',
          '# TYPE arbitrage_executions_successful_total counter',
          `arbitrage_executions_successful_total ${sys.successfulExecutions}`,
          // Phase 1 Admission Control metrics
          '# HELP arbitrage_opportunities_admitted_total Opportunities admitted through admission gate',
          '# TYPE arbitrage_opportunities_admitted_total counter',
          `arbitrage_opportunities_admitted_total ${sys.admissionMetrics?.admitted ?? 0}`,
          '# HELP arbitrage_opportunities_shed_total Opportunities shed by admission gate (explicit drop)',
          '# TYPE arbitrage_opportunities_shed_total counter',
          `arbitrage_opportunities_shed_total ${sys.admissionMetrics?.shed ?? 0}`,
          '# HELP arbitrage_admission_avg_score_admitted Average score of admitted opportunities',
          '# TYPE arbitrage_admission_avg_score_admitted gauge',
          `arbitrage_admission_avg_score_admitted ${sys.admissionMetrics?.avgScoreAdmitted ?? 0}`,
          '# HELP arbitrage_admission_avg_score_shed Average score of shed opportunities',
          '# TYPE arbitrage_admission_avg_score_shed gauge',
          `arbitrage_admission_avg_score_shed ${sys.admissionMetrics?.avgScoreShed ?? 0}`,
          '',
        ].join('\n');
        const providerMetrics = getProviderLatencyTracker().getPrometheusMetrics();
        res.type('text/plain; version=0.0.4; charset=utf-8').send(streamMetrics + runtimeMetrics + providerMetrics + coordinatorMetrics);
      } catch (_error) {
        res.status(500).type('text/plain').send('Failed to get Prometheus metrics');
      }
    }) as RequestHandler
  );

  /**
   * Phase 4: GET /api/redis/dashboard
   * Returns formatted Redis usage dashboard (text/plain).
   *
   * Useful for terminal display and quick diagnostics.
   */
  router.get(
    '/redis/dashboard',
    readAuth as unknown as RequestHandler,
    apiAuthorize('metrics', 'read') as unknown as RequestHandler,
    (async (_req: Request, res: Response) => {
      try {
        // P1 FIX #13: Add timeout guard to prevent hanging if Redis is unavailable
        const redis = await Promise.race([
          getRedisClient(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), redisTimeoutMs)
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
    }) as RequestHandler
  );

  return router;
}

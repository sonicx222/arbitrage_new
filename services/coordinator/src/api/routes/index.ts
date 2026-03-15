/**
 * Routes Index
 *
 * Re-exports all route factory functions and provides a combined setup helper.
 *
 * @see coordinator.ts (main service)
 */

import http from 'http';
import { Application, Request, Response, RequestHandler } from 'express';
import { getStreamHealthMonitor, getRuntimeMonitor, getProviderLatencyTracker } from '@arbitrage/core/monitoring';
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import { apiAuth, apiAuthorize } from '@arbitrage/security';
import type { CoordinatorStateProvider } from '../types';
import { createHealthRoutes } from './health.routes';
import { createMetricsRoutes } from './metrics.routes';
import { createDashboardRoutes } from './dashboard.routes';
import { createAdminRoutes } from './admin.routes';
import { createSSERoutes, getActiveSSEConnections } from './sse.routes';

// Re-export individual route factories
export { createHealthRoutes } from './health.routes';
export { createMetricsRoutes } from './metrics.routes';
export { createDashboardRoutes } from './dashboard.routes';
export { createAdminRoutes } from './admin.routes';
export { createSSERoutes } from './sse.routes';

/**
 * Setup all routes on an Express application.
 *
 * @param app - Express application
 * @param state - Coordinator state provider
 */
export function setupAllRoutes(app: Application, state: CoordinatorStateProvider): void {
  // API routes (must be registered BEFORE dashboard SPA catch-all)
  app.use('/api', createHealthRoutes(state));
  app.use('/api', createMetricsRoutes(state));
  app.use('/api', createAdminRoutes(state));
  app.use('/api', createSSERoutes(state));

  // RT-009 FIX: Mount health routes at root for uniform monitoring.
  // Partitions expose /health, /health/live, /health/ready directly.
  // Without this, monitoring scripts need special-case logic for coordinator.
  app.use('/', createHealthRoutes(state));

  // FIX: GCP probes /ready (not /health/ready). Add explicit /ready alias at root
  // so coordinator-standby.yaml readinessProbe gets 200 instead of 404.
  // H-01 FIX: Aligned with health.routes.ts — includes Redis connectivity check.
  // P1-1 FIX: Added consumersOk check to match /api/health/ready (was missing,
  // causing a coordinator with zero stream consumers to report "ready" here
  // but "not_ready" on /api/health/ready).
  app.get('/ready', (async (_req: Request, res: Response) => {
    const isRunning = state.getIsRunning();
    const systemHealth = state.getSystemMetrics().systemHealth;
    const redisOk = await state.checkRedisConnectivity();
    const streamConsumers = state.getActiveStreamConsumerCount();
    const consumersOk = streamConsumers > 0;
    const isReady = isRunning && systemHealth > 0 && redisOk && consumersOk;

    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json({
      status: isReady ? 'ready' : 'not_ready',
      isRunning,
      systemHealth,
      redisConnected: redisOk,
      streamConsumers,
      consumersOk,
      timestamp: Date.now(),
    });
  }) as RequestHandler);

  // RT-004 FIX: Unauthenticated /metrics and /stats at root for uniform monitoring.
  // Partitions and execution engine expose these without auth; coordinator only had
  // them under /api/ with auth, making monitoring scripts fail silently.
  // H-06 FIX: Aligned with /api/metrics/prometheus — now includes runtime, provider,
  // admission, and pipeline metrics. Previously this was a subset, causing scrapers
  // using the root endpoint to miss half the metrics.
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const monitor = getStreamHealthMonitor();
      const streamMetrics = await monitor.getPrometheusMetrics();
      const runtimeMetrics = getRuntimeMonitor().getPrometheusMetrics();
      const providerMetrics = getProviderLatencyTracker().getPrometheusMetrics();
      const sys = state.getSystemMetrics();
      // P1-2 FIX: Aligned with /api/metrics/prometheus — added forwarding, DLQ,
      // SSE, leader, and notification metrics that were previously missing.
      const lines: string[] = [
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
        '# HELP arbitrage_opportunities_admitted_total Opportunities admitted through admission gate',
        '# TYPE arbitrage_opportunities_admitted_total counter',
        `arbitrage_opportunities_admitted_total ${sys.admissionMetrics?.admitted ?? 0}`,
        '# HELP arbitrage_opportunities_shed_total Opportunities shed by admission gate',
        '# TYPE arbitrage_opportunities_shed_total counter',
        `arbitrage_opportunities_shed_total ${sys.admissionMetrics?.shed ?? 0}`,
        '# HELP arbitrage_admission_avg_score_admitted Average score of admitted opportunities',
        '# TYPE arbitrage_admission_avg_score_admitted gauge',
        `arbitrage_admission_avg_score_admitted ${sys.admissionMetrics?.avgScoreAdmitted ?? 0}`,
        '# HELP arbitrage_admission_avg_score_shed Average score of shed opportunities',
        '# TYPE arbitrage_admission_avg_score_shed gauge',
        `arbitrage_admission_avg_score_shed ${sys.admissionMetrics?.avgScoreShed ?? 0}`,
        '# HELP pipeline_events_total Total pipeline events processed by coordinator',
        '# TYPE pipeline_events_total counter',
        `pipeline_events_total ${sys.totalOpportunities + sys.totalExecutions}`,
        '# HELP arbitrage_alert_notifications_dropped_total Alert notifications dropped (notifier failures)',
        '# TYPE arbitrage_alert_notifications_dropped_total counter',
        `arbitrage_alert_notifications_dropped_total ${sys.notificationDroppedAlerts ?? 0}`,
        '# HELP arbitrage_sse_connections_active Current active SSE connections',
        '# TYPE arbitrage_sse_connections_active gauge',
        `arbitrage_sse_connections_active ${getActiveSSEConnections()}`,
        '# HELP arbitrage_coordinator_is_leader Whether this coordinator instance is the leader',
        '# TYPE arbitrage_coordinator_is_leader gauge',
        `arbitrage_coordinator_is_leader ${state.getIsLeader() ? 1 : 0}`,
      ];
      if (sys.forwardingMetrics) {
        lines.push(
          '# HELP arbitrage_forwarding_expired_total Opportunities rejected (expired)',
          '# TYPE arbitrage_forwarding_expired_total counter',
          `arbitrage_forwarding_expired_total ${sys.forwardingMetrics.expired}`,
          '# HELP arbitrage_forwarding_duplicate_total Opportunities rejected (duplicate)',
          '# TYPE arbitrage_forwarding_duplicate_total counter',
          `arbitrage_forwarding_duplicate_total ${sys.forwardingMetrics.duplicate}`,
          '# HELP arbitrage_forwarding_profit_rejected_total Opportunities rejected (profit below threshold)',
          '# TYPE arbitrage_forwarding_profit_rejected_total counter',
          `arbitrage_forwarding_profit_rejected_total ${sys.forwardingMetrics.profitRejected}`,
          '# HELP arbitrage_forwarding_chain_rejected_total Opportunities rejected (unsupported chain)',
          '# TYPE arbitrage_forwarding_chain_rejected_total counter',
          `arbitrage_forwarding_chain_rejected_total ${sys.forwardingMetrics.chainRejected}`,
          '# HELP arbitrage_forwarding_grace_period_deferred_total Opportunities deferred (startup grace period)',
          '# TYPE arbitrage_forwarding_grace_period_deferred_total counter',
          `arbitrage_forwarding_grace_period_deferred_total ${sys.forwardingMetrics.gracePeriodDeferred}`,
          '# HELP arbitrage_forwarding_not_leader_total Opportunities rejected (not leader)',
          '# TYPE arbitrage_forwarding_not_leader_total counter',
          `arbitrage_forwarding_not_leader_total ${sys.forwardingMetrics.notLeader}`,
          '# HELP arbitrage_forwarding_circuit_open_total Opportunities rejected (circuit breaker open)',
          '# TYPE arbitrage_forwarding_circuit_open_total counter',
          `arbitrage_forwarding_circuit_open_total ${sys.forwardingMetrics.circuitOpen}`,
        );
      }
      if (sys.dlqMetrics) {
        lines.push(
          '# HELP arbitrage_dlq_total Total messages sent to dead letter queue',
          '# TYPE arbitrage_dlq_total counter',
          `arbitrage_dlq_total ${sys.dlqMetrics.total}`,
          '# HELP arbitrage_dlq_expired_total DLQ messages (expired TTL)',
          '# TYPE arbitrage_dlq_expired_total counter',
          `arbitrage_dlq_expired_total ${sys.dlqMetrics.expired}`,
          '# HELP arbitrage_dlq_validation_total DLQ messages (validation failure)',
          '# TYPE arbitrage_dlq_validation_total counter',
          `arbitrage_dlq_validation_total ${sys.dlqMetrics.validation}`,
          '# HELP arbitrage_dlq_transient_total DLQ messages (transient error)',
          '# TYPE arbitrage_dlq_transient_total counter',
          `arbitrage_dlq_transient_total ${sys.dlqMetrics.transient}`,
          '# HELP arbitrage_dlq_unknown_total DLQ messages (unknown category)',
          '# TYPE arbitrage_dlq_unknown_total counter',
          `arbitrage_dlq_unknown_total ${sys.dlqMetrics.unknown}`,
        );
      }
      lines.push('');
      const coordinatorMetrics = lines.join('\n');
      res.type('text/plain; version=0.0.4; charset=utf-8').send(streamMetrics + runtimeMetrics + providerMetrics + coordinatorMetrics);
    } catch (error) {
      state.getLogger().error('Failed to get Prometheus metrics', { error: (error as Error).message });
      res.status(500).type('text/plain').send('Failed to get Prometheus metrics');
    }
  });

  // M-03 FIX: /stats exposes full system state (service health, leader status, metrics).
  // Add auth — leave /metrics unauthenticated per Prometheus convention.
  const statsAuth = apiAuth();
  const statsAuthAdapter: RequestHandler = (req, res, next) => { statsAuth(req, res, next); };
  app.get('/stats', statsAuthAdapter, (_req: Request, res: Response) => {
    const metrics = state.getSystemMetrics();
    const serviceHealth = state.getServiceHealthMap();
    res.json({
      ...metrics,
      services: Object.fromEntries(serviceHealth),
      isLeader: state.getIsLeader(),
      instanceId: state.getInstanceId(),
    });
  });

  // EE proxy — dashboard needs direct access to execution engine endpoints.
  // In dev, Vite proxies /ee/* and /circuit-breaker to EE port 3005.
  // In production, coordinator proxies these for the SPA.
  // Port parsing with fail-fast — misconfigured port must throw, not silently fallback
  const eePort = parseEnvIntSafe('EXECUTION_ENGINE_PORT', 3005, 1);
  // Validate that explicitly-set port is actually numeric
  if (process.env.EXECUTION_ENGINE_PORT && Number.isNaN(parseInt(process.env.EXECUTION_ENGINE_PORT, 10))) {
    throw new Error(`Invalid EXECUTION_ENGINE_PORT: '${process.env.EXECUTION_ENGINE_PORT}'`);
  }
  const eeHost = process.env.EXECUTION_ENGINE_HOST ?? 'localhost';

  const MAX_PROXY_RESPONSE_SIZE = 1024 * 1024; // 1MB limit

  function proxyToEE(targetPath: string, req: Request, res: Response): void {
    let responded = false;
    const respond = (status: number, body: object) => {
      if (responded) return;
      responded = true;
      res.status(status).json(body);
    };

    const options: http.RequestOptions = {
      hostname: eeHost,
      port: eePort,
      path: targetPath,
      method: req.method,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['x-api-key'] ? { 'x-api-key': req.headers['x-api-key'] as string } : {}),
      },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      let body = '';
      let bodySize = 0;
      proxyRes.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_PROXY_RESPONSE_SIZE) {
          proxyReq.destroy();
          respond(502, { error: 'Execution engine response too large' });
          return;
        }
        body += chunk.toString();
      });
      proxyRes.on('error', () => {
        respond(502, { error: 'Execution engine connection lost' });
      });
      proxyRes.on('end', () => {
        try {
          respond(proxyRes.statusCode ?? 200, JSON.parse(body));
        } catch {
          respond(502, { error: 'Invalid response from execution engine' });
        }
      });
    });
    proxyReq.on('error', () => {
      respond(503, { error: 'Execution engine unreachable' });
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      respond(504, { error: 'Execution engine timeout' });
    });
    if (req.method === 'POST' && req.body) {
      proxyReq.write(JSON.stringify(req.body));
    }
    proxyReq.end();
  }

  // EE health proxy — RiskTab needs drawdown state, simulation mode, queue size
  app.get('/ee/health', (req: Request, res: Response) => {
    proxyToEE('/health', req, res);
  });

  // Circuit breaker proxy — AdminTab needs CB status + open/close controls (D-3)
  // GET is read-only (public). POST requires coordinator-level auth (H5 fix).
  // H-03 FIX: Typed adapter wrappers instead of `as unknown as RequestHandler` double-casts.
  // The security middleware uses `Request & { user?: ... }` which is structurally compatible
  // with Express's `Request`. Adapters forward args without bypassing the type system.
  const writeAuth = apiAuth();
  const writeAuthorize = apiAuthorize('services', 'write');
  const authAdapter: RequestHandler = (req, res, next) => { writeAuth(req, res, next); };
  const authorizeAdapter: RequestHandler = (req, res, next) => { writeAuthorize(req, res, next); };
  // T4-2 FIX: Add read auth to GET /circuit-breaker — exposes CB state (open/closed, failure counts).
  const readAuth = apiAuth();
  const readAuthAdapter: RequestHandler = (req, res, next) => { readAuth(req, res, next); };
  app.get('/circuit-breaker', readAuthAdapter, (req: Request, res: Response) => {
    proxyToEE('/circuit-breaker', req, res);
  });
  app.post('/circuit-breaker/open',
    authAdapter,
    authorizeAdapter,
    (req: Request, res: Response) => {
      proxyToEE('/circuit-breaker/open', req, res);
    },
  );
  app.post('/circuit-breaker/close',
    authAdapter,
    authorizeAdapter,
    (req: Request, res: Response) => {
      proxyToEE('/circuit-breaker/close', req, res);
    },
  );

  // Dashboard SPA - MUST be last (catch-all `*` would intercept API routes if mounted earlier)
  app.use('/', createDashboardRoutes(state));
}

/**
 * Routes Index
 *
 * Re-exports all route factory functions and provides a combined setup helper.
 *
 * @see coordinator.ts (main service)
 */

import http from 'http';
import { Application, Request, Response, RequestHandler } from 'express';
import { getStreamHealthMonitor } from '@arbitrage/core/monitoring';
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import { apiAuth, apiAuthorize } from '@arbitrage/security';
import type { CoordinatorStateProvider } from '../types';
import { createHealthRoutes } from './health.routes';
import { createMetricsRoutes } from './metrics.routes';
import { createDashboardRoutes } from './dashboard.routes';
import { createAdminRoutes } from './admin.routes';
import { createSSERoutes } from './sse.routes';

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
  app.get('/ready', (_req: Request, res: Response) => {
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

  // RT-004 FIX: Unauthenticated /metrics and /stats at root for uniform monitoring.
  // Partitions and execution engine expose these without auth; coordinator only had
  // them under /api/ with auth, making monitoring scripts fail silently.
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const monitor = getStreamHealthMonitor();
      const metrics = await monitor.getPrometheusMetrics();
      // P2-004 FIX: Add coordinator system metrics to Prometheus output.
      // opportunitiesDropped was only available via /stats JSON — not scrapable by Prometheus.
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
        '',
      ].join('\n');
      res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics + coordinatorMetrics);
    } catch (_error) {
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
  app.get('/circuit-breaker', (req: Request, res: Response) => {
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

/**
 * Routes Index
 *
 * Re-exports all route factory functions and provides a combined setup helper.
 *
 * @see coordinator.ts (main service)
 */

import { Application, Request, Response } from 'express';
import { getStreamHealthMonitor } from '@arbitrage/core/monitoring';
import type { CoordinatorStateProvider } from '../types';
import { createHealthRoutes } from './health.routes';
import { createMetricsRoutes } from './metrics.routes';
import { createDashboardRoutes } from './dashboard.routes';
import { createAdminRoutes } from './admin.routes';

// Re-export individual route factories
export { createHealthRoutes } from './health.routes';
export { createMetricsRoutes } from './metrics.routes';
export { createDashboardRoutes } from './dashboard.routes';
export { createAdminRoutes } from './admin.routes';

/**
 * Setup all routes on an Express application.
 *
 * @param app - Express application
 * @param state - Coordinator state provider
 */
export function setupAllRoutes(app: Application, state: CoordinatorStateProvider): void {
  // Dashboard - root path (public)
  app.use('/', createDashboardRoutes(state));

  // API routes
  app.use('/api', createHealthRoutes(state));
  app.use('/api', createMetricsRoutes(state));
  app.use('/api', createAdminRoutes(state));

  // RT-009 FIX: Mount health routes at root for uniform monitoring.
  // Partitions expose /health, /health/live, /health/ready directly.
  // Without this, monitoring scripts need special-case logic for coordinator.
  app.use('/', createHealthRoutes(state));

  // RT-004 FIX: Unauthenticated /metrics and /stats at root for uniform monitoring.
  // Partitions and execution engine expose these without auth; coordinator only had
  // them under /api/ with auth, making monitoring scripts fail silently.
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const monitor = getStreamHealthMonitor();
      const metrics = await monitor.getPrometheusMetrics();
      res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics);
    } catch (_error) {
      res.status(500).type('text/plain').send('Failed to get Prometheus metrics');
    }
  });

  app.get('/stats', (_req: Request, res: Response) => {
    const metrics = state.getSystemMetrics();
    const serviceHealth = state.getServiceHealthMap();
    res.json({
      ...metrics,
      services: Object.fromEntries(serviceHealth),
      isLeader: state.getIsLeader(),
      instanceId: state.getInstanceId(),
    });
  });
}

/**
 * Routes Index
 *
 * Re-exports all route factory functions and provides a combined setup helper.
 *
 * @see coordinator.ts (main service)
 */

import { Application } from 'express';
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
}

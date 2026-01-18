/**
 * API Module
 *
 * Re-exports all API components: routes, middleware, and types.
 *
 * @see coordinator.ts (main service)
 */

// Types
export * from './types';

// Middleware
export { configureMiddleware } from './middleware';

// Routes
export {
  setupAllRoutes,
  createHealthRoutes,
  createMetricsRoutes,
  createDashboardRoutes,
  createAdminRoutes
} from './routes';

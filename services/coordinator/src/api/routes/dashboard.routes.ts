/**
 * Dashboard Routes
 *
 * Serves the React SPA dashboard when built assets exist in public/,
 * falls back to a minimal server-rendered HTML dashboard otherwise.
 *
 * C4 FIX: DASHBOARD_AUTH_TOKEN is required in production.
 *
 * @see docs/plans/2026-03-06-react-dashboard-design.md
 * @see coordinator.ts (parent service)
 * @throws Error if NODE_ENV=production and DASHBOARD_AUTH_TOKEN is not set
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import type { CoordinatorStateProvider } from '../types';

/**
 * Create dashboard router.
 *
 * Serves React SPA from public/ when available, otherwise falls back
 * to a minimal HTML dashboard for dev without frontend build.
 *
 * @param state - Coordinator state provider
 * @returns Express router with dashboard endpoint
 */
export function createDashboardRoutes(state: CoordinatorStateProvider): Router {
  // C4 FIX: Require DASHBOARD_AUTH_TOKEN in production.
  if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_AUTH_TOKEN) {
    throw new Error(
      'DASHBOARD_AUTH_TOKEN is required in production. '
      + 'Set DASHBOARD_AUTH_TOKEN environment variable to enable dashboard authentication.'
    );
  }

  const router = Router();
  const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN;

  // Auth middleware: if DASHBOARD_AUTH_TOKEN is set, require Bearer token
  if (dashboardAuthToken) {
    router.use((req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).send('Unauthorized');
        return;
      }
      const provided = Buffer.from(authHeader.slice(7));
      const expected = Buffer.from(dashboardAuthToken);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        res.status(401).send('Unauthorized');
        return;
      }
      next();
    });
  }

  // Try to serve React SPA from built assets
  // At runtime, __dirname is dist/api/routes/ — go up 3 levels to coordinator/, then into public/
  const publicDir = path.join(__dirname, '..', '..', '..', 'public');
  const indexPath = path.join(publicDir, 'index.html');

  // L-01 FIX: Cache sync I/O result — called once at route registration, not per-request.
  const hasSpaAssets = fs.existsSync(indexPath);

  if (hasSpaAssets) {
    // Serve static assets (JS, CSS, images)
    router.use(express.static(publicDir));

    // SPA fallback: serve index.html for all non-asset routes
    router.get('*', (_req: Request, res: Response) => {
      res.sendFile(indexPath);
    });
  } else {
    // Fallback: minimal legacy HTML dashboard (dev without frontend build)
    router.get('/', (_req: Request, res: Response) => {
      const metrics = state.getSystemMetrics();
      const serviceHealth = state.getServiceHealthMap();
      res.send(`<!DOCTYPE html><html><head><title>Arbitrage Dashboard</title>
        <style>body{font-family:monospace;background:#1a1a2e;color:#eee;padding:20px}</style></head>
        <body><h2>Arbitrage System (legacy view)</h2>
        <p>Health: ${metrics.systemHealth.toFixed(1)}% | Services: ${serviceHealth.size} | Executions: ${metrics.totalExecutions}</p>
        <p><small>Build the React dashboard: <code>cd dashboard && npm run build</code></small></p>
        <script>setTimeout(()=>location.reload(),10000)</script></body></html>`);
    });
  }

  return router;
}

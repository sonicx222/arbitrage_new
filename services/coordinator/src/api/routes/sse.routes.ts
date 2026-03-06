/**
 * SSE (Server-Sent Events) Route
 *
 * Pushes real-time system data to the React dashboard.
 * Single endpoint multiplexes metrics, services, alerts, execution results,
 * circuit breaker state, and stream health at different frequencies.
 *
 * @see docs/plans/2026-03-06-react-dashboard-design.md
 */

import { Router, Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import { getStreamHealthMonitor } from '@arbitrage/core/monitoring';
import type { CoordinatorStateProvider } from '../types';

export function createSSERoutes(state: CoordinatorStateProvider): Router {
  const router = Router();
  const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN;

  router.get('/events', ((req: Request, res: Response) => {
    // Auth: validate token from query param (EventSource can't set headers)
    if (dashboardAuthToken) {
      const token = req.query.token as string | undefined;
      if (!token) {
        res.status(401).json({ error: 'Token required' });
        return;
      }
      const provided = Buffer.from(token);
      const expected = Buffer.from(dashboardAuthToken);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state immediately
    send('metrics', state.getSystemMetrics());
    send('services', Object.fromEntries(state.getServiceHealthMap()));

    // Periodic pushes
    const metricsInterval = setInterval(() => {
      send('metrics', state.getSystemMetrics());
    }, 2000);

    const servicesInterval = setInterval(() => {
      send('services', Object.fromEntries(state.getServiceHealthMap()));
    }, 5000);

    const streamsInterval = setInterval(async () => {
      try {
        const monitor = getStreamHealthMonitor();
        const health = await monitor.getSummary();
        send('streams', health);
      } catch {
        // Stream monitor not available yet — skip
      }
    }, 10000);

    // Keepalive comment every 15s to prevent proxy timeouts
    const keepaliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(metricsInterval);
      clearInterval(servicesInterval);
      clearInterval(streamsInterval);
      clearInterval(keepaliveInterval);
    });
  }) as RequestHandler);

  return router;
}

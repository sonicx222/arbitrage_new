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

const MAX_SSE_CONNECTIONS = 50;
let activeSSEConnections = 0;

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

    // M5: Limit concurrent SSE connections to prevent resource exhaustion
    // Checked after auth to avoid counting rejected connections
    if (activeSSEConnections >= MAX_SSE_CONNECTIONS) {
      res.status(503).json({ error: 'Too many SSE connections' });
      return;
    }
    activeSSEConnections++;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // H-04 FIX: Monotonic SSE message IDs enable Last-Event-Id on reconnect
    let messageId = 0;
    const send = (event: string, data: unknown) => {
      messageId++;
      res.write(`id: ${messageId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state immediately
    send('metrics', state.getSystemMetrics());
    send('services', Object.fromEntries(state.getServiceHealthMap()));
    send('circuit-breaker', state.getCircuitBreakerSnapshot());

    // Subscribe to real-time events (execution results, alerts)
    const unsubscribe = state.subscribeSSE((event, data) => {
      send(event, data);
    });

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
        const health = await monitor.checkStreamHealth();
        // Map MonitoredStreamInfo to dashboard StreamHealth shape
        const mapped: Record<string, { length: number; pending: number; consumerGroups: number; status: string }> = {};
        for (const [name, info] of Object.entries(health.streams)) {
          mapped[name] = {
            length: info.length,
            pending: info.pendingCount,
            consumerGroups: info.consumerGroups,
            status: info.status,
          };
        }
        send('streams', mapped);
      } catch {
        // Stream monitor not available yet — skip
      }
    }, 10000);

    // Push circuit breaker state every 5s
    const cbInterval = setInterval(() => {
      send('circuit-breaker', state.getCircuitBreakerSnapshot());
    }, 5000);

    // Keepalive comment every 15s to prevent proxy timeouts
    const keepaliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    // Cleanup on disconnect
    req.on('close', () => {
      activeSSEConnections--;
      unsubscribe();
      clearInterval(metricsInterval);
      clearInterval(servicesInterval);
      clearInterval(streamsInterval);
      clearInterval(cbInterval);
      clearInterval(keepaliveInterval);
    });
  }) as RequestHandler);

  return router;
}

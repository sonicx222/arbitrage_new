/**
 * SSE (Server-Sent Events) Route
 *
 * Pushes real-time system data to the React dashboard.
 * Single endpoint multiplexes metrics, services, alerts, execution results,
 * circuit breaker state, and stream health at different frequencies.
 *
 * H-04 FIX: Timer pooling — shared timers broadcast to all connections instead
 * of creating 6 timers per connection. Serialized JSON is cached so
 * JSON.stringify runs once per interval, not once per connection.
 *
 * M-05 FIX: MAX_SSE_CONNECTIONS configurable via SSE_MAX_CONNECTIONS env var.
 *
 * @see docs/plans/2026-03-06-react-dashboard-design.md
 */

import { Router, Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import { getStreamHealthMonitor, getDiagnosticsCollector } from '@arbitrage/core/monitoring';
import type { CoordinatorStateProvider } from '../types';

// M-05 FIX: Configurable max SSE connections (default: 50, min: 1)
const MAX_SSE_CONNECTIONS = parseEnvIntSafe('SSE_MAX_CONNECTIONS', 50, 1);

// =============================================================================
// SSE Client Registry + Timer Pool
// =============================================================================

interface SSEClient {
  res: Response;
  messageId: number;
  unsubscribe: () => void;
}

/** Active SSE clients — shared timer pool broadcasts to all */
const clients = new Set<SSEClient>();

/** Shared timer handles (created on first connection, cleared when last disconnects) */
let sharedTimers: NodeJS.Timeout[] | null = null;

/** Send a pre-serialized SSE frame to a single client */
function sendRaw(client: SSEClient, event: string, serialized: string): void {
  client.messageId++;
  client.res.write(`id: ${client.messageId}\nevent: ${event}\ndata: ${serialized}\n\n`);
}

/** Broadcast a pre-serialized SSE frame to all connected clients */
function broadcast(event: string, serialized: string): void {
  for (const client of clients) {
    sendRaw(client, event, serialized);
  }
}

/** Send an object to a single client (serializes once) */
function sendToClient(client: SSEClient, event: string, data: unknown): void {
  sendRaw(client, event, JSON.stringify(data));
}

/**
 * Start shared timer pool. Called when first client connects.
 * All timers serialize once and broadcast to all clients.
 */
function startTimerPool(state: CoordinatorStateProvider): void {
  if (sharedTimers) return; // Already running

  const timers: NodeJS.Timeout[] = [];

  // Metrics every 5s (RT-010 FIX: reduced from 2s)
  timers.push(setInterval(() => {
    broadcast('metrics', JSON.stringify(state.getSystemMetrics()));
  }, 5000));

  // Services every 5s
  timers.push(setInterval(() => {
    broadcast('services', JSON.stringify(Object.fromEntries(state.getServiceHealthMap())));
  }, 5000));

  // Stream health every 10s
  timers.push(setInterval(async () => {
    try {
      const monitor = getStreamHealthMonitor();
      const health = await monitor.checkStreamHealth();
      const mapped: Record<string, { length: number; pending: number; consumerGroups: number; status: string }> = {};
      for (const [name, info] of Object.entries(health.streams)) {
        mapped[name] = {
          length: info.length,
          pending: info.pendingCount,
          consumerGroups: info.consumerGroups,
          status: info.status,
        };
      }
      broadcast('streams', JSON.stringify(mapped));
    } catch {
      // Stream monitor not available yet — skip
    }
  }, 10000));

  // Circuit breaker every 5s
  timers.push(setInterval(() => {
    broadcast('circuit-breaker', JSON.stringify(state.getCircuitBreakerSnapshot()));
  }, 5000));

  // Diagnostics every 10s
  timers.push(setInterval(async () => {
    try {
      const collector = getDiagnosticsCollector();
      const snapshot = await collector.collect();
      broadcast('diagnostics', JSON.stringify(snapshot));
    } catch {
      // DiagnosticsCollector or underlying monitors not ready — skip
    }
  }, 10000));

  // Keepalive every 15s
  timers.push(setInterval(() => {
    for (const client of clients) {
      client.res.write(': keepalive\n\n');
    }
  }, 15000));

  sharedTimers = timers;
}

/** Stop shared timer pool. Called when last client disconnects. */
function stopTimerPool(): void {
  if (!sharedTimers) return;
  for (const timer of sharedTimers) {
    clearInterval(timer);
  }
  sharedTimers = null;
}

// L-12 FIX: Expose active SSE connection count for Prometheus gauge
export function getActiveSSEConnections(): number {
  return clients.size;
}

// =============================================================================
// Route Factory
// =============================================================================

export function createSSERoutes(state: CoordinatorStateProvider): Router {
  const router = Router();
  const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN;

  // H-01 FIX: Require DASHBOARD_AUTH_TOKEN in production (matches dashboard.routes.ts startup guard)
  if (process.env.NODE_ENV === 'production' && !dashboardAuthToken) {
    throw new Error('DASHBOARD_AUTH_TOKEN is required in production for SSE endpoint security');
  }

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

    // M-05 FIX: Limit concurrent SSE connections (configurable via SSE_MAX_CONNECTIONS)
    if (clients.size >= MAX_SSE_CONNECTIONS) {
      res.status(503).json({ error: 'Too many SSE connections' });
      return;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Register client
    const client: SSEClient = {
      res,
      messageId: 0,
      unsubscribe: () => {},
    };
    clients.add(client);

    // Start shared timers on first connection
    startTimerPool(state);

    // Send initial state immediately (per-client, not broadcast)
    sendToClient(client, 'metrics', state.getSystemMetrics());
    sendToClient(client, 'services', Object.fromEntries(state.getServiceHealthMap()));
    sendToClient(client, 'circuit-breaker', state.getCircuitBreakerSnapshot());

    // Subscribe to real-time events (execution results, alerts)
    client.unsubscribe = state.subscribeSSE((event, data) => {
      sendToClient(client, event, data);
    });

    // Cleanup on disconnect
    req.on('close', () => {
      client.unsubscribe();
      clients.delete(client);
      // Stop shared timers when last client disconnects
      if (clients.size === 0) {
        stopTimerPool();
      }
    });
  }) as RequestHandler);

  return router;
}

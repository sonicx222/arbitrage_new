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
 * M-04 KNOWN LIMITATION: SSE auth token is passed via URL query parameter
 * (?token=<value>) because the EventSource API does not support custom headers.
 * The token will appear in server access logs, browser history, and Referer headers.
 * Mitigations: (1) tokens should be rotated frequently, (2) reverse proxy should
 * strip query params from access logs, (3) future improvement: two-step flow where
 * a POST with auth header returns a short-lived SSE-only token.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import { getStreamHealthMonitor, getDiagnosticsCollector } from '@arbitrage/core/monitoring';
import { getCexPriceFeedService } from '@arbitrage/core/feeds';
import { FEATURE_FLAGS } from '@arbitrage/config';
import type { CoordinatorStateProvider } from '../types';

// M-05 FIX: Configurable max SSE connections (default: 50, min: 1)
const MAX_SSE_CONNECTIONS = parseEnvIntSafe('SSE_MAX_CONNECTIONS', 50, 1);

// M-06 FIX: Configurable SSE push intervals (milliseconds)
const SSE_INTERVAL_METRICS = parseEnvIntSafe('SSE_INTERVAL_METRICS_MS', 5000, 1000);
const SSE_INTERVAL_SERVICES = parseEnvIntSafe('SSE_INTERVAL_SERVICES_MS', 5000, 1000);
const SSE_INTERVAL_STREAMS = parseEnvIntSafe('SSE_INTERVAL_STREAMS_MS', 10000, 2000);
const SSE_INTERVAL_CB = parseEnvIntSafe('SSE_INTERVAL_CB_MS', 5000, 1000);
const SSE_INTERVAL_DIAGNOSTICS = parseEnvIntSafe('SSE_INTERVAL_DIAGNOSTICS_MS', 10000, 2000);
const SSE_INTERVAL_CEX_SPREAD = parseEnvIntSafe('SSE_INTERVAL_CEX_SPREAD_MS', 10000, 2000);
const SSE_INTERVAL_KEEPALIVE = parseEnvIntSafe('SSE_INTERVAL_KEEPALIVE_MS', 15000, 5000);

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
  // OPT-006: Skip iteration when no clients connected
  if (clients.size === 0) return;
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

  // M-06 FIX: All intervals configurable via SSE_INTERVAL_*_MS env vars
  // OPT-006: Each timer skips serialization + broadcast when no SSE clients are connected
  timers.push(setInterval(() => {
    if (clients.size === 0) return;
    broadcast('metrics', JSON.stringify(state.getSystemMetrics()));
  }, SSE_INTERVAL_METRICS));

  timers.push(setInterval(() => {
    if (clients.size === 0) return;
    broadcast('services', JSON.stringify(Object.fromEntries(state.getServiceHealthMap())));
  }, SSE_INTERVAL_SERVICES));

  timers.push(setInterval(async () => {
    if (clients.size === 0) return;
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
  }, SSE_INTERVAL_STREAMS));

  timers.push(setInterval(() => {
    if (clients.size === 0) return;
    broadcast('circuit-breaker', JSON.stringify(state.getCircuitBreakerSnapshot()));
  }, SSE_INTERVAL_CB));

  timers.push(setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const collector = getDiagnosticsCollector();
      const snapshot = await collector.collect();
      broadcast('diagnostics', JSON.stringify(snapshot));
    } catch {
      // DiagnosticsCollector or underlying monitors not ready — skip
    }
  }, SSE_INTERVAL_DIAGNOSTICS));

  // ADR-036: CEX-DEX spread data — always emit so dashboard knows feature state
  timers.push(setInterval(() => {
    if (clients.size === 0) return;
    if (!FEATURE_FLAGS.useCexPriceSignals) {
      broadcast('cex-spread', JSON.stringify({ enabled: false }));
      return;
    }
    try {
      const cexFeed = getCexPriceFeedService();
      broadcast('cex-spread', JSON.stringify({
        enabled: true,
        stats: cexFeed.getStats(),
        alerts: cexFeed.getActiveAlerts(),
        healthSnapshot: cexFeed.getHealthSnapshot(),
      }));
    } catch {
      // CEX feed not initialized — skip
    }
  }, SSE_INTERVAL_CEX_SPREAD));

  timers.push(setInterval(() => {
    for (const client of clients) {
      client.res.write(': keepalive\n\n');
    }
  }, SSE_INTERVAL_KEEPALIVE));

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

    // L-14 FIX: Log SSE connection events for debugging connection lifecycle
    const clientCount = clients.size;
    state.getLogger().info('SSE client connected', { clientCount });

    // Start shared timers on first connection
    startTimerPool(state);

    // Send initial state immediately (per-client, not broadcast)
    sendToClient(client, 'metrics', state.getSystemMetrics());
    sendToClient(client, 'services', Object.fromEntries(state.getServiceHealthMap()));
    sendToClient(client, 'circuit-breaker', state.getCircuitBreakerSnapshot());

    // ADR-036: Send initial CEX spread data (always emit so dashboard knows feature state)
    if (!FEATURE_FLAGS.useCexPriceSignals) {
      sendToClient(client, 'cex-spread', { enabled: false });
    } else {
      try {
        const cexFeed = getCexPriceFeedService();
        sendToClient(client, 'cex-spread', {
          enabled: true,
          stats: cexFeed.getStats(),
          alerts: cexFeed.getActiveAlerts(),
          healthSnapshot: cexFeed.getHealthSnapshot(),
        });
      } catch {
        // CEX feed not initialized — skip
      }
    }

    // Subscribe to real-time events (execution results, alerts)
    client.unsubscribe = state.subscribeSSE((event, data) => {
      sendToClient(client, event, data);
    });

    // Cleanup on disconnect
    req.on('close', () => {
      client.unsubscribe();
      clients.delete(client);
      // L-14 FIX: Log SSE disconnection
      state.getLogger().info('SSE client disconnected', { clientCount: clients.size });
      // Stop shared timers when last client disconnects
      if (clients.size === 0) {
        stopTimerPool();
      }
    });
  }) as RequestHandler);

  return router;
}

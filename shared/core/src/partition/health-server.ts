/**
 * Partition Health Server
 *
 * HTTP health check server and graceful shutdown for partition services.
 * Extracted from partition-service-utils.ts for focused responsibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module partition/health-server
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { createLogger } from '../logger';
import { getStreamHealthMonitor } from '../monitoring/stream-health-monitor';
import { getLatencyTracker } from '../monitoring/latency-tracker';
import { getRuntimeMonitor } from '../monitoring/runtime-monitor';
import { getProviderLatencyTracker } from '../monitoring/provider-latency-tracker';
import { setLogLevel, getOtelTransport } from '../logging/pino-logger';
import type { LogLevel } from '../logging/types';
import type { PartitionServiceConfig, HealthServerOptions, PartitionDetectorInterface } from './config';
import { getPriceUpdatesTotal } from './handlers';
import { getPublishDropsTotal } from './runner';

// =============================================================================
// Health Check Cache (PERF-FIX)
// =============================================================================

/** Default cache TTL in milliseconds for health check results */
const DEFAULT_HEALTH_CACHE_TTL_MS = 1000;

interface HealthCacheEntry {
  data: {
    status: string;
    partitionId: string;
    chainHealth: Map<string, unknown>;
    uptimeSeconds: number;
    totalEventsProcessed: number;
    memoryUsage: number;
  };
  /** FIX #3: Cache healthyChains alongside health data to prevent contradictory responses */
  healthyChains: string[];
  timestamp: number;
}

/**
 * Simple in-memory cache for health check data.
 * Prevents repetitive async calls on high-frequency health check requests.
 * Each server instance has its own cache to avoid cross-service contamination.
 *
 * @param ttlMs - Cache TTL in milliseconds (default: 1000ms)
 */
function createHealthCache(ttlMs: number = DEFAULT_HEALTH_CACHE_TTL_MS) {
  let cache: HealthCacheEntry | null = null;

  return {
    get(): { data: HealthCacheEntry['data']; healthyChains: string[] } | null {
      if (!cache) return null;
      if (Date.now() - cache.timestamp > ttlMs) {
        cache = null;
        return null;
      }
      return { data: cache.data, healthyChains: cache.healthyChains };
    },
    /** FIX #3: Cache healthyChains alongside health data to prevent stale/live mismatch */
    set(data: HealthCacheEntry['data'], healthyChains: string[]): void {
      cache = { data, healthyChains, timestamp: Date.now() };
    },
    clear(): void {
      cache = null;
    }
  };
}

// =============================================================================
// Stats Cache (P3-FIX: Prevent /stats event loop starvation on P1/P2)
// =============================================================================

interface StatsCacheEntry {
  data: string; // Pre-serialized JSON to avoid re-serialization on each request
  timestamp: number;
}

/**
 * Simple cache for /stats responses. Pre-serializes JSON to minimize
 * time spent in the request handler on high-volume partitions.
 */
function createStatsCache(ttlMs: number = DEFAULT_HEALTH_CACHE_TTL_MS) {
  let cache: StatsCacheEntry | null = null;

  return {
    get(): string | null {
      if (!cache) return null;
      if (Date.now() - cache.timestamp > ttlMs) {
        cache = null;
        return null;
      }
      return cache.data;
    },
    set(data: string): void {
      cache = { data, timestamp: Date.now() };
    },
    clear(): void {
      cache = null;
    }
  };
}

// =============================================================================
// Response timeout helper (P3-FIX)
// =============================================================================

/** Maximum time for /health and /stats handlers before sending 504 */
const HANDLER_TIMEOUT_MS = 3000;

/**
 * Wraps an async handler with a response timeout. If the handler doesn't
 * complete within the deadline, sends a 504 Gateway Timeout. This prevents
 * event loop starvation from causing indefinite HTTP request hangs on
 * high-volume partitions (P1/P2).
 */
function withResponseTimeout(
  res: ServerResponse,
  serviceName: string,
  handler: () => Promise<void>,
  logger: ReturnType<typeof createLogger>,
): void {
  let responded = false;
  const timer = setTimeout(() => {
    if (!responded) {
      responded = true;
      logger.warn('Health handler timed out — event loop may be saturated', {
        service: serviceName,
        timeoutMs: HANDLER_TIMEOUT_MS,
      });
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        status: 'timeout',
        error: `Handler did not respond within ${HANDLER_TIMEOUT_MS}ms`,
      }));
    }
  }, HANDLER_TIMEOUT_MS);

  handler().then(() => {
    clearTimeout(timer);
    responded = true;
  }).catch((error) => {
    clearTimeout(timer);
    if (!responded) {
      responded = true;
      logger.error('Health handler error', { error: (error as Error).message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        status: 'error',
        error: 'Internal health check failed',
      }));
    }
  });
}

// =============================================================================
// Health Server (P12-P14 Refactor)
// =============================================================================

/**
 * Creates an HTTP health check server for partition services.
 * Provides consistent endpoints across all partitions.
 *
 * Features:
 * - Health check caching with 1s TTL (PERF-FIX)
 * - Graceful error handling
 * - EADDRINUSE/EACCES error handling
 *
 * Endpoints:
 * - GET / - Service info
 * - GET /health - Health status (Kubernetes liveness probe)
 * - GET /ready - Readiness check (Kubernetes readiness probe)
 * - GET /stats - Detailed statistics
 *
 * @param options - Health server configuration
 * @returns HTTP Server instance
 */
export function createPartitionHealthServer(options: HealthServerOptions): Server {
  const { port, config, detector, logger } = options;
  const authToken = options.authToken ?? process.env.HEALTH_AUTH_TOKEN;
  const bindAddress = options.bindAddress ?? process.env.HEALTH_BIND_ADDRESS ?? '0.0.0.0';

  // PERF-FIX: Create cache per server instance to avoid repetitive async calls
  // FIX #8: Allow per-partition TTL configuration via healthCacheTtlMs option
  const healthCache = createHealthCache(options.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS);

  // P3-FIX: Separate stats cache — /stats had no caching, causing event loop starvation
  // on P1/P2 (high-volume partitions with 1000+ pairs). getStats() iterates all chain
  // instances and pairs synchronously, blocking the event loop when WebSocket events flood it.
  const statsCache = createStatsCache(options.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // LOG-OPT Task 8: Log level hot-reload — accepts PUT /log-level, all other
    // endpoints are GET-only (SEC-02).
    if (req.method === 'PUT' && req.url === '/log-level') {
      // Require auth token for level changes (same policy as /stats)
      if (authToken) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      const body = await new Promise<string>((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      try {
        const parsed = JSON.parse(body) as { level?: string };
        const validLevels: string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
        if (!parsed.level || !validLevels.includes(parsed.level)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid level. Must be one of: ${validLevels.join(', ')}` }));
          return;
        }
        const newLevel = parsed.level as LogLevel;
        setLogLevel(newLevel);
        logger.info('Log level changed via hot-reload', { newLevel, service: config.serviceName });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ level: newLevel }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      return;
    }

    // SEC-02: Reject non-GET methods for all other endpoints
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET, PUT' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    if (req.url === '/health') {
      // P3-FIX: Wrap with response timeout to prevent indefinite hang when
      // event loop is saturated by WebSocket events on high-volume partitions (P1/P2).
      withResponseTimeout(res, config.serviceName, async () => {
        // PERF-FIX: Use cached health data if available and fresh
        // FIX #3: Cache healthyChains alongside health data to prevent contradictory responses
        // where status could be "healthy" (cached) while healthyChains is [] (live, post-disconnect)
        let health: HealthCacheEntry['data'];
        let healthyChains: string[];
        const cached = healthCache.get();
        if (cached) {
          health = cached.data;
          healthyChains = cached.healthyChains;
        } else {
          health = await detector.getPartitionHealth();
          healthyChains = detector.getHealthyChains();
          healthCache.set(health, healthyChains);
        }
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: health.status,
          partitionId: health.partitionId,
          chains: Array.from(health.chainHealth.keys()),
          healthyChains,
          uptime: health.uptimeSeconds,
          eventsProcessed: health.totalEventsProcessed,
          memoryMB: Math.round(health.memoryUsage / 1024 / 1024),
          region: config.region,
          timestamp: Date.now()
        }));
      }, logger);
    } else if (req.url === '/stats') {
      // SEC-01: Require auth token for /stats when HEALTH_AUTH_TOKEN is configured
      if (authToken) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      // P3-FIX: Wrap with response timeout + caching to prevent event loop starvation.
      // getStats() iterates all chain instances and pairs synchronously (1000+ on P1/P2),
      // which blocks the event loop when WebSocket events are flooding in.
      withResponseTimeout(res, config.serviceName, async () => {
        const cachedStats = statsCache.get();
        if (cachedStats) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(cachedStats);
          return;
        }

        const stats = detector.getStats();
        const body = JSON.stringify({
          service: config.serviceName,
          partitionId: stats.partitionId,
          chains: stats.chains,
          totalEvents: stats.totalEventsProcessed,
          totalOpportunities: stats.totalOpportunitiesFound,
          uptimeSeconds: stats.uptimeSeconds,
          memoryMB: stats.memoryUsageMB,
          chainStats: Object.fromEntries(stats.chainStats)
        });
        statsCache.set(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      }, logger);
    } else if (req.url === '/ready') {
      // ST-001 FIX: Wrap /ready with response timeout to prevent indefinite hang when
      // event loop is blocked by CPU-bound path finding during startup.
      // Previously /ready had no timeout wrapper (unlike /health and /stats),
      // causing Kubernetes readiness probes to fail during initial burst.
      withResponseTimeout(res, config.serviceName, async () => {
        const ready = detector.isRunning();
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          ready,
          chains: detector.getChains()
        }));
      }, logger);
    } else if (req.url === '/metrics') {
      // W2-H7: Prometheus metrics endpoint for scraping
      try {
        const streamMonitor = getStreamHealthMonitor();
        const streamMetrics = await streamMonitor.getPrometheusMetrics();

        const latencyMetrics = getLatencyTracker().getMetrics();
        const latencyLines: string[] = [];
        latencyLines.push('# HELP pipeline_latency_p50_ms Pipeline latency 50th percentile in ms');
        latencyLines.push('# TYPE pipeline_latency_p50_ms gauge');
        latencyLines.push(`pipeline_latency_p50_ms ${latencyMetrics.e2e.p50}`);
        latencyLines.push('# HELP pipeline_latency_p95_ms Pipeline latency 95th percentile in ms');
        latencyLines.push('# TYPE pipeline_latency_p95_ms gauge');
        latencyLines.push(`pipeline_latency_p95_ms ${latencyMetrics.e2e.p95}`);
        latencyLines.push('# HELP pipeline_latency_p99_ms Pipeline latency 99th percentile in ms');
        latencyLines.push('# TYPE pipeline_latency_p99_ms gauge');
        latencyLines.push(`pipeline_latency_p99_ms ${latencyMetrics.e2e.p99}`);
        latencyLines.push('# HELP pipeline_events_total Total pipeline events tracked');
        latencyLines.push('# TYPE pipeline_events_total counter');
        latencyLines.push(`pipeline_events_total ${latencyMetrics.e2e.totalRecorded}`);
        // RT-007: Standard schema aliases expected by monitoring validation
        latencyLines.push('# HELP events_processed_total Total events processed by this partition');
        latencyLines.push('# TYPE events_processed_total counter');
        latencyLines.push(`events_processed_total ${latencyMetrics.e2e.totalRecorded}`);
        latencyLines.push('# HELP price_updates_total Total price update events received');
        latencyLines.push('# TYPE price_updates_total counter');
        latencyLines.push(`price_updates_total ${getPriceUpdatesTotal()}`);
        // M-01 FIX: Publish drop counter for monitoring backpressure
        latencyLines.push('# HELP opportunity_publish_drops_total Opportunities dropped due to concurrent publish limit');
        latencyLines.push('# TYPE opportunity_publish_drops_total counter');
        latencyLines.push(`opportunity_publish_drops_total ${getPublishDropsTotal()}`);

        // P2-005 FIX: WebSocket health gauges per chain — exposes connection status
        // as Prometheus metrics for per-chain alerting (e.g., chain disconnected > 5min).
        // Previously only visible via /stats JSON, not scrapable by Prometheus.
        const wsLines: string[] = [];
        try {
          const stats = detector.getStats();
          if (stats.chainStats.size > 0) {
            wsLines.push('# HELP websocket_connections_active WebSocket connection active (1=connected, 0=not)');
            wsLines.push('# TYPE websocket_connections_active gauge');
            wsLines.push('# HELP websocket_chain_status Chain connection status (0=disconnected, 1=connecting, 2=connected, 3=error)');
            wsLines.push('# TYPE websocket_chain_status gauge');
            for (const [chainId, rawStats] of stats.chainStats) {
              const chainStats = rawStats as { status?: string };
              const status = chainStats.status ?? 'disconnected';
              const active = status === 'connected' ? 1 : 0;
              const statusCode = status === 'disconnected' ? 0
                : status === 'connecting' ? 1
                : status === 'connected' ? 2
                : 3; // error
              wsLines.push(`websocket_connections_active{chain="${chainId}"} ${active}`);
              wsLines.push(`websocket_chain_status{chain="${chainId}"} ${statusCode}`);
            }
          }
        } catch (_wsErr) {
          // Non-critical — don't fail /metrics if WS stats unavailable
        }

        // Phase 1 Enhanced Monitoring: Runtime health metrics (event loop, GC, memory)
        const runtimeMetrics = getRuntimeMonitor().getPrometheusMetrics();

        // Phase 2 Enhanced Monitoring: Provider/RPC quality metrics (C1, C2, C3, C4)
        const providerMetrics = getProviderLatencyTracker().getPrometheusMetrics();

        // M-10 FIX: Expose OTEL transport drop/export counts for monitoring
        const otelLines: string[] = [];
        const otelTransport = getOtelTransport();
        if (otelTransport) {
          otelLines.push('# HELP otel_logs_exported_total OTEL log records successfully exported');
          otelLines.push('# TYPE otel_logs_exported_total counter');
          otelLines.push(`otel_logs_exported_total ${otelTransport.exportCount}`);
          otelLines.push('# HELP otel_logs_dropped_total OTEL log records dropped due to export errors');
          otelLines.push('# TYPE otel_logs_dropped_total counter');
          otelLines.push(`otel_logs_dropped_total ${otelTransport.dropCount}`);
        }
        const otelBlock = otelLines.length > 0 ? otelLines.join('\n') + '\n' : '';

        const wsBlock = wsLines.length > 0 ? wsLines.join('\n') + '\n' : '';
        const body = streamMetrics + '\n' + latencyLines.join('\n') + '\n' + wsBlock + runtimeMetrics + providerMetrics + otelBlock;
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      } catch (error) {
        logger.error('Metrics endpoint failed', { error: (error as Error).message });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('# Error generating metrics\n');
      }
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: config.serviceName,
        description: `${config.partitionId} Partition Detector`,
        partitionId: config.partitionId,
        chains: config.defaultChains,
        region: config.region,
        endpoints: ['/health', '/ready', '/stats', '/metrics', 'PUT /log-level']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  // SEC-03: Prevent slowloris-style DoS via server timeouts
  server.requestTimeout = 5000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 100;

  // SEC-04: Prevent accidental public exposure in production
  // If binding to all interfaces without auth token in production, refuse to start
  const isProductionEnv = process.env.NODE_ENV === 'production';
  const isPublicBind = bindAddress === '0.0.0.0' || bindAddress === '::';
  if (isProductionEnv && isPublicBind && !authToken) {
    const msg = `SECURITY ERROR: Health server binds to ${bindAddress} in production without HEALTH_AUTH_TOKEN. ` +
      'Set HEALTH_AUTH_TOKEN or use HEALTH_BIND_ADDRESS=127.0.0.1 to restrict access.';
    logger.error(msg);
    throw new Error(msg);
  }
  if (!isProductionEnv && isPublicBind && !authToken) {
    // P0-2 FIX: Clarified log text — "will bind" not "bound" (binding hasn't happened yet)
    logger.warn('Health server will bind to all interfaces without auth token (non-production)', {
      bindAddress,
      hint: 'Set HEALTH_AUTH_TOKEN or HEALTH_BIND_ADDRESS=127.0.0.1 for production',
    });
  }

  server.listen(port, bindAddress, () => {
    // P0-2 FIX: Promote bind confirmation from debug to info level so operators
    // can verify the server actually bound (previously invisible at default log level)
    // LOG-OPT Fix 3: Static string + structured fields
    logger.info('Health server listening', { serviceName: config.serviceName, bindAddress, port });
  });

  // CRITICAL-FIX: Handle fatal server errors appropriately
  // EADDRINUSE means another process is using this port - service cannot function without health endpoint
  server.on('error', (error: NodeJS.ErrnoException) => {
    const errorCode = error.code;

    if (errorCode === 'EADDRINUSE') {
      logger.error('Health server port already in use - cannot start service', {
        port,
        service: config.serviceName,
        error: error.message,
        hint: `Another process is using port ${port}. Check for duplicate services or use a different HEALTH_CHECK_PORT.`
      });
      process.exit(1);
    } else if (errorCode === 'EACCES') {
      logger.error('Health server port requires elevated privileges', {
        port,
        service: config.serviceName,
        error: error.message,
        hint: `Port ${port} requires root/admin privileges. Use a port > 1024 or run with elevated permissions.`
      });
      process.exit(1);
    } else if (!server.listening) {
      // P0-2 FIX: If the server hasn't bound yet, any error is a startup failure.
      // Previously non-EADDRINUSE/EACCES errors were swallowed, leaving the service
      // running with a dead health server (invisible to monitoring).
      logger.error('Health server failed to bind — startup failure', {
        port,
        service: config.serviceName,
        code: errorCode,
        error: error.message,
        hint: `Health server could not bind to ${bindAddress}:${port}. Service cannot operate without health endpoint.`
      });
      process.exit(1);
    } else {
      // Runtime errors on established server (e.g., connection resets) — non-fatal
      logger.error('Health server runtime error', {
        service: config.serviceName,
        code: errorCode,
        error: error.message
      });
    }
  });

  return server;
}

// =============================================================================
// Graceful Shutdown (P15 Refactor)
// =============================================================================

/**
 * Default timeout for shutdown operations in milliseconds.
 *
 * SA-008 FIX: Must exceed Redis connectTimeout (3000ms) so the Redis client
 * has time to complete its connection attempt before shutdown forcibly exits.
 * Previously matched connectTimeout exactly — a race condition under reconnect.
 */
export const SHUTDOWN_TIMEOUT_MS = 8000;

/** Default timeout for health server close during startup failure cleanup */
export const HEALTH_SERVER_CLOSE_TIMEOUT_MS = 1000;

/**
 * Closes an HTTP server with timeout protection and resolved flag pattern.
 *
 * FIX 9.2/6.2: Extracted from partition services to consolidate the shutdown
 * pattern that was duplicated across P1/P2/P3/P4. Uses a resolved flag to
 * prevent double resolution when both timeout and close callback fire.
 *
 * Use this utility for startup failure cleanup in partition services.
 *
 * @param server - HTTP server to close (null is safely handled)
 * @param timeoutMs - Timeout in milliseconds (default: 1000ms)
 * @param logger - Logger instance for warnings
 * @returns Promise that resolves when server is closed or timeout expires
 */
export async function closeServerWithTimeout(
  server: Server | null,
  timeoutMs: number = HEALTH_SERVER_CLOSE_TIMEOUT_MS,
  logger?: ReturnType<typeof createLogger>
): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const safeResolve = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    const timeout = setTimeout(() => {
      if (logger) {
        // LOG-OPT Fix 3: Static string + structured fields
        logger.warn('Health server close timed out', { timeoutMs });
      }
      safeResolve();
    }, timeoutMs);

    server.close((err) => {
      clearTimeout(timeout);
      if (err) {
        if (logger) {
          logger.warn('Failed to close health server during cleanup', { error: err });
        }
      } else {
        if (logger) {
          logger.info('Health server closed after startup failure');
        }
      }
      safeResolve();
    });
  });
}

/**
 * Gracefully shuts down a partition service.
 * Handles health server and detector shutdown with timeouts.
 *
 * @param signal - Signal that triggered shutdown
 * @param healthServer - HTTP server to close
 * @param detector - Detector instance to stop
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 */
export async function shutdownPartitionService(
  signal: string,
  healthServer: Server | null,
  detector: PartitionDetectorInterface,
  logger: ReturnType<typeof createLogger>,
  serviceName: string
): Promise<void> {
  // LOG-OPT Fix 3: Static string + structured fields
  logger.info('Received signal, shutting down', { signal, serviceName });

  try {
    // Close health server first with timeout (P8-FIX, safeResolve pattern)
    // FIX #13: Reuse closeServerWithTimeout to eliminate duplicated shutdown logic
    await closeServerWithTimeout(healthServer, SHUTDOWN_TIMEOUT_MS, logger);

    // H6: Wrap detector.stop() with timeout to prevent hanging on stuck WebSocket/RPC calls
    // W2-M3: Track whether shutdown timed out — exit(1) signals unclean shutdown to orchestrator
    let timedOut = false;
    await Promise.race([
      detector.stop(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          // LOG-OPT Fix 3: Static string + structured fields
          logger.warn('Detector stop timed out, async operations may still be running', { serviceName, timeoutMs: SHUTDOWN_TIMEOUT_MS });
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      // LOG-OPT Fix 3: Static string + structured fields
      logger.error('Shutdown incomplete (timed out), exiting with code 1', { serviceName });
      process.exit(1);
    }
    // LOG-OPT Fix 3: Static string + structured fields
    logger.info('Shutdown complete', { serviceName });
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

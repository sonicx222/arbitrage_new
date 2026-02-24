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
import type { PartitionServiceConfig, HealthServerOptions, PartitionDetectorInterface } from './config';

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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // SEC-02: Reject non-GET methods (all legitimate consumers use GET)
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    if (req.url === '/health') {
      try {
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
      } catch (error) {
        logger.error('Health check failed', { error: (error as Error).message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: 'error',
          error: 'Internal health check failed'
        }));
      }
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
      try {
        const stats = detector.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          partitionId: stats.partitionId,
          chains: stats.chains,
          totalEvents: stats.totalEventsProcessed,
          totalOpportunities: stats.totalOpportunitiesFound,
          uptimeSeconds: stats.uptimeSeconds,
          memoryMB: stats.memoryUsageMB,
          chainStats: Object.fromEntries(stats.chainStats)
        }));
      } catch (error) {
        logger.error('Stats endpoint failed', { error: (error as Error).message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: 'error',
          error: 'Internal stats check failed'
        }));
      }
    } else if (req.url === '/ready') {
      const ready = detector.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: config.serviceName,
        ready,
        chains: detector.getChains()
      }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: config.serviceName,
        description: `${config.partitionId} Partition Detector`,
        partitionId: config.partitionId,
        chains: config.defaultChains,
        region: config.region,
        endpoints: ['/health', '/ready', '/stats']
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
    logger.warn('Health server bound to all interfaces without auth token (non-production)', {
      bindAddress,
      hint: 'Set HEALTH_AUTH_TOKEN or HEALTH_BIND_ADDRESS=127.0.0.1 for production',
    });
  }

  server.listen(port, bindAddress, () => {
    logger.debug(`${config.serviceName} health server listening on ${bindAddress}:${port}`);
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
    } else {
      // Non-fatal errors - log but continue (e.g., connection resets)
      logger.error('Health server error', {
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

/** Default timeout for shutdown operations in milliseconds */
export const SHUTDOWN_TIMEOUT_MS = 5000;

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
        logger.warn(`Health server close timed out after ${timeoutMs}ms`);
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
  logger.info(`Received ${signal}, shutting down ${serviceName}...`);

  try {
    // Close health server first with timeout (P8-FIX, safeResolve pattern)
    // FIX #13: Reuse closeServerWithTimeout to eliminate duplicated shutdown logic
    await closeServerWithTimeout(healthServer, SHUTDOWN_TIMEOUT_MS, logger);

    // H6: Wrap detector.stop() with timeout to prevent hanging on stuck WebSocket/RPC calls
    await Promise.race([
      detector.stop(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn(`${serviceName} detector.stop() timed out after ${SHUTDOWN_TIMEOUT_MS}ms, proceeding with shutdown`);
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    logger.info(`${serviceName} shutdown complete`);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

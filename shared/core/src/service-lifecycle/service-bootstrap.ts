/**
 * Service Bootstrap Utilities
 *
 * Common bootstrap patterns for non-partition services (coordinator, execution-engine,
 * cross-chain-detector, mempool-detector). Reduces duplicated shutdown handling,
 * signal registration, and service entry point boilerplate.
 *
 * For partition services, use the partition-specific utilities in partition-service-utils.ts.
 *
 * @see partition-service-utils.ts - Partition-specific bootstrap utilities
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { parentPort } from 'worker_threads';
import type { Logger } from '../logger';
import { setupParentPortListener } from '../async/lifecycle-utils';
import { getErrorMessage } from '../resilience/error-handling';
// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for graceful shutdown setup.
 */
export interface ServiceShutdownConfig {
  /** Logger instance for shutdown messages */
  logger: Logger;

  /** Async callback to run during shutdown (stop services, close connections) */
  onShutdown: () => Promise<void>;

  /** Service name for log messages */
  serviceName: string;

  /** FIX #7: Max time (ms) to wait for graceful shutdown before force-exiting (default: 10000) */
  shutdownTimeoutMs?: number;
}

/**
 * Cleanup function returned by setupServiceShutdown.
 * Call this to remove all registered process handlers (useful in tests).
 */
export type ServiceShutdownCleanup = () => void;

/**
 * Configuration for a simple health check server.
 */
export interface SimpleHealthServerConfig {
  /** Port to listen on */
  port: number;

  /** Service name for JSON responses */
  serviceName: string;

  /** Logger instance */
  logger: Logger;

  /** Optional description for the root endpoint */
  description?: string;

  /**
   * Health check handler. Returns an object with health data.
   * The handler should return { status, statusCode, ...data }.
   * If statusCode is omitted, 200 is used for 'healthy'/'degraded', 503 for others.
   */
  healthCheck: () => HealthCheckResult | Promise<HealthCheckResult>;

  /**
   * Readiness check handler. Returns whether the service is ready.
   * If omitted, defaults to returning true.
   */
  readyCheck?: () => boolean;

  /**
   * Optional additional route handlers.
   * Keys are URL paths (e.g., '/stats', '/circuit-breaker').
   * If the request URL matches a key, the handler is invoked.
   */
  additionalRoutes?: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
}

/**
 * Result from a health check handler.
 */
export interface HealthCheckResult {
  /** Health status string (e.g., 'healthy', 'degraded', 'unhealthy') */
  status: string;

  /** Optional explicit HTTP status code. If omitted, derived from status field. */
  statusCode?: number;

  /** Additional health data fields to include in the JSON response */
  [key: string]: unknown;
}

/**
 * Configuration for the runServiceMain wrapper.
 */
export interface RunServiceMainConfig {
  /** The async main function to execute */
  main: () => Promise<void>;

  /** Service name for error logging */
  serviceName: string;

  /** Logger instance (falls back to console.error if not provided) */
  logger?: Logger;
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

/**
 * Sets up graceful shutdown handling for a service.
 *
 * Provides:
 * - isShuttingDown guard to prevent duplicate shutdown attempts
 * - SIGTERM and SIGINT signal handlers
 * - uncaughtException handler that triggers shutdown
 * - unhandledRejection handler for error visibility
 *
 * Returns a cleanup function to remove all registered handlers (useful in tests).
 *
 * @param config - Shutdown configuration
 * @returns Cleanup function to remove all registered handlers
 */
export function setupServiceShutdown(config: ServiceShutdownConfig): ServiceShutdownCleanup {
  const { logger, onShutdown, serviceName, shutdownTimeoutMs = 10000 } = config;

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.debug(`Already shutting down ${serviceName}, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down ${serviceName} gracefully`);

    // FIX #7: Force-exit timer to prevent hanging shutdown
    const forceExitTimer = setTimeout(() => {
      logger.error(`${serviceName} shutdown timed out after ${shutdownTimeoutMs}ms, forcing exit`);
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();

    try {
      await onShutdown();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error(`Error during ${serviceName} shutdown`, {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  };

  const sigtermHandler = () => shutdown('SIGTERM');
  const sigintHandler = () => shutdown('SIGINT');
  const uncaughtHandler = (error: Error) => {
    logger.error(`Uncaught exception in ${serviceName}`, {
      error: error.message,
      stack: error.stack,
    });
    shutdown('uncaughtException').catch(() => {
      process.exit(1);
    });
  };
  const rejectionHandler = (reason: unknown, _promise: Promise<unknown>) => {
    logger.error(`Unhandled rejection in ${serviceName}`, { reason });
  };

  // Prevent MaxListenersExceededWarning — services register 4 process handlers
  // plus Pino transport exit handlers (ADR-015)
  process.setMaxListeners(Math.max(process.getMaxListeners(), 15));

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', rejectionHandler);

  // Fix #37: Listen for shutdown and health_request messages from monolith WorkerManager.
  // Extracted to shared utility to eliminate duplication with partition-service-utils.ts.
  const cleanupParentPort = setupParentPortListener({
    parentPort,
    serviceName,
    logger,
    isShuttingDown: () => isShuttingDown,
    shutdown,
  });

  return () => {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', rejectionHandler);
    cleanupParentPort?.();
  };
}

// =============================================================================
// Simple Health Server
// =============================================================================

/**
 * Creates a simple HTTP health check server for services.
 *
 * Provides standard endpoints:
 * - GET /health - Health check (Kubernetes liveness probe)
 * - GET /ready - Readiness check (Kubernetes readiness probe)
 * - GET / - Service info with endpoint list
 * - Additional custom routes via additionalRoutes config
 *
 * @param config - Health server configuration
 * @returns HTTP Server instance
 */
export function createSimpleHealthServer(config: SimpleHealthServerConfig): Server {
  const { port, serviceName, logger, description, healthCheck, readyCheck, additionalRoutes } = config;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';

    // Check additional routes first
    if (additionalRoutes && url in additionalRoutes) {
      try {
        await additionalRoutes[url](req, res);
      } catch (error) {
        logger.error('Route handler error', {
          url,
          error: (error as Error).message,
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    if (url === '/health') {
      try {
        const result = await healthCheck();
        const statusCode = result.statusCode ??
          (result.status === 'healthy' || result.status === 'degraded' ? 200 : 503);

        // Remove statusCode from the response payload
        const { statusCode: _sc, ...responseData } = result;
        const response = {
          service: serviceName,
          ...responseData,
          timestamp: Date.now(),
        };

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        logger.error('Health check failed', { error: (error as Error).message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: serviceName,
          status: 'error',
          error: 'Internal health check failed',
        }));
      }
    } else if (url === '/ready') {
      const ready = readyCheck ? readyCheck() : true;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        ready,
      }));
    } else if (url === '/') {
      const endpoints = ['/health', '/ready'];
      if (additionalRoutes) {
        endpoints.push(...Object.keys(additionalRoutes));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        description: description ?? `${serviceName} Service`,
        endpoints,
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    logger.debug(`${serviceName} health server listening on port ${port}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const errorCode = error.code;

    if (errorCode === 'EADDRINUSE') {
      logger.error('Health server port already in use', {
        port,
        service: serviceName,
        error: error.message,
        hint: `Another process is using port ${port}. Check for duplicate services or use a different port.`,
      });
      process.exit(1);
    } else if (errorCode === 'EACCES') {
      logger.error('Health server port requires elevated privileges', {
        port,
        service: serviceName,
        error: error.message,
        hint: `Port ${port} requires root/admin privileges. Use a port > 1024.`,
      });
      process.exit(1);
    } else {
      logger.error('Health server error', {
        service: serviceName,
        code: errorCode,
        error: error.message,
      });
    }
  });

  return server;
}

// =============================================================================
// Service Runner
// =============================================================================

/**
 * Wraps a service's main() function with standard error handling and Jest guard.
 *
 * Provides:
 * - Jest auto-start guard (skips when JEST_WORKER_ID is set)
 * - Top-level catch with logging and process.exit(1)
 *
 * @param config - Service runner configuration
 */
export function runServiceMain(config: RunServiceMainConfig): void {
  const { main, serviceName, logger } = config;

  // Skip auto-start during tests
  if (process.env.JEST_WORKER_ID) {
    return;
  }

  main().catch((error) => {
    const message = `Unhandled error in ${serviceName}`;
    if (logger) {
      logger.error(message, { error });
    } else {
      console.error(`${message}:`, error);
    }
    process.exit(1);
  });
}

/**
 * Close an HTTP server with a timeout to prevent hanging during shutdown.
 * Convenience utility for shutdown handlers.
 *
 * Uses the safeResolve flag pattern (see partition-service-utils.ts) to avoid
 * race conditions between server.close() callback and timeout.
 *
 * @param server - HTTP server to close (null is safely handled)
 * @param timeoutMs - Maximum time to wait for server close (default: 5000ms)
 * @returns Promise that resolves when server is closed or timeout expires
 */
export async function closeHealthServer(server: Server | null, timeoutMs = 5000): Promise<void> {
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

    const timer = setTimeout(() => {
      safeResolve();
    }, timeoutMs);

    server.close(() => {
      clearTimeout(timer);
      safeResolve();
    });
  });
}

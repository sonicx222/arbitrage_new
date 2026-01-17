/**
 * Shared Partition Service Utilities
 *
 * Common utilities for all partition detector services (P1-P4).
 * Reduces code duplication and ensures consistency across partitions.
 *
 * Features:
 * - Port validation and parsing
 * - Chain validation and filtering
 * - HTTP health server creation
 * - Graceful shutdown handling
 * - Event handler setup
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.3-S3.1.6: Partition service implementations
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { CHAINS } from '../../config/src';

// =============================================================================
// Types
// =============================================================================

export interface PartitionServiceConfig {
  /** Partition ID (e.g., 'asia-fast', 'l2-turbo') */
  partitionId: string;

  /** Service name for logging and health responses */
  serviceName: string;

  /** Default chains for this partition */
  defaultChains: readonly string[];

  /** Default health check port */
  defaultPort: number;

  /** Region ID for health responses */
  region: string;

  /** Provider name (e.g., 'oracle', 'fly') */
  provider: string;
}

export interface HealthServerOptions {
  /** Port to listen on */
  port: number;

  /** Service config for responses */
  config: PartitionServiceConfig;

  /** Detector instance for health checks */
  detector: PartitionDetectorInterface;

  /** Logger instance */
  logger: ReturnType<typeof createLogger>;
}

export interface PartitionDetectorInterface extends EventEmitter {
  getPartitionHealth(): Promise<{
    status: string;
    partitionId: string;
    chainHealth: Map<string, unknown>;
    uptimeSeconds: number;
    totalEventsProcessed: number;
    memoryUsage: number;
  }>;
  getHealthyChains(): string[];
  getStats(): {
    partitionId: string;
    chains: string[];
    totalEventsProcessed: number;
    totalOpportunitiesFound: number;
    uptimeSeconds: number;
    memoryUsageMB: number;
    chainStats: Map<string, unknown>;
  };
  isRunning(): boolean;
  getPartitionId(): string;
  getChains(): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

// =============================================================================
// Port Validation (P7-FIX Pattern)
// =============================================================================

/**
 * Validates and parses a port number from environment variable.
 * Returns defaultPort if the value is invalid or not provided.
 *
 * @param portEnv - The port environment variable value
 * @param defaultPort - Default port to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Valid port number
 */
export function parsePort(
  portEnv: string | undefined,
  defaultPort: number,
  logger?: ReturnType<typeof createLogger>
): number {
  if (!portEnv) {
    return defaultPort;
  }

  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    if (logger) {
      logger.warn('Invalid HEALTH_CHECK_PORT, using default', {
        provided: portEnv,
        default: defaultPort
      });
    }
    return defaultPort;
  }
  return parsed;
}

// =============================================================================
// Chain Validation (P4-FIX Pattern)
// =============================================================================

/**
 * Validates chains from environment variable against known chain IDs.
 * Returns only valid chains, or defaults if none are valid.
 *
 * @param chainsEnv - Comma-separated chain IDs from environment
 * @param defaultChains - Default chains to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Array of valid chain IDs
 */
export function validateAndFilterChains(
  chainsEnv: string | undefined,
  defaultChains: readonly string[],
  logger?: ReturnType<typeof createLogger>
): string[] {
  if (!chainsEnv) {
    return [...defaultChains];
  }

  // Chain IDs are the keys of the CHAINS object
  const validChainIds = Object.keys(CHAINS);
  const requestedChains = chainsEnv.split(',').map(c => c.trim().toLowerCase());
  const validChains: string[] = [];
  const invalidChains: string[] = [];

  for (const chain of requestedChains) {
    if (validChainIds.includes(chain)) {
      validChains.push(chain);
    } else {
      invalidChains.push(chain);
    }
  }

  if (invalidChains.length > 0 && logger) {
    logger.warn('Invalid chain IDs in PARTITION_CHAINS, ignoring', {
      invalidChains,
      validChains,
      availableChains: validChainIds
    });
  }

  if (validChains.length === 0) {
    if (logger) {
      logger.warn('No valid chains in PARTITION_CHAINS, using defaults', {
        defaults: defaultChains
      });
    }
    return [...defaultChains];
  }

  return validChains;
}

// =============================================================================
// Health Server (P12-P14 Refactor)
// =============================================================================

/**
 * Creates an HTTP health check server for partition services.
 * Provides consistent endpoints across all partitions.
 *
 * Endpoints:
 * - GET / - Service info
 * - GET /health, /healthz - Health status
 * - GET /ready - Readiness check
 * - GET /stats - Detailed statistics
 *
 * @param options - Health server configuration
 * @returns HTTP Server instance
 */
export function createPartitionHealthServer(options: HealthServerOptions): Server {
  const { port, config, detector, logger } = options;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/healthz') {
      try {
        const health = await detector.getPartitionHealth();
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: health.status,
          partitionId: health.partitionId,
          chains: Array.from(health.chainHealth.keys()),
          healthyChains: detector.getHealthyChains(),
          uptime: health.uptimeSeconds,
          eventsProcessed: health.totalEventsProcessed,
          memoryMB: Math.round(health.memoryUsage / 1024 / 1024),
          region: config.region,
          timestamp: Date.now()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: 'error',
          error: (error as Error).message
        }));
      }
    } else if (req.url === '/stats') {
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: config.serviceName,
          status: 'error',
          error: (error as Error).message
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
        endpoints: ['/health', '/healthz', '/ready', '/stats']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    logger.info(`${config.serviceName} health server listening on port ${port}`);
  });

  server.on('error', (error) => {
    logger.error('Health server error', { error });
  });

  return server;
}

// =============================================================================
// Graceful Shutdown (P15 Refactor)
// =============================================================================

/** Default timeout for shutdown operations in milliseconds */
export const SHUTDOWN_TIMEOUT_MS = 5000;

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
    // Close health server first with timeout (P8-FIX pattern)
    if (healthServer) {
      let timeoutId: NodeJS.Timeout | null = null;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          healthServer.close((err) => {
            if (timeoutId) clearTimeout(timeoutId);
            if (err) reject(err);
            else resolve();
          });
        }),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Health server close timeout')),
            SHUTDOWN_TIMEOUT_MS
          );
        })
      ]).catch((err) => {
        if (timeoutId) clearTimeout(timeoutId);
        logger.warn('Health server close error or timeout', { error: (err as Error).message });
      });
      logger.info('Health server closed');
    }

    await detector.stop();
    logger.info(`${serviceName} shutdown complete`);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

// =============================================================================
// Event Handlers (P16 Refactor)
// =============================================================================

/**
 * Sets up standard event handlers for a partition detector.
 * Provides consistent logging across all partitions.
 *
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param partitionId - Partition ID for log context
 */
export function setupDetectorEventHandlers(
  detector: PartitionDetectorInterface,
  logger: ReturnType<typeof createLogger>,
  partitionId: string
): void {
  detector.on('priceUpdate', (update: { chain: string; dex: string; price: number }) => {
    logger.debug('Price update', {
      partition: partitionId,
      chain: update.chain,
      dex: update.dex,
      price: update.price
    });
  });

  detector.on('opportunity', (opp: {
    id: string;
    type: string;
    buyDex: string;
    sellDex: string;
    expectedProfit: number;
    profitPercentage: number;
  }) => {
    logger.info('Arbitrage opportunity detected', {
      partition: partitionId,
      id: opp.id,
      type: opp.type,
      buyDex: opp.buyDex,
      sellDex: opp.sellDex,
      profit: opp.expectedProfit,
      percentage: opp.profitPercentage.toFixed(2) + '%'  // profitPercentage is already a percentage value
    });
  });

  detector.on('chainError', ({ chainId, error }: { chainId: string; error: Error }) => {
    logger.error(`Chain error: ${chainId}`, {
      partition: partitionId,
      error: error.message
    });
  });

  detector.on('chainConnected', ({ chainId }: { chainId: string }) => {
    logger.info(`Chain connected: ${chainId}`, { partition: partitionId });
  });

  detector.on('chainDisconnected', ({ chainId }: { chainId: string }) => {
    logger.warn(`Chain disconnected: ${chainId}`, { partition: partitionId });
  });

  detector.on('failoverEvent', (event: unknown) => {
    logger.warn('Failover event received', { partition: partitionId, ...event as object });
  });
}

// =============================================================================
// Process Signal Handlers
// =============================================================================

/**
 * Cleanup function returned by setupProcessHandlers to remove registered listeners.
 * Call this during testing or when reinitializing handlers.
 */
export type ProcessHandlerCleanup = () => void;

/**
 * Sets up process signal handlers for graceful shutdown.
 *
 * P19-FIX: Uses a shutdown flag to prevent multiple concurrent shutdown attempts
 * when signals arrive close together (e.g., SIGTERM followed by SIGINT).
 *
 * S3.2.3-FIX: Returns cleanup function to prevent MaxListenersExceeded warnings
 * when handlers are registered multiple times (e.g., in tests).
 *
 * @param healthServerRef - Reference to health server (use object to allow mutation)
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 * @returns Cleanup function to remove all registered handlers
 */
export function setupProcessHandlers(
  healthServerRef: { current: Server | null },
  detector: PartitionDetectorInterface,
  logger: ReturnType<typeof createLogger>,
  serviceName: string
): ProcessHandlerCleanup {
  // P19-FIX: Guard flag to prevent multiple shutdown calls
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    // P19-FIX: Skip if already shutting down
    if (isShuttingDown) {
      logger.info(`Already shutting down, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;
    await shutdownPartitionService(signal, healthServerRef.current, detector, logger, serviceName);
  };

  // S3.2.3-FIX: Store handler references for cleanup
  const sigtermHandler = () => shutdown('SIGTERM');
  const sigintHandler = () => shutdown('SIGINT');
  const uncaughtHandler = (error: Error) => {
    logger.error(`Uncaught exception in ${serviceName}`, { error });
    shutdown('uncaughtException').catch(() => {
      process.exit(1);
    });
  };
  const rejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
    logger.error(`Unhandled rejection in ${serviceName}`, { reason, promise });
  };

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', rejectionHandler);

  // S3.2.3-FIX: Return cleanup function to prevent listener accumulation
  return () => {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', rejectionHandler);
  };
}

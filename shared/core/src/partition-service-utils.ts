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
// Typed Environment Configuration (Standardized across P1-P4)
// =============================================================================

/**
 * Typed environment configuration for partition services.
 * Provides compile-time safety for environment variable handling.
 *
 * ARCHITECTURE NOTE:
 * The RPC/WS URLs parsed here are used for VALIDATION AND OPERATOR FEEDBACK ONLY.
 * The actual URL values flow through the shared CHAINS config in @arbitrage/config,
 * which reads from the same environment variables at module load time.
 *
 * This validation layer provides:
 * - Production deployment warnings for operators about missing private endpoints
 * - Typed configuration for IDE autocomplete and compile-time safety
 * - Centralized environment parsing for testability
 *
 * NOTE: Environment config is parsed ONCE at module load time and should be
 * treated as immutable. If you need to test with different env values,
 * use jest.resetModules() to force a fresh module import.
 *
 * @see shared/config/src/chains/index.ts - Where env vars like BSC_RPC_URL are consumed
 */
export interface PartitionEnvironmentConfig {
  /** Redis URL (required in production) */
  redisUrl: string | undefined;
  /** Override chains to monitor */
  partitionChains: string | undefined;
  /** Health check port override */
  healthCheckPort: string | undefined;
  /** Instance identifier */
  instanceId: string | undefined;
  /** Region identifier override */
  regionId: string | undefined;
  /** Enable cross-region health reporting */
  enableCrossRegionHealth: boolean;
  /** Node environment */
  nodeEnv: string;
  /** RPC URLs for validation (actual URLs consumed by @arbitrage/config) */
  rpcUrls: Record<string, string | undefined>;
  /** WebSocket URLs for validation (actual URLs consumed by @arbitrage/config) */
  wsUrls: Record<string, string | undefined>;
}

/**
 * Parse environment variables into typed configuration for a partition.
 *
 * @param chainNames - Array of chain names to parse RPC/WS URLs for
 * @returns Typed environment configuration
 */
export function parsePartitionEnvironmentConfig(
  chainNames: readonly string[]
): PartitionEnvironmentConfig {
  const rpcUrls: Record<string, string | undefined> = {};
  const wsUrls: Record<string, string | undefined> = {};

  // Parse RPC/WS URLs for each chain
  for (const chain of chainNames) {
    const upperChain = chain.toUpperCase();
    rpcUrls[chain] = process.env[`${upperChain}_RPC_URL`];
    wsUrls[chain] = process.env[`${upperChain}_WS_URL`];
  }

  return {
    redisUrl: process.env.REDIS_URL,
    partitionChains: process.env.PARTITION_CHAINS,
    healthCheckPort: process.env.HEALTH_CHECK_PORT,
    instanceId: process.env.INSTANCE_ID,
    regionId: process.env.REGION_ID,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
    nodeEnv: process.env.NODE_ENV || 'development',
    rpcUrls,
    wsUrls
  };
}

/**
 * Validate environment configuration for a partition service.
 * Exits process on critical errors, warns on non-critical issues.
 *
 * @param envConfig - Parsed environment configuration
 * @param partitionId - Partition identifier for logging context
 * @param chainNames - Chain names to validate RPC/WS URLs for
 * @param logger - Logger instance for warnings
 */
export function validatePartitionEnvironmentConfig(
  envConfig: PartitionEnvironmentConfig,
  partitionId: string,
  chainNames: readonly string[],
  logger?: ReturnType<typeof createLogger>
): void {
  // Validate REDIS_URL - required for all partition services (except in test)
  if (!envConfig.redisUrl && envConfig.nodeEnv !== 'test') {
    exitWithConfigError('REDIS_URL environment variable is required', {
      partitionId,
      hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
    }, logger);
  }

  // Warn about missing RPC/WebSocket URLs in production
  if (envConfig.nodeEnv === 'production') {
    const missingRpcUrls: string[] = [];
    const missingWsUrls: string[] = [];

    for (const chain of chainNames) {
      const upperChain = chain.toUpperCase();
      if (!envConfig.rpcUrls[chain]) {
        missingRpcUrls.push(`${upperChain}_RPC_URL`);
      }
      if (!envConfig.wsUrls[chain]) {
        missingWsUrls.push(`${upperChain}_WS_URL`);
      }
    }

    if (missingRpcUrls.length > 0 && logger) {
      logger.warn('Production deployment without custom RPC URLs - public endpoints may have rate limits', {
        partitionId,
        missingRpcUrls,
        hint: 'Configure private RPC endpoints (Alchemy, Infura, QuickNode) for production reliability'
      });
    }

    if (missingWsUrls.length > 0 && logger) {
      logger.warn('Production deployment without custom WebSocket URLs - public endpoints may be unreliable', {
        partitionId,
        missingWsUrls,
        hint: 'Configure private WebSocket endpoints for production reliability'
      });
    }
  }
}

/**
 * Generate a unique instance ID for a partition service.
 * Uses HOSTNAME if available, falls back to 'local' with timestamp for uniqueness.
 *
 * @param partitionId - Partition identifier (e.g., 'asia-fast', 'l2-turbo')
 * @param providedId - Optional pre-configured instance ID from environment
 * @returns Unique instance identifier
 */
export function generateInstanceId(
  partitionId: string,
  providedId?: string
): string {
  if (providedId) {
    return providedId;
  }
  const hostname = process.env.HOSTNAME || 'local';
  return `${partitionId}-${hostname}-${Date.now()}`;
}

// =============================================================================
// Critical Configuration Validation (Shared across all partitions)
// =============================================================================

/**
 * Logs a critical configuration error and exits the process.
 * Use this for fatal configuration issues that prevent service startup.
 *
 * Returns `never` to help TypeScript understand this terminates the process,
 * allowing proper control flow analysis.
 *
 * @param message - Error message to log
 * @param context - Additional context for the error
 * @param logger - Logger instance (uses console.error as fallback)
 */
export function exitWithConfigError(
  message: string,
  context: Record<string, unknown>,
  logger?: ReturnType<typeof createLogger>
): never {
  if (logger) {
    logger.error(message, context);
  } else {
    console.error(message, context);
  }
  process.exit(1);
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
// Health Check Cache (PERF-FIX)
// =============================================================================

/** Cache TTL in milliseconds for health check results */
const HEALTH_CACHE_TTL_MS = 1000;

interface HealthCacheEntry {
  data: {
    status: string;
    partitionId: string;
    chainHealth: Map<string, unknown>;
    uptimeSeconds: number;
    totalEventsProcessed: number;
    memoryUsage: number;
  };
  timestamp: number;
}

/**
 * Simple in-memory cache for health check data.
 * Prevents repetitive async calls on high-frequency health check requests.
 * Each server instance has its own cache to avoid cross-service contamination.
 */
function createHealthCache() {
  let cache: HealthCacheEntry | null = null;

  return {
    get(): HealthCacheEntry['data'] | null {
      if (!cache) return null;
      if (Date.now() - cache.timestamp > HEALTH_CACHE_TTL_MS) {
        cache = null;
        return null;
      }
      return cache.data;
    },
    set(data: HealthCacheEntry['data']): void {
      cache = { data, timestamp: Date.now() };
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

  // PERF-FIX: Create cache per server instance to avoid repetitive async calls
  const healthCache = createHealthCache();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      try {
        // PERF-FIX: Use cached health data if available and fresh
        let health = healthCache.get();
        if (!health) {
          health = await detector.getPartitionHealth();
          healthCache.set(health);
        }
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
        endpoints: ['/health', '/ready', '/stats']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    logger.info(`${config.serviceName} health server listening on port ${port}`);
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
 * FIX 10.3: Uses conditional debug logging to avoid object allocation
 * on hot-path events (priceUpdate fires 100s-1000s times/sec).
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
  // FIX 10.3: Pre-check if debug logging is enabled to avoid hot-path object allocation
  // priceUpdate events fire 100s-1000s times/sec - even creating log objects has GC cost
  detector.on('priceUpdate', (update: { chain: string; dex: string; price: number }) => {
    // Only create log object if debug level is enabled
    if (logger.isLevelEnabled?.('debug') ?? logger.level === 'debug') {
      logger.debug('Price update', {
        partition: partitionId,
        chain: update.chain,
        dex: update.dex,
        price: update.price
      });
    }
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

  // FIX: Handle statusChange event emitted by UnifiedChainDetector's chainInstanceManager
  detector.on('statusChange', ({ chainId, oldStatus, newStatus }: {
    chainId: string;
    oldStatus: string;
    newStatus: string;
  }) => {
    // Log status changes with appropriate severity based on transition
    const isRecovery = oldStatus === 'error' || oldStatus === 'disconnected';
    const isDegradation = newStatus === 'error' || newStatus === 'disconnected';

    if (isDegradation) {
      logger.warn(`Chain status degraded: ${chainId}`, {
        partition: partitionId,
        from: oldStatus,
        to: newStatus
      });
    } else if (isRecovery) {
      logger.info(`Chain status recovered: ${chainId}`, {
        partition: partitionId,
        from: oldStatus,
        to: newStatus
      });
    } else {
      // FIX 10.3: Conditional debug logging for status changes
      if (logger.isLevelEnabled?.('debug') ?? logger.level === 'debug') {
        logger.debug(`Chain status changed: ${chainId}`, {
          partition: partitionId,
          from: oldStatus,
          to: newStatus
        });
      }
    }
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

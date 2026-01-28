/**
 * Unified Detector Service Entry Point
 *
 * Multi-chain detector that runs multiple blockchain detectors
 * in a single process based on partition configuration.
 *
 * Environment Variables:
 * - PARTITION_ID: Partition to run (default: asia-fast)
 * - PARTITION_CHAINS: Override chains (comma-separated)
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - REGION_ID: Region for cross-region health reporting
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3001)
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { UnifiedChainDetector, UnifiedDetectorConfig } from './unified-detector';
import { createLogger, parsePort } from '@arbitrage/core';
import { getPartition } from '@arbitrage/config';
import { DEFAULT_HEALTH_CHECK_PORT } from './constants';

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('unified-detector:main');

// Store server reference for graceful shutdown
let healthServer: Server | null = null;

// FIX Inconsistency 6.2: Use parsePort for consistent port validation
const healthCheckPort = parsePort(process.env.HEALTH_CHECK_PORT, DEFAULT_HEALTH_CHECK_PORT, logger);

// Get region from partition config for consistent health response
const partitionConfig = process.env.PARTITION_ID ? getPartition(process.env.PARTITION_ID) : null;
const regionId = process.env.REGION_ID || partitionConfig?.region || 'asia-southeast1';

const config: UnifiedDetectorConfig = {
  partitionId: process.env.PARTITION_ID,
  chains: process.env.PARTITION_CHAINS?.split(',').map(c => c.trim()),
  instanceId: process.env.INSTANCE_ID || `unified-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// HTTP Health Check Server
// FIX Inconsistency 6.1: Aligned response format with createPartitionHealthServer
// =============================================================================

/** Health cache TTL in milliseconds (matches partition-service-utils) */
const HEALTH_CACHE_TTL_MS = 1000;

interface HealthCacheEntry {
  data: Awaited<ReturnType<typeof detector.getPartitionHealth>>;
  timestamp: number;
}

let healthCache: HealthCacheEntry | null = null;

function getHealthFromCache(): HealthCacheEntry['data'] | null {
  if (!healthCache) return null;
  if (Date.now() - healthCache.timestamp > HEALTH_CACHE_TTL_MS) {
    healthCache = null;
    return null;
  }
  return healthCache.data;
}

function setHealthCache(data: HealthCacheEntry['data']): void {
  healthCache = { data, timestamp: Date.now() };
}

function createHealthServer(port: number): Server {
  const serviceName = `unified-detector-${config.partitionId || 'default'}`;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      try {
        // PERF-FIX: Use cached health data if available and fresh
        let health = getHealthFromCache();
        if (!health) {
          health = await detector.getPartitionHealth();
          setHealthCache(health);
        }
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

        // FIX Inconsistency 6.1: Consistent response format with partition services
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: serviceName,
          status: health.status,
          partitionId: health.partitionId,
          chains: Array.from(health.chainHealth.keys()),
          healthyChains: detector.getHealthyChains(),
          uptime: health.uptimeSeconds,
          eventsProcessed: health.totalEventsProcessed,
          memoryMB: Math.round(health.memoryUsage / 1024 / 1024),
          region: regionId,
          timestamp: Date.now()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: serviceName,
          status: 'error',
          error: (error as Error).message
        }));
      }
    } else if (req.url === '/stats') {
      try {
        const stats = detector.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: serviceName,
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
          service: serviceName,
          status: 'error',
          error: (error as Error).message
        }));
      }
    } else if (req.url === '/ready') {
      const ready = detector.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        ready,
        chains: detector.getChains()
      }));
    } else if (req.url === '/') {
      // FIX: Add root endpoint for service info (consistent with partition services)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: serviceName,
        description: `${config.partitionId || 'unified'} Partition Detector`,
        partitionId: config.partitionId,
        chains: config.chains || [],
        region: regionId,
        endpoints: ['/health', '/ready', '/stats']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    logger.info(`${serviceName} health server listening on port ${port}`);
  });

  // CRITICAL-FIX: Handle fatal server errors appropriately
  server.on('error', (error: NodeJS.ErrnoException) => {
    const errorCode = error.code;

    if (errorCode === 'EADDRINUSE') {
      logger.error('Health server port already in use - cannot start service', {
        port,
        service: serviceName,
        error: error.message,
        hint: `Another process is using port ${port}. Check for duplicate services or use a different HEALTH_CHECK_PORT.`
      });
      process.exit(1);
    } else if (errorCode === 'EACCES') {
      logger.error('Health server port requires elevated privileges', {
        port,
        service: serviceName,
        error: error.message,
        hint: `Port ${port} requires root/admin privileges. Use a port > 1024 or run with elevated permissions.`
      });
      process.exit(1);
    } else {
      // Non-fatal errors - log but continue
      logger.error('Health server error', {
        service: serviceName,
        code: errorCode,
        error: error.message
      });
    }
  });

  return server;
}

// =============================================================================
// Event Handlers
// =============================================================================

// NOTE: Price update event logging removed - fires 100s-1000s times/sec
// Use metrics/monitoring for price update visibility if needed
// detector.on('priceUpdate', ...) intentionally not logged

detector.on('opportunity', (opp) => {
  logger.info('Arbitrage opportunity detected', {
    id: opp.id,
    type: opp.type,
    buyDex: opp.buyDex,
    sellDex: opp.sellDex,
    profit: opp.expectedProfit,
    percentage: opp.profitPercentage.toFixed(2) + '%'  // profitPercentage is already a percentage value
  });
});

detector.on('chainError', ({ chainId, error }) => {
  logger.error(`Chain error: ${chainId}`, { error: error.message });
});

detector.on('failoverEvent', (event) => {
  logger.warn('Failover event received', event);
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

// FIX B5: Guard against double shutdown when user presses Ctrl+C multiple times
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.debug(`Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // BUG-FIX: Clear health cache to prevent stale data on restart scenarios
    healthCache = null;

    // Close health server first
    if (healthServer) {
      await new Promise<void>((resolve, reject) => {
        healthServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info('Health server closed');
    }

    // BUG-FIX: Remove event listeners from detector to prevent memory leaks
    // This is important if the process doesn't exit (e.g., in tests)
    detector.removeAllListeners();

    await detector.stop();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  shutdown('uncaughtException').catch(() => {
    // If shutdown fails, force exit
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting Unified Detector Service', {
    partitionId: config.partitionId,
    chains: config.chains,
    region: regionId,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first
    healthServer = createHealthServer(config.healthCheckPort || DEFAULT_HEALTH_CHECK_PORT);

    // Start detector
    await detector.start();

    logger.info('Unified Detector Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains()
    });

  } catch (error) {
    logger.error('Failed to start Unified Detector Service', { error });

    // BUG-4.2-FIX: Await health server close before exiting
    if (healthServer) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Health server close timed out');
          resolve();
        }, 1000);

        healthServer!.close((err) => {
          clearTimeout(timeout);
          if (err) {
            logger.warn('Failed to close health server during cleanup', { error: err });
          } else {
            logger.info('Health server closed after startup failure');
          }
          resolve();
        });
      });
    }

    process.exit(1);
  }
}

// Run - only when this is the main entry point (not when imported by tests)
// Check for Jest worker to prevent auto-start during test imports
if (!process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    if (logger) {
      logger.error('Fatal error in main', { error });
    } else {
      console.error('Fatal error in main (logger unavailable):', error);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports (re-export from exports.ts for backwards compatibility)
// =============================================================================

// NOTE: For library imports, use the package which points to exports.ts
// This file (index.ts) is the SERVICE entry point and should only be run directly.
// Re-exports are kept here for any code that directly imports from index.ts
export * from './exports';

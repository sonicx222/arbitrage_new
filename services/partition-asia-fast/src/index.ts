/**
 * P1 Asia-Fast Partition Service Entry Point
 *
 * Deploys the unified detector for the Asia-Fast partition:
 * - Chains: BSC, Polygon, Avalanche, Fantom
 * - Region: Oracle Cloud Singapore (asia-southeast1)
 * - Resource Profile: Heavy (4 chains)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P1 partition.
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'asia-fast' by default
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3001)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.3: Create P1 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { UnifiedChainDetector, UnifiedDetectorConfig } from '../../unified-detector/src/unified-detector';
import { createLogger } from '../../../shared/core/src';
// P1-FIX: PARTITION_IDS is defined in index.ts, not partitions.ts
import { getPartition } from '../../../shared/config/src/partitions';
import { PARTITION_IDS, CHAINS } from '../../../shared/config/src';

// =============================================================================
// P1 Partition Constants
// =============================================================================

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-asia-fast:main');

// P5-FIX: Single partition config retrieval to prevent redundancy
const partitionConfig = getPartition(P1_PARTITION_ID);
if (!partitionConfig) {
  logger.error('P1 partition configuration not found', { partitionId: P1_PARTITION_ID });
  process.exit(1);
}

// P3-FIX: Derive chains and region from partition config to prevent drift
const P1_CHAINS: readonly string[] = partitionConfig.chains;
const P1_REGION = partitionConfig.region;

// P7-FIX: Validate and parse port number with fallback
function parsePort(portEnv: string | undefined, defaultPort: number): number {
  if (!portEnv) {
    return defaultPort;
  }
  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    logger.warn('Invalid HEALTH_CHECK_PORT, using default', {
      provided: portEnv,
      default: defaultPort
    });
    return defaultPort;
  }
  return parsed;
}

// P4-FIX: Validate chains from environment variable
function validateAndFilterChains(chainsEnv: string | undefined): string[] {
  if (!chainsEnv) {
    return [...P1_CHAINS];
  }

  // Chain IDs are the keys of the CHAINS object (e.g., 'bsc', 'polygon', 'ethereum')
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

  if (invalidChains.length > 0) {
    logger.warn('Invalid chain IDs in PARTITION_CHAINS, ignoring', {
      invalidChains,
      validChains,
      availableChains: validChainIds
    });
  }

  if (validChains.length === 0) {
    logger.warn('No valid chains in PARTITION_CHAINS, using defaults', {
      defaults: P1_CHAINS
    });
    return [...P1_CHAINS];
  }

  return validChains;
}

// Store server reference for graceful shutdown
let healthServer: Server | null = null;

const config: UnifiedDetectorConfig = {
  partitionId: P1_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS),
  instanceId: process.env.INSTANCE_ID || `p1-asia-fast-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P1_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, 3001)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// HTTP Health Check Server
// =============================================================================

function createHealthServer(port: number): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/healthz') {
      try {
        const health = await detector.getPartitionHealth();
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'partition-asia-fast',
          status: health.status,
          partitionId: health.partitionId,
          chains: Array.from(health.chainHealth.keys()),
          healthyChains: detector.getHealthyChains(),
          uptime: health.uptimeSeconds,
          eventsProcessed: health.totalEventsProcessed,
          memoryMB: Math.round(health.memoryUsage / 1024 / 1024),
          region: P1_REGION,
          timestamp: Date.now()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'partition-asia-fast',
          status: 'error',
          error: (error as Error).message
        }));
      }
    } else if (req.url === '/stats') {
      try {
        const stats = detector.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'partition-asia-fast',
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
          service: 'partition-asia-fast',
          status: 'error',
          error: (error as Error).message
        }));
      }
    } else if (req.url === '/ready') {
      // P6-FIX: Use config.chains (actual configured chains) instead of P1_CHAINS (defaults)
      const ready = detector.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'partition-asia-fast',
        ready,
        chains: config.chains
      }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'partition-asia-fast',
        description: 'P1 Asia-Fast Partition Detector',
        partitionId: P1_PARTITION_ID,
        chains: P1_CHAINS,
        region: P1_REGION,
        endpoints: ['/health', '/healthz', '/ready', '/stats']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, () => {
    logger.info(`P1 Asia-Fast health server listening on port ${port}`);
  });

  server.on('error', (error) => {
    logger.error('Health server error', { error });
  });

  return server;
}

// =============================================================================
// Event Handlers
// =============================================================================

detector.on('priceUpdate', (update) => {
  logger.debug('Price update', {
    partition: P1_PARTITION_ID,
    chain: update.chain,
    dex: update.dex,
    price: update.price
  });
});

detector.on('opportunity', (opp) => {
  logger.info('Arbitrage opportunity detected', {
    partition: P1_PARTITION_ID,
    id: opp.id,
    type: opp.type,
    buyDex: opp.buyDex,
    sellDex: opp.sellDex,
    profit: opp.expectedProfit,
    percentage: (opp.profitPercentage * 100).toFixed(2) + '%'
  });
});

detector.on('chainError', ({ chainId, error }) => {
  logger.error(`Chain error: ${chainId}`, {
    partition: P1_PARTITION_ID,
    error: error.message
  });
});

detector.on('chainConnected', ({ chainId }) => {
  logger.info(`Chain connected: ${chainId}`, { partition: P1_PARTITION_ID });
});

detector.on('chainDisconnected', ({ chainId }) => {
  logger.warn(`Chain disconnected: ${chainId}`, { partition: P1_PARTITION_ID });
});

detector.on('failoverEvent', (event) => {
  logger.warn('Failover event received', { partition: P1_PARTITION_ID, ...event });
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down P1 Asia-Fast partition...`);

  const SHUTDOWN_TIMEOUT_MS = 5000;

  try {
    // Close health server first with timeout to prevent hanging
    if (healthServer) {
      // P8-FIX: Track timeout timer to clear it and prevent resource leak
      let timeoutId: NodeJS.Timeout | null = null;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          healthServer!.close((err) => {
            if (timeoutId) clearTimeout(timeoutId);
            if (err) reject(err);
            else resolve();
          });
        }),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Health server close timeout')), SHUTDOWN_TIMEOUT_MS);
        })
      ]).catch((err) => {
        if (timeoutId) clearTimeout(timeoutId);
        logger.warn('Health server close error or timeout', { error: (err as Error).message });
      });
      logger.info('Health server closed');
    }

    await detector.stop();
    logger.info('P1 Asia-Fast partition shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in P1 Asia-Fast partition', { error });
  shutdown('uncaughtException').catch(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection in P1 Asia-Fast partition', { reason, promise });
});

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting P1 Asia-Fast Partition Service', {
    partitionId: P1_PARTITION_ID,
    chains: config.chains,
    region: P1_REGION,
    provider: partitionConfig!.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first
    healthServer = createHealthServer(config.healthCheckPort || 3001);

    // Start detector
    await detector.start();

    logger.info('P1 Asia-Fast Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains()
    });

  } catch (error) {
    logger.error('Failed to start P1 Asia-Fast Partition Service', { error });
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error('Fatal error in P1 Asia-Fast partition main', { error });
  process.exit(1);
});

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P1_PARTITION_ID, P1_CHAINS, P1_REGION };

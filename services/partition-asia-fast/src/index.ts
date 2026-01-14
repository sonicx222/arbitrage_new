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

import { Server } from 'http';
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import {
  createLogger,
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  PartitionServiceConfig
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P1 Partition Constants
// =============================================================================

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;
const P1_DEFAULT_PORT = 3001;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-asia-fast:main');

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P1_PARTITION_ID);
if (!partitionConfig) {
  logger.error('P1 partition configuration not found', { partitionId: P1_PARTITION_ID });
  process.exit(1);
}

// Derive chains and region from partition config (P3-FIX pattern)
const P1_CHAINS: readonly string[] = partitionConfig.chains;
const P1_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P1_PARTITION_ID,
  serviceName: 'partition-asia-fast',
  defaultChains: P1_CHAINS,
  defaultPort: P1_DEFAULT_PORT,
  region: P1_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration
const config: UnifiedDetectorConfig = {
  partitionId: P1_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P1_CHAINS, logger),
  instanceId: process.env.INSTANCE_ID || `p1-asia-fast-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P1_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P1_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P1_PARTITION_ID);

// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================

setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // S3.2.3-FIX: Explicit guard for TypeScript type narrowing (partitionConfig is guaranteed
  // non-null by module-level check that calls process.exit(1), but TS can't narrow across
  // function boundaries at module scope)
  if (!partitionConfig) {
    throw new Error('Partition config unavailable - this should never happen');
  }

  logger.info('Starting P1 Asia-Fast Partition Service', {
    partitionId: P1_PARTITION_ID,
    chains: config.chains,
    region: P1_REGION,
    provider: partitionConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (P12-P14 refactor - Using shared utilities)
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort || P1_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

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

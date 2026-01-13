/**
 * P3 High-Value Partition Service Entry Point
 *
 * Deploys the unified detector for the High-Value partition:
 * - Chains: Ethereum, zkSync, Linea
 * - Region: Oracle Cloud US-East (us-east1)
 * - Resource Profile: Heavy (3 high-value chains)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P3 partition.
 *
 * High-Value partition characteristics:
 * - Longer health checks (30s) for Ethereum's ~12s blocks
 * - Standard failover timeout (60s) for mainnet stability
 * - Heavy resource profile for Ethereum mainnet processing
 * - US-East deployment for proximity to major Ethereum infrastructure
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'high-value' by default
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3003)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.5: Create P3 detector service
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
// P3 Partition Constants
// =============================================================================

const P3_PARTITION_ID = PARTITION_IDS.HIGH_VALUE;
const P3_DEFAULT_PORT = 3003; // Different port from P1 (3001) and P2 (3002)

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-high-value:main');

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P3_PARTITION_ID);
if (!partitionConfig) {
  logger.error('P3 partition configuration not found', { partitionId: P3_PARTITION_ID });
  process.exit(1);
}

// Derive chains and region from partition config (P3-FIX pattern)
const P3_CHAINS: readonly string[] = partitionConfig.chains;
const P3_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P3_PARTITION_ID,
  serviceName: 'partition-high-value',
  defaultChains: P3_CHAINS,
  defaultPort: P3_DEFAULT_PORT,
  region: P3_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration
const config: UnifiedDetectorConfig = {
  partitionId: P3_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P3_CHAINS, logger),
  instanceId: process.env.INSTANCE_ID || `p3-high-value-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P3_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P3_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P3_PARTITION_ID);

// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================

setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting P3 High-Value Partition Service', {
    partitionId: P3_PARTITION_ID,
    chains: config.chains,
    region: P3_REGION,
    provider: partitionConfig!.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (P12-P14 refactor - Using shared utilities)
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort || P3_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

    // Start detector
    await detector.start();

    logger.info('P3 High-Value Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains()
    });

  } catch (error) {
    logger.error('Failed to start P3 High-Value Partition Service', { error });
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error('Fatal error in P3 High-Value partition main', { error });
  process.exit(1);
});

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P3_PARTITION_ID, P3_CHAINS, P3_REGION };

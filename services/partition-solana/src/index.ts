/**
 * P4 Solana-Native Partition Service Entry Point
 *
 * Deploys the unified detector for the Solana-Native partition:
 * - Chain: Solana (non-EVM)
 * - Region: Fly.io US-West (us-west1)
 * - Resource Profile: Heavy (high-throughput chain)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P4 partition.
 *
 * Solana-Native partition characteristics:
 * - Non-EVM chain requiring different connection handling
 * - Fast health checks (10s) for ~400ms block times
 * - Shorter failover timeout (45s) for quick recovery
 * - US-West deployment for proximity to Solana validators
 * - Uses program account subscriptions instead of event logs
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'solana-native' by default
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3004)
 * - SOLANA_RPC_URL: Solana RPC endpoint
 * - SOLANA_WS_URL: Solana WebSocket endpoint
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.6: Create P4 detector service
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
// P4 Partition Constants
// =============================================================================

const P4_PARTITION_ID = PARTITION_IDS.SOLANA_NATIVE;
const P4_DEFAULT_PORT = 3004; // Different port from P1 (3001), P2 (3002), P3 (3003)

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-solana:main');

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P4_PARTITION_ID);
if (!partitionConfig) {
  logger.error('P4 partition configuration not found', { partitionId: P4_PARTITION_ID });
  process.exit(1);
}

// Derive chains and region from partition config (P3-FIX pattern)
const P4_CHAINS: readonly string[] = partitionConfig.chains;
const P4_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P4_PARTITION_ID,
  serviceName: 'partition-solana',
  defaultChains: P4_CHAINS,
  defaultPort: P4_DEFAULT_PORT,
  region: P4_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration
const config: UnifiedDetectorConfig = {
  partitionId: P4_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P4_CHAINS, logger),
  instanceId: process.env.INSTANCE_ID || `p4-solana-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P4_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P4_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P4_PARTITION_ID);

// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================

setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting P4 Solana-Native Partition Service', {
    partitionId: P4_PARTITION_ID,
    chains: config.chains,
    region: P4_REGION,
    provider: partitionConfig!.provider,
    nodeVersion: process.version,
    pid: process.pid,
    nonEvm: true // P4 is the only non-EVM partition
  });

  try {
    // Start health check server first (P12-P14 refactor - Using shared utilities)
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort || P4_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

    // Start detector
    await detector.start();

    logger.info('P4 Solana-Native Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains()
    });

  } catch (error) {
    logger.error('Failed to start P4 Solana-Native Partition Service', { error });
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error('Fatal error in P4 Solana-Native partition main', { error });
  process.exit(1);
});

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P4_PARTITION_ID, P4_CHAINS, P4_REGION };

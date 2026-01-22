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
 * - PARTITION_CHAINS: Override chains to monitor (comma-separated, default: ethereum,zksync,linea)
 * - REDIS_URL: Redis connection URL (required)
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3003)
 * - INSTANCE_ID: Unique instance identifier (default: auto-generated)
 * - REGION_ID: Deployment region (default: us-east1)
 * - ENABLE_CROSS_REGION_HEALTH: Enable cross-region health reporting (default: true)
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

// =============================================================================
// Critical Environment Validation
// CRITICAL-FIX: Validate required environment variables early to fail fast
// =============================================================================

/**
 * Validates critical environment variables and exits with clear error if missing.
 * Returns never to help TypeScript understand this terminates the process.
 */
function exitWithConfigError(message: string, context: Record<string, unknown>): never {
  logger.error(message, context);
  process.exit(1);
}

// Validate REDIS_URL - required for all partition services
if (!process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  exitWithConfigError('REDIS_URL environment variable is required', {
    partitionId: P3_PARTITION_ID,
    hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
  });
}

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P3_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P3 partition configuration not found', { partitionId: P3_PARTITION_ID });
}

// Derive chains and region from partition config (P3-FIX pattern)
// Note: Explicit type annotation for consistency with P1 partition service
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

// S3.2.3-FIX: Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // Note: serviceConfig captures all partition config values at module init time,
  // after validation by exitWithConfigError(), so it's safe to use here

  logger.info('Starting P3 High-Value Partition Service', {
    partitionId: P3_PARTITION_ID,
    chains: config.chains,
    region: P3_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (P12-P14 refactor - Using shared utilities)
    // P7-FIX: Use defensive fallback pattern for consistency with P1 partition
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

    // CRITICAL-FIX: Clean up health server if detector start failed
    // This prevents leaving port bound when process exits due to startup failure
    if (healthServerRef.current) {
      try {
        healthServerRef.current.close();
        logger.info('Health server closed after startup failure');
      } catch (closeError) {
        logger.warn('Failed to close health server during cleanup', { closeError });
      }
    }

    process.exit(1);
  }
}

// Run - only when this is the main entry point (not when imported by tests)
// Check for Jest worker to prevent auto-start during test imports
if (!process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    if (logger) {
      logger.error('Fatal error in P3 High-Value partition main', { error });
    } else {
      console.error('Fatal error in P3 High-Value partition main (logger unavailable):', error);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P3_PARTITION_ID, P3_CHAINS, P3_REGION, cleanupProcessHandlers };

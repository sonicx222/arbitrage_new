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
  exitWithConfigError,
  PartitionServiceConfig,
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P1 Partition Constants
// =============================================================================

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;
// Use centralized port constant (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
const P1_DEFAULT_PORT = PARTITION_PORTS[P1_PARTITION_ID] ?? 3001;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-asia-fast:main');

// =============================================================================
// Critical Environment Validation
// CRITICAL-FIX: Validate required environment variables early to fail fast
// P2-FIX: Using shared exitWithConfigError from @arbitrage/core
// =============================================================================

// Validate REDIS_URL - required for all partition services
if (!process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  exitWithConfigError('REDIS_URL environment variable is required', {
    partitionId: P1_PARTITION_ID,
    hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
  }, logger);
}

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P1_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P1 partition configuration not found', { partitionId: P1_PARTITION_ID }, logger);
}

// Derive chains and region from partition config (P3-FIX pattern)
const P1_CHAINS: readonly string[] = partitionConfig.chains;
const P1_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P1_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P1_PARTITION_ID] ?? 'partition-asia-fast',
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

// S3.2.3-FIX: Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // Note: serviceConfig captures all partition config values at module init time,
  // after validation by exitWithConfigError(), so it's safe to use here

  logger.info('Starting P1 Asia-Fast Partition Service', {
    partitionId: P1_PARTITION_ID,
    chains: config.chains,
    region: P1_REGION,
    provider: serviceConfig.provider,
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

    // CRITICAL-FIX: Clean up health server if detector start failed
    // This prevents leaving port bound when process exits due to startup failure
    // BUG-4.2-FIX: Await health server close before exiting to ensure port is released
    if (healthServerRef.current) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Health server close timed out after 1000ms');
          resolve();
        }, 1000);

        healthServerRef.current!.close((err) => {
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

    // BUG-4.1-FIX: Clean up process handlers before exit to prevent listener leaks
    cleanupProcessHandlers();

    process.exit(1);
  }
}

// Run - only when this is the main entry point (not when imported by tests)
// Check for Jest worker to prevent auto-start during test imports
if (!process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    if (logger) {
      logger.error('Fatal error in P1 Asia-Fast partition main', { error });
    } else {
      console.error('Fatal error in P1 Asia-Fast partition main (logger unavailable):', error);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P1_PARTITION_ID, P1_CHAINS, P1_REGION, cleanupProcessHandlers };

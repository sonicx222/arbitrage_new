/**
 * P2 L2-Turbo Partition Service Entry Point
 *
 * Deploys the unified detector for the L2-Turbo partition:
 * - Chains: Arbitrum, Optimism, Base
 * - Region: Fly.io Singapore (asia-southeast1)
 * - Resource Profile: Standard (3 chains)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P2 partition.
 *
 * L2-specific optimizations:
 * - Faster health checks (10s) for sub-second block times
 * - Shorter failover timeout (45s) for quick recovery
 * - High-frequency event handling for L2 throughput
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'l2-turbo' by default
 * - REDIS_URL: Redis connection URL (required)
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3002)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.4: Create P2 detector service
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
// P2 Partition Constants
// =============================================================================

const P2_PARTITION_ID = PARTITION_IDS.L2_TURBO;
// Use centralized port constant (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
const P2_DEFAULT_PORT = PARTITION_PORTS[P2_PARTITION_ID] ?? 3002;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-l2-turbo:main');

// =============================================================================
// Critical Environment Validation
// CRITICAL-FIX: Validate required environment variables early to fail fast
// Uses shared exitWithConfigError from @arbitrage/core for consistency
// =============================================================================

// Validate REDIS_URL - required for all partition services
if (!process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  exitWithConfigError('REDIS_URL environment variable is required', {
    partitionId: P2_PARTITION_ID,
    hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
  }, logger);
}

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P2_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P2 partition configuration not found', { partitionId: P2_PARTITION_ID }, logger);
}

// Derive chains and region from partition config (P3-FIX pattern)
const P2_CHAINS: readonly string[] = partitionConfig.chains;
const P2_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P2_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P2_PARTITION_ID] ?? 'partition-l2-turbo',
  defaultChains: P2_CHAINS,
  defaultPort: P2_DEFAULT_PORT,
  region: P2_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration
const config: UnifiedDetectorConfig = {
  partitionId: P2_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P2_CHAINS, logger),
  instanceId: process.env.INSTANCE_ID || `p2-l2-turbo-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P2_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P2_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P2_PARTITION_ID);

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

  logger.info('Starting P2 L2-Turbo Partition Service', {
    partitionId: P2_PARTITION_ID,
    chains: config.chains,
    region: P2_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (P12-P14 refactor - Using shared utilities)
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort || P2_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

    // Start detector
    await detector.start();

    logger.info('P2 L2-Turbo Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains()
    });

  } catch (error) {
    logger.error('Failed to start P2 L2-Turbo Partition Service', { error });

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
      logger.error('Fatal error in P2 L2-Turbo partition main', { error });
    } else {
      console.error('Fatal error in P2 L2-Turbo partition main (logger unavailable):', error);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

export { detector, config, P2_PARTITION_ID, P2_CHAINS, P2_REGION, cleanupProcessHandlers };

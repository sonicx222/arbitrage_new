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
 * - INSTANCE_ID: Unique instance identifier (auto-generated if not set)
 * - REGION_ID: Region identifier (default: asia-southeast1)
 * - ENABLE_CROSS_REGION_HEALTH: Enable cross-region health reporting (default: true)
 * - PARTITION_CHAINS: Override default chains (comma-separated)
 *
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
  closeServerWithTimeout,
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  PartitionServiceConfig,
  PartitionEnvironmentConfig,
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
// Partition Configuration Retrieval
// =============================================================================

// Single partition config retrieval
const partitionConfig = getPartition(P2_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P2 partition configuration not found', { partitionId: P2_PARTITION_ID }, logger);
}

// Derive chains and region from partition config
const P2_CHAINS: readonly string[] = partitionConfig.chains;
const P2_REGION = partitionConfig.region;

// =============================================================================
// Environment Configuration (Using shared typed utilities)
// =============================================================================

// Parse environment into typed configuration using shared utility
const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P2_CHAINS);

// Validate environment configuration (exits on critical errors, warns on non-critical)
validatePartitionEnvironmentConfig(envConfig, P2_PARTITION_ID, P2_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

// Service configuration for shared utilities
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

// Unified detector configuration (uses typed envConfig)
const config: UnifiedDetectorConfig = {
  partitionId: P2_PARTITION_ID,
  chains: validateAndFilterChains(envConfig.partitionChains, P2_CHAINS, logger),
  instanceId: generateInstanceId(P2_PARTITION_ID, envConfig.instanceId),
  regionId: envConfig.regionId || P2_REGION,
  enableCrossRegionHealth: envConfig.enableCrossRegionHealth,
  healthCheckPort: parsePort(envConfig.healthCheckPort, P2_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P2_PARTITION_ID);

// =============================================================================
// Process Handlers (Using shared utilities with shutdown guard)
// =============================================================================

// Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

// Guard against multiple main() invocations (e.g., from integration tests)
let mainStarted = false;

async function main(): Promise<void> {
  // Prevent multiple invocations
  if (mainStarted) {
    logger.warn('main() already started, ignoring duplicate invocation');
    return;
  }
  mainStarted = true;

  logger.info('Starting P2 L2-Turbo Partition Service', {
    partitionId: P2_PARTITION_ID,
    chains: config.chains,
    region: P2_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (using shared utilities)
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

    // Use shared utility for cleanup (prevents code duplication)
    await closeServerWithTimeout(healthServerRef.current, 1000, logger);

    // Clean up process handlers before exit to prevent listener leaks
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

export {
  detector,
  config,
  P2_PARTITION_ID,
  P2_CHAINS,
  P2_REGION,
  cleanupProcessHandlers,
  // Export for testing
  envConfig
};

// Re-export type from shared utilities for convenience
export type { PartitionEnvironmentConfig };

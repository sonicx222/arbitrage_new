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
 * Architecture Note:
 * This service creates its own HTTP health server via createPartitionHealthServer().
 * The UnifiedChainDetector class provides health data but NOT an HTTP server.
 * This separation of concerns allows:
 * - Partition-specific health endpoint configuration
 * - Consistent health response format across all partition services
 * - The detector class to remain transport-agnostic
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'asia-fast' by default
 * - REDIS_URL: Redis connection URL (required)
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3001)
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
  PARTITION_SERVICE_NAMES,
  Logger
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
// Partition Configuration Retrieval
// =============================================================================

// Single partition config retrieval
const partitionConfig = getPartition(P1_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P1 partition configuration not found', { partitionId: P1_PARTITION_ID }, logger);
}

// Derive chains and region from partition config
const P1_CHAINS: readonly string[] = partitionConfig.chains;
const P1_REGION = partitionConfig.region;

// =============================================================================
// Environment Configuration (Using shared typed utilities)
// =============================================================================

// Parse environment into typed configuration using shared utility
const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P1_CHAINS);

// Validate environment configuration (exits on critical errors, warns on non-critical)
validatePartitionEnvironmentConfig(envConfig, P1_PARTITION_ID, P1_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

// Service configuration for shared utilities
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

// Unified detector configuration (uses typed envConfig)
const config: UnifiedDetectorConfig = {
  partitionId: P1_PARTITION_ID,
  chains: validateAndFilterChains(envConfig.partitionChains, P1_CHAINS, logger),
  instanceId: generateInstanceId(P1_PARTITION_ID, envConfig.instanceId),
  regionId: envConfig.regionId || P1_REGION,
  enableCrossRegionHealth: envConfig.enableCrossRegionHealth,
  healthCheckPort: parsePort(envConfig.healthCheckPort, P1_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P1_PARTITION_ID);

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

  logger.info('Starting P1 Asia-Fast Partition Service', {
    partitionId: P1_PARTITION_ID,
    chains: config.chains,
    region: P1_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (using shared utilities)
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

export {
  detector,
  config,
  P1_PARTITION_ID,
  P1_CHAINS,
  P1_REGION,
  cleanupProcessHandlers,
  // Export for testing
  envConfig
};

// Re-export type from shared utilities for convenience
export type { PartitionEnvironmentConfig };

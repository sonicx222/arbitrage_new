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
 * - INSTANCE_ID: Unique instance identifier (auto-generated if not set)
 * - REGION_ID: Deployment region (default: us-east1)
 * - ENABLE_CROSS_REGION_HEALTH: Enable cross-region health reporting (default: true)
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
// P3 Partition Constants
// =============================================================================

const P3_PARTITION_ID = PARTITION_IDS.HIGH_VALUE;
// Use centralized port constant (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
const P3_DEFAULT_PORT = PARTITION_PORTS[P3_PARTITION_ID] ?? 3003;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-high-value:main');

// =============================================================================
// Partition Configuration Retrieval
// =============================================================================

// Single partition config retrieval
const partitionConfig = getPartition(P3_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P3 partition configuration not found', { partitionId: P3_PARTITION_ID }, logger);
}

// Derive chains and region from partition config
const P3_CHAINS: readonly string[] = partitionConfig.chains;
const P3_REGION = partitionConfig.region;

// =============================================================================
// Environment Configuration (Using shared typed utilities)
// =============================================================================

// Parse environment into typed configuration using shared utility
const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P3_CHAINS);

// Validate environment configuration (exits on critical errors, warns on non-critical)
validatePartitionEnvironmentConfig(envConfig, P3_PARTITION_ID, P3_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

// Service configuration for shared utilities
const serviceConfig: PartitionServiceConfig = {
  partitionId: P3_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P3_PARTITION_ID] ?? 'partition-high-value',
  defaultChains: P3_CHAINS,
  defaultPort: P3_DEFAULT_PORT,
  region: P3_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration (uses typed envConfig)
const config: UnifiedDetectorConfig = {
  partitionId: P3_PARTITION_ID,
  chains: validateAndFilterChains(envConfig.partitionChains, P3_CHAINS, logger),
  instanceId: generateInstanceId(P3_PARTITION_ID, envConfig.instanceId),
  regionId: envConfig.regionId || P3_REGION,
  enableCrossRegionHealth: envConfig.enableCrossRegionHealth,
  healthCheckPort: parsePort(envConfig.healthCheckPort, P3_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P3_PARTITION_ID);

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

  logger.info('Starting P3 High-Value Partition Service', {
    partitionId: P3_PARTITION_ID,
    chains: config.chains,
    region: P3_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (using shared utilities)
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

export {
  detector,
  config,
  P3_PARTITION_ID,
  P3_CHAINS,
  P3_REGION,
  cleanupProcessHandlers,
  // Export for testing
  envConfig
};

// Re-export type from shared utilities for convenience
export type { PartitionEnvironmentConfig };

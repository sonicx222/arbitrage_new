/**
 * P2 L2-Turbo Partition Service Entry Point
 *
 * Deploys the unified detector for the L2-Turbo partition:
 * - Chains: Arbitrum, Optimism, Base
 * - Region: Fly.io Singapore (asia-southeast1)
 * - Resource Profile: Standard (3 chains)
 *
 * L2-specific optimizations:
 * - Faster health checks (10s) for sub-second block times
 * - Shorter failover timeout (45s) for quick recovery
 * - High-frequency event handling for L2 throughput
 *
 * Architecture Note:
 * Uses the shared partition service runner factory for consistent startup,
 * shutdown, and health server behavior across all partition services.
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
 * @see ADR-024: Partition Service Factory Pattern
 */

import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import {
  createLogger,
  parsePort,
  validateAndFilterChains,
  exitWithConfigError,
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  PartitionServiceConfig,
  PartitionEnvironmentConfig,
  runPartitionService,
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES,
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P2 Partition Constants
// =============================================================================

const P2_PARTITION_ID = PARTITION_IDS.L2_TURBO;
const P2_DEFAULT_PORT = PARTITION_PORTS[P2_PARTITION_ID] ?? 3002;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-l2-turbo:main');

// Partition configuration retrieval
const partitionConfig = getPartition(P2_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P2 partition configuration not found', { partitionId: P2_PARTITION_ID }, logger);
}

// Defensive null-safety for test compatibility
const P2_CHAINS: readonly string[] = partitionConfig?.chains ?? [];
const P2_REGION = partitionConfig?.region ?? 'asia-southeast1';

if (!P2_CHAINS || P2_CHAINS.length === 0) {
  exitWithConfigError('P2 partition has no chains configured', {
    partitionId: P2_PARTITION_ID,
    chains: P2_CHAINS
  }, logger);
}

// =============================================================================
// Environment Configuration
// =============================================================================

const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P2_CHAINS);
validatePartitionEnvironmentConfig(envConfig, P2_PARTITION_ID, P2_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

const serviceConfig: PartitionServiceConfig = {
  partitionId: P2_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P2_PARTITION_ID] ?? 'partition-l2-turbo',
  defaultChains: P2_CHAINS,
  defaultPort: P2_DEFAULT_PORT,
  region: P2_REGION,
  provider: partitionConfig?.provider ?? 'oracle'
};

// Build detector config with explicit types for the factory
const detectorConfig = {
  partitionId: P2_PARTITION_ID,
  chains: validateAndFilterChains(envConfig?.partitionChains, P2_CHAINS, logger),
  instanceId: generateInstanceId(P2_PARTITION_ID, envConfig?.instanceId),
  regionId: envConfig?.regionId ?? P2_REGION,
  enableCrossRegionHealth: envConfig?.enableCrossRegionHealth ?? true,
  healthCheckPort: parsePort(envConfig?.healthCheckPort, P2_DEFAULT_PORT, logger)
};

// Re-export config with UnifiedDetectorConfig type for backward compatibility
const config: UnifiedDetectorConfig = detectorConfig;

// =============================================================================
// Service Runner (Using shared factory for consistent behavior)
// =============================================================================

const runner = runPartitionService({
  config: serviceConfig,
  detectorConfig,
  createDetector: (cfg) => new UnifiedChainDetector(cfg),
  logger
});

// =============================================================================
// Exports (Maintaining backward compatibility)
// =============================================================================

// Cast back to UnifiedChainDetector for consumers that need the full type
const detector = runner.detector as UnifiedChainDetector;
const cleanupProcessHandlers = runner.cleanup;

export {
  detector,
  config,
  P2_PARTITION_ID,
  P2_CHAINS,
  P2_REGION,
  cleanupProcessHandlers,
  envConfig
};

export type { PartitionEnvironmentConfig };

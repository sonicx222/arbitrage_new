/**
 * P1 Asia-Fast Partition Service Entry Point
 *
 * Deploys the unified detector for the Asia-Fast partition:
 * - Chains: BSC, Polygon, Avalanche, Fantom
 * - Region: Oracle Cloud Singapore (asia-southeast1)
 * - Resource Profile: Heavy (4 chains)
 *
 * Architecture Note:
 * Uses the shared partition service runner factory for consistent startup,
 * shutdown, and health server behavior across all partition services.
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
  PartitionDetectorInterface
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P1 Partition Constants
// =============================================================================

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;
const P1_DEFAULT_PORT = PARTITION_PORTS[P1_PARTITION_ID] ?? 3001;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-asia-fast:main');

// Partition configuration retrieval
const partitionConfig = getPartition(P1_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P1 partition configuration not found', { partitionId: P1_PARTITION_ID }, logger);
}

// Defensive null-safety for test compatibility
const P1_CHAINS: readonly string[] = partitionConfig?.chains ?? [];
const P1_REGION = partitionConfig?.region ?? 'asia-southeast1';

if (!P1_CHAINS || P1_CHAINS.length === 0) {
  exitWithConfigError('P1 partition has no chains configured', {
    partitionId: P1_PARTITION_ID,
    chains: P1_CHAINS
  }, logger);
}

// =============================================================================
// Environment Configuration
// =============================================================================

const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P1_CHAINS);
validatePartitionEnvironmentConfig(envConfig, P1_PARTITION_ID, P1_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

const serviceConfig: PartitionServiceConfig = {
  partitionId: P1_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P1_PARTITION_ID] ?? 'partition-asia-fast',
  defaultChains: P1_CHAINS,
  defaultPort: P1_DEFAULT_PORT,
  region: P1_REGION,
  provider: partitionConfig?.provider ?? 'oracle'
};

// Build detector config with explicit types for the factory
const detectorConfig = {
  partitionId: P1_PARTITION_ID,
  chains: validateAndFilterChains(envConfig?.partitionChains, P1_CHAINS, logger),
  instanceId: generateInstanceId(P1_PARTITION_ID, envConfig?.instanceId),
  regionId: envConfig?.regionId ?? P1_REGION,
  enableCrossRegionHealth: envConfig?.enableCrossRegionHealth ?? true,
  healthCheckPort: parsePort(envConfig?.healthCheckPort, P1_DEFAULT_PORT, logger)
};

// Re-export config with UnifiedDetectorConfig type for backward compatibility
const config: UnifiedDetectorConfig = detectorConfig;

// =============================================================================
// Service Runner (Using shared factory for consistent behavior)
// =============================================================================

/**
 * TYPE-CAST-EXPLANATION:
 * The `as unknown as` cast is required because UnifiedChainDetector doesn't
 * explicitly implement PartitionDetectorInterface, though it has all required
 * methods. The interfaces have slightly different return type signatures:
 *
 * - PartitionDetectorInterface.getStats() returns { chainStats: Map<string, unknown> }
 * - UnifiedChainDetector.getStats() returns { chainStats: Map<string, ChainStats> }
 *
 * The types ARE compatible at runtime (more specific → less specific is OK),
 * but TypeScript can't verify this without explicit implementation.
 *
 * TODO: Refactor UnifiedChainDetector to explicitly implement PartitionDetectorInterface
 * by aligning the return types or using interface generics.
 * @see ADR-024: Partition Service Factory Pattern
 */
const runner = runPartitionService({
  config: serviceConfig,
  detectorConfig,
  createDetector: (cfg) => new UnifiedChainDetector(cfg) as unknown as PartitionDetectorInterface,
  logger
});

// =============================================================================
// Exports (Maintaining backward compatibility)
// =============================================================================

// Cast back to UnifiedChainDetector for consumers that need the full type
const detector = runner.detector as unknown as UnifiedChainDetector;
const cleanupProcessHandlers = runner.cleanup;

export {
  detector,
  config,
  P1_PARTITION_ID,
  P1_CHAINS,
  P1_REGION,
  cleanupProcessHandlers,
  envConfig
};

export type { PartitionEnvironmentConfig };

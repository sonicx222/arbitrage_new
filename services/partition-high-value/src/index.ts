/**
 * P3 High-Value Partition Service Entry Point
 *
 * Deploys the unified detector for the High-Value partition:
 * - Chains: Ethereum, zkSync, Linea
 * - Region: Oracle Cloud US-East (us-east1)
 * - Resource Profile: Heavy (3 high-value chains)
 *
 * High-Value partition characteristics:
 * - Longer health checks (30s) for Ethereum's ~12s blocks
 * - Standard failover timeout (60s) for mainnet stability
 * - Heavy resource profile for Ethereum mainnet processing
 * - US-East deployment for proximity to major Ethereum infrastructure
 *
 * Architecture Note:
 * Uses the shared partition service runner factory for consistent startup,
 * shutdown, and health server behavior across all partition services.
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
// P3 Partition Constants
// =============================================================================

const P3_PARTITION_ID = PARTITION_IDS.HIGH_VALUE;
const P3_DEFAULT_PORT = PARTITION_PORTS[P3_PARTITION_ID] ?? 3003;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-high-value:main');

// Partition configuration retrieval
const partitionConfig = getPartition(P3_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P3 partition configuration not found', { partitionId: P3_PARTITION_ID }, logger);
}

// Defensive null-safety for test compatibility
const P3_CHAINS: readonly string[] = partitionConfig?.chains ?? [];
const P3_REGION = partitionConfig?.region ?? 'us-east1';

if (!P3_CHAINS || P3_CHAINS.length === 0) {
  exitWithConfigError('P3 partition has no chains configured', {
    partitionId: P3_PARTITION_ID,
    chains: P3_CHAINS
  }, logger);
}

// =============================================================================
// Environment Configuration
// =============================================================================

const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P3_CHAINS);
validatePartitionEnvironmentConfig(envConfig, P3_PARTITION_ID, P3_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

const serviceConfig: PartitionServiceConfig = {
  partitionId: P3_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P3_PARTITION_ID] ?? 'partition-high-value',
  defaultChains: P3_CHAINS,
  defaultPort: P3_DEFAULT_PORT,
  region: P3_REGION,
  provider: partitionConfig?.provider ?? 'oracle'
};

// Build detector config with explicit types for the factory
const detectorConfig = {
  partitionId: P3_PARTITION_ID,
  chains: validateAndFilterChains(envConfig?.partitionChains, P3_CHAINS, logger),
  instanceId: generateInstanceId(P3_PARTITION_ID, envConfig?.instanceId),
  regionId: envConfig?.regionId ?? P3_REGION,
  enableCrossRegionHealth: envConfig?.enableCrossRegionHealth ?? true,
  healthCheckPort: parsePort(envConfig?.healthCheckPort, P3_DEFAULT_PORT, logger)
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
  P3_PARTITION_ID,
  P3_CHAINS,
  P3_REGION,
  cleanupProcessHandlers,
  envConfig
};

export type { PartitionEnvironmentConfig };

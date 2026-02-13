/**
 * P1 Asia-Fast Partition Service Entry Point
 *
 * Deploys the unified detector for the Asia-Fast partition:
 * - Chains: BSC, Polygon, Avalanche, Fantom
 * - Region: Oracle Cloud Singapore (asia-southeast1)
 * - Resource Profile: Heavy (4 chains)
 *
 * Architecture Note:
 * Uses the shared createPartitionEntry factory for consistent startup,
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
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */

import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import { createPartitionEntry, PartitionEnvironmentConfig } from '@arbitrage/core';
import { PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P1 Partition Entry (Data-driven via createPartitionEntry factory)
// =============================================================================

const entry = createPartitionEntry(
  PARTITION_IDS.ASIA_FAST,
  (cfg) => new UnifiedChainDetector(cfg)
);

// =============================================================================
// Exports (Backward-compatible)
// =============================================================================

const detector = entry.detector as UnifiedChainDetector;
const config: UnifiedDetectorConfig = entry.config;
const P1_PARTITION_ID = entry.partitionId;
const P1_CHAINS = entry.chains;
const P1_REGION = entry.region;
const cleanupProcessHandlers = entry.cleanupProcessHandlers;
const envConfig = entry.envConfig;

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

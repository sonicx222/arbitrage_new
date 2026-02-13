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
 * Uses the shared createPartitionEntry factory for consistent startup,
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
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */

import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import { createPartitionEntry, PartitionEnvironmentConfig } from '@arbitrage/core';
import { PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P2 Partition Entry (Data-driven via createPartitionEntry factory)
// =============================================================================

const entry = createPartitionEntry(
  PARTITION_IDS.L2_TURBO,
  (cfg) => new UnifiedChainDetector(cfg)
);

// =============================================================================
// Exports (Backward-compatible)
// =============================================================================

const detector = entry.detector as UnifiedChainDetector;
const config: UnifiedDetectorConfig = entry.config;
const P2_PARTITION_ID = entry.partitionId;
const P2_CHAINS = entry.chains;
const P2_REGION = entry.region;
const cleanupProcessHandlers = entry.cleanupProcessHandlers;
const envConfig = entry.envConfig;

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

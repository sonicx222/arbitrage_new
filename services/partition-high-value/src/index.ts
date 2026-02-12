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
 * Uses the shared createPartitionEntry factory for consistent startup,
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
import { createPartitionEntry, PartitionEnvironmentConfig } from '@arbitrage/core';
import { PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P3 Partition Entry (Data-driven via createPartitionEntry factory)
// =============================================================================

const entry = createPartitionEntry(
  PARTITION_IDS.HIGH_VALUE,
  (cfg) => new UnifiedChainDetector(cfg)
);

// =============================================================================
// Exports (Backward-compatible)
// =============================================================================

const detector = entry.detector as UnifiedChainDetector;
const config: UnifiedDetectorConfig = entry.config;
const P3_PARTITION_ID = entry.partitionId;
const P3_CHAINS = entry.chains;
const P3_REGION = entry.region;
const cleanupProcessHandlers = entry.cleanupProcessHandlers;
const envConfig = entry.envConfig;

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

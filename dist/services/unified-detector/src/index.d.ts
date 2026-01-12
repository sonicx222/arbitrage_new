/**
 * Unified Detector Service Entry Point
 *
 * Multi-chain detector that runs multiple blockchain detectors
 * in a single process based on partition configuration.
 *
 * Environment Variables:
 * - PARTITION_ID: Partition to run (default: asia-fast)
 * - PARTITION_CHAINS: Override chains (comma-separated)
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - REGION_ID: Region for cross-region health reporting
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3001)
 *
 * @see ADR-003: Partitioned Chain Detectors
 */
export { UnifiedChainDetector } from './unified-detector';
export { ChainDetectorInstance } from './chain-instance';
export type { UnifiedDetectorConfig, UnifiedDetectorStats, ChainStats } from './unified-detector';
//# sourceMappingURL=index.d.ts.map
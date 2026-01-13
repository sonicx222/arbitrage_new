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
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3002)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.4: Create P2 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
declare const P2_PARTITION_ID: "l2-turbo";
declare const P2_CHAINS: readonly string[];
declare const P2_REGION: import("@arbitrage/config").Region;
declare const config: UnifiedDetectorConfig;
declare const detector: UnifiedChainDetector;
export { detector, config, P2_PARTITION_ID, P2_CHAINS, P2_REGION };
//# sourceMappingURL=index.d.ts.map
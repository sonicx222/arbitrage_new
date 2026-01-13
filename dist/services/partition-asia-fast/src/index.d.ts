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
 * Environment Variables:
 * - PARTITION_ID: Set to 'asia-fast' by default
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3001)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.3: Create P1 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
declare const P1_PARTITION_ID: "asia-fast";
declare const P1_CHAINS: readonly string[];
declare const P1_REGION: import("@arbitrage/config").Region;
declare const config: UnifiedDetectorConfig;
declare const detector: UnifiedChainDetector;
export { detector, config, P1_PARTITION_ID, P1_CHAINS, P1_REGION };
//# sourceMappingURL=index.d.ts.map
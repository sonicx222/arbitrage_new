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
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3003)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.5: Create P3 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
declare const P3_PARTITION_ID: "high-value";
declare const P3_CHAINS: readonly string[];
declare const P3_REGION: import("@arbitrage/config").Region;
declare const config: UnifiedDetectorConfig;
declare const detector: UnifiedChainDetector;
export { detector, config, P3_PARTITION_ID, P3_CHAINS, P3_REGION };
//# sourceMappingURL=index.d.ts.map
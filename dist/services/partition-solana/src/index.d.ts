/**
 * P4 Solana-Native Partition Service Entry Point
 *
 * Deploys the unified detector for the Solana-Native partition:
 * - Chain: Solana (non-EVM)
 * - Region: Fly.io US-West (us-west1)
 * - Resource Profile: Heavy (high-throughput chain)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P4 partition.
 *
 * Solana-Native partition characteristics:
 * - Non-EVM chain requiring different connection handling
 * - Fast health checks (10s) for ~400ms block times
 * - Shorter failover timeout (45s) for quick recovery
 * - US-West deployment for proximity to Solana validators
 * - Uses program account subscriptions instead of event logs
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'solana-native' by default
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3004)
 * - SOLANA_RPC_URL: Solana RPC endpoint
 * - SOLANA_WS_URL: Solana WebSocket endpoint
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.6: Create P4 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
declare const P4_PARTITION_ID: "solana-native";
declare const P4_CHAINS: readonly string[];
declare const P4_REGION: import("@arbitrage/config").Region;
declare const config: UnifiedDetectorConfig;
declare const detector: UnifiedChainDetector;
export { detector, config, P4_PARTITION_ID, P4_CHAINS, P4_REGION };
//# sourceMappingURL=index.d.ts.map
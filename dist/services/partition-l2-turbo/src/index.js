"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.P2_REGION = exports.P2_CHAINS = exports.P2_PARTITION_ID = exports.config = exports.detector = void 0;
const unified_detector_1 = require("@arbitrage/unified-detector");
const core_1 = require("@arbitrage/core");
const config_1 = require("@arbitrage/config");
// =============================================================================
// P2 Partition Constants
// =============================================================================
const P2_PARTITION_ID = config_1.PARTITION_IDS.L2_TURBO;
exports.P2_PARTITION_ID = P2_PARTITION_ID;
const P2_DEFAULT_PORT = 3002; // Different port from P1
// =============================================================================
// Configuration
// =============================================================================
const logger = (0, core_1.createLogger)('partition-l2-turbo:main');
// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = (0, config_1.getPartition)(P2_PARTITION_ID);
if (!partitionConfig) {
    logger.error('P2 partition configuration not found', { partitionId: P2_PARTITION_ID });
    process.exit(1);
}
// Derive chains and region from partition config (P3-FIX pattern)
const P2_CHAINS = partitionConfig.chains;
exports.P2_CHAINS = P2_CHAINS;
const P2_REGION = partitionConfig.region;
exports.P2_REGION = P2_REGION;
// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig = {
    partitionId: P2_PARTITION_ID,
    serviceName: 'partition-l2-turbo',
    defaultChains: P2_CHAINS,
    defaultPort: P2_DEFAULT_PORT,
    region: P2_REGION,
    provider: partitionConfig.provider
};
// Store server reference for graceful shutdown
const healthServerRef = { current: null };
// Unified detector configuration
const config = {
    partitionId: P2_PARTITION_ID,
    chains: (0, core_1.validateAndFilterChains)(process.env.PARTITION_CHAINS, P2_CHAINS, logger),
    instanceId: process.env.INSTANCE_ID || `p2-l2-turbo-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
    regionId: process.env.REGION_ID || P2_REGION,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
    healthCheckPort: (0, core_1.parsePort)(process.env.HEALTH_CHECK_PORT, P2_DEFAULT_PORT, logger)
};
exports.config = config;
// =============================================================================
// Service Instance
// =============================================================================
const detector = new unified_detector_1.UnifiedChainDetector(config);
exports.detector = detector;
// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================
(0, core_1.setupDetectorEventHandlers)(detector, logger, P2_PARTITION_ID);
// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================
(0, core_1.setupProcessHandlers)(healthServerRef, detector, logger, serviceConfig.serviceName);
// =============================================================================
// Main Entry Point
// =============================================================================
async function main() {
    // S3.2.3-FIX: Explicit guard for TypeScript type narrowing
    if (!partitionConfig) {
        throw new Error('Partition config unavailable - this should never happen');
    }
    logger.info('Starting P2 L2-Turbo Partition Service', {
        partitionId: P2_PARTITION_ID,
        chains: config.chains,
        region: P2_REGION,
        provider: partitionConfig.provider,
        nodeVersion: process.version,
        pid: process.pid
    });
    try {
        // Start health check server first (P12-P14 refactor - Using shared utilities)
        healthServerRef.current = (0, core_1.createPartitionHealthServer)({
            port: config.healthCheckPort || P2_DEFAULT_PORT,
            config: serviceConfig,
            detector,
            logger
        });
        // Start detector
        await detector.start();
        logger.info('P2 L2-Turbo Partition Service started successfully', {
            partitionId: detector.getPartitionId(),
            chains: detector.getChains(),
            healthyChains: detector.getHealthyChains()
        });
    }
    catch (error) {
        logger.error('Failed to start P2 L2-Turbo Partition Service', { error });
        process.exit(1);
    }
}
// Run
main().catch((error) => {
    logger.error('Fatal error in P2 L2-Turbo partition main', { error });
    process.exit(1);
});
//# sourceMappingURL=index.js.map
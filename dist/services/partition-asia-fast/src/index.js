"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.P1_REGION = exports.P1_CHAINS = exports.P1_PARTITION_ID = exports.config = exports.detector = void 0;
const unified_detector_1 = require("@arbitrage/unified-detector");
const core_1 = require("@arbitrage/core");
const config_1 = require("@arbitrage/config");
// =============================================================================
// P1 Partition Constants
// =============================================================================
const P1_PARTITION_ID = config_1.PARTITION_IDS.ASIA_FAST;
exports.P1_PARTITION_ID = P1_PARTITION_ID;
const P1_DEFAULT_PORT = 3001;
// =============================================================================
// Configuration
// =============================================================================
const logger = (0, core_1.createLogger)('partition-asia-fast:main');
// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = (0, config_1.getPartition)(P1_PARTITION_ID);
if (!partitionConfig) {
    logger.error('P1 partition configuration not found', { partitionId: P1_PARTITION_ID });
    process.exit(1);
}
// Derive chains and region from partition config (P3-FIX pattern)
const P1_CHAINS = partitionConfig.chains;
exports.P1_CHAINS = P1_CHAINS;
const P1_REGION = partitionConfig.region;
exports.P1_REGION = P1_REGION;
// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig = {
    partitionId: P1_PARTITION_ID,
    serviceName: 'partition-asia-fast',
    defaultChains: P1_CHAINS,
    defaultPort: P1_DEFAULT_PORT,
    region: P1_REGION,
    provider: partitionConfig.provider
};
// Store server reference for graceful shutdown
const healthServerRef = { current: null };
// Unified detector configuration
const config = {
    partitionId: P1_PARTITION_ID,
    chains: (0, core_1.validateAndFilterChains)(process.env.PARTITION_CHAINS, P1_CHAINS, logger),
    instanceId: process.env.INSTANCE_ID || `p1-asia-fast-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
    regionId: process.env.REGION_ID || P1_REGION,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
    healthCheckPort: (0, core_1.parsePort)(process.env.HEALTH_CHECK_PORT, P1_DEFAULT_PORT, logger)
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
(0, core_1.setupDetectorEventHandlers)(detector, logger, P1_PARTITION_ID);
// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================
(0, core_1.setupProcessHandlers)(healthServerRef, detector, logger, serviceConfig.serviceName);
// =============================================================================
// Main Entry Point
// =============================================================================
async function main() {
    logger.info('Starting P1 Asia-Fast Partition Service', {
        partitionId: P1_PARTITION_ID,
        chains: config.chains,
        region: P1_REGION,
        provider: partitionConfig.provider,
        nodeVersion: process.version,
        pid: process.pid
    });
    try {
        // Start health check server first (P12-P14 refactor - Using shared utilities)
        healthServerRef.current = (0, core_1.createPartitionHealthServer)({
            port: config.healthCheckPort || P1_DEFAULT_PORT,
            config: serviceConfig,
            detector,
            logger
        });
        // Start detector
        await detector.start();
        logger.info('P1 Asia-Fast Partition Service started successfully', {
            partitionId: detector.getPartitionId(),
            chains: detector.getChains(),
            healthyChains: detector.getHealthyChains()
        });
    }
    catch (error) {
        logger.error('Failed to start P1 Asia-Fast Partition Service', { error });
        process.exit(1);
    }
}
// Run
main().catch((error) => {
    logger.error('Fatal error in P1 Asia-Fast partition main', { error });
    process.exit(1);
});
//# sourceMappingURL=index.js.map
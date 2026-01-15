"use strict";
/**
 * Shared Partition Service Utilities
 *
 * Common utilities for all partition detector services (P1-P4).
 * Reduces code duplication and ensures consistency across partitions.
 *
 * Features:
 * - Port validation and parsing
 * - Chain validation and filtering
 * - HTTP health server creation
 * - Graceful shutdown handling
 * - Event handler setup
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.3-S3.1.6: Partition service implementations
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHUTDOWN_TIMEOUT_MS = void 0;
exports.parsePort = parsePort;
exports.validateAndFilterChains = validateAndFilterChains;
exports.createPartitionHealthServer = createPartitionHealthServer;
exports.shutdownPartitionService = shutdownPartitionService;
exports.setupDetectorEventHandlers = setupDetectorEventHandlers;
exports.setupProcessHandlers = setupProcessHandlers;
const http_1 = require("http");
const src_1 = require("../../config/src");
// =============================================================================
// Port Validation (P7-FIX Pattern)
// =============================================================================
/**
 * Validates and parses a port number from environment variable.
 * Returns defaultPort if the value is invalid or not provided.
 *
 * @param portEnv - The port environment variable value
 * @param defaultPort - Default port to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Valid port number
 */
function parsePort(portEnv, defaultPort, logger) {
    if (!portEnv) {
        return defaultPort;
    }
    const parsed = parseInt(portEnv, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        if (logger) {
            logger.warn('Invalid HEALTH_CHECK_PORT, using default', {
                provided: portEnv,
                default: defaultPort
            });
        }
        return defaultPort;
    }
    return parsed;
}
// =============================================================================
// Chain Validation (P4-FIX Pattern)
// =============================================================================
/**
 * Validates chains from environment variable against known chain IDs.
 * Returns only valid chains, or defaults if none are valid.
 *
 * @param chainsEnv - Comma-separated chain IDs from environment
 * @param defaultChains - Default chains to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Array of valid chain IDs
 */
function validateAndFilterChains(chainsEnv, defaultChains, logger) {
    if (!chainsEnv) {
        return [...defaultChains];
    }
    // Chain IDs are the keys of the CHAINS object
    const validChainIds = Object.keys(src_1.CHAINS);
    const requestedChains = chainsEnv.split(',').map(c => c.trim().toLowerCase());
    const validChains = [];
    const invalidChains = [];
    for (const chain of requestedChains) {
        if (validChainIds.includes(chain)) {
            validChains.push(chain);
        }
        else {
            invalidChains.push(chain);
        }
    }
    if (invalidChains.length > 0 && logger) {
        logger.warn('Invalid chain IDs in PARTITION_CHAINS, ignoring', {
            invalidChains,
            validChains,
            availableChains: validChainIds
        });
    }
    if (validChains.length === 0) {
        if (logger) {
            logger.warn('No valid chains in PARTITION_CHAINS, using defaults', {
                defaults: defaultChains
            });
        }
        return [...defaultChains];
    }
    return validChains;
}
// =============================================================================
// Health Server (P12-P14 Refactor)
// =============================================================================
/**
 * Creates an HTTP health check server for partition services.
 * Provides consistent endpoints across all partitions.
 *
 * Endpoints:
 * - GET / - Service info
 * - GET /health, /healthz - Health status
 * - GET /ready - Readiness check
 * - GET /stats - Detailed statistics
 *
 * @param options - Health server configuration
 * @returns HTTP Server instance
 */
function createPartitionHealthServer(options) {
    const { port, config, detector, logger } = options;
    const server = (0, http_1.createServer)(async (req, res) => {
        if (req.url === '/health' || req.url === '/healthz') {
            try {
                const health = await detector.getPartitionHealth();
                const statusCode = health.status === 'healthy' ? 200 :
                    health.status === 'degraded' ? 200 : 503;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: config.serviceName,
                    status: health.status,
                    partitionId: health.partitionId,
                    chains: Array.from(health.chainHealth.keys()),
                    healthyChains: detector.getHealthyChains(),
                    uptime: health.uptimeSeconds,
                    eventsProcessed: health.totalEventsProcessed,
                    memoryMB: Math.round(health.memoryUsage / 1024 / 1024),
                    region: config.region,
                    timestamp: Date.now()
                }));
            }
            catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: config.serviceName,
                    status: 'error',
                    error: error.message
                }));
            }
        }
        else if (req.url === '/stats') {
            try {
                const stats = detector.getStats();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: config.serviceName,
                    partitionId: stats.partitionId,
                    chains: stats.chains,
                    totalEvents: stats.totalEventsProcessed,
                    totalOpportunities: stats.totalOpportunitiesFound,
                    uptimeSeconds: stats.uptimeSeconds,
                    memoryMB: stats.memoryUsageMB,
                    chainStats: Object.fromEntries(stats.chainStats)
                }));
            }
            catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: config.serviceName,
                    status: 'error',
                    error: error.message
                }));
            }
        }
        else if (req.url === '/ready') {
            const ready = detector.isRunning();
            res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                service: config.serviceName,
                ready,
                chains: detector.getChains()
            }));
        }
        else if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                service: config.serviceName,
                description: `${config.partitionId} Partition Detector`,
                partitionId: config.partitionId,
                chains: config.defaultChains,
                region: config.region,
                endpoints: ['/health', '/healthz', '/ready', '/stats']
            }));
        }
        else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });
    server.listen(port, () => {
        logger.info(`${config.serviceName} health server listening on port ${port}`);
    });
    server.on('error', (error) => {
        logger.error('Health server error', { error });
    });
    return server;
}
// =============================================================================
// Graceful Shutdown (P15 Refactor)
// =============================================================================
/** Default timeout for shutdown operations in milliseconds */
exports.SHUTDOWN_TIMEOUT_MS = 5000;
/**
 * Gracefully shuts down a partition service.
 * Handles health server and detector shutdown with timeouts.
 *
 * @param signal - Signal that triggered shutdown
 * @param healthServer - HTTP server to close
 * @param detector - Detector instance to stop
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 */
async function shutdownPartitionService(signal, healthServer, detector, logger, serviceName) {
    logger.info(`Received ${signal}, shutting down ${serviceName}...`);
    try {
        // Close health server first with timeout (P8-FIX pattern)
        if (healthServer) {
            let timeoutId = null;
            await Promise.race([
                new Promise((resolve, reject) => {
                    healthServer.close((err) => {
                        if (timeoutId)
                            clearTimeout(timeoutId);
                        if (err)
                            reject(err);
                        else
                            resolve();
                    });
                }),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('Health server close timeout')), exports.SHUTDOWN_TIMEOUT_MS);
                })
            ]).catch((err) => {
                if (timeoutId)
                    clearTimeout(timeoutId);
                logger.warn('Health server close error or timeout', { error: err.message });
            });
            logger.info('Health server closed');
        }
        await detector.stop();
        logger.info(`${serviceName} shutdown complete`);
        process.exit(0);
    }
    catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
    }
}
// =============================================================================
// Event Handlers (P16 Refactor)
// =============================================================================
/**
 * Sets up standard event handlers for a partition detector.
 * Provides consistent logging across all partitions.
 *
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param partitionId - Partition ID for log context
 */
function setupDetectorEventHandlers(detector, logger, partitionId) {
    detector.on('priceUpdate', (update) => {
        logger.debug('Price update', {
            partition: partitionId,
            chain: update.chain,
            dex: update.dex,
            price: update.price
        });
    });
    detector.on('opportunity', (opp) => {
        logger.info('Arbitrage opportunity detected', {
            partition: partitionId,
            id: opp.id,
            type: opp.type,
            buyDex: opp.buyDex,
            sellDex: opp.sellDex,
            profit: opp.expectedProfit,
            percentage: (opp.profitPercentage * 100).toFixed(2) + '%'
        });
    });
    detector.on('chainError', ({ chainId, error }) => {
        logger.error(`Chain error: ${chainId}`, {
            partition: partitionId,
            error: error.message
        });
    });
    detector.on('chainConnected', ({ chainId }) => {
        logger.info(`Chain connected: ${chainId}`, { partition: partitionId });
    });
    detector.on('chainDisconnected', ({ chainId }) => {
        logger.warn(`Chain disconnected: ${chainId}`, { partition: partitionId });
    });
    detector.on('failoverEvent', (event) => {
        logger.warn('Failover event received', { partition: partitionId, ...event });
    });
}
/**
 * Sets up process signal handlers for graceful shutdown.
 *
 * P19-FIX: Uses a shutdown flag to prevent multiple concurrent shutdown attempts
 * when signals arrive close together (e.g., SIGTERM followed by SIGINT).
 *
 * S3.2.3-FIX: Returns cleanup function to prevent MaxListenersExceeded warnings
 * when handlers are registered multiple times (e.g., in tests).
 *
 * @param healthServerRef - Reference to health server (use object to allow mutation)
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 * @returns Cleanup function to remove all registered handlers
 */
function setupProcessHandlers(healthServerRef, detector, logger, serviceName) {
    // P19-FIX: Guard flag to prevent multiple shutdown calls
    let isShuttingDown = false;
    const shutdown = async (signal) => {
        // P19-FIX: Skip if already shutting down
        if (isShuttingDown) {
            logger.info(`Already shutting down, ignoring ${signal}`);
            return;
        }
        isShuttingDown = true;
        await shutdownPartitionService(signal, healthServerRef.current, detector, logger, serviceName);
    };
    // S3.2.3-FIX: Store handler references for cleanup
    const sigtermHandler = () => shutdown('SIGTERM');
    const sigintHandler = () => shutdown('SIGINT');
    const uncaughtHandler = (error) => {
        logger.error(`Uncaught exception in ${serviceName}`, { error });
        shutdown('uncaughtException').catch(() => {
            process.exit(1);
        });
    };
    const rejectionHandler = (reason, promise) => {
        logger.error(`Unhandled rejection in ${serviceName}`, { reason, promise });
    };
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', rejectionHandler);
    // S3.2.3-FIX: Return cleanup function to prevent listener accumulation
    return () => {
        process.off('SIGTERM', sigtermHandler);
        process.off('SIGINT', sigintHandler);
        process.off('uncaughtException', uncaughtHandler);
        process.off('unhandledRejection', rejectionHandler);
    };
}
//# sourceMappingURL=partition-service-utils.js.map
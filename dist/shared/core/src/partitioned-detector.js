"use strict";
/**
 * PartitionedDetector Base Class
 *
 * Base class for partition-specific detectors that manage multiple chains.
 * Implements ADR-003 (Partitioned Chain Detectors) for efficient multi-chain
 * monitoring within free-tier resource limits.
 *
 * Features:
 * - Multi-chain WebSocket connection management
 * - Aggregated health reporting across chains
 * - Cross-chain price tracking for arbitrage detection
 * - Graceful degradation when individual chains fail
 * - Dynamic chain addition/removal at runtime
 *
 * Design Goals:
 * - Enable 15+ chains within free tier limits
 * - Isolate failures to individual chains
 * - Provide unified health reporting per partition
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.1: Create PartitionedDetector base class
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartitionedDetector = void 0;
const events_1 = require("events");
const ethers_1 = require("ethers");
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
const websocket_manager_1 = require("./websocket-manager");
const src_1 = require("../../config/src");
// =============================================================================
// S3.2.4-FIX: Token Pair Normalization Helper
// =============================================================================
/**
 * Normalize a token pair string for cross-chain matching.
 * Handles different token symbol conventions across chains:
 * - WETH.e_USDT (Avalanche) → WETH_USDT
 * - ETH_USDT (BSC) → WETH_USDT
 * - WBTC.e_USDC (Avalanche) → WBTC_USDC
 *
 * @param pairKey - Token pair string in format "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
 * @returns Normalized token pair string
 */
function normalizeTokenPair(pairKey) {
    const parts = pairKey.split('_');
    if (parts.length < 2)
        return pairKey;
    // Take last 2 parts as tokens (handles both formats)
    const token0 = parts[parts.length - 2];
    const token1 = parts[parts.length - 1];
    // Normalize each token in the pair
    const normalizedToken0 = (0, src_1.normalizeTokenForCrossChain)(token0);
    const normalizedToken1 = (0, src_1.normalizeTokenForCrossChain)(token1);
    return `${normalizedToken0}_${normalizedToken1}`;
}
// =============================================================================
// PartitionedDetector Base Class
// =============================================================================
class PartitionedDetector extends events_1.EventEmitter {
    constructor(config) {
        super();
        // Clients
        this.redis = null;
        this.streamsClient = null;
        // Chain management
        this.chainManagers = new Map();
        this.chainProviders = new Map();
        this.chainHealth = new Map();
        this.chainStats = new Map();
        this.chainConfigs = new Map();
        // Cross-chain price tracking
        this.chainPrices = new Map();
        // Health tracking
        this.eventLatencies = [];
        this.healthMonitoringInterval = null;
        this.startTime = 0;
        // Lifecycle state
        this.running = false;
        this.stopping = false;
        this.startPromise = null;
        this.stopPromise = null;
        // Validate chains
        if (!config.chains || config.chains.length === 0) {
            throw new Error('At least one chain must be specified');
        }
        for (const chainId of config.chains) {
            if (!src_1.CHAINS[chainId]) {
                throw new Error(`Invalid chain: ${chainId}`);
            }
        }
        // Set defaults
        this.config = {
            partitionId: config.partitionId,
            chains: [...config.chains],
            region: config.region,
            healthCheckIntervalMs: config.healthCheckIntervalMs ?? 15000,
            failoverTimeoutMs: config.failoverTimeoutMs ?? 60000,
            maxReconnectAttempts: config.maxReconnectAttempts ?? 5
        };
        this.logger = (0, logger_1.createLogger)(`partition:${config.partitionId}`);
        this.perfLogger = (0, logger_1.getPerformanceLogger)(`partition:${config.partitionId}`);
        // Initialize chain configs
        for (const chainId of this.config.chains) {
            this.chainConfigs.set(chainId, src_1.CHAINS[chainId]);
            this.initializeChainHealth(chainId);
        }
    }
    // ===========================================================================
    // Lifecycle Methods
    // ===========================================================================
    async start() {
        // Return existing promise if start in progress
        if (this.startPromise) {
            return this.startPromise;
        }
        // Wait for pending stop
        if (this.stopPromise) {
            await this.stopPromise;
        }
        // Guard against starting while stopping
        if (this.stopping) {
            this.logger.warn('Cannot start: PartitionedDetector is stopping');
            return;
        }
        // Guard against double start
        if (this.running) {
            this.logger.warn('PartitionedDetector already running');
            return;
        }
        this.startPromise = this.performStart();
        try {
            await this.startPromise;
        }
        finally {
            this.startPromise = null;
        }
    }
    async performStart() {
        this.logger.info('Starting PartitionedDetector', {
            partitionId: this.config.partitionId,
            chains: this.config.chains,
            region: this.config.region
        });
        this.startTime = Date.now();
        try {
            // Initialize Redis clients
            await this.initializeRedis();
            // Initialize chain connections
            await this.initializeChainConnections();
            // Start health monitoring
            this.startHealthMonitoring();
            this.running = true;
            this.emit('started', {
                partitionId: this.config.partitionId,
                chains: this.config.chains
            });
            this.logger.info('PartitionedDetector started successfully', {
                chainsConnected: this.chainManagers.size
            });
        }
        catch (error) {
            // Cleanup on failure
            await this.cleanup();
            this.logger.error('Failed to start PartitionedDetector', { error });
            throw error;
        }
    }
    async stop() {
        // Return existing promise if stop in progress
        if (this.stopPromise) {
            return this.stopPromise;
        }
        // Guard against stop when not running
        if (!this.running && !this.stopping) {
            this.logger.debug('PartitionedDetector not running');
            return;
        }
        this.stopPromise = this.performStop();
        try {
            await this.stopPromise;
        }
        finally {
            this.stopPromise = null;
        }
    }
    async performStop() {
        this.logger.info('Stopping PartitionedDetector', {
            partitionId: this.config.partitionId
        });
        this.stopping = true;
        this.running = false;
        await this.cleanup();
        this.stopping = false;
        this.emit('stopped', {
            partitionId: this.config.partitionId
        });
        this.logger.info('PartitionedDetector stopped');
    }
    async cleanup() {
        // Stop health monitoring
        if (this.healthMonitoringInterval) {
            clearInterval(this.healthMonitoringInterval);
            this.healthMonitoringInterval = null;
        }
        // Disconnect all WebSocket managers
        const disconnectPromises = [];
        for (const [chainId, wsManager] of this.chainManagers) {
            disconnectPromises.push(this.disconnectChain(chainId).catch(err => {
                this.logger.warn(`Error disconnecting ${chainId}`, { error: err });
            }));
        }
        await Promise.allSettled(disconnectPromises);
        // Clear chain managers
        this.chainManagers.clear();
        this.chainProviders.clear();
        // Disconnect Redis
        if (this.streamsClient) {
            try {
                await this.streamsClient.disconnect();
            }
            catch (error) {
                this.logger.warn('Error disconnecting Streams client', { error });
            }
            this.streamsClient = null;
        }
        if (this.redis) {
            try {
                await this.redis.disconnect();
            }
            catch (error) {
                this.logger.warn('Error disconnecting Redis client', { error });
            }
            this.redis = null;
        }
        // Clear tracking data
        this.chainPrices.clear();
        this.eventLatencies = [];
    }
    // ===========================================================================
    // Redis Initialization
    // ===========================================================================
    async initializeRedis() {
        this.redis = await (0, redis_1.getRedisClient)();
        this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
        this.logger.debug('Redis clients initialized');
    }
    // ===========================================================================
    // Chain Connection Management
    // ===========================================================================
    async initializeChainConnections() {
        const connectionPromises = [];
        for (const chainId of this.config.chains) {
            connectionPromises.push(this.connectChain(chainId).catch(err => {
                this.logger.error(`Failed to connect ${chainId}`, { error: err });
                this.updateChainHealth(chainId, 'unhealthy', false);
            }));
        }
        // Wait for all connections (successful or failed)
        await Promise.allSettled(connectionPromises);
    }
    async connectChain(chainId) {
        const chainConfig = this.chainConfigs.get(chainId);
        if (!chainConfig) {
            throw new Error(`Chain config not found: ${chainId}`);
        }
        // Initialize RPC provider
        const provider = new ethers_1.ethers.JsonRpcProvider(chainConfig.rpcUrl);
        this.chainProviders.set(chainId, provider);
        // Initialize WebSocket manager
        const wsConfig = {
            url: chainConfig.wsUrl || chainConfig.rpcUrl,
            fallbackUrls: chainConfig.wsFallbackUrls,
            reconnectInterval: 5000,
            maxReconnectAttempts: this.config.maxReconnectAttempts,
            pingInterval: 30000,
            connectionTimeout: 10000
        };
        const wsManager = new websocket_manager_1.WebSocketManager(wsConfig);
        // Set up event handlers BEFORE connecting
        // The 'connected' handler will emit chainConnected and update health
        this.setupChainEventHandlers(chainId, wsManager);
        // Connect - this will trigger 'connected' event which handles:
        // - updateChainHealth(chainId, 'healthy', true)
        // - emit('chainConnected', { chainId })
        await wsManager.connect();
        // P2-1 FIX: Only add to chainManagers here - health and event are handled by 'connected' handler
        // This prevents duplicate chainConnected events and ensures consistency for reconnections
        this.chainManagers.set(chainId, wsManager);
        this.logger.info(`Chain ${chainId} connected`);
    }
    async disconnectChain(chainId) {
        const wsManager = this.chainManagers.get(chainId);
        if (wsManager) {
            wsManager.removeAllListeners();
            await Promise.race([
                wsManager.disconnect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnect timeout')), 5000))
            ]).catch(() => {
                // Timeout is acceptable during cleanup
            });
        }
        this.chainProviders.delete(chainId);
        this.updateChainHealth(chainId, 'unhealthy', false);
    }
    setupChainEventHandlers(chainId, wsManager) {
        wsManager.on('connected', () => {
            this.updateChainHealth(chainId, 'healthy', true);
            this.emit('chainConnected', { chainId });
        });
        wsManager.on('disconnected', () => {
            this.logger.warn(`Chain ${chainId} disconnected, will attempt reconnection`);
            this.updateChainHealth(chainId, 'degraded', false);
            this.emit('chainDisconnected', { chainId });
        });
        wsManager.on('error', (error) => {
            this.updateChainHealth(chainId, 'unhealthy', false);
            this.emit('chainError', { chainId, error });
        });
        wsManager.on('message', (message) => {
            this.handleChainMessage(chainId, message);
        });
    }
    // ===========================================================================
    // Dynamic Chain Management
    // ===========================================================================
    async addChain(chainId) {
        if (!src_1.CHAINS[chainId]) {
            throw new Error(`Invalid chain: ${chainId}`);
        }
        if (this.config.chains.includes(chainId)) {
            this.logger.warn(`Chain ${chainId} already in partition`);
            return;
        }
        this.config.chains.push(chainId);
        this.chainConfigs.set(chainId, src_1.CHAINS[chainId]);
        this.initializeChainHealth(chainId);
        if (this.running) {
            await this.connectChain(chainId);
        }
        this.logger.info(`Chain ${chainId} added to partition`);
    }
    async removeChain(chainId) {
        if (this.config.chains.length === 1) {
            throw new Error('Cannot remove last chain from partition');
        }
        const index = this.config.chains.indexOf(chainId);
        if (index === -1) {
            this.logger.warn(`Chain ${chainId} not in partition`);
            return;
        }
        // Disconnect if running
        if (this.chainManagers.has(chainId)) {
            await this.disconnectChain(chainId);
            this.chainManagers.delete(chainId);
        }
        // Remove from config
        this.config.chains.splice(index, 1);
        this.chainConfigs.delete(chainId);
        this.chainHealth.delete(chainId);
        this.chainStats.delete(chainId);
        this.chainPrices.delete(chainId);
        this.logger.info(`Chain ${chainId} removed from partition`);
    }
    // ===========================================================================
    // Health Management
    // ===========================================================================
    initializeChainHealth(chainId) {
        this.chainHealth.set(chainId, {
            chainId,
            status: 'unhealthy',
            wsConnected: false,
            blocksBehind: 0,
            lastBlockTime: 0,
            eventsPerSecond: 0,
            errorCount: 0
        });
        this.chainStats.set(chainId, {
            eventsProcessed: 0,
            lastBlockNumber: 0,
            lastBlockTimestamp: 0
        });
        this.chainPrices.set(chainId, new Map());
    }
    updateChainHealth(chainId, status, wsConnected) {
        const health = this.chainHealth.get(chainId);
        if (health) {
            health.status = status;
            health.wsConnected = wsConnected;
            if (status === 'unhealthy') {
                health.errorCount++;
            }
        }
    }
    startHealthMonitoring() {
        this.healthMonitoringInterval = setInterval(async () => {
            if (!this.running || this.stopping) {
                return;
            }
            try {
                const health = this.getPartitionHealth();
                // Persist to Redis - convert to ServiceHealth format
                // P3-2 FIX: Use unified ServiceHealth with 'name' field
                if (this.redis) {
                    const serviceHealth = {
                        name: `partition:${this.config.partitionId}`,
                        status: health.status,
                        uptime: health.uptimeSeconds,
                        memoryUsage: health.memoryUsage,
                        cpuUsage: health.cpuUsage,
                        lastHeartbeat: health.lastHealthCheck,
                        latency: health.avgEventLatencyMs
                    };
                    await this.redis.updateServiceHealth(`partition:${this.config.partitionId}`, serviceHealth);
                }
                this.emit('healthUpdate', health);
                this.perfLogger.logHealthCheck(this.config.partitionId, health);
            }
            catch (error) {
                this.logger.error('Health monitoring failed', { error });
            }
        }, this.config.healthCheckIntervalMs);
    }
    getPartitionHealth() {
        let totalEvents = 0;
        let healthyChains = 0;
        for (const stats of this.chainStats.values()) {
            totalEvents += stats.eventsProcessed;
        }
        for (const health of this.chainHealth.values()) {
            if (health.status === 'healthy') {
                healthyChains++;
            }
        }
        const totalChains = this.config.chains.length;
        let status;
        if (healthyChains === totalChains) {
            status = 'healthy';
        }
        else if (healthyChains === 0) {
            status = 'unhealthy';
        }
        else {
            status = 'degraded';
        }
        const avgLatency = this.eventLatencies.length > 0
            ? this.eventLatencies.reduce((a, b) => a + b, 0) / this.eventLatencies.length
            : 0;
        return {
            partitionId: this.config.partitionId,
            status,
            chainHealth: new Map(this.chainHealth),
            totalEventsProcessed: totalEvents,
            avgEventLatencyMs: avgLatency,
            memoryUsage: process.memoryUsage().heapUsed,
            cpuUsage: 0, // Would need os module for accurate CPU
            uptimeSeconds: this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0,
            lastHealthCheck: Date.now(),
            activeOpportunities: 0
        };
    }
    getHealthyChains() {
        const healthy = [];
        for (const [chainId, health] of this.chainHealth) {
            if (health.status === 'healthy') {
                healthy.push(chainId);
            }
        }
        return healthy;
    }
    // ===========================================================================
    // Message Handling
    // ===========================================================================
    handleChainMessage(chainId, message) {
        // Guard against processing during shutdown
        if (this.stopping || !this.running) {
            return;
        }
        try {
            if (message.method === 'eth_subscription') {
                const result = message.params?.result;
                // P0-1 FIX: Type-safe checks with proper casting
                if (result && typeof result === 'object' && 'topics' in result) {
                    this.handleLogEvent(chainId, result);
                }
                else if (result && typeof result === 'object' && 'number' in result) {
                    this.handleNewBlock(chainId, result);
                }
            }
        }
        catch (error) {
            this.logger.error(`Error handling message from ${chainId}`, { error });
        }
    }
    // P0-1 FIX: Use EthereumLog type instead of any
    handleLogEvent(chainId, log) {
        const topic0 = log.topics?.[0];
        if (topic0 === src_1.EVENT_SIGNATURES.SYNC) {
            this.handleSyncEvent(chainId, log);
        }
        else if (topic0 === src_1.EVENT_SIGNATURES.SWAP_V2) {
            this.handleSwapEvent(chainId, log);
        }
        // Update stats
        const stats = this.chainStats.get(chainId);
        if (stats) {
            stats.eventsProcessed++;
        }
    }
    // P0-1 FIX: Use EthereumLog type instead of any
    handleSyncEvent(chainId, log) {
        // Override in subclass for specific handling
    }
    // P0-1 FIX: Use EthereumLog type instead of any
    handleSwapEvent(chainId, log) {
        // Override in subclass for specific handling
    }
    // P0-1 FIX: Use EthereumBlockHeader type instead of any
    handleNewBlock(chainId, block) {
        const stats = this.chainStats.get(chainId);
        if (stats) {
            const blockNumber = parseInt(block.number, 16);
            stats.lastBlockNumber = blockNumber;
            stats.lastBlockTimestamp = Date.now();
        }
        const health = this.chainHealth.get(chainId);
        if (health) {
            health.lastBlockTime = Date.now();
        }
    }
    // ===========================================================================
    // Cross-Chain Price Tracking
    // ===========================================================================
    updatePrice(chainId, pairKey, price) {
        const chainPriceMap = this.chainPrices.get(chainId);
        if (chainPriceMap) {
            chainPriceMap.set(pairKey, { price, timestamp: Date.now() });
        }
    }
    getCrossChainPrices(pairKey) {
        const prices = new Map();
        for (const [chainId, chainPriceMap] of this.chainPrices) {
            const pricePoint = chainPriceMap.get(pairKey);
            if (pricePoint) {
                prices.set(chainId, pricePoint);
            }
        }
        return prices;
    }
    findCrossChainDiscrepancies(minDifferencePercent) {
        const discrepancies = [];
        // P1-1 FIX: Create a deep snapshot of all chain prices to prevent race conditions
        // during iteration. If updatePrice is called during discrepancy detection,
        // we work with consistent point-in-time data.
        const pricesSnapshot = new Map();
        for (const [chainId, chainPriceMap] of this.chainPrices) {
            pricesSnapshot.set(chainId, new Map(chainPriceMap));
        }
        // S3.2.4-FIX: Group prices by NORMALIZED pair key to detect cross-chain discrepancies
        // Different chains may use different token symbols for the same asset:
        // - Avalanche: WETH.e_USDT → normalizes to WETH_USDT
        // - BSC: ETH_USDT → normalizes to WETH_USDT
        // Without normalization, these would be treated as different pairs!
        const normalizedPrices = new Map();
        for (const [chainId, chainPriceMap] of pricesSnapshot) {
            for (const [pairKey, pricePoint] of chainPriceMap) {
                const normalizedPair = normalizeTokenPair(pairKey);
                if (!normalizedPrices.has(normalizedPair)) {
                    normalizedPrices.set(normalizedPair, new Map());
                }
                normalizedPrices.get(normalizedPair).set(chainId, {
                    price: pricePoint,
                    originalPairKey: pairKey
                });
            }
        }
        // Check each normalized pair for cross-chain discrepancies
        for (const [normalizedPair, chainPriceData] of normalizedPrices) {
            if (chainPriceData.size < 2)
                continue;
            const priceValues = Array.from(chainPriceData.values()).map(p => p.price.price);
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);
            if (minPrice === 0)
                continue;
            const difference = (maxPrice - minPrice) / minPrice;
            if (difference >= minDifferencePercent) {
                const priceMap = new Map();
                for (const [chainId, data] of chainPriceData) {
                    priceMap.set(chainId, data.price.price);
                }
                discrepancies.push({
                    pairKey: normalizedPair, // Use normalized pair key for consistency
                    chains: Array.from(chainPriceData.keys()),
                    prices: priceMap,
                    maxDifference: difference,
                    timestamp: Date.now()
                });
            }
        }
        return discrepancies;
    }
    // ===========================================================================
    // Public Getters
    // ===========================================================================
    isRunning() {
        return this.running;
    }
    getPartitionId() {
        return this.config.partitionId;
    }
    getChains() {
        return [...this.config.chains];
    }
    getRegion() {
        return this.config.region;
    }
    getChainManagers() {
        return new Map(this.chainManagers);
    }
    getChainHealth(chainId) {
        return this.chainHealth.get(chainId);
    }
}
exports.PartitionedDetector = PartitionedDetector;
exports.default = PartitionedDetector;
//# sourceMappingURL=partitioned-detector.js.map
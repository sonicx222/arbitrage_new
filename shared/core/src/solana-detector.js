"use strict";
/**
 * S3.3.1 Solana Detector Base Infrastructure
 *
 * Base class for Solana blockchain detection that provides:
 * - @solana/web3.js integration (different from ethers.js for EVM)
 * - Program account subscriptions (not event logs)
 * - Connection pooling for RPC rate limits
 * - Solana-specific price feed handling
 * - Arbitrage detection between Solana DEXs
 *
 * Key Differences from EVM BaseDetector:
 * - Uses Connection instead of JsonRpcProvider
 * - Uses accountSubscribe/programSubscribe instead of eth_subscribe
 * - Program IDs instead of contract addresses
 * - Instruction parsing instead of event log decoding
 * - Slot instead of block number
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.1
 * @see ADR-003: Partitioned Chain Detectors
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolanaDetector = exports.SOLANA_DEX_PROGRAMS = void 0;
const events_1 = require("events");
const web3_js_1 = require("@solana/web3.js");
const logger_1 = require("./logger");
const async_mutex_1 = require("./async-mutex");
const async_utils_1 = require("./async-utils");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
// =============================================================================
// Known Solana DEX Program IDs
// =============================================================================
exports.SOLANA_DEX_PROGRAMS = {
    // Jupiter Aggregator
    JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    // Raydium AMM
    RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    // Raydium CLMM (Concentrated Liquidity)
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    // Orca Whirlpools
    ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    // Meteora DLMM
    METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    // Phoenix (Order Book)
    PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
    // Lifinity
    LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
};
// =============================================================================
// SolanaDetector Class
// =============================================================================
/**
 * Base class for Solana blockchain detection.
 * Provides connection pooling, program subscriptions, and arbitrage detection.
 */
class SolanaDetector extends events_1.EventEmitter {
    constructor(config, deps) {
        super();
        // Redis clients
        this.redis = null;
        this.streamsClient = null;
        this.priceUpdateBatcher = null;
        // Subscription tracking
        this.subscriptions = new Map();
        // Pool management
        this.pools = new Map();
        this.poolsByDex = new Map();
        this.poolsByTokenPair = new Map();
        // State tracking
        this.running = false;
        this.stopping = false;
        this.startTime = 0;
        this.currentSlot = 0;
        this.healthCheckInterval = null;
        // Lifecycle protection (consistent with PartitionedDetector pattern)
        this.startPromise = null;
        this.stopPromise = null;
        // Latency tracking for health metrics
        this.recentLatencies = [];
        // RACE CONDITION FIX: Mutex to prevent concurrent updateCurrentSlot execution
        this.slotUpdateMutex = new async_mutex_1.AsyncMutex();
        // RACE CONDITION FIX: Mutex for atomic pool updates across multiple maps
        // Ensures pools, poolsByDex, and poolsByTokenPair stay consistent
        this.poolUpdateMutex = new async_mutex_1.AsyncMutex();
        // Validate required config
        if (!config.rpcUrl || config.rpcUrl.trim() === '') {
            throw new Error('RPC URL is required for SolanaDetector');
        }
        // Set defaults
        this.config = {
            rpcUrl: config.rpcUrl,
            wsUrl: config.wsUrl || this.deriveWsUrl(config.rpcUrl),
            commitment: config.commitment || 'confirmed',
            rpcFallbackUrls: config.rpcFallbackUrls || [],
            wsFallbackUrls: config.wsFallbackUrls || [],
            healthCheckIntervalMs: config.healthCheckIntervalMs || 30000,
            connectionPoolSize: config.connectionPoolSize || 3,
            maxRetries: config.maxRetries || 3,
            retryDelayMs: config.retryDelayMs || 1000,
            minProfitThreshold: config.minProfitThreshold || 0.3
        };
        // Set up logging
        this.logger = deps?.logger || (0, logger_1.createLogger)('solana-detector');
        this.perfLogger = deps?.perfLogger || (0, logger_1.getPerformanceLogger)('solana-detector');
        // Store injected Redis clients for DI pattern (used in tests)
        this.injectedRedisClient = deps?.redisClient;
        this.injectedStreamsClient = deps?.streamsClient;
        // Initialize RPC URLs list
        this.currentRpcUrl = this.config.rpcUrl;
        this.allRpcUrls = [this.config.rpcUrl, ...this.config.rpcFallbackUrls];
        // Initialize connection pool structure (connections created on start)
        this.connectionPool = {
            size: this.config.connectionPoolSize,
            connections: [],
            currentIndex: 0,
            healthStatus: [],
            latencies: [],
            failedRequests: [],
            subscriptionConnections: new Map(),
            reconnecting: [],
            reconnectAttempts: []
        };
        this.logger.info('SolanaDetector initialized', {
            rpcUrl: this.config.rpcUrl,
            wsUrl: this.config.wsUrl,
            commitment: this.config.commitment,
            poolSize: this.config.connectionPoolSize,
            fallbackUrls: this.config.rpcFallbackUrls.length
        });
    }
    // ===========================================================================
    // Configuration Getters
    // ===========================================================================
    getChain() {
        return 'solana';
    }
    isEVM() {
        return false;
    }
    getRpcUrl() {
        return this.config.rpcUrl;
    }
    getWsUrl() {
        return this.config.wsUrl;
    }
    getCommitment() {
        return this.config.commitment;
    }
    getFallbackUrls() {
        return {
            rpc: this.config.rpcFallbackUrls,
            ws: this.config.wsFallbackUrls
        };
    }
    getCurrentRpcUrl() {
        return this.currentRpcUrl;
    }
    // ===========================================================================
    // Lifecycle Methods (with race-condition protection)
    // ===========================================================================
    async start() {
        // Return existing promise if start in progress (prevents race conditions)
        if (this.startPromise) {
            return this.startPromise;
        }
        // Wait for pending stop
        if (this.stopPromise) {
            await this.stopPromise;
        }
        // Guard against starting while stopping
        if (this.stopping) {
            this.logger.warn('Cannot start: SolanaDetector is stopping');
            return;
        }
        // Guard against double start
        if (this.running) {
            this.logger.warn('SolanaDetector already running');
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
        this.logger.info('Starting SolanaDetector', {
            rpcUrl: this.currentRpcUrl,
            commitment: this.config.commitment
        });
        try {
            // Initialize Redis
            await this.initializeRedis();
            // Initialize connection pool
            await this.initializeConnectionPool();
            // Get initial slot
            await this.updateCurrentSlot();
            // Start health monitoring
            this.startHealthMonitoring();
            this.running = true;
            this.startTime = Date.now();
            this.emit('started', { chain: 'solana' });
            this.logger.info('SolanaDetector started successfully', {
                slot: this.currentSlot,
                connections: this.connectionPool.connections.length
            });
        }
        catch (error) {
            this.logger.error('Failed to start SolanaDetector', { error });
            await this.cleanup();
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
            this.logger.debug('SolanaDetector not running');
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
        this.logger.info('Stopping SolanaDetector');
        this.stopping = true;
        this.running = false;
        await this.cleanup();
        this.stopping = false;
        this.emit('stopped', { chain: 'solana' });
        this.logger.info('SolanaDetector stopped');
    }
    isRunning() {
        return this.running;
    }
    async cleanup() {
        // Stop health monitoring
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        // Unsubscribe from all programs
        for (const [programId] of this.subscriptions) {
            try {
                await this.unsubscribeFromProgram(programId);
            }
            catch (error) {
                this.logger.warn(`Error unsubscribing from ${programId}`, { error });
            }
        }
        this.subscriptions.clear();
        // Clean up batcher
        if (this.priceUpdateBatcher) {
            try {
                await this.priceUpdateBatcher.destroy();
            }
            catch (error) {
                this.logger.warn('Error destroying price update batcher', { error });
            }
            this.priceUpdateBatcher = null;
        }
        // Disconnect Redis
        if (this.streamsClient) {
            try {
                await this.streamsClient.disconnect();
            }
            catch (error) {
                this.logger.warn('Error disconnecting streams client', { error });
            }
            this.streamsClient = null;
        }
        if (this.redis) {
            try {
                await this.redis.disconnect();
            }
            catch (error) {
                this.logger.warn('Error disconnecting redis', { error });
            }
            this.redis = null;
        }
        // Clear connection pool
        this.connectionPool.connections = [];
        this.connectionPool.healthStatus = [];
        this.connectionPool.reconnecting = [];
        this.connectionPool.reconnectAttempts = [];
        this.connectionPool.subscriptionConnections.clear();
        // Clear pools
        this.pools.clear();
        this.poolsByDex.clear();
        this.poolsByTokenPair.clear();
        // Clear latency tracking
        this.recentLatencies = [];
    }
    // ===========================================================================
    // Redis Initialization
    // ===========================================================================
    async initializeRedis() {
        // Use injected clients if available (DI pattern for tests), otherwise use singletons
        if (this.injectedRedisClient) {
            this.redis = this.injectedRedisClient;
        }
        else {
            this.redis = await (0, redis_1.getRedisClient)();
        }
        if (this.injectedStreamsClient) {
            this.streamsClient = this.injectedStreamsClient;
        }
        else {
            this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
        }
        // Create price update batcher
        this.priceUpdateBatcher = this.streamsClient.createBatcher(redis_streams_1.RedisStreamsClient.STREAMS.PRICE_UPDATES, {
            maxBatchSize: 50,
            maxWaitMs: 100
        });
        this.logger.debug('Redis clients initialized');
    }
    // ===========================================================================
    // Connection Pool Management
    // ===========================================================================
    async initializeConnectionPool() {
        const { size, commitment } = { size: this.config.connectionPoolSize, commitment: this.config.commitment };
        this.connectionPool = {
            size,
            connections: [],
            currentIndex: 0,
            healthStatus: [],
            latencies: [],
            failedRequests: [],
            subscriptionConnections: new Map(),
            reconnecting: [],
            reconnectAttempts: []
        };
        // Create connections - distribute across available URLs
        for (let i = 0; i < size; i++) {
            const urlIndex = i % this.allRpcUrls.length;
            const rpcUrl = this.allRpcUrls[urlIndex];
            const connection = new web3_js_1.Connection(rpcUrl, {
                commitment,
                wsEndpoint: this.config.wsUrl
            });
            this.connectionPool.connections.push(connection);
            this.connectionPool.healthStatus.push(true);
            this.connectionPool.latencies.push(0);
            this.connectionPool.failedRequests.push(0);
            this.connectionPool.reconnecting.push(false);
            this.connectionPool.reconnectAttempts.push(0);
        }
        // Validate at least one connection works
        const slot = await this.connectionPool.connections[0].getSlot();
        this.currentSlot = slot;
        this.logger.info('Connection pool initialized', {
            size,
            initialSlot: slot
        });
    }
    getConnectionPoolSize() {
        return this.connectionPool.size;
    }
    getActiveConnections() {
        return this.connectionPool.connections.length;
    }
    getHealthyConnectionCount() {
        return this.connectionPool.healthStatus.filter(h => h).length;
    }
    /**
     * Get a connection from the pool using round-robin.
     * Prefers healthy connections when available.
     * Returns the connection and the actual index used.
     */
    getConnection() {
        const { connection } = this.getConnectionWithIndex();
        return connection;
    }
    /**
     * Get a connection from the pool along with its index.
     * This is critical for subscription tracking - subscriptions must be
     * unsubscribed from the same connection that created them.
     * @internal
     */
    getConnectionWithIndex() {
        // Safety check for empty pool
        if (this.connectionPool.connections.length === 0) {
            throw new Error('Connection pool is empty - detector may not be started');
        }
        // Try to find a healthy connection starting from current index
        const startIndex = this.connectionPool.currentIndex;
        let attempts = 0;
        while (attempts < this.connectionPool.size) {
            const index = (startIndex + attempts) % this.connectionPool.size;
            if (this.connectionPool.healthStatus[index]) {
                this.connectionPool.currentIndex = (index + 1) % this.connectionPool.size;
                return { connection: this.connectionPool.connections[index], index };
            }
            attempts++;
        }
        // Fallback to round-robin if no healthy connections
        const index = this.connectionPool.currentIndex;
        const conn = this.connectionPool.connections[index];
        this.connectionPool.currentIndex = (index + 1) % this.connectionPool.size;
        return { connection: conn, index };
    }
    /**
     * Get a connection by index (for subscription tracking).
     * @internal
     */
    getConnectionByIndex(index) {
        if (index < 0 || index >= this.connectionPool.connections.length) {
            throw new Error(`Invalid connection index: ${index}`);
        }
        return this.connectionPool.connections[index];
    }
    /**
     * Get the current connection index (for subscription tracking).
     * @internal
     */
    getCurrentConnectionIndex() {
        return this.connectionPool.currentIndex;
    }
    /**
     * Mark a connection as failed.
     */
    async markConnectionFailed(index) {
        if (index >= 0 && index < this.connectionPool.size) {
            this.connectionPool.healthStatus[index] = false;
            this.connectionPool.failedRequests[index]++;
            this.logger.warn('Connection marked as failed', {
                index,
                failedRequests: this.connectionPool.failedRequests[index]
            });
            // Schedule reconnection attempt
            setTimeout(() => this.attemptReconnection(index), this.config.retryDelayMs);
        }
    }
    async attemptReconnection(index) {
        if (this.stopping || !this.running)
            return;
        // Mutex: prevent concurrent reconnection attempts for same index
        if (this.connectionPool.reconnecting[index]) {
            this.logger.debug('Reconnection already in progress', { index });
            return;
        }
        this.connectionPool.reconnecting[index] = true;
        try {
            // Create new connection
            const urlIndex = index % this.allRpcUrls.length;
            const rpcUrl = this.allRpcUrls[urlIndex];
            const connection = new web3_js_1.Connection(rpcUrl, {
                commitment: this.config.commitment,
                wsEndpoint: this.config.wsUrl
            });
            // Test the connection
            await connection.getSlot();
            // Replace the failed connection
            this.connectionPool.connections[index] = connection;
            this.connectionPool.healthStatus[index] = true;
            // BUG FIX: Reset attempt counter on successful reconnection
            this.connectionPool.reconnectAttempts[index] = 0;
            this.logger.info('Connection reconnected successfully', { index });
        }
        catch (error) {
            // BUG FIX: Proper exponential backoff with attempt tracking
            const attempts = this.connectionPool.reconnectAttempts[index]++;
            // Cap at 5 attempts to prevent extremely long delays (max ~32x base delay)
            const cappedAttempts = Math.min(attempts, 5);
            const backoffDelay = this.config.retryDelayMs * Math.pow(2, cappedAttempts);
            this.logger.warn('Reconnection attempt failed', {
                index,
                attempt: attempts + 1,
                nextDelayMs: backoffDelay,
                error
            });
            setTimeout(() => this.attemptReconnection(index), backoffDelay);
        }
        finally {
            this.connectionPool.reconnecting[index] = false;
        }
    }
    getConnectionMetrics() {
        const healthyCount = this.connectionPool.healthStatus.filter(h => h).length;
        const totalFailed = this.connectionPool.failedRequests.reduce((a, b) => a + b, 0);
        const avgLatency = this.recentLatencies.length > 0
            ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
            : 0;
        return {
            totalConnections: this.connectionPool.size,
            healthyConnections: healthyCount,
            failedRequests: totalFailed,
            avgLatencyMs: avgLatency
        };
    }
    // ===========================================================================
    // Program Account Subscriptions
    // ===========================================================================
    async subscribeToProgramAccounts(programId) {
        // Validate program ID
        if (!this.isValidSolanaAddress(programId)) {
            this.logger.error('Invalid program ID', { programId });
            throw new Error(`Invalid program ID: ${programId}`);
        }
        if (this.subscriptions.has(programId)) {
            this.logger.debug('Already subscribed to program', { programId });
            return;
        }
        // BUG FIX: Get connection AND its actual index atomically
        // Previously captured index BEFORE getConnection(), which could return
        // a different connection if some were unhealthy
        const { connection, index: connectionIndex } = this.getConnectionWithIndex();
        const pubkey = new web3_js_1.PublicKey(programId);
        const subscriptionId = connection.onProgramAccountChange(pubkey, (accountInfo, context) => {
            this.handleProgramAccountUpdate(programId, accountInfo, context);
        }, this.config.commitment);
        this.subscriptions.set(programId, {
            programId,
            subscriptionId
        });
        // Track which connection this subscription was created on
        this.connectionPool.subscriptionConnections.set(programId, connectionIndex);
        this.logger.info('Subscribed to program accounts', {
            programId,
            subscriptionId,
            connectionIndex
        });
    }
    async unsubscribeFromProgram(programId) {
        const subscription = this.subscriptions.get(programId);
        if (!subscription) {
            this.logger.debug('Not subscribed to program', { programId });
            return;
        }
        // Use the same connection that was used to create the subscription
        // This is critical - subscription IDs are tied to specific connections
        const connectionIndex = this.connectionPool.subscriptionConnections.get(programId);
        let connection;
        if (connectionIndex !== undefined && connectionIndex < this.connectionPool.connections.length) {
            connection = this.connectionPool.connections[connectionIndex];
        }
        else {
            // Fallback if connection index is invalid (shouldn't happen normally)
            this.logger.warn('Subscription connection index not found, using current connection', { programId });
            connection = this.getConnection();
        }
        try {
            await connection.removeProgramAccountChangeListener(subscription.subscriptionId);
        }
        catch (error) {
            // Log but don't throw - we still want to clean up our tracking
            this.logger.warn('Error removing subscription listener', { programId, error });
        }
        this.subscriptions.delete(programId);
        this.connectionPool.subscriptionConnections.delete(programId);
        this.logger.info('Unsubscribed from program', { programId });
    }
    isSubscribedToProgram(programId) {
        return this.subscriptions.has(programId);
    }
    getSubscriptionCount() {
        return this.subscriptions.size;
    }
    handleProgramAccountUpdate(programId, accountInfo, context) {
        if (this.stopping || !this.running)
            return;
        this.emit('accountUpdate', {
            programId,
            accountId: accountInfo.accountId.toBase58(),
            data: accountInfo.accountInfo.data,
            slot: context.slot
        });
        // Update current slot
        if (context.slot > this.currentSlot) {
            this.currentSlot = context.slot;
        }
    }
    /**
     * Simulate an account update (for testing).
     */
    simulateAccountUpdate(programId, data) {
        this.emit('accountUpdate', {
            programId,
            accountId: data.accountId,
            data: data.accountInfo?.data,
            slot: this.currentSlot + 1
        });
    }
    // ===========================================================================
    // Pool Management
    // ===========================================================================
    addPool(pool) {
        this.pools.set(pool.address, pool);
        // Index by DEX
        if (!this.poolsByDex.has(pool.dex)) {
            this.poolsByDex.set(pool.dex, new Set());
        }
        this.poolsByDex.get(pool.dex).add(pool.address);
        // Index by token pair (normalized)
        const pairKey = this.getTokenPairKey(pool.token0.mint, pool.token1.mint);
        if (!this.poolsByTokenPair.has(pairKey)) {
            this.poolsByTokenPair.set(pairKey, new Set());
        }
        this.poolsByTokenPair.get(pairKey).add(pool.address);
        this.logger.debug('Pool added', {
            address: pool.address,
            dex: pool.dex,
            pair: `${pool.token0.symbol}/${pool.token1.symbol}`
        });
    }
    removePool(address) {
        const pool = this.pools.get(address);
        if (!pool)
            return;
        // Remove from DEX index and clean up empty Set
        const dexSet = this.poolsByDex.get(pool.dex);
        if (dexSet) {
            dexSet.delete(address);
            if (dexSet.size === 0) {
                this.poolsByDex.delete(pool.dex);
            }
        }
        // Remove from token pair index and clean up empty Set
        const pairKey = this.getTokenPairKey(pool.token0.mint, pool.token1.mint);
        const pairSet = this.poolsByTokenPair.get(pairKey);
        if (pairSet) {
            pairSet.delete(address);
            if (pairSet.size === 0) {
                this.poolsByTokenPair.delete(pairKey);
            }
        }
        // Remove from main map
        this.pools.delete(address);
        this.logger.debug('Pool removed', { address });
    }
    getPool(address) {
        return this.pools.get(address);
    }
    getPoolCount() {
        return this.pools.size;
    }
    getPoolsByDex(dex) {
        const addresses = this.poolsByDex.get(dex);
        if (!addresses)
            return [];
        return Array.from(addresses)
            .map(addr => this.pools.get(addr))
            .filter((p) => p !== undefined);
    }
    getPoolsByTokenPair(token0, token1) {
        const pairKey = this.getTokenPairKey(token0, token1);
        const addresses = this.poolsByTokenPair.get(pairKey);
        if (!addresses)
            return [];
        return Array.from(addresses)
            .map(addr => this.pools.get(addr))
            .filter((p) => p !== undefined);
    }
    async updatePoolPrice(poolAddress, update) {
        const pool = this.pools.get(poolAddress);
        if (!pool) {
            this.logger.warn('Pool not found for price update', { poolAddress });
            return;
        }
        pool.price = update.price;
        pool.reserve0 = update.reserve0;
        pool.reserve1 = update.reserve1;
        pool.lastSlot = update.slot;
    }
    getTokenPairKey(token0, token1) {
        // Normalize by sorting alphabetically
        const sorted = [token0.toLowerCase(), token1.toLowerCase()].sort();
        return `${sorted[0]}_${sorted[1]}`;
    }
    // ===========================================================================
    // Price Update Publishing
    // ===========================================================================
    async publishPriceUpdate(update) {
        if (!this.priceUpdateBatcher) {
            throw new Error('Price update batcher not initialized');
        }
        const standardUpdate = this.toStandardPriceUpdate(update);
        const message = {
            type: 'price-update',
            data: standardUpdate,
            timestamp: Date.now(),
            source: 'solana-detector'
        };
        this.priceUpdateBatcher.add(message);
    }
    /**
     * Convert Solana-specific price update to standard format.
     */
    toStandardPriceUpdate(update) {
        return {
            pairKey: `${update.dex}_${update.token0}_${update.token1}`,
            pairAddress: update.poolAddress,
            dex: update.dex,
            chain: 'solana',
            token0: update.token0,
            token1: update.token1,
            price: update.price,
            reserve0: update.reserve0,
            reserve1: update.reserve1,
            blockNumber: update.slot, // Slot maps to blockNumber
            timestamp: update.timestamp,
            latency: 0
        };
    }
    getPendingUpdates() {
        if (!this.priceUpdateBatcher) {
            // INCONSISTENCY FIX: Log warning for observability (matches publishPriceUpdate behavior)
            this.logger.debug('getPendingUpdates called with no batcher initialized');
            return 0;
        }
        return this.priceUpdateBatcher.getStats().currentQueueSize || 0;
    }
    getBatcherStats() {
        if (!this.priceUpdateBatcher) {
            // INCONSISTENCY FIX: Log warning for observability (matches publishPriceUpdate behavior)
            this.logger.debug('getBatcherStats called with no batcher initialized');
            return { pending: 0, flushed: 0 };
        }
        const stats = this.priceUpdateBatcher.getStats();
        return {
            pending: stats.currentQueueSize || 0,
            flushed: stats.batchesSent || 0
        };
    }
    // ===========================================================================
    // Arbitrage Detection
    // ===========================================================================
    async checkArbitrage() {
        const opportunities = [];
        // RACE CONDITION FIX: Snapshot the pools map and token pairs at the start
        // This prevents inconsistent reads if addPool/removePool is called during iteration
        const poolsSnapshot = new Map(this.pools);
        const pairKeysSnapshot = Array.from(this.poolsByTokenPair.entries());
        // Get all unique token pairs
        for (const [pairKey, poolAddresses] of pairKeysSnapshot) {
            if (poolAddresses.size < 2)
                continue; // Need at least 2 pools for arbitrage
            // Use snapshot for pool lookup
            const pools = Array.from(poolAddresses)
                .map(addr => poolsSnapshot.get(addr))
                .filter((p) => p !== undefined && p.price !== undefined);
            if (pools.length < 2)
                continue;
            // Compare all pool pairs
            for (let i = 0; i < pools.length; i++) {
                for (let j = i + 1; j < pools.length; j++) {
                    const pool1 = pools[i];
                    const pool2 = pools[j];
                    const opportunity = this.calculateArbitrageOpportunity(pool1, pool2);
                    if (opportunity) {
                        opportunities.push(opportunity);
                    }
                }
            }
        }
        return opportunities;
    }
    calculateArbitrageOpportunity(pool1, pool2) {
        if (!pool1.price || !pool2.price)
            return null;
        // Calculate price difference
        const minPrice = Math.min(pool1.price, pool2.price);
        const maxPrice = Math.max(pool1.price, pool2.price);
        const grossDiff = (maxPrice - minPrice) / minPrice;
        // Calculate fees (convert from basis points to percentage)
        const fee1 = pool1.fee / 10000;
        const fee2 = pool2.fee / 10000;
        const totalFees = fee1 + fee2;
        // Net profit after fees
        const netProfit = grossDiff - totalFees;
        // Check against threshold
        if (netProfit * 100 < this.config.minProfitThreshold) {
            return null;
        }
        // Determine buy/sell direction
        const buyPool = pool1.price < pool2.price ? pool1 : pool2;
        const sellPool = pool1.price < pool2.price ? pool2 : pool1;
        return {
            id: `solana-${buyPool.address}-${sellPool.address}-${Date.now()}`,
            type: 'intra-dex',
            chain: 'solana',
            buyDex: buyPool.dex,
            sellDex: sellPool.dex,
            buyPair: buyPool.address,
            sellPair: sellPool.address,
            token0: buyPool.token0.mint,
            token1: buyPool.token1.mint,
            buyPrice: buyPool.price,
            sellPrice: sellPool.price,
            profitPercentage: netProfit * 100,
            expectedProfit: netProfit,
            confidence: 0.85, // Solana has fast finality
            timestamp: Date.now(),
            expiresAt: Date.now() + 1000, // 1 second expiry (Solana is fast)
            status: 'pending'
        };
    }
    // ===========================================================================
    // Health Monitoring
    // ===========================================================================
    async getHealth() {
        const metrics = this.getConnectionMetrics();
        // Determine health status with degraded support
        let status;
        if (!this.running) {
            status = 'unhealthy';
        }
        else if (metrics.healthyConnections === 0) {
            status = 'unhealthy';
        }
        else if (metrics.healthyConnections < metrics.totalConnections) {
            // Some but not all connections healthy = degraded
            status = 'degraded';
        }
        else {
            status = 'healthy';
        }
        return {
            service: 'solana-detector',
            status,
            uptime: this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0,
            memoryUsage: process.memoryUsage().heapUsed,
            lastHeartbeat: Date.now(),
            connections: metrics,
            subscriptions: this.subscriptions.size,
            pools: this.pools.size,
            slot: this.currentSlot
        };
    }
    startHealthMonitoring() {
        this.healthCheckInterval = setInterval(async () => {
            if (!this.running || this.stopping) {
                if (this.healthCheckInterval) {
                    clearInterval(this.healthCheckInterval);
                    this.healthCheckInterval = null;
                }
                return;
            }
            try {
                // Update current slot
                await this.updateCurrentSlot();
                // Get and log health
                const health = await this.getHealth();
                this.perfLogger.logHealthCheck('solana-detector', health);
                // Update Redis
                if (this.redis) {
                    await this.redis.updateServiceHealth('solana-detector', {
                        name: 'solana-detector',
                        status: health.status,
                        uptime: health.uptime,
                        memoryUsage: health.memoryUsage,
                        cpuUsage: 0,
                        lastHeartbeat: health.lastHeartbeat,
                        latency: health.connections.avgLatencyMs
                    });
                }
            }
            catch (error) {
                if (!this.stopping) {
                    this.logger.error('Health monitoring failed', { error });
                }
            }
        }, this.config.healthCheckIntervalMs);
    }
    async updateCurrentSlot() {
        // RACE CONDITION FIX: Use mutex to prevent concurrent execution
        // Health check intervals may queue multiple executions if getSlot() is slow
        const release = await this.slotUpdateMutex.acquire();
        try {
            const startTime = Date.now();
            const connection = this.getConnection();
            // S3.3.5 FIX: Add timeout to prevent indefinite hangs on slow RPC nodes
            this.currentSlot = await (0, async_utils_1.withTimeout)(connection.getSlot(), SolanaDetector.SLOT_UPDATE_TIMEOUT_MS, 'getSlot');
            let latency = Date.now() - startTime;
            // Cap extreme latency values to avoid skewing metrics
            if (latency > SolanaDetector.MAX_LATENCY_VALUE_MS) {
                this.logger.warn('Extreme latency detected, capping value', {
                    actual: latency,
                    capped: SolanaDetector.MAX_LATENCY_VALUE_MS
                });
                latency = SolanaDetector.MAX_LATENCY_VALUE_MS;
            }
            // Track latency (ring buffer) - now race-safe under mutex
            this.recentLatencies.push(latency);
            if (this.recentLatencies.length > SolanaDetector.MAX_LATENCY_SAMPLES) {
                this.recentLatencies.shift();
            }
        }
        catch (error) {
            this.logger.warn('Failed to update current slot', { error });
        }
        finally {
            release();
        }
    }
    // ===========================================================================
    // Error Handling
    // ===========================================================================
    async handleRpcError(error) {
        const errorCode = error.code;
        if (errorCode === 429) {
            this.logger.warn('RPC rate limit hit', { error: error.message });
            // Could implement exponential backoff here
        }
        else {
            this.logger.error('RPC error', { error: error.message, code: errorCode });
        }
    }
    async handleRpcFailure(failedUrl) {
        this.logger.warn('RPC endpoint failed', { url: failedUrl });
        // Find next available URL
        const currentIndex = this.allRpcUrls.indexOf(this.currentRpcUrl);
        const nextIndex = (currentIndex + 1) % this.allRpcUrls.length;
        if (nextIndex !== currentIndex) {
            this.currentRpcUrl = this.allRpcUrls[nextIndex];
            this.logger.info('Switched to fallback RPC', { url: this.currentRpcUrl });
        }
    }
    async withRetry(operation) {
        let lastError = null;
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                lastError = error;
                if (attempt < this.config.maxRetries) {
                    const delay = this.config.retryDelayMs * attempt;
                    await this.sleep(delay);
                }
            }
        }
        this.logger.error('Operation failed after retries', {
            maxRetries: this.config.maxRetries,
            error: lastError?.message
        });
        throw lastError;
    }
    emitError(error) {
        this.emit('error', error);
    }
    // ===========================================================================
    // Utility Methods
    // ===========================================================================
    deriveWsUrl(rpcUrl) {
        // Convert http(s) to ws(s)
        return rpcUrl.replace(/^http/, 'ws');
    }
    isValidSolanaAddress(address) {
        try {
            new web3_js_1.PublicKey(address);
            return true;
        }
        catch {
            return false;
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.SolanaDetector = SolanaDetector;
SolanaDetector.MAX_LATENCY_SAMPLES = 100;
SolanaDetector.MAX_LATENCY_VALUE_MS = 30000; // Cap extreme values
// S3.3.5 FIX: Timeout for slot updates to prevent indefinite hangs
SolanaDetector.SLOT_UPDATE_TIMEOUT_MS = 10000; // 10 seconds
exports.default = SolanaDetector;
//# sourceMappingURL=solana-detector.js.map
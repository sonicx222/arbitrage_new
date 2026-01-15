"use strict";
/**
 * Cross-Chain Arbitrage Detector Service
 *
 * Detects arbitrage opportunities across multiple chains by monitoring
 * price discrepancies and accounting for bridge costs.
 *
 * Uses Redis Streams for event consumption (ADR-002 compliant).
 * Uses ServiceStateManager for lifecycle management.
 *
 * Architecture Note: Intentional Exception to BaseDetector Pattern
 * ----------------------------------------------------------------
 * This service does NOT extend BaseDetector for the following reasons:
 *
 * 1. **Consumer vs Producer**: BaseDetector is designed for single-chain
 *    event producers (subscribe to chain -> publish price updates).
 *    CrossChainDetector is an event consumer (consume price updates from
 *    ALL chains -> detect cross-chain opportunities).
 *
 * 2. **No WebSocket Connection**: BaseDetector manages WebSocket connections
 *    to blockchain nodes. CrossChainDetector has no direct blockchain
 *    connection - it consumes from Redis Streams.
 *
 * 3. **Different Lifecycle**: BaseDetector's lifecycle is tied to chain
 *    availability. CrossChainDetector's lifecycle is tied to Redis Streams.
 *
 * 4. **Multi-Chain by Design**: BaseDetector = 1 chain per instance.
 *    CrossChainDetector = aggregates ALL chains in one instance.
 *
 * This exception is documented in ADR-003.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-003: Partitioned Chain Detectors (documents this exception)
 * @see ADR-007: Failover Strategy
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossChainDetectorService = void 0;
const core_1 = require("@arbitrage/core");
const config_1 = require("@arbitrage/config");
const bridge_predictor_1 = require("./bridge-predictor");
// =============================================================================
// S3.2.4-FIX: Token Pair Normalization Helper
// =============================================================================
/**
 * Normalize a token pair string for cross-chain matching.
 * Handles different token symbol conventions across chains:
 * - WETH.e (Avalanche) → WETH
 * - ETH (BSC) → WETH
 * - fUSDT (Fantom) → USDT
 * - BTCB (BSC) → WBTC
 *
 * @param tokenPair - Token pair string in format "TOKEN0_TOKEN1"
 * @returns Normalized token pair string
 */
function normalizeTokenPair(tokenPair) {
    const parts = tokenPair.split('_');
    if (parts.length < 2)
        return tokenPair;
    // Normalize each token in the pair
    const normalizedParts = parts.map(token => (0, config_1.normalizeTokenForCrossChain)(token));
    return normalizedParts.join('_');
}
// =============================================================================
// Cross-Chain Detector Service
// =============================================================================
class CrossChainDetectorService {
    constructor() {
        this.redis = null;
        this.streamsClient = null;
        this.priceOracle = null;
        this.logger = (0, core_1.createLogger)('cross-chain-detector');
        this.priceData = {};
        this.opportunitiesCache = new Map();
        this.mlPredictor = null;
        // Intervals
        this.opportunityDetectionInterval = null;
        this.healthMonitoringInterval = null;
        this.streamConsumerInterval = null;
        this.cacheCleanupInterval = null;
        // Counter for deterministic cleanup (replaces random sampling)
        this.priceUpdateCounter = 0;
        this.CLEANUP_FREQUENCY = 100; // Cleanup every 100 price updates
        this.perfLogger = (0, core_1.getPerformanceLogger)('cross-chain-detector');
        this.bridgePredictor = new bridge_predictor_1.BridgeLatencyPredictor();
        // Generate unique instance ID
        this.instanceId = `cross-chain-${process.env.HOSTNAME || 'local'}-${Date.now()}`;
        // State machine for lifecycle management
        this.stateManager = (0, core_1.createServiceState)({
            serviceName: 'cross-chain-detector',
            transitionTimeoutMs: 30000
        });
        // Define consumer groups for streams we need to consume
        this.consumerGroups = [
            {
                streamName: core_1.RedisStreamsClient.STREAMS.PRICE_UPDATES,
                groupName: 'cross-chain-detector-group',
                consumerName: this.instanceId,
                startId: '$'
            },
            {
                streamName: core_1.RedisStreamsClient.STREAMS.WHALE_ALERTS,
                groupName: 'cross-chain-detector-group',
                consumerName: this.instanceId,
                startId: '$'
            }
        ];
    }
    // ===========================================================================
    // Lifecycle Methods
    // ===========================================================================
    async start() {
        const result = await this.stateManager.executeStart(async () => {
            this.logger.info('Starting Cross-Chain Detector Service', {
                instanceId: this.instanceId
            });
            // Initialize Redis clients
            this.redis = await (0, core_1.getRedisClient)();
            this.streamsClient = await (0, core_1.getRedisStreamsClient)();
            // P0-6 FIX: Validate Redis clients initialized successfully
            if (!this.redis) {
                throw new Error('Failed to initialize Redis client - returned null');
            }
            if (!this.streamsClient) {
                throw new Error('Failed to initialize Redis Streams client - returned null');
            }
            // Initialize price oracle
            this.priceOracle = await (0, core_1.getPriceOracle)();
            // P0-6 FIX: Validate price oracle initialized successfully
            if (!this.priceOracle) {
                throw new Error('Failed to initialize Price Oracle - returned null');
            }
            // Create consumer groups for Redis Streams
            await this.createConsumerGroups();
            // Initialize ML predictor (placeholder)
            await this.initializeMLPredictor();
            // Start stream consumers
            this.startStreamConsumers();
            // Start opportunity detection loop
            this.startOpportunityDetection();
            // Start health monitoring
            this.startHealthMonitoring();
            this.logger.info('Cross-Chain Detector Service started successfully');
        });
        if (!result.success) {
            this.logger.error('Failed to start Cross-Chain Detector Service', {
                error: result.error
            });
            throw result.error;
        }
    }
    async stop() {
        const result = await this.stateManager.executeStop(async () => {
            this.logger.info('Stopping Cross-Chain Detector Service');
            // Clear all intervals
            this.clearAllIntervals();
            // P0-NEW-6 FIX: Disconnect streams client with timeout
            if (this.streamsClient) {
                try {
                    await Promise.race([
                        this.streamsClient.disconnect(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Streams client disconnect timeout')), CrossChainDetectorService.SHUTDOWN_TIMEOUT_MS))
                    ]);
                }
                catch (error) {
                    this.logger.warn('Streams client disconnect timeout or error', { error: error.message });
                }
                this.streamsClient = null;
            }
            // P0-NEW-6 FIX: Disconnect Redis with timeout
            if (this.redis) {
                try {
                    await Promise.race([
                        this.redis.disconnect(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis disconnect timeout')), CrossChainDetectorService.SHUTDOWN_TIMEOUT_MS))
                    ]);
                }
                catch (error) {
                    this.logger.warn('Redis disconnect timeout or error', { error: error.message });
                }
                this.redis = null;
            }
            // Clear caches
            this.priceData = {};
            this.opportunitiesCache.clear();
            // P1-NEW-7 FIX: Reset counter for clean restart
            this.priceUpdateCounter = 0;
            this.logger.info('Cross-Chain Detector Service stopped');
        });
        if (!result.success) {
            this.logger.error('Error stopping Cross-Chain Detector Service', {
                error: result.error
            });
        }
    }
    clearAllIntervals() {
        if (this.opportunityDetectionInterval) {
            clearInterval(this.opportunityDetectionInterval);
            this.opportunityDetectionInterval = null;
        }
        if (this.healthMonitoringInterval) {
            clearInterval(this.healthMonitoringInterval);
            this.healthMonitoringInterval = null;
        }
        if (this.streamConsumerInterval) {
            clearInterval(this.streamConsumerInterval);
            this.streamConsumerInterval = null;
        }
        // P0-5 FIX: Clear cacheCleanupInterval to prevent memory leaks
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
        }
    }
    // ===========================================================================
    // Redis Streams (ADR-002 Compliant)
    // ===========================================================================
    async createConsumerGroups() {
        if (!this.streamsClient)
            return;
        for (const config of this.consumerGroups) {
            try {
                await this.streamsClient.createConsumerGroup(config);
                this.logger.info('Consumer group ready', {
                    stream: config.streamName,
                    group: config.groupName
                });
            }
            catch (error) {
                this.logger.error('Failed to create consumer group', {
                    error,
                    stream: config.streamName
                });
            }
        }
    }
    startStreamConsumers() {
        // Poll streams every 100ms
        this.streamConsumerInterval = setInterval(async () => {
            if (!this.stateManager.isRunning() || !this.streamsClient)
                return;
            try {
                await Promise.all([
                    this.consumePriceUpdatesStream(),
                    this.consumeWhaleAlertsStream()
                ]);
            }
            catch (error) {
                this.logger.error('Stream consumer error', { error });
            }
        }, 100);
    }
    async consumePriceUpdatesStream() {
        if (!this.streamsClient)
            return;
        const config = this.consumerGroups.find(c => c.streamName === core_1.RedisStreamsClient.STREAMS.PRICE_UPDATES);
        if (!config)
            return;
        try {
            const messages = await this.streamsClient.xreadgroup(config, {
                count: 50,
                block: 0,
                startId: '>'
            });
            for (const message of messages) {
                // P1-6 FIX: Validate message data before processing
                const update = message.data;
                if (!this.validatePriceUpdate(update)) {
                    this.logger.warn('Skipping invalid price update message', { messageId: message.id });
                    await this.streamsClient.xack(config.streamName, config.groupName, message.id);
                    continue;
                }
                this.handlePriceUpdate(update);
                await this.streamsClient.xack(config.streamName, config.groupName, message.id);
            }
        }
        catch (error) {
            if (!error.message?.includes('timeout')) {
                this.logger.error('Error consuming price updates stream', { error });
            }
        }
    }
    async consumeWhaleAlertsStream() {
        if (!this.streamsClient)
            return;
        const config = this.consumerGroups.find(c => c.streamName === core_1.RedisStreamsClient.STREAMS.WHALE_ALERTS);
        if (!config)
            return;
        try {
            const messages = await this.streamsClient.xreadgroup(config, {
                count: 10,
                block: 0,
                startId: '>'
            });
            for (const message of messages) {
                // P1-6 FIX: Validate message data before processing
                const whaleTx = message.data;
                if (!this.validateWhaleTransaction(whaleTx)) {
                    this.logger.warn('Skipping invalid whale transaction message', { messageId: message.id });
                    await this.streamsClient.xack(config.streamName, config.groupName, message.id);
                    continue;
                }
                this.handleWhaleTransaction(whaleTx);
                await this.streamsClient.xack(config.streamName, config.groupName, message.id);
            }
        }
        catch (error) {
            if (!error.message?.includes('timeout')) {
                this.logger.error('Error consuming whale alerts stream', { error });
            }
        }
    }
    // ===========================================================================
    // Price Update Handling
    // ===========================================================================
    handlePriceUpdate(update) {
        try {
            // Update price data structure
            if (!this.priceData[update.chain]) {
                this.priceData[update.chain] = {};
            }
            if (!this.priceData[update.chain][update.dex]) {
                this.priceData[update.chain][update.dex] = {};
            }
            this.priceData[update.chain][update.dex][update.pairKey] = update;
            // Deterministic cleanup instead of random sampling (fixes P0 issue)
            this.priceUpdateCounter++;
            if (this.priceUpdateCounter >= this.CLEANUP_FREQUENCY) {
                this.priceUpdateCounter = 0;
                this.cleanOldPriceData();
                this.cleanOldOpportunityCache();
            }
            this.logger.debug(`Updated price: ${update.chain}/${update.dex}/${update.pairKey} = ${update.price}`);
        }
        catch (error) {
            this.logger.error('Failed to handle price update', { error });
        }
    }
    handleWhaleTransaction(whaleTx) {
        try {
            // Analyze whale transaction for cross-chain implications
            this.analyzeWhaleImpact(whaleTx);
        }
        catch (error) {
            this.logger.error('Failed to handle whale transaction', { error });
        }
    }
    // ===========================================================================
    // P1-6 FIX: Message Validation
    // ===========================================================================
    /**
     * Validate PriceUpdate message has all required fields
     */
    validatePriceUpdate(update) {
        if (!update || typeof update !== 'object') {
            return false;
        }
        // Required fields for price updates
        if (typeof update.chain !== 'string' || !update.chain) {
            return false;
        }
        if (typeof update.dex !== 'string' || !update.dex) {
            return false;
        }
        if (typeof update.pairKey !== 'string' || !update.pairKey) {
            return false;
        }
        if (typeof update.price !== 'number' || isNaN(update.price) || update.price < 0) {
            return false;
        }
        if (typeof update.timestamp !== 'number' || update.timestamp <= 0) {
            return false;
        }
        return true;
    }
    /**
     * Validate WhaleTransaction message has all required fields
     */
    validateWhaleTransaction(tx) {
        if (!tx || typeof tx !== 'object') {
            return false;
        }
        // Required fields for whale transactions
        if (typeof tx.chain !== 'string' || !tx.chain) {
            return false;
        }
        if (typeof tx.usdValue !== 'number' || isNaN(tx.usdValue) || tx.usdValue < 0) {
            return false;
        }
        if (typeof tx.direction !== 'string' || !['buy', 'sell'].includes(tx.direction)) {
            return false;
        }
        return true;
    }
    /**
     * P0-NEW-7 FIX: Clean old price data using snapshot-based iteration
     * Prevents race conditions where priceData is modified during cleanup
     */
    cleanOldPriceData() {
        const cutoffTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago
        // P0-NEW-7 FIX: Take snapshot of keys to prevent iterator invalidation
        const chainSnapshot = Object.keys(this.priceData);
        for (const chain of chainSnapshot) {
            // Check if chain still exists (may have been deleted by concurrent operation)
            if (!this.priceData[chain])
                continue;
            const dexSnapshot = Object.keys(this.priceData[chain]);
            for (const dex of dexSnapshot) {
                // Check if dex still exists
                if (!this.priceData[chain] || !this.priceData[chain][dex])
                    continue;
                const pairSnapshot = Object.keys(this.priceData[chain][dex]);
                for (const pairKey of pairSnapshot) {
                    // Check if pair still exists before accessing
                    if (!this.priceData[chain]?.[dex]?.[pairKey])
                        continue;
                    const update = this.priceData[chain][dex][pairKey];
                    if (update && update.timestamp < cutoffTime) {
                        delete this.priceData[chain][dex][pairKey];
                    }
                }
                // Clean empty dex objects (re-check existence)
                if (this.priceData[chain]?.[dex] && Object.keys(this.priceData[chain][dex]).length === 0) {
                    delete this.priceData[chain][dex];
                }
            }
            // Clean empty chain objects (re-check existence)
            if (this.priceData[chain] && Object.keys(this.priceData[chain]).length === 0) {
                delete this.priceData[chain];
            }
        }
    }
    /**
     * Clean old entries from opportunity cache to prevent memory leak (P0 fix)
     * Keeps cache bounded to prevent unbounded growth
     * P1-NEW-3 FIX: Uses createdAt field instead of parsing from ID
     */
    cleanOldOpportunityCache() {
        const maxCacheSize = 1000; // Hard limit on cache size
        const maxAgeMs = 10 * 60 * 1000; // 10 minutes TTL
        const now = Date.now();
        // First pass: remove old entries using createdAt field
        for (const [id, opp] of this.opportunitiesCache) {
            // P1-NEW-3 FIX: Use createdAt field for reliable age checking
            if (opp.createdAt && (now - opp.createdAt) > maxAgeMs) {
                this.opportunitiesCache.delete(id);
            }
        }
        // Second pass: if still over limit, remove oldest entries
        if (this.opportunitiesCache.size > maxCacheSize) {
            const entries = Array.from(this.opportunitiesCache.entries());
            // P1-NEW-3 FIX: Sort by createdAt field (oldest first)
            entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
            // Remove oldest entries to get under limit
            const toRemove = entries.slice(0, entries.length - maxCacheSize);
            for (const [id] of toRemove) {
                this.opportunitiesCache.delete(id);
            }
            this.logger.debug('Trimmed opportunity cache', {
                removed: toRemove.length,
                remaining: this.opportunitiesCache.size
            });
        }
    }
    /**
     * Create atomic snapshot of priceData for thread-safe detection (P1 fix)
     * Prevents race conditions where priceData is modified during detection
     */
    createPriceDataSnapshot() {
        const snapshot = {};
        for (const chain of Object.keys(this.priceData)) {
            snapshot[chain] = {};
            for (const dex of Object.keys(this.priceData[chain])) {
                snapshot[chain][dex] = {};
                for (const pairKey of Object.keys(this.priceData[chain][dex])) {
                    // Deep copy the PriceUpdate object
                    const original = this.priceData[chain][dex][pairKey];
                    snapshot[chain][dex][pairKey] = { ...original };
                }
            }
        }
        return snapshot;
    }
    // ===========================================================================
    // ML Predictor
    // ===========================================================================
    async initializeMLPredictor() {
        // Placeholder for ML predictor initialization
        // Will be implemented in Phase 3 with TensorFlow.js
        this.mlPredictor = {
            predictPriceMovement: async () => ({ direction: 0, confidence: 0.5 }),
            predictOpportunity: async () => ({ confidence: 0.5, expectedProfit: 0 })
        };
        this.logger.info('ML predictor initialized (placeholder)');
    }
    // ===========================================================================
    // Opportunity Detection
    // ===========================================================================
    startOpportunityDetection() {
        // Run opportunity detection every 100ms for real-time analysis
        this.opportunityDetectionInterval = setInterval(() => {
            if (this.stateManager.isRunning()) {
                this.detectCrossChainOpportunities();
            }
        }, 100);
    }
    detectCrossChainOpportunities() {
        const startTime = performance.now();
        try {
            // P1 fix: Take atomic snapshot of priceData to prevent race conditions
            // during concurrent modifications by handlePriceUpdate
            const priceSnapshot = this.createPriceDataSnapshot();
            const opportunities = [];
            // Get all unique token pairs across chains (using snapshot)
            const tokenPairs = this.getAllTokenPairsFromSnapshot(priceSnapshot);
            for (const tokenPair of tokenPairs) {
                const chainPrices = this.getPricesForTokenPairFromSnapshot(tokenPair, priceSnapshot);
                if (chainPrices.length >= 2) {
                    const pairOpportunities = this.findArbitrageInPair(chainPrices);
                    opportunities.push(...pairOpportunities);
                }
            }
            // Filter and rank opportunities
            const validOpportunities = this.filterValidOpportunities(opportunities);
            // Publish opportunities
            for (const opportunity of validOpportunities) {
                this.publishArbitrageOpportunity(opportunity);
            }
            const latency = performance.now() - startTime;
            this.perfLogger.logEventLatency('cross_chain_detection', latency, {
                opportunitiesFound: validOpportunities.length,
                totalPairs: tokenPairs.length
            });
        }
        catch (error) {
            this.logger.error('Failed to detect cross-chain opportunities', { error });
        }
    }
    getAllTokenPairsFromSnapshot(priceData) {
        const tokenPairs = new Set();
        for (const chain of Object.keys(priceData)) {
            for (const dex of Object.keys(priceData[chain])) {
                for (const pairKey of Object.keys(priceData[chain][dex])) {
                    // Extract token pair from pairKey (format: DEX_TOKEN1_TOKEN2)
                    const tokens = pairKey.split('_').slice(1).join('_');
                    // S3.2.4-FIX: Normalize token pairs for cross-chain matching
                    // WETH.e_USDT (Avalanche) and ETH_USDT (BSC) both normalize to WETH_USDT
                    tokenPairs.add(normalizeTokenPair(tokens));
                }
            }
        }
        return Array.from(tokenPairs);
    }
    getPricesForTokenPairFromSnapshot(tokenPair, priceData) {
        const prices = [];
        for (const chain of Object.keys(priceData)) {
            for (const dex of Object.keys(priceData[chain])) {
                for (const pairKey of Object.keys(priceData[chain][dex])) {
                    const tokens = pairKey.split('_').slice(1).join('_');
                    // S3.2.4-FIX: Use normalized comparison for cross-chain matching
                    // tokenPair is already normalized from getAllTokenPairsFromSnapshot
                    if (normalizeTokenPair(tokens) === tokenPair) {
                        const update = priceData[chain][dex][pairKey];
                        prices.push({
                            chain,
                            dex,
                            price: update.price,
                            update
                        });
                    }
                }
            }
        }
        return prices;
    }
    findArbitrageInPair(chainPrices) {
        const opportunities = [];
        // Sort by price to find best buy/sell opportunities
        const sortedPrices = chainPrices.sort((a, b) => a.price - b.price);
        if (sortedPrices.length >= 2) {
            const lowestPrice = sortedPrices[0];
            const highestPrice = sortedPrices[sortedPrices.length - 1];
            const priceDiff = highestPrice.price - lowestPrice.price;
            const percentageDiff = (priceDiff / lowestPrice.price) * 100;
            // Check if profitable after estimated bridge costs
            const bridgeCost = this.estimateBridgeCost(lowestPrice.chain, highestPrice.chain, lowestPrice.update);
            const netProfit = priceDiff - bridgeCost;
            if (netProfit > config_1.ARBITRAGE_CONFIG.minProfitPercentage * lowestPrice.price) {
                const opportunity = {
                    token: this.extractTokenFromPair(lowestPrice.update.pairKey),
                    sourceChain: lowestPrice.chain,
                    sourceDex: lowestPrice.dex,
                    sourcePrice: lowestPrice.price,
                    targetChain: highestPrice.chain,
                    targetDex: highestPrice.dex,
                    targetPrice: highestPrice.price,
                    priceDiff,
                    percentageDiff,
                    estimatedProfit: priceDiff,
                    bridgeCost,
                    netProfit,
                    confidence: this.calculateConfidence(lowestPrice, highestPrice),
                    // P1-NEW-3 FIX: Include createdAt for reliable cleanup
                    createdAt: Date.now()
                };
                opportunities.push(opportunity);
            }
        }
        return opportunities;
    }
    extractTokenFromPair(pairKey) {
        // S3.2.4-FIX: Extract and normalize tokens from pair key
        // Handles both formats:
        // - "traderjoe_WETH.e_USDT" (3 parts) -> "WETH/USDT"
        // - "uniswap_v3_WETH_USDT" (4 parts) -> "WETH/USDT"
        const parts = pairKey.split('_');
        if (parts.length >= 2) {
            // Always take last 2 parts as tokens regardless of DEX name format
            const token0 = parts[parts.length - 2];
            const token1 = parts[parts.length - 1];
            // Normalize for consistent canonical names
            return `${(0, config_1.normalizeTokenForCrossChain)(token0)}/${(0, config_1.normalizeTokenForCrossChain)(token1)}`;
        }
        return pairKey;
    }
    estimateBridgeCost(sourceChain, targetChain, tokenUpdate) {
        // Use bridge predictor for accurate cost estimation
        const availableBridges = this.bridgePredictor.getAvailableRoutes(sourceChain, targetChain);
        if (availableBridges.length === 0) {
            // Fallback to simplified estimation if no bridge data available
            return this.fallbackBridgeCost(sourceChain, targetChain, tokenUpdate);
        }
        // Get the best bridge prediction
        const tokenAmount = this.extractTokenAmount(tokenUpdate);
        const prediction = this.bridgePredictor.predictOptimalBridge(sourceChain, targetChain, tokenAmount, 'medium' // Default urgency
        );
        if (prediction && prediction.confidence > 0.3) {
            // Convert from wei to token units (simplified conversion)
            return prediction.estimatedCost / 1e18;
        }
        // Fallback if prediction confidence is too low
        return this.fallbackBridgeCost(sourceChain, targetChain, tokenUpdate);
    }
    /**
     * P1-5 FIX: Use centralized bridge cost configuration instead of hardcoded multipliers.
     * This provides more accurate cost estimates based on actual bridge fees.
     */
    fallbackBridgeCost(sourceChain, targetChain, tokenUpdate) {
        const DEFAULT_TRADE_SIZE_USD = 1000; // Standard trade size for cost estimation
        // P1-5 FIX: Use centralized bridge cost configuration
        const bridgeCostResult = (0, config_1.calculateBridgeCostUsd)(sourceChain, targetChain, DEFAULT_TRADE_SIZE_USD);
        if (bridgeCostResult) {
            this.logger.debug('Using configured bridge cost', {
                sourceChain,
                targetChain,
                bridge: bridgeCostResult.bridge,
                feeUsd: bridgeCostResult.fee,
                latency: bridgeCostResult.latency
            });
            return bridgeCostResult.fee;
        }
        // Fallback: Estimate cost if no configuration exists
        this.logger.debug('No bridge cost config, using fallback estimate', {
            sourceChain,
            targetChain
        });
        // Base cost as percentage of trade size
        const baseFeePercentage = 0.1; // 0.1% fallback fee
        const minFeeUsd = 2.0; // Minimum $2 fee
        const percentageFee = DEFAULT_TRADE_SIZE_USD * (baseFeePercentage / 100);
        return Math.max(percentageFee, minFeeUsd);
    }
    /**
     * P0-4 FIX: Extract token amount for bridge cost estimation
     *
     * Previous implementation was WRONG:
     *   return price > 0 ? 1.0 / price : 1.0  // Returns inverse of price, NOT token amount!
     *
     * This caused bridge cost calculations to be off by ±500% because:
     *   - If ETH price = $3000, it would return 0.000333 tokens
     *   - If ETH price = $0.01, it would return 100 tokens
     *
     * Correct implementation: Return a reasonable default trade size in token terms.
     * For cross-chain arbitrage, we typically trade a fixed USD amount (e.g., $1000)
     * and calculate how many tokens that represents.
     */
    extractTokenAmount(tokenUpdate) {
        const DEFAULT_TRADE_SIZE_USD = 1000; // Standard trade size for bridge cost estimation
        const price = tokenUpdate.price;
        if (price <= 0) {
            this.logger.warn('Invalid token price for amount extraction', {
                pairKey: tokenUpdate.pairKey,
                price
            });
            return 1.0; // Fallback to 1 token
        }
        // Calculate tokens worth $1000 USD
        // If price is $3000/ETH, then $1000 = 0.333 ETH
        // If price is $0.01/token, then $1000 = 100,000 tokens
        const tokenAmount = DEFAULT_TRADE_SIZE_USD / price;
        this.logger.debug('Extracted token amount for bridge estimation', {
            pairKey: tokenUpdate.pairKey,
            price,
            usdValue: DEFAULT_TRADE_SIZE_USD,
            tokenAmount
        });
        return tokenAmount;
    }
    // Method to update bridge predictor with actual bridge transaction data
    updateBridgeData(bridgeResult) {
        const bridgeObj = {
            bridge: bridgeResult.bridge,
            sourceChain: bridgeResult.sourceChain,
            targetChain: bridgeResult.targetChain,
            token: bridgeResult.token,
            amount: bridgeResult.amount
        };
        this.bridgePredictor.updateModel({
            bridge: bridgeObj,
            actualLatency: bridgeResult.actualLatency,
            actualCost: bridgeResult.actualCost,
            success: bridgeResult.success,
            timestamp: bridgeResult.timestamp
        });
        this.logger.debug('Updated bridge predictor with transaction data', {
            bridge: bridgeResult.bridge,
            latency: bridgeResult.actualLatency,
            cost: bridgeResult.actualCost,
            success: bridgeResult.success
        });
    }
    calculateConfidence(lowPrice, highPrice) {
        // Base confidence on price difference and data freshness
        let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2; // 0-1 scale
        // Reduce confidence for stale data
        const agePenalty = Math.max(0, (Date.now() - lowPrice.update.timestamp) / 60000); // 1 minute = 1.0 penalty
        confidence *= Math.max(0.1, 1 - agePenalty * 0.1);
        // ML prediction boost (placeholder)
        if (this.mlPredictor) {
            confidence *= 1.2; // Boost from ML prediction
            confidence = Math.min(confidence, 0.95); // Cap at 95%
        }
        return confidence;
    }
    filterValidOpportunities(opportunities) {
        return opportunities
            .filter(opp => opp.netProfit > 0)
            .filter(opp => opp.confidence > config_1.ARBITRAGE_CONFIG.confidenceThreshold)
            .sort((a, b) => b.netProfit - a.netProfit)
            .slice(0, 10); // Top 10 opportunities
    }
    analyzeWhaleImpact(whaleTx) {
        // Analyze how whale transaction affects cross-chain opportunities
        // This could trigger immediate opportunity detection or adjust confidence scores
        this.logger.debug('Analyzing whale transaction impact', {
            chain: whaleTx.chain,
            usdValue: whaleTx.usdValue,
            direction: whaleTx.direction
        });
    }
    async publishArbitrageOpportunity(opportunity) {
        if (!this.streamsClient)
            return;
        // S3.2.4-FIX: Generate deterministic cache key for deduplication BEFORE publishing
        // Key based on opportunity characteristics, not random ID
        const dedupeKey = `${opportunity.sourceChain}-${opportunity.targetChain}-${opportunity.token}`;
        // Check if we recently published this opportunity (within 5 seconds)
        const existingOpp = this.opportunitiesCache.get(dedupeKey);
        const DEDUPE_WINDOW_MS = 5000; // Don't republish same opportunity within 5 seconds
        if (existingOpp && (Date.now() - existingOpp.createdAt) < DEDUPE_WINDOW_MS) {
            // Skip duplicate - only publish if profit improved significantly (>10%)
            const profitImprovement = (opportunity.netProfit - existingOpp.netProfit) / existingOpp.netProfit;
            if (profitImprovement < 0.1) {
                this.logger.debug('Skipping duplicate opportunity', {
                    dedupeKey,
                    ageMs: Date.now() - existingOpp.createdAt,
                    profitImprovement: `${(profitImprovement * 100).toFixed(1)}%`
                });
                return;
            }
        }
        const arbitrageOpp = {
            id: `cross-chain-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'cross-chain',
            buyDex: opportunity.sourceDex,
            sellDex: opportunity.targetDex,
            buyChain: opportunity.sourceChain,
            sellChain: opportunity.targetChain,
            tokenIn: opportunity.token.split('/')[0],
            tokenOut: opportunity.token.split('/')[1],
            amountIn: '1000000000000000000', // 1 token (placeholder)
            expectedProfit: opportunity.netProfit,
            profitPercentage: opportunity.percentageDiff / 100,
            gasEstimate: '0', // Cross-chain, gas estimated separately
            confidence: opportunity.confidence,
            timestamp: Date.now(),
            blockNumber: 0, // Cross-chain
            bridgeRequired: true,
            bridgeCost: opportunity.bridgeCost
        };
        try {
            // Publish to Redis Streams (ADR-002 compliant)
            await this.streamsClient.xadd(core_1.RedisStreamsClient.STREAMS.OPPORTUNITIES, arbitrageOpp);
            this.perfLogger.logArbitrageOpportunity(arbitrageOpp);
            // S3.2.4-FIX: Cache with deterministic key for proper deduplication
            // P1-NEW-3 FIX: Add createdAt timestamp for reliable cleanup
            this.opportunitiesCache.set(dedupeKey, {
                ...opportunity,
                createdAt: Date.now()
            });
        }
        catch (error) {
            this.logger.error('Failed to publish arbitrage opportunity', { error });
        }
    }
    // ===========================================================================
    // Health Monitoring
    // ===========================================================================
    startHealthMonitoring() {
        this.healthMonitoringInterval = setInterval(async () => {
            try {
                // P3-2 FIX: Use unified ServiceHealth with 'name' field
                const health = {
                    name: 'cross-chain-detector',
                    status: (this.stateManager.isRunning() ? 'healthy' : 'unhealthy'),
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage().heapUsed,
                    cpuUsage: 0,
                    lastHeartbeat: Date.now(),
                    chainsMonitored: Object.keys(this.priceData).length,
                    opportunitiesCache: this.opportunitiesCache.size,
                    mlPredictorActive: !!this.mlPredictor
                };
                // Publish health to stream
                if (this.streamsClient) {
                    await this.streamsClient.xadd(core_1.RedisStreamsClient.STREAMS.HEALTH, health);
                }
                // Also update legacy health key
                if (this.redis) {
                    await this.redis.updateServiceHealth('cross-chain-detector', health);
                }
                this.perfLogger.logHealthCheck('cross-chain-detector', health);
            }
            catch (error) {
                this.logger.error('Cross-chain health monitoring failed', { error });
            }
        }, 30000);
    }
    // ===========================================================================
    // Public Getters
    // ===========================================================================
    isRunning() {
        return this.stateManager.isRunning();
    }
    getState() {
        return this.stateManager.getState();
    }
    getChainsMonitored() {
        return Object.keys(this.priceData);
    }
    getOpportunitiesCount() {
        return this.opportunitiesCache.size;
    }
}
exports.CrossChainDetectorService = CrossChainDetectorService;
// P0-NEW-6 FIX: Timeout constant for shutdown operations
CrossChainDetectorService.SHUTDOWN_TIMEOUT_MS = 5000;
//# sourceMappingURL=detector.js.map
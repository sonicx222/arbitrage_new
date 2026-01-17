"use strict";
/**
 * Chain Detector Instance
 *
 * Individual chain detector running within the UnifiedChainDetector.
 * Handles WebSocket connection, event processing, and price updates
 * for a single blockchain.
 *
 * This is a lightweight wrapper around the BaseDetector pattern,
 * optimized for running multiple chains in a single process.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChainDetectorInstance = void 0;
const events_1 = require("events");
const ethers_1 = require("ethers");
const core_1 = require("@arbitrage/core");
const config_1 = require("@arbitrage/config");
// =============================================================================
// Chain Detector Instance
// =============================================================================
class ChainDetectorInstance extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.provider = null;
        this.wsManager = null;
        this.pairs = new Map();
        this.pairsByAddress = new Map();
        this.status = 'disconnected';
        this.eventsProcessed = 0;
        this.opportunitiesFound = 0;
        this.lastBlockNumber = 0;
        this.lastBlockTimestamp = 0;
        this.blockLatencies = [];
        this.isRunning = false;
        this.isStopping = false;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        // P0-NEW-3/P0-NEW-4 FIX: Lifecycle promises to prevent race conditions
        // These ensure concurrent start/stop calls are handled correctly
        this.startPromise = null;
        this.stopPromise = null;
        this.chainId = config.chainId;
        this.partitionId = config.partitionId;
        this.streamsClient = config.streamsClient;
        this.perfLogger = config.perfLogger;
        this.logger = (0, core_1.createLogger)(`chain:${config.chainId}`);
        // Load chain configuration
        this.chainConfig = config_1.CHAINS[this.chainId];
        if (!this.chainConfig) {
            throw new Error(`Chain configuration not found: ${this.chainId}`);
        }
        this.detectorConfig = config_1.DETECTOR_CONFIG[this.chainId] || config_1.DETECTOR_CONFIG.ethereum;
        this.dexes = (0, config_1.getEnabledDexes)(this.chainId);
        this.tokens = config_1.CORE_TOKENS[this.chainId] || [];
        this.tokenMetadata = config_1.TOKEN_METADATA[this.chainId] || {};
        // Override URLs if provided
        if (config.wsUrl) {
            this.chainConfig = { ...this.chainConfig, wsUrl: config.wsUrl };
        }
        if (config.rpcUrl) {
            this.chainConfig = { ...this.chainConfig, rpcUrl: config.rpcUrl };
        }
    }
    // ===========================================================================
    // Lifecycle
    // ===========================================================================
    async start() {
        // P0-NEW-3 FIX: Return existing promise if start is already in progress
        if (this.startPromise) {
            return this.startPromise;
        }
        // P0-NEW-4 FIX: Wait for any pending stop operation to complete
        if (this.stopPromise) {
            await this.stopPromise;
        }
        // Guard against starting while stopping or already running
        if (this.isStopping) {
            this.logger.warn('Cannot start: ChainDetectorInstance is stopping');
            return;
        }
        if (this.isRunning) {
            this.logger.warn('ChainDetectorInstance already running');
            return;
        }
        // P0-NEW-3 FIX: Create and store the start promise for concurrent callers
        this.startPromise = this.performStart();
        try {
            await this.startPromise;
        }
        finally {
            this.startPromise = null;
        }
    }
    /**
     * P0-NEW-3 FIX: Internal start implementation separated for promise tracking
     */
    async performStart() {
        this.logger.info('Starting ChainDetectorInstance', {
            chainId: this.chainId,
            partitionId: this.partitionId,
            dexes: this.dexes.length,
            tokens: this.tokens.length
        });
        this.status = 'connecting';
        this.emit('statusChange', this.status);
        try {
            // Initialize RPC provider
            this.provider = new ethers_1.ethers.JsonRpcProvider(this.chainConfig.rpcUrl);
            // Initialize WebSocket manager
            await this.initializeWebSocket();
            // Initialize pairs from DEX factories
            await this.initializePairs();
            // Subscribe to events
            await this.subscribeToEvents();
            this.isRunning = true;
            this.status = 'connected';
            this.reconnectAttempts = 0;
            this.emit('statusChange', this.status);
            this.logger.info('ChainDetectorInstance started', {
                pairsMonitored: this.pairs.size
            });
        }
        catch (error) {
            this.status = 'error';
            this.emit('statusChange', this.status);
            this.emit('error', error);
            throw error;
        }
    }
    async stop() {
        // P0-NEW-4 FIX: Return existing promise if stop is already in progress
        // This allows concurrent callers to await the same stop operation
        if (this.stopPromise) {
            return this.stopPromise;
        }
        // Guard: Can't stop if not running and not stopping
        if (!this.isRunning && !this.isStopping) {
            return;
        }
        // P0-NEW-4 FIX: Create and store the stop promise for concurrent callers
        this.stopPromise = this.performStop();
        try {
            await this.stopPromise;
        }
        finally {
            this.stopPromise = null;
        }
    }
    /**
     * P0-NEW-4 FIX: Internal stop implementation separated for promise tracking
     */
    async performStop() {
        this.logger.info('Stopping ChainDetectorInstance', { chainId: this.chainId });
        // Set stopping flag FIRST to prevent new event processing
        this.isStopping = true;
        this.isRunning = false;
        // P0-NEW-6 FIX: Disconnect WebSocket with timeout to prevent indefinite hangs
        if (this.wsManager) {
            // Remove all event listeners before disconnecting to prevent memory leak
            this.wsManager.removeAllListeners();
            try {
                await Promise.race([
                    this.wsManager.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('WebSocket disconnect timeout')), 5000))
                ]);
            }
            catch (error) {
                this.logger.warn('WebSocket disconnect timeout or error', { error: error.message });
            }
            this.wsManager = null;
        }
        // Clean up provider reference
        if (this.provider) {
            this.provider = null;
        }
        // Clear pairs
        this.pairs.clear();
        this.pairsByAddress.clear();
        // Clear latency tracking (P0-NEW-1 FIX: ensure cleanup)
        this.blockLatencies = [];
        // Reset stats for clean restart
        this.eventsProcessed = 0;
        this.opportunitiesFound = 0;
        this.lastBlockNumber = 0;
        this.lastBlockTimestamp = 0;
        this.reconnectAttempts = 0;
        this.status = 'disconnected';
        this.isStopping = false; // Reset for potential restart
        this.emit('statusChange', this.status);
        this.logger.info('ChainDetectorInstance stopped');
    }
    // ===========================================================================
    // WebSocket Management
    // ===========================================================================
    async initializeWebSocket() {
        // Use wsUrl, fallback to rpcUrl if not available
        const primaryWsUrl = this.chainConfig.wsUrl || this.chainConfig.rpcUrl;
        // FIX: Pass chainId for proper staleness thresholds and health tracking
        // Use extended timeout for known unstable chains (BSC, Fantom)
        const unstableChains = ['bsc', 'fantom'];
        const connectionTimeout = unstableChains.includes(this.chainId.toLowerCase()) ? 15000 : 10000;
        const wsConfig = {
            url: primaryWsUrl,
            fallbackUrls: this.chainConfig.wsFallbackUrls,
            reconnectInterval: 5000,
            maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
            pingInterval: 30000,
            connectionTimeout,
            chainId: this.chainId // FIX: Enable chain-specific staleness detection
        };
        this.wsManager = new core_1.WebSocketManager(wsConfig);
        this.logger.info(`WebSocket configured with ${1 + (this.chainConfig.wsFallbackUrls?.length || 0)} URL(s)`);
        // Set up WebSocket event handlers
        this.wsManager.on('message', (message) => {
            this.handleWebSocketMessage(message);
        });
        this.wsManager.on('error', (error) => {
            this.logger.error('WebSocket error', { error });
            this.handleConnectionError(error);
        });
        this.wsManager.on('disconnected', () => {
            this.logger.warn('WebSocket disconnected');
            if (this.isRunning) {
                this.status = 'connecting';
                this.emit('statusChange', this.status);
            }
        });
        this.wsManager.on('connected', () => {
            this.logger.info('WebSocket connected');
            this.status = 'connected';
            this.reconnectAttempts = 0;
            this.emit('statusChange', this.status);
        });
        await this.wsManager.connect();
    }
    handleConnectionError(error) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.status = 'error';
            this.emit('statusChange', this.status);
            this.emit('error', new Error(`Max reconnect attempts reached for ${this.chainId}`));
        }
    }
    // ===========================================================================
    // Pair Initialization
    // ===========================================================================
    async initializePairs() {
        // This is a simplified version - in production would query DEX factories
        // For now, create pairs from token combinations
        // Note: this.dexes is already filtered by getEnabledDexes() in constructor
        for (const dex of this.dexes) {
            for (let i = 0; i < this.tokens.length; i++) {
                for (let j = i + 1; j < this.tokens.length; j++) {
                    const token0 = this.tokens[i];
                    const token1 = this.tokens[j];
                    // Generate a deterministic pair address (placeholder)
                    const pairAddress = this.generatePairAddress(dex.factoryAddress, token0.address, token1.address);
                    // Convert fee from basis points to percentage for pair storage
                    // Config stores fees in basis points (30 = 0.30%), Pair uses percentage (0.003)
                    // S2.2.3 FIX: Use ?? instead of ternary to correctly handle fee: 0
                    const feePercentage = (0, config_1.dexFeeToPercentage)(dex.fee ?? 30);
                    const pair = {
                        address: pairAddress,
                        dex: dex.name,
                        token0: token0.address,
                        token1: token1.address,
                        fee: feePercentage,
                        reserve0: '0',
                        reserve1: '0',
                        blockNumber: 0,
                        lastUpdate: 0
                    };
                    const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
                    this.pairs.set(pairKey, pair);
                    this.pairsByAddress.set(pairAddress.toLowerCase(), pair);
                }
            }
        }
        this.logger.info(`Initialized ${this.pairs.size} pairs for monitoring`);
    }
    generatePairAddress(factory, token0, token1) {
        // Generate deterministic address based on factory and tokens
        // This is a simplified version - real implementation would use CREATE2
        const hash = ethers_1.ethers.keccak256(ethers_1.ethers.solidityPacked(['address', 'address', 'address'], [factory, token0, token1]));
        return '0x' + hash.slice(26);
    }
    // ===========================================================================
    // Event Subscription
    // ===========================================================================
    async subscribeToEvents() {
        if (!this.wsManager)
            return;
        // Get monitored pair addresses for filtering
        const pairAddresses = Array.from(this.pairsByAddress.keys());
        // Subscribe to Sync events
        await this.wsManager.subscribe({
            method: 'eth_subscribe',
            params: ['logs', { topics: [config_1.EVENT_SIGNATURES.SYNC], address: pairAddresses }],
            type: 'logs',
            topics: [config_1.EVENT_SIGNATURES.SYNC],
            callback: (log) => this.handleSyncEvent(log)
        });
        // Subscribe to Swap events
        await this.wsManager.subscribe({
            method: 'eth_subscribe',
            params: ['logs', { topics: [config_1.EVENT_SIGNATURES.SWAP_V2], address: pairAddresses }],
            type: 'logs',
            topics: [config_1.EVENT_SIGNATURES.SWAP_V2],
            callback: (log) => this.handleSwapEvent(log)
        });
        // Subscribe to new blocks for latency tracking
        await this.wsManager.subscribe({
            method: 'eth_subscribe',
            params: ['newHeads'],
            type: 'newHeads',
            callback: (block) => this.handleNewBlock(block)
        });
        this.logger.info('Subscribed to blockchain events');
    }
    // ===========================================================================
    // Event Handlers
    // ===========================================================================
    // P2 FIX: Use WebSocketMessage type instead of any
    handleWebSocketMessage(message) {
        try {
            // Route message based on type
            if (message.method === 'eth_subscription') {
                const params = message.params;
                const result = params?.result;
                if (result && 'topics' in result && result.topics) {
                    // Log event
                    const topic0 = result.topics[0];
                    if (topic0 === config_1.EVENT_SIGNATURES.SYNC) {
                        this.handleSyncEvent(result);
                    }
                    else if (topic0 === config_1.EVENT_SIGNATURES.SWAP_V2) {
                        this.handleSwapEvent(result);
                    }
                }
                else if (result && 'number' in result && result.number) {
                    // New block
                    this.handleNewBlock(result);
                }
            }
        }
        catch (error) {
            this.logger.error('Error handling WebSocket message', { error });
        }
    }
    // P2 FIX: Use EthereumLog type instead of any
    handleSyncEvent(log) {
        // Guard against processing during shutdown (consistent with base-detector.ts)
        if (this.isStopping || !this.isRunning)
            return;
        try {
            const pairAddress = log.address?.toLowerCase();
            const pair = this.pairsByAddress.get(pairAddress);
            if (!pair)
                return; // Not a monitored pair
            // Decode reserves from log data
            const data = log.data;
            if (data && data.length >= 130) {
                const reserve0 = BigInt('0x' + data.slice(2, 66)).toString();
                const reserve1 = BigInt('0x' + data.slice(66, 130)).toString();
                // P1-9 FIX: Use Object.assign for atomic pair updates
                // This prevents partial updates if concurrent access occurs during
                // initialization or other event handling
                Object.assign(pair, {
                    reserve0,
                    reserve1,
                    blockNumber: parseInt(log.blockNumber, 16),
                    lastUpdate: Date.now()
                });
                this.eventsProcessed++;
                // Calculate and emit price update
                this.emitPriceUpdate(pair);
                // Check for arbitrage opportunities
                this.checkArbitrageOpportunity(pair);
            }
        }
        catch (error) {
            this.logger.error('Error handling Sync event', { error });
        }
    }
    // P2 FIX: Use EthereumLog type instead of any
    handleSwapEvent(log) {
        // Guard against processing during shutdown (consistent with base-detector.ts)
        if (this.isStopping || !this.isRunning)
            return;
        try {
            const pairAddress = log.address?.toLowerCase();
            const pair = this.pairsByAddress.get(pairAddress);
            if (!pair)
                return;
            this.eventsProcessed++;
            // Emit swap event for downstream processing
            const swapEvent = {
                chain: this.chainId,
                dex: pair.dex,
                pairAddress: pairAddress,
                blockNumber: parseInt(log.blockNumber, 16),
                transactionHash: log.transactionHash,
                timestamp: Date.now()
            };
            this.emit('swapEvent', swapEvent);
        }
        catch (error) {
            this.logger.error('Error handling Swap event', { error });
        }
    }
    // P2 FIX: Use EthereumBlockHeader type instead of any
    handleNewBlock(block) {
        const blockNumber = parseInt(block.number, 16);
        const now = Date.now();
        if (this.lastBlockNumber > 0) {
            const latency = now - this.lastBlockTimestamp;
            this.blockLatencies.push(latency);
            // Keep only last 100 latencies
            if (this.blockLatencies.length > 100) {
                this.blockLatencies.shift();
            }
        }
        this.lastBlockNumber = blockNumber;
        this.lastBlockTimestamp = now;
    }
    // ===========================================================================
    // Price Update & Arbitrage Detection
    // ===========================================================================
    emitPriceUpdate(pair) {
        const reserve0 = BigInt(pair.reserve0);
        const reserve1 = BigInt(pair.reserve1);
        if (reserve0 === 0n || reserve1 === 0n)
            return;
        // P0-1 FIX: Use precision-safe price calculation to prevent precision loss
        // for large BigInt values (reserves can be > 2^53)
        const price = (0, core_1.calculatePriceFromBigIntReserves)(reserve0, reserve1);
        if (price === null)
            return;
        const priceUpdate = {
            chain: this.chainId,
            dex: pair.dex,
            pairKey: this.getPairKey(pair),
            pairAddress: pair.address,
            token0: pair.token0,
            token1: pair.token1,
            price,
            reserve0: pair.reserve0,
            reserve1: pair.reserve1,
            timestamp: Date.now(),
            blockNumber: pair.blockNumber,
            latency: 0, // Calculated by downstream consumers if needed
            // Include DEX-specific fee for accurate arbitrage calculations (S2.2.2 fix)
            fee: pair.fee
        };
        // Publish to Redis Streams
        this.publishPriceUpdate(priceUpdate);
        this.emit('priceUpdate', priceUpdate);
    }
    async publishPriceUpdate(update) {
        try {
            await this.streamsClient.xadd(core_1.RedisStreamsClient.STREAMS.PRICE_UPDATES, update);
        }
        catch (error) {
            this.logger.error('Failed to publish price update', { error });
        }
    }
    /**
     * Create a deep snapshot of a single pair for thread-safe arbitrage detection.
     * Captures all mutable values at a point in time.
     */
    createPairSnapshot(pair) {
        // Skip pairs without initialized reserves
        if (!pair.reserve0 || !pair.reserve1 || pair.reserve0 === '0' || pair.reserve1 === '0') {
            return null;
        }
        return {
            address: pair.address,
            dex: pair.dex,
            token0: pair.token0,
            token1: pair.token1,
            reserve0: pair.reserve0,
            reserve1: pair.reserve1,
            fee: pair.fee ?? 0.003, // Default 0.3% fee if undefined
            blockNumber: pair.blockNumber
        };
    }
    /**
     * Create deep snapshots of all pairs for thread-safe iteration.
     * This prevents race conditions where concurrent Sync events could
     * modify pair reserves while we're iterating for arbitrage detection.
     */
    createPairsSnapshot() {
        const snapshots = new Map();
        for (const [key, pair] of this.pairs.entries()) {
            const snapshot = this.createPairSnapshot(pair);
            if (snapshot) {
                snapshots.set(key, snapshot);
            }
        }
        return snapshots;
    }
    checkArbitrageOpportunity(updatedPair) {
        // Guard against processing during shutdown (consistent with base-detector.ts)
        if (this.isStopping || !this.isRunning)
            return;
        // Create snapshot of the updated pair first
        const currentSnapshot = this.createPairSnapshot(updatedPair);
        if (!currentSnapshot)
            return;
        // Create deep snapshots of ALL pairs to prevent race conditions
        // This captures reserve values atomically - concurrent Sync events
        // won't affect these snapshot values during iteration
        const pairsSnapshot = this.createPairsSnapshot();
        // Find pairs with same tokens but different DEXes
        for (const [key, otherSnapshot] of pairsSnapshot) {
            // Skip same pair
            if (otherSnapshot.address === currentSnapshot.address)
                continue;
            // BUG FIX: Skip same DEX - arbitrage requires different DEXes
            if (otherSnapshot.dex === currentSnapshot.dex)
                continue;
            // Check if same token pair (in either order)
            if (this.isSameTokenPair(currentSnapshot, otherSnapshot)) {
                const opportunity = this.calculateArbitrage(currentSnapshot, otherSnapshot);
                if (opportunity && (opportunity.expectedProfit ?? 0) > 0) {
                    this.opportunitiesFound++;
                    this.emitOpportunity(opportunity);
                }
            }
        }
    }
    /**
     * Check if two pairs represent the same token pair (in either order).
     * Returns { sameOrder: boolean, reverseOrder: boolean }
     */
    isSameTokenPair(pair1, pair2) {
        const token1_0 = pair1.token0.toLowerCase();
        const token1_1 = pair1.token1.toLowerCase();
        const token2_0 = pair2.token0.toLowerCase();
        const token2_1 = pair2.token1.toLowerCase();
        return ((token1_0 === token2_0 && token1_1 === token2_1) ||
            (token1_0 === token2_1 && token1_1 === token2_0));
    }
    /**
     * Check if token order is reversed between two pairs.
     */
    isReverseOrder(pair1, pair2) {
        const token1_0 = pair1.token0.toLowerCase();
        const token1_1 = pair1.token1.toLowerCase();
        const token2_0 = pair2.token0.toLowerCase();
        const token2_1 = pair2.token1.toLowerCase();
        return token1_0 === token2_1 && token1_1 === token2_0;
    }
    /**
     * Get minimum profit threshold for this chain from config.
     * Uses ARBITRAGE_CONFIG.chainMinProfits for consistency with base-detector.ts.
     */
    getMinProfitThreshold() {
        const chainMinProfits = config_1.ARBITRAGE_CONFIG.chainMinProfits;
        // S2.2.3 FIX: Use ?? instead of || to correctly handle 0 min profit (if any chain allows it)
        return chainMinProfits[this.chainId] ?? 0.003; // Default 0.3%
    }
    calculateArbitrage(pair1, pair2) {
        const reserve1_0 = BigInt(pair1.reserve0);
        const reserve1_1 = BigInt(pair1.reserve1);
        const reserve2_0 = BigInt(pair2.reserve0);
        const reserve2_1 = BigInt(pair2.reserve1);
        if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
            return null;
        }
        // Calculate prices (price = token0/token1) - consistent with base-detector.ts
        // This gives "price of token1 in terms of token0"
        const price1 = Number(reserve1_0) / Number(reserve1_1);
        let price2 = Number(reserve2_0) / Number(reserve2_1);
        // BUG FIX: Adjust price for reverse order pairs
        // If tokens are in reverse order, invert the price for accurate comparison
        if (this.isReverseOrder(pair1, pair2) && price2 !== 0) {
            price2 = 1 / price2;
        }
        // Calculate price difference as a percentage of the lower price
        const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
        // Use config-based profit threshold (not hardcoded)
        const minProfitThreshold = this.getMinProfitThreshold();
        // Calculate fee-adjusted profit
        // Fees are stored as decimals (e.g., 0.003 for 0.3%)
        // Use ?? instead of || to correctly handle fee: 0 (if a DEX ever has 0% fee)
        const totalFees = (pair1.fee ?? 0.003) + (pair2.fee ?? 0.003);
        const netProfitPct = priceDiff - totalFees;
        // Check if profitable after fees
        if (netProfitPct < minProfitThreshold) {
            return null;
        }
        const opportunity = {
            id: `${this.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            type: 'simple', // Standardized with base-detector.ts
            chain: this.chainId,
            buyDex: price1 < price2 ? pair1.dex : pair2.dex,
            sellDex: price1 < price2 ? pair2.dex : pair1.dex,
            buyPair: price1 < price2 ? pair1.address : pair2.address,
            sellPair: price1 < price2 ? pair2.address : pair1.address,
            token0: pair1.token0,
            token1: pair1.token1,
            buyPrice: Math.min(price1, price2),
            sellPrice: Math.max(price1, price2),
            profitPercentage: netProfitPct * 100, // Convert to percentage
            expectedProfit: netProfitPct, // Net profit after fees
            estimatedProfit: 0, // To be calculated by execution engine
            gasEstimate: String(this.detectorConfig.gasEstimate),
            confidence: this.detectorConfig.confidence,
            timestamp: Date.now(),
            expiresAt: Date.now() + this.detectorConfig.expiryMs,
            blockNumber: pair1.blockNumber,
            status: 'pending'
        };
        return opportunity;
    }
    async emitOpportunity(opportunity) {
        try {
            await this.streamsClient.xadd(core_1.RedisStreamsClient.STREAMS.OPPORTUNITIES, opportunity);
            this.emit('opportunity', opportunity);
            this.perfLogger.logArbitrageOpportunity(opportunity);
        }
        catch (error) {
            this.logger.error('Failed to publish opportunity', { error });
        }
    }
    // ===========================================================================
    // Helpers
    // ===========================================================================
    getPairKey(pair) {
        // Get token symbols from addresses (simplified)
        const token0Symbol = this.getTokenSymbol(pair.token0);
        const token1Symbol = this.getTokenSymbol(pair.token1);
        return `${pair.dex}_${token0Symbol}_${token1Symbol}`;
    }
    getTokenSymbol(address) {
        const token = this.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
        return token?.symbol || address.slice(0, 8);
    }
    // ===========================================================================
    // Public Getters
    // ===========================================================================
    isConnected() {
        return this.status === 'connected';
    }
    getChainId() {
        return this.chainId;
    }
    getStatus() {
        return this.status;
    }
    getStats() {
        const avgLatency = this.blockLatencies.length > 0
            ? this.blockLatencies.reduce((a, b) => a + b, 0) / this.blockLatencies.length
            : 0;
        return {
            chainId: this.chainId,
            status: this.status,
            eventsProcessed: this.eventsProcessed,
            opportunitiesFound: this.opportunitiesFound,
            lastBlockNumber: this.lastBlockNumber,
            avgBlockLatencyMs: avgLatency,
            pairsMonitored: this.pairs.size
        };
    }
}
exports.ChainDetectorInstance = ChainDetectorInstance;
//# sourceMappingURL=chain-instance.js.map
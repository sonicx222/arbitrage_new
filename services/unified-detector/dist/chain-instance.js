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
const src_1 = require("../../../shared/core/src");
const src_2 = require("../../../shared/config/src");
// =============================================================================
// Chain Detector Instance
// =============================================================================
class ChainDetectorInstance extends events_1.EventEmitter {
    logger;
    perfLogger;
    streamsClient;
    chainId;
    partitionId;
    chainConfig;
    detectorConfig;
    provider = null;
    wsManager = null;
    dexes;
    tokens;
    tokenMetadata;
    pairs = new Map();
    pairsByAddress = new Map();
    status = 'disconnected';
    eventsProcessed = 0;
    opportunitiesFound = 0;
    lastBlockNumber = 0;
    lastBlockTimestamp = 0;
    blockLatencies = [];
    isRunning = false;
    reconnectAttempts = 0;
    MAX_RECONNECT_ATTEMPTS = 5;
    constructor(config) {
        super();
        this.chainId = config.chainId;
        this.partitionId = config.partitionId;
        this.streamsClient = config.streamsClient;
        this.perfLogger = config.perfLogger;
        this.logger = (0, src_1.createLogger)(`chain:${config.chainId}`);
        // Load chain configuration
        this.chainConfig = src_2.CHAINS[this.chainId];
        if (!this.chainConfig) {
            throw new Error(`Chain configuration not found: ${this.chainId}`);
        }
        this.detectorConfig = src_2.DETECTOR_CONFIG[this.chainId] || src_2.DETECTOR_CONFIG.ethereum;
        this.dexes = src_2.DEXES[this.chainId] || [];
        this.tokens = src_2.CORE_TOKENS[this.chainId] || [];
        this.tokenMetadata = src_2.TOKEN_METADATA[this.chainId] || {};
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
        if (this.isRunning) {
            this.logger.warn('ChainDetectorInstance already running');
            return;
        }
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
        if (!this.isRunning) {
            return;
        }
        this.logger.info('Stopping ChainDetectorInstance', { chainId: this.chainId });
        this.isRunning = false;
        // Disconnect WebSocket (P0-2 fix: remove listeners to prevent memory leak)
        if (this.wsManager) {
            // Remove all event listeners before disconnecting to prevent memory leak
            this.wsManager.removeAllListeners();
            await this.wsManager.disconnect();
            this.wsManager = null;
        }
        // Clean up provider reference
        if (this.provider) {
            this.provider = null;
        }
        // Clear pairs
        this.pairs.clear();
        this.pairsByAddress.clear();
        // Clear latency tracking
        this.blockLatencies = [];
        this.status = 'disconnected';
        this.emit('statusChange', this.status);
        this.logger.info('ChainDetectorInstance stopped');
    }
    // ===========================================================================
    // WebSocket Management
    // ===========================================================================
    async initializeWebSocket() {
        const wsConfig = {
            url: this.chainConfig.wsUrl,
            reconnectInterval: 5000,
            maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
            pingInterval: 30000,
            connectionTimeout: 10000
        };
        this.wsManager = new src_1.WebSocketManager(wsConfig);
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
        for (const dex of this.dexes) {
            for (let i = 0; i < this.tokens.length; i++) {
                for (let j = i + 1; j < this.tokens.length; j++) {
                    const token0 = this.tokens[i];
                    const token1 = this.tokens[j];
                    // Generate a deterministic pair address (placeholder)
                    const pairAddress = this.generatePairAddress(dex.factoryAddress, token0.address, token1.address);
                    const pair = {
                        address: pairAddress,
                        dex: dex.name,
                        token0: token0.address,
                        token1: token1.address,
                        fee: dex.fee,
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
        // Subscribe to Sync events
        await this.wsManager.subscribe({
            type: 'logs',
            topics: [src_2.EVENT_SIGNATURES.SYNC],
            callback: (log) => this.handleSyncEvent(log)
        });
        // Subscribe to Swap events
        await this.wsManager.subscribe({
            type: 'logs',
            topics: [src_2.EVENT_SIGNATURES.SWAP_V2],
            callback: (log) => this.handleSwapEvent(log)
        });
        // Subscribe to new blocks for latency tracking
        await this.wsManager.subscribe({
            type: 'newHeads',
            callback: (block) => this.handleNewBlock(block)
        });
        this.logger.info('Subscribed to blockchain events');
    }
    // ===========================================================================
    // Event Handlers
    // ===========================================================================
    handleWebSocketMessage(message) {
        try {
            // Route message based on type
            if (message.method === 'eth_subscription') {
                const params = message.params;
                if (params?.result?.topics) {
                    // Log event
                    const topic0 = params.result.topics[0];
                    if (topic0 === src_2.EVENT_SIGNATURES.SYNC) {
                        this.handleSyncEvent(params.result);
                    }
                    else if (topic0 === src_2.EVENT_SIGNATURES.SWAP_V2) {
                        this.handleSwapEvent(params.result);
                    }
                }
                else if (params?.result?.number) {
                    // New block
                    this.handleNewBlock(params.result);
                }
            }
        }
        catch (error) {
            this.logger.error('Error handling WebSocket message', { error });
        }
    }
    handleSyncEvent(log) {
        if (!this.isRunning)
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
    handleSwapEvent(log) {
        if (!this.isRunning)
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
        // Calculate price (token1/token0)
        const price = Number(reserve1 * 10n ** 18n / reserve0) / 1e18;
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
            blockNumber: pair.blockNumber
        };
        // Publish to Redis Streams
        this.publishPriceUpdate(priceUpdate);
        this.emit('priceUpdate', priceUpdate);
    }
    async publishPriceUpdate(update) {
        try {
            await this.streamsClient.xadd(src_1.RedisStreamsClient.STREAMS.PRICE_UPDATES, update);
        }
        catch (error) {
            this.logger.error('Failed to publish price update', { error });
        }
    }
    checkArbitrageOpportunity(updatedPair) {
        // Create atomic snapshot of pairs to prevent race conditions during iteration
        // Without this, concurrent Sync events could modify pairs while we're iterating
        const pairsSnapshot = new Map(this.pairs);
        // Find pairs with same tokens but different DEXes
        for (const [key, pair] of pairsSnapshot) {
            if (pair.address === updatedPair.address)
                continue;
            // Check if same token pair
            if (this.isSameTokenPair(pair, updatedPair)) {
                const opportunity = this.calculateArbitrage(updatedPair, pair);
                if (opportunity && opportunity.expectedProfit > 0) {
                    this.opportunitiesFound++;
                    this.emitOpportunity(opportunity);
                }
            }
        }
    }
    isSameTokenPair(pair1, pair2) {
        return ((pair1.token0 === pair2.token0 && pair1.token1 === pair2.token1) ||
            (pair1.token0 === pair2.token1 && pair1.token1 === pair2.token0));
    }
    calculateArbitrage(pair1, pair2) {
        const reserve1_0 = BigInt(pair1.reserve0);
        const reserve1_1 = BigInt(pair1.reserve1);
        const reserve2_0 = BigInt(pair2.reserve0);
        const reserve2_1 = BigInt(pair2.reserve1);
        if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
            return null;
        }
        // Calculate prices
        const price1 = Number(reserve1_1) / Number(reserve1_0);
        const price2 = Number(reserve2_1) / Number(reserve2_0);
        const priceDiff = Math.abs(price1 - price2);
        const avgPrice = (price1 + price2) / 2;
        const percentageDiff = priceDiff / avgPrice;
        // Check if profitable (basic check)
        if (percentageDiff < 0.003) { // 0.3% minimum
            return null;
        }
        const opportunity = {
            id: `${this.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            type: 'intra-dex',
            buyDex: price1 < price2 ? pair1.dex : pair2.dex,
            sellDex: price1 < price2 ? pair2.dex : pair1.dex,
            buyChain: this.chainId,
            sellChain: this.chainId,
            tokenIn: pair1.token0,
            tokenOut: pair1.token1,
            amountIn: '1000000000000000000', // 1 token
            expectedProfit: priceDiff,
            profitPercentage: percentageDiff,
            gasEstimate: this.detectorConfig.gasEstimate,
            confidence: this.detectorConfig.confidence,
            timestamp: Date.now(),
            blockNumber: pair1.blockNumber
        };
        return opportunity;
    }
    async emitOpportunity(opportunity) {
        try {
            await this.streamsClient.xadd(src_1.RedisStreamsClient.STREAMS.OPPORTUNITIES, opportunity);
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
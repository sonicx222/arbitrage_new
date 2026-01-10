"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BSCDetectorService = void 0;
// BSC DEX Detector Service
const ethers_1 = require("ethers");
const ws_1 = __importDefault(require("ws"));
const src_1 = require("../../../shared/core/src");
const src_2 = require("../../../shared/config/src");
class BSCDetectorService {
    constructor() {
        this.wsProvider = null;
        this.redis = null; // Will be initialized asynchronously
        this.logger = (0, src_1.createLogger)('bsc-detector');
        this.pairs = new Map(); // pairKey -> pair data
        this.monitoredPairs = new Set();
        this.isRunning = false;
        this.reconnectionTimer = null; // Track reconnection timer
        this.perfLogger = (0, src_1.getPerformanceLogger)('bsc-detector');
        this.dexes = src_2.DEXES.bsc;
        this.tokens = src_2.CORE_TOKENS.bsc;
        this.provider = new ethers_1.ethers.JsonRpcProvider(src_2.CHAINS.bsc.rpcUrl);
        // Initialize event batcher for optimized processing
        this.eventBatcher = (0, src_1.createEventBatcher)({
            maxBatchSize: 20, // Optimized batch size for BSC
            maxWaitTime: 30, // 30ms for fast processing
            enableDeduplication: true,
            enablePrioritization: true
        }, (batch) => this.processBatchedEvents(batch));
    }
    async start() {
        try {
            this.logger.info('Starting BSC detector service');
            // Initialize Redis client
            this.redis = await (0, src_1.getRedisClient)();
            // Initialize pairs
            await this.initializePairs();
            // Connect to WebSocket
            await this.connectWebSocket();
            // Subscribe to events
            await this.subscribeToEvents();
            this.isRunning = true;
            this.logger.info('BSC detector service started successfully');
            // Start health monitoring
            this.startHealthMonitoring();
        }
        catch (error) {
            this.logger.error('Failed to start BSC detector service', { error });
            throw error;
        }
    }
    async stop() {
        this.logger.info('Stopping BSC detector service');
        this.isRunning = false;
        // Clear reconnection timer to prevent new connections
        if (this.reconnectionTimer) {
            clearTimeout(this.reconnectionTimer);
            this.reconnectionTimer = null;
        }
        // Flush any remaining batched events
        if (this.eventBatcher) {
            this.eventBatcher.flushAll();
            this.eventBatcher.destroy();
            this.eventBatcher = null;
        }
        // Close WebSocket connection
        if (this.wsProvider) {
            this.wsProvider.removeAllListeners(); // Clean up event listeners
            this.wsProvider.close();
            this.wsProvider = null;
        }
        // Disconnect Redis
        if (this.redis) {
            await this.redis.disconnect();
            this.redis = null;
        }
        // Clear collections to prevent memory leaks
        this.pairs.clear();
        this.monitoredPairs.clear();
    }
    scheduleReconnection() {
        if (!this.isRunning || this.reconnectionTimer)
            return;
        this.reconnectionTimer = setTimeout(async () => {
            this.reconnectionTimer = null;
            if (!this.isRunning)
                return;
            try {
                this.logger.info('Attempting WebSocket reconnection');
                await this.connectWebSocket();
            }
            catch (error) {
                this.logger.error('WebSocket reconnection failed, will retry', { error });
                // Schedule another attempt with exponential backoff
                setTimeout(() => {
                    if (this.isRunning) {
                        this.scheduleReconnection();
                    }
                }, 10000); // 10 second backoff
            }
        }, 5000);
    }
    async initializePairs() {
        this.logger.info('Initializing BSC trading pairs');
        for (const dex of this.dexes) {
            for (let i = 0; i < this.tokens.length; i++) {
                for (let j = i + 1; j < this.tokens.length; j++) {
                    const token0 = this.tokens[i];
                    const token1 = this.tokens[j];
                    try {
                        // Get pair address from DEX factory
                        const factoryContract = new ethers_1.ethers.Contract(dex.factoryAddress, ['function getPair(address,address) view returns (address)'], this.provider);
                        const pairAddress = await factoryContract.getPair(token0.address, token1.address);
                        if (pairAddress !== ethers_1.ethers.ZeroAddress) {
                            const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
                            const pair = {
                                address: pairAddress,
                                token0,
                                token1,
                                dex,
                                reserve0: '0',
                                reserve1: '0',
                                blockNumber: 0,
                                lastUpdate: 0
                            };
                            this.pairs.set(pairKey, pair);
                            this.monitoredPairs.add(pairAddress);
                            this.logger.debug(`Added pair: ${pairKey} at ${pairAddress}`);
                        }
                    }
                    catch (error) {
                        this.logger.warn(`Failed to initialize pair ${token0.symbol}-${token1.symbol} on ${dex.name}`, { error });
                    }
                }
            }
        }
        this.logger.info(`Initialized ${this.pairs.size} trading pairs`);
    }
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = src_2.CHAINS.bsc.wsUrl;
                this.logger.info(`Connecting to BSC WebSocket: ${wsUrl}`);
                this.wsProvider = new ws_1.default(wsUrl);
                this.wsProvider.on('open', () => {
                    this.logger.info('BSC WebSocket connected');
                    resolve();
                });
                this.wsProvider.on('message', (data) => {
                    this.handleWebSocketMessage(data);
                });
                this.wsProvider.on('error', (error) => {
                    this.logger.error('BSC WebSocket error', { error });
                    reject(error);
                });
                this.wsProvider.on('close', (code, reason) => {
                    this.logger.warn('BSC WebSocket closed', { code, reason: reason.toString() });
                    if (this.isRunning && !this.reconnectionTimer) {
                        this.scheduleReconnection();
                    }
                });
            }
            catch (error) {
                this.logger.error('Failed to connect to BSC WebSocket', { error });
                reject(error);
            }
        });
    }
    async subscribeToEvents() {
        if (!this.wsProvider) {
            throw new Error('WebSocket not connected');
        }
        // Subscribe to Sync events (reserve changes)
        if (src_2.EVENT_CONFIG.syncEvents.enabled) {
            const syncSubscription = {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: [
                    'logs',
                    {
                        topics: [
                            '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1', // Sync event signature
                        ],
                        address: Array.from(this.monitoredPairs)
                    }
                ]
            };
            this.wsProvider.send(JSON.stringify(syncSubscription));
            this.logger.info(`Subscribed to Sync events for ${this.monitoredPairs.size} pairs`);
        }
        // Subscribe to Swap events (trading activity)
        if (src_2.EVENT_CONFIG.swapEvents.enabled) {
            const swapSubscription = {
                jsonrpc: '2.0',
                id: 2,
                method: 'eth_subscribe',
                params: [
                    'logs',
                    {
                        topics: [
                            '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822e', // Swap event signature
                        ],
                        address: Array.from(this.monitoredPairs)
                    }
                ]
            };
            this.wsProvider.send(JSON.stringify(swapSubscription));
            this.logger.info(`Subscribed to Swap events for ${this.monitoredPairs.size} pairs`);
        }
    }
    handleWebSocketMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            if (message.method === 'eth_subscription') {
                const { result } = message;
                // Add event to batcher for optimized processing
                this.eventBatcher.addEvent(result);
            }
        }
        catch (error) {
            this.logger.error('Failed to process WebSocket message', { error, data: data.toString() });
        }
    }
    async processLogEvent(log) {
        const startTime = performance.now();
        try {
            // Find the pair this log belongs to
            const pair = Array.from(this.pairs.values()).find(p => p.address.toLowerCase() === log.address.toLowerCase());
            if (!pair) {
                return; // Not a monitored pair
            }
            // Decode the event based on topics
            if (log.topics[0] === '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1') {
                // Sync event (reserve update)
                await this.processSyncEvent(log, pair);
            }
            else if (log.topics[0] === '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822e') {
                // Swap event (trade)
                await this.processSwapEvent(log, pair);
            }
            const latency = performance.now() - startTime;
            this.perfLogger.logEventLatency('log_processing', latency, {
                pair: `${pair.token0.symbol}-${pair.token1.symbol}`,
                dex: pair.dex.name,
                eventType: log.topics[0]
            });
        }
        catch (error) {
            this.logger.error('Failed to process log event', { error, log });
        }
    }
    async processSyncEvent(log, pair) {
        try {
            // Decode reserve data from log data
            const decodedData = ethers_1.ethers.AbiCoder.defaultAbiCoder().decode(['uint112', 'uint112'], log.data);
            const reserve0 = decodedData[0].toString();
            const reserve1 = decodedData[1].toString();
            const blockNumber = parseInt(log.blockNumber, 16);
            // Update pair data
            pair.reserve0 = reserve0;
            pair.reserve1 = reserve1;
            pair.blockNumber = blockNumber;
            pair.lastUpdate = Date.now();
            // Calculate price
            const price = this.calculatePrice(pair);
            // Create price update
            const priceUpdate = {
                pairKey: `${pair.dex.name}_${pair.token0.symbol}_${pair.token1.symbol}`,
                dex: pair.dex.name,
                chain: 'bsc',
                token0: pair.token0.symbol,
                token1: pair.token1.symbol,
                price,
                reserve0,
                reserve1,
                blockNumber,
                timestamp: Date.now(),
                latency: 0
            };
            // Publish price update
            await this.publishPriceUpdate(priceUpdate);
            // Check for intra-DEX arbitrage
            await this.checkIntraDexArbitrage(pair);
        }
        catch (error) {
            this.logger.error('Failed to process sync event', { error, pair: pair.address });
        }
    }
    async processSwapEvent(log, pair) {
        try {
            // Only process significant trades (configurable threshold)
            const decodedData = ethers_1.ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
            const amount0In = decodedData[0].toString();
            const amount1In = decodedData[1].toString();
            const amount0Out = decodedData[2].toString();
            const amount1Out = decodedData[3].toString();
            // Calculate USD value (simplified - would need price oracle in production)
            const usdValue = await this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);
            // Apply filtering based on configuration
            if (usdValue < src_2.EVENT_CONFIG.swapEvents.minAmountUSD) {
                // Apply sampling for small trades
                if (Math.random() > src_2.EVENT_CONFIG.swapEvents.samplingRate) {
                    return; // Skip this event
                }
            }
            const swapEvent = {
                pairAddress: pair.address,
                sender: '0x' + log.topics[1].slice(26), // Extract from topics
                recipient: '0x' + log.topics[2].slice(26),
                amount0In,
                amount1In,
                amount0Out,
                amount1Out,
                to: '0x' + log.topics[2].slice(26),
                blockNumber: parseInt(log.blockNumber, 16),
                transactionHash: log.transactionHash,
                timestamp: Date.now(),
                dex: pair.dex.name,
                chain: 'bsc',
                usdValue
            };
            // Publish swap event for analysis
            await this.publishSwapEvent(swapEvent);
            // Check for whale activity
            await this.checkWhaleActivity(swapEvent);
        }
        catch (error) {
            this.logger.error('Failed to process swap event', { error, pair: pair.address });
        }
    }
    calculatePrice(pair) {
        try {
            const reserve0 = parseFloat(pair.reserve0);
            const reserve1 = parseFloat(pair.reserve1);
            if (reserve0 === 0 || reserve1 === 0)
                return 0;
            // Price of token1 in terms of token0
            return reserve0 / reserve1;
        }
        catch (error) {
            this.logger.error('Failed to calculate price', { error, pair });
            return 0;
        }
    }
    async checkIntraDexArbitrage(pair) {
        // For now, just check basic triangular arbitrage within the same DEX
        // This will be enhanced with the WebAssembly engine later
        const opportunities = [];
        // Check if this price update creates arbitrage with existing pairs
        // This is a simplified version - full implementation in Phase 2
        if (opportunities.length > 0) {
            for (const opportunity of opportunities) {
                await this.publishArbitrageOpportunity(opportunity);
                this.perfLogger.logArbitrageOpportunity(opportunity);
            }
        }
    }
    async checkWhaleActivity(swapEvent) {
        if (!swapEvent.usdValue || swapEvent.usdValue < 50000)
            return; // $50K threshold
        const whaleTransaction = {
            transactionHash: swapEvent.transactionHash,
            address: swapEvent.sender,
            token: swapEvent.amount0In > swapEvent.amount1In ? 'token0' : 'token1',
            amount: Math.max(parseFloat(swapEvent.amount0In), parseFloat(swapEvent.amount1In)),
            usdValue: swapEvent.usdValue,
            direction: swapEvent.amount0In > swapEvent.amount1In ? 'sell' : 'buy',
            dex: swapEvent.dex,
            chain: swapEvent.chain,
            timestamp: swapEvent.timestamp,
            impact: await this.calculatePriceImpact(swapEvent)
        };
        await this.publishWhaleTransaction(whaleTransaction);
    }
    async estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out) {
        // Simplified USD estimation - would use price oracle in production
        // For now, assume BNB pairs have known USD values
        if (pair.token0.symbol === 'WBNB' || pair.token1.symbol === 'WBNB') {
            const bnbPrice = 300; // Approximate BNB price in USD
            const amount = Math.max(parseFloat(amount0In), parseFloat(amount1In), parseFloat(amount0Out), parseFloat(amount1Out));
            return (amount / 1e18) * bnbPrice;
        }
        return 0;
    }
    async calculatePriceImpact(swapEvent) {
        // Simplified price impact calculation
        // Would be more sophisticated in production
        return 0.02; // 2% default
    }
    // Publishing methods
    async publishPriceUpdate(update) {
        const message = {
            type: 'price-update',
            data: update,
            timestamp: Date.now(),
            source: 'bsc-detector'
        };
        await this.redis.publish('price-updates', message);
    }
    async publishSwapEvent(swapEvent) {
        const message = {
            type: 'swap-event',
            data: swapEvent,
            timestamp: Date.now(),
            source: 'bsc-detector'
        };
        await this.redis.publish('swap-events', message);
    }
    async publishArbitrageOpportunity(opportunity) {
        const message = {
            type: 'arbitrage-opportunity',
            data: opportunity,
            timestamp: Date.now(),
            source: 'bsc-detector'
        };
        await this.redis.publish('arbitrage-opportunities', message);
    }
    async publishWhaleTransaction(whaleTransaction) {
        const message = {
            type: 'whale-transaction',
            data: whaleTransaction,
            timestamp: Date.now(),
            source: 'bsc-detector'
        };
        await this.redis.publish('whale-transactions', message);
    }
    async processBatchedEvents(batch) {
        const startTime = performance.now();
        try {
            // Process all events in the batch
            const processPromises = batch.events.map(event => this.processLogEvent(event));
            await Promise.all(processPromises);
            const latency = performance.now() - startTime;
            this.perfLogger.logEventLatency('batch_processing', latency, {
                pairKey: batch.pairKey,
                batchSize: batch.batchSize,
                eventsPerMs: batch.batchSize / (latency / 1000)
            });
        }
        catch (error) {
            this.logger.error('Failed to process batched events', {
                error,
                pairKey: batch.pairKey,
                batchSize: batch.batchSize
            });
        }
    }
    startHealthMonitoring() {
        setInterval(async () => {
            try {
                const batcherStats = this.eventBatcher ? this.eventBatcher.getStats() : null;
                const health = {
                    service: 'bsc-detector',
                    status: (this.isRunning ? 'healthy' : 'unhealthy'),
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage().heapUsed,
                    cpuUsage: 0, // Would need additional monitoring
                    lastHeartbeat: Date.now(),
                    pairs: this.pairs.size,
                    websocket: this.wsProvider?.readyState === ws_1.default.OPEN,
                    batcherStats
                };
                await this.redis.updateServiceHealth('bsc-detector', health);
                this.perfLogger.logHealthCheck('bsc-detector', health);
            }
            catch (error) {
                this.logger.error('Health monitoring failed', { error });
            }
        }, 30000); // Every 30 seconds
    }
}
exports.BSCDetectorService = BSCDetectorService;
//# sourceMappingURL=detector.js.map
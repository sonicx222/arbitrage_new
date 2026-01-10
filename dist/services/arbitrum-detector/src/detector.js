"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArbitrumDetectorService = void 0;
// Arbitrum DEX Detector Service - Ultra Fast Monitoring
const ethers_1 = require("ethers");
const ws_1 = __importDefault(require("ws"));
const src_1 = require("../../../shared/core/src");
const src_2 = require("../../../shared/config/src");
class ArbitrumDetectorService {
    constructor() {
        this.wsProvider = null;
        this.redis = (0, src_1.getRedisClient)();
        this.logger = (0, src_1.createLogger)('arbitrum-detector');
        this.pairs = new Map(); // pairKey -> pair data
        this.monitoredPairs = new Set();
        this.isRunning = false;
        this.eventBuffer = []; // Buffer for ultra-fast processing
        this.processingInterval = null;
        this.perfLogger = (0, src_1.getPerformanceLogger)('arbitrum-detector');
        this.dexes = src_2.DEXES.arbitrum;
        this.tokens = src_2.CORE_TOKENS.arbitrum;
        this.provider = new ethers_1.ethers.JsonRpcProvider(src_2.CHAINS.arbitrum.rpcUrl);
    }
    async start() {
        try {
            this.logger.info('Starting Arbitrum detector service (Ultra-Fast Mode)');
            // Initialize pairs
            await this.initializePairs();
            // Connect to WebSocket with ultra-fast settings
            await this.connectWebSocket();
            // Subscribe to events with high-frequency monitoring
            await this.subscribeToEvents();
            // Start ultra-fast event processing (every 50ms)
            this.startUltraFastProcessing();
            this.isRunning = true;
            this.logger.info('Arbitrum detector service started successfully (250ms block time optimized)');
            // Start health monitoring
            this.startHealthMonitoring();
        }
        catch (error) {
            this.logger.error('Failed to start Arbitrum detector service', { error });
            throw error;
        }
    }
    async stop() {
        this.logger.info('Stopping Arbitrum detector service');
        this.isRunning = false;
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        if (this.wsProvider) {
            this.wsProvider.close();
            this.wsProvider = null;
        }
        await this.redis.disconnect();
    }
    async initializePairs() {
        this.logger.info('Initializing Arbitrum trading pairs (Ultra-Fast Configuration)');
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
                            this.logger.debug(`Added Arbitrum pair: ${pairKey} at ${pairAddress}`);
                        }
                    }
                    catch (error) {
                        this.logger.warn(`Failed to initialize pair ${token0.symbol}-${token1.symbol} on ${dex.name}`, { error });
                    }
                }
            }
        }
        this.logger.info(`Initialized ${this.pairs.size} Arbitrum trading pairs`);
    }
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = src_2.CHAINS.arbitrum.wsUrl;
                this.logger.info(`Connecting to Arbitrum WebSocket (Ultra-Fast): ${wsUrl}`);
                // Configure for ultra-fast Arbitrum monitoring
                this.wsProvider = new ws_1.default(wsUrl, [], {
                    handshakeTimeout: 1000, // Faster handshake
                    perMessageDeflate: false, // Disable compression for speed
                });
                this.wsProvider.on('open', () => {
                    this.logger.info('Arbitrum WebSocket connected (250ms block time optimized)');
                    resolve();
                });
                this.wsProvider.on('message', (data) => {
                    this.handleWebSocketMessage(data);
                });
                this.wsProvider.on('error', (error) => {
                    this.logger.error('Arbitrum WebSocket error', { error });
                    reject(error);
                });
                this.wsProvider.on('close', () => {
                    this.logger.warn('Arbitrum WebSocket closed, attempting ultra-fast reconnection');
                    if (this.isRunning) {
                        setTimeout(() => this.connectWebSocket(), 1000); // Faster reconnection
                    }
                });
            }
            catch (error) {
                this.logger.error('Failed to connect to Arbitrum WebSocket', { error });
                reject(error);
            }
        });
    }
    async subscribeToEvents() {
        if (!this.wsProvider) {
            throw new Error('WebSocket not connected');
        }
        // Subscribe to Sync events with ultra-fast processing
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
            this.logger.info(`Subscribed to Sync events for ${this.monitoredPairs.size} Arbitrum pairs (Ultra-Fast)`);
        }
        // Subscribe to Swap events with high-frequency sampling
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
            this.logger.info(`Subscribed to Swap events for ${this.monitoredPairs.size} Arbitrum pairs (Ultra-Fast)`);
        }
    }
    startUltraFastProcessing() {
        // Process events every 50ms for ultra-fast Arbitrum monitoring
        this.processingInterval = setInterval(() => {
            this.processEventBuffer();
        }, 50);
    }
    handleWebSocketMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            if (message.method === 'eth_subscription') {
                const { result } = message;
                // Buffer events for ultra-fast batch processing
                this.eventBuffer.push(result);
            }
        }
        catch (error) {
            this.logger.error('Failed to process Arbitrum WebSocket message', { error, data: data.toString() });
        }
    }
    async processEventBuffer() {
        if (this.eventBuffer.length === 0)
            return;
        const events = [...this.eventBuffer];
        this.eventBuffer = [];
        // Process events in parallel for ultra-fast performance
        const processingPromises = events.map(event => this.processLogEvent(event));
        try {
            await Promise.all(processingPromises);
        }
        catch (error) {
            this.logger.error('Failed to process event buffer', { error });
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
                eventType: log.topics[0],
                ultraFast: true
            });
        }
        catch (error) {
            this.logger.error('Failed to process Arbitrum log event', { error, pair: log.address });
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
            // Create price update with ultra-fast latency tracking
            const priceUpdate = {
                pairKey: `${pair.dex.name}_${pair.token0.symbol}_${pair.token1.symbol}`,
                dex: pair.dex.name,
                chain: 'arbitrum',
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
            // Check for intra-DEX arbitrage with ultra-fast detection
            await this.checkIntraDexArbitrage(pair);
        }
        catch (error) {
            this.logger.error('Failed to process Arbitrum sync event', { error, pair: pair.address });
        }
    }
    async processSwapEvent(log, pair) {
        try {
            // Decode swap data
            const decodedData = ethers_1.ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
            const amount0In = decodedData[0].toString();
            const amount1In = decodedData[1].toString();
            const amount0Out = decodedData[2].toString();
            const amount1Out = decodedData[3].toString();
            // Calculate USD value
            const usdValue = await this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);
            // Lower threshold for Arbitrum due to low gas costs
            if (usdValue < 1000) { // $1K threshold for Arbitrum
                // Higher sampling rate for ultra-fast monitoring
                if (Math.random() > 0.5) { // 50% sampling for small trades
                    return;
                }
            }
            const swapEvent = {
                pairAddress: pair.address,
                sender: '0x' + log.topics[1].slice(26),
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
                chain: 'arbitrum',
                usdValue
            };
            // Publish swap event for ultra-fast analysis
            await this.publishSwapEvent(swapEvent);
            // Check for whale activity with lower threshold
            await this.checkWhaleActivity(swapEvent);
        }
        catch (error) {
            this.logger.error('Failed to process Arbitrum swap event', { error, pair: pair.address });
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
            this.logger.error('Failed to calculate Arbitrum price', { error, pair });
            return 0;
        }
    }
    async checkIntraDexArbitrage(pair) {
        // Ultra-fast arbitrage checking for Arbitrum
        const opportunities = [];
        // Check if this price update creates arbitrage with existing pairs
        // This will be enhanced with the WebAssembly engine later
        if (opportunities.length > 0) {
            for (const opportunity of opportunities) {
                await this.publishArbitrageOpportunity(opportunity);
                this.perfLogger.logArbitrageOpportunity(opportunity);
            }
        }
    }
    async checkWhaleActivity(swapEvent) {
        if (!swapEvent.usdValue || swapEvent.usdValue < 25000)
            return; // $25K threshold for Arbitrum (lower due to gas costs)
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
        // Simplified USD estimation for Arbitrum
        if (pair.token0.symbol === 'WETH' || pair.token1.symbol === 'WETH') {
            const ethPrice = 2500; // Approximate ETH price in USD
            const amount = Math.max(parseFloat(amount0In), parseFloat(amount1In), parseFloat(amount0Out), parseFloat(amount1Out));
            return (amount / 1e18) * ethPrice;
        }
        return 0;
    }
    async calculatePriceImpact(swapEvent) {
        // Simplified price impact calculation
        return 0.02; // 2% default
    }
    // Publishing methods with ultra-fast Redis communication
    async publishPriceUpdate(update) {
        const message = {
            type: 'price-update',
            data: update,
            timestamp: Date.now(),
            source: 'arbitrum-detector',
            ultraFast: true
        };
        await this.redis.publish('price-updates', message);
    }
    async publishSwapEvent(swapEvent) {
        const message = {
            type: 'swap-event',
            data: swapEvent,
            timestamp: Date.now(),
            source: 'arbitrum-detector',
            ultraFast: true
        };
        await this.redis.publish('swap-events', message);
    }
    async publishArbitrageOpportunity(opportunity) {
        const message = {
            type: 'arbitrage-opportunity',
            data: opportunity,
            timestamp: Date.now(),
            source: 'arbitrum-detector',
            ultraFast: true
        };
        await this.redis.publish('arbitrage-opportunities', message);
    }
    async publishWhaleTransaction(whaleTransaction) {
        const message = {
            type: 'whale-transaction',
            data: whaleTransaction,
            timestamp: Date.now(),
            source: 'arbitrum-detector',
            ultraFast: true
        };
        await this.redis.publish('whale-transactions', message);
    }
    startHealthMonitoring() {
        setInterval(async () => {
            try {
                const health = {
                    service: 'arbitrum-detector',
                    status: (this.isRunning ? 'healthy' : 'unhealthy'),
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage().heapUsed,
                    cpuUsage: 0,
                    lastHeartbeat: Date.now(),
                    pairs: this.pairs.size,
                    websocket: this.wsProvider?.readyState === ws_1.default.OPEN,
                    ultraFastMode: true,
                    eventBufferSize: this.eventBuffer.length
                };
                await this.redis.updateServiceHealth('arbitrum-detector', health);
                this.perfLogger.logHealthCheck('arbitrum-detector', health);
            }
            catch (error) {
                this.logger.error('Arbitrum health monitoring failed', { error });
            }
        }, 15000); // More frequent health checks for ultra-fast service
    }
}
exports.ArbitrumDetectorService = ArbitrumDetectorService;
//# sourceMappingURL=detector.js.map
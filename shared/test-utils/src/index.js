"use strict";
// Test Utilities for Arbitrage System
// Provides mocks, fixtures, and helpers for comprehensive testing
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestEnvironment = exports.mockSwapEvent = exports.mockArbitrageOpportunity = exports.mockPriceUpdate = exports.mockDexes = exports.mockTokens = exports.WebSocketMock = exports.BlockchainMock = exports.RedisMock = void 0;
exports.createMockPriceUpdate = createMockPriceUpdate;
exports.createMockArbitrageOpportunity = createMockArbitrageOpportunity;
exports.createMockSwapEvent = createMockSwapEvent;
exports.delay = delay;
exports.generateRandomAddress = generateRandomAddress;
exports.generateRandomHash = generateRandomHash;
exports.measurePerformance = measurePerformance;
exports.getMemoryUsage = getMemoryUsage;
exports.formatBytes = formatBytes;
// Set required environment variables before any imports
// These are needed by shared/config/src/index.ts which validates at module load time
process.env.ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = process.env.ETHEREUM_WS_URL || 'wss://mainnet.infura.io/ws/v3/test';
process.env.ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = process.env.ARBITRUM_WS_URL || 'wss://arb1.arbitrum.io/feed';
process.env.BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org';
process.env.BSC_WS_URL = process.env.BSC_WS_URL || 'wss://bsc-ws-node.nariox.org:443';
process.env.POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com';
process.env.OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = process.env.OPTIMISM_WS_URL || 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
process.env.BASE_WS_URL = process.env.BASE_WS_URL || 'wss://mainnet.base.org';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// Mock implementations
class RedisMock {
    constructor() {
        this.data = new Map();
        this.pubSubChannels = new Map();
    }
    async get(key) {
        return this.data.get(key) || null;
    }
    async set(key, value) {
        this.data.set(key, value);
    }
    async setex(key, ttl, value) {
        this.data.set(key, value);
        // In real implementation, would set TTL
    }
    async del(...keys) {
        let deleted = 0;
        for (const key of keys) {
            if (this.data.delete(key))
                deleted++;
        }
        return deleted;
    }
    async exists(key) {
        return this.data.has(key);
    }
    async publish(channel, message) {
        const subscribers = this.pubSubChannels.get(channel);
        if (subscribers) {
            const serializedMessage = typeof message === 'string' ? message : JSON.stringify(message);
            subscribers.forEach(callback => {
                try {
                    callback(null, serializedMessage);
                }
                catch (error) {
                    console.error('Mock pub/sub callback error:', error);
                }
            });
            return subscribers.size;
        }
        return 0;
    }
    async subscribe(channel, callback) {
        if (!this.pubSubChannels.has(channel)) {
            this.pubSubChannels.set(channel, new Set());
        }
        this.pubSubChannels.get(channel).add(callback);
    }
    async unsubscribe(channel, callback) {
        if (callback) {
            this.pubSubChannels.get(channel)?.delete(callback);
        }
        else {
            this.pubSubChannels.delete(channel);
        }
    }
    async keys(pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return Array.from(this.data.keys()).filter(key => regex.test(key));
    }
    async hset(key, field, value) {
        const hash = this.data.get(key) || {};
        const oldValue = hash[field];
        hash[field] = value;
        this.data.set(key, hash);
        return oldValue ? 0 : 1;
    }
    async hget(key, field) {
        const hash = this.data.get(key);
        return hash ? hash[field] : null;
    }
    async hgetall(key) {
        return this.data.get(key) || {};
    }
    async lpush(key, value) {
        const list = this.data.get(key) || [];
        list.unshift(value);
        this.data.set(key, list);
        return list.length;
    }
    async lrange(key, start, end) {
        const list = this.data.get(key) || [];
        return list.slice(start, end + 1);
    }
    async ltrim(key, start, end) {
        const list = this.data.get(key) || [];
        const trimmed = list.slice(start, end + 1);
        this.data.set(key, trimmed);
    }
    async llen(key) {
        const list = this.data.get(key) || [];
        return list.length;
    }
    async rpop(key) {
        const list = this.data.get(key) || [];
        return list.pop();
    }
    async expire(key, ttl) {
        // Mock TTL - in real implementation would set expiration
        return 1;
    }
    async ping() {
        return true; // Simplified for mock
    }
    async disconnect() {
        this.data.clear();
        this.pubSubChannels.clear();
    }
    // Test helpers
    getData() {
        return new Map(this.data);
    }
    clear() {
        this.data.clear();
        this.pubSubChannels.clear();
    }
}
exports.RedisMock = RedisMock;
class BlockchainMock {
    constructor() {
        this.blocks = new Map();
        this.transactions = new Map();
        this.logs = [];
        this.networkFailure = false;
    }
    // Provider mock
    async getBlockNumber() {
        if (this.networkFailure)
            throw new Error('Network failure');
        return Math.floor(Date.now() / 1000);
    }
    async getBlock(blockNumber) {
        if (this.networkFailure)
            throw new Error('Network failure');
        return this.blocks.get(blockNumber) || {
            number: blockNumber,
            timestamp: Date.now(),
            transactions: []
        };
    }
    async getTransaction(hash) {
        if (this.networkFailure)
            throw new Error('Network failure');
        return this.transactions.get(hash) || null;
    }
    async getLogs(filter) {
        if (this.networkFailure)
            throw new Error('Network failure');
        return this.logs.filter(log => (!filter.address || log.address === filter.address) &&
            (!filter.fromBlock || log.blockNumber >= filter.fromBlock) &&
            (!filter.toBlock || log.blockNumber <= filter.toBlock));
    }
    // Test helpers
    addBlock(block) {
        this.blocks.set(block.number, block);
    }
    addTransaction(tx) {
        this.transactions.set(tx.hash, tx);
    }
    addLog(log) {
        this.logs.push(log);
    }
    setNetworkFailure(failure) {
        this.networkFailure = failure;
    }
    clear() {
        this.blocks.clear();
        this.transactions.clear();
        this.logs.length = 0;
        this.networkFailure = false;
    }
}
exports.BlockchainMock = BlockchainMock;
class WebSocketMock {
    constructor(url) {
        this.listeners = new Map();
        this.readyState = 1; // OPEN
        this.sentMessages = [];
        // Mock connection
        setTimeout(() => {
            this.emit('open');
        }, 10);
    }
    addEventListener(event, listener) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(listener);
    }
    removeEventListener(event, listener) {
        const listeners = this.listeners.get(event);
        if (listeners) {
            const index = listeners.indexOf(listener);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        }
    }
    send(message) {
        this.sentMessages.push(message);
    }
    close() {
        this.readyState = 3; // CLOSED
        this.emit('close', { code: 1000, reason: 'Normal closure' });
    }
    emit(event, ...args) {
        const listeners = this.listeners.get(event);
        if (listeners) {
            listeners.forEach(listener => {
                try {
                    listener(...args);
                }
                catch (error) {
                    console.error('Mock WebSocket listener error:', error);
                }
            });
        }
    }
    // Test helpers
    getSentMessages() {
        return [...this.sentMessages];
    }
    simulateMessage(message) {
        this.emit('message', { data: JSON.stringify(message) });
    }
    simulateError(error) {
        this.emit('error', error);
    }
    getReadyState() {
        return this.readyState;
    }
    clear() {
        this.listeners.clear();
        this.sentMessages.length = 0;
        this.readyState = 1;
    }
}
exports.WebSocketMock = WebSocketMock;
// Test fixtures
exports.mockTokens = {
    WETH: {
        name: 'Wrapped Ether',
        symbol: 'WETH',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
        chain: 'ethereum'
    },
    USDC: {
        name: 'USD Coin',
        symbol: 'USDC',
        address: '0xA0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
        decimals: 6,
        chain: 'ethereum'
    },
    WBNB: {
        name: 'Wrapped BNB',
        symbol: 'WBNB',
        address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        decimals: 18,
        chain: 'bsc'
    },
    BUSD: {
        name: 'Binance USD',
        symbol: 'BUSD',
        address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        decimals: 18,
        chain: 'bsc'
    }
};
exports.mockDexes = {
    uniswap: {
        name: 'uniswap_v3',
        chain: 'ethereum',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        fee: 0.003,
        enabled: true
    },
    pancakeswap: {
        name: 'pancakeswap',
        chain: 'bsc',
        factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        fee: 0.0025,
        enabled: true
    }
};
exports.mockPriceUpdate = {
    dex: 'uniswap_v3',
    chain: 'ethereum',
    pair: 'WETH/USDC',
    pairAddress: '0x1234567890123456789012345678901234567890',
    token0: exports.mockTokens.WETH.address,
    token1: exports.mockTokens.USDC.address,
    price0: 1800.0, // WETH price in USDC
    price1: 0.000555, // USDC price in WETH
    timestamp: Date.now(),
    blockNumber: 18500000
};
exports.mockArbitrageOpportunity = {
    id: 'arb_eth_1234567890_abcdef',
    sourceChain: 'ethereum',
    targetChain: 'ethereum',
    sourceDex: 'uniswap_v3',
    targetDex: 'sushiswap',
    tokenAddress: exports.mockTokens.WETH.address,
    amount: 1.0,
    priceDifference: 5.0,
    percentageDifference: 0.28,
    estimatedProfit: 2.5,
    gasCost: 0.01,
    netProfit: 2.49,
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 300000 // 5 minutes
};
exports.mockSwapEvent = {
    dex: 'uniswap_v3',
    chain: 'ethereum',
    pair: 'WETH/USDC',
    pairAddress: '0x1234567890123456789012345678901234567890',
    sender: '0xabcdef1234567890abcdef1234567890abcdef12',
    to: '0x1234567890abcdef1234567890abcdef12345678',
    amount0In: 1.0,
    amount1In: 0.0,
    amount0Out: 0.0,
    amount1Out: 1800.0,
    timestamp: Date.now(),
    blockNumber: 18500000
};
// Test helpers
function createMockPriceUpdate(overrides = {}) {
    return { ...exports.mockPriceUpdate, ...overrides };
}
function createMockArbitrageOpportunity(overrides = {}) {
    return { ...exports.mockArbitrageOpportunity, ...overrides };
}
function createMockSwapEvent(overrides = {}) {
    return { ...exports.mockSwapEvent, ...overrides };
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function generateRandomAddress() {
    return '0x' + Math.random().toString(16).substr(2, 40);
}
function generateRandomHash() {
    return '0x' + Math.random().toString(16).substr(2, 64);
}
// Performance testing helpers
async function measurePerformance(operation, iterations = 100) {
    const times = [];
    let result;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        result = await operation();
        const end = performance.now();
        times.push(end - start);
    }
    return {
        result: result,
        averageTime: times.reduce((a, b) => a + b, 0) / times.length,
        minTime: Math.min(...times),
        maxTime: Math.max(...times),
        totalTime: times.reduce((a, b) => a + b, 0)
    };
}
// Memory usage monitoring
function getMemoryUsage() {
    return process.memoryUsage();
}
function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(2)} ${units[unitIndex]}`;
}
// Test environment setup
class TestEnvironment {
    constructor() {
        this.services = new Map();
        this.redis = new RedisMock();
        this.blockchain = new BlockchainMock();
    }
    static async create() {
        const env = new TestEnvironment();
        await env.initialize();
        return env;
    }
    async initialize() {
        // Setup mock data
        await this.setupMockData();
    }
    async setupMockData() {
        // Setup initial price data
        await this.redis.set('price:WETH/USDC:uniswap', JSON.stringify({
            price: 1800,
            timestamp: Date.now(),
            volume: 1000000
        }));
        await this.redis.set('price:WETH/USDC:sushiswap', JSON.stringify({
            price: 1795,
            timestamp: Date.now(),
            volume: 500000
        }));
        // Setup mock blockchain logs
        this.blockchain.addLog({
            address: '0x1234567890123456789012345678901234567890',
            topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
            data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
            blockNumber: 18500000,
            transactionHash: generateRandomHash()
        });
    }
    async startService(serviceName, serviceClass, config) {
        const service = new serviceClass(config);
        await service.start();
        this.services.set(serviceName, service);
        return service;
    }
    async stopService(serviceName) {
        const service = this.services.get(serviceName);
        if (service && service.stop) {
            await service.stop();
        }
        this.services.delete(serviceName);
    }
    async setupArbitrageOpportunity() {
        // Setup price difference that creates arbitrage opportunity
        await this.redis.set('price:WETH/USDC:uniswap', JSON.stringify({
            price: 1800,
            timestamp: Date.now(),
            volume: 1000000
        }));
        await this.redis.set('price:WETH/USDC:sushiswap', JSON.stringify({
            price: 1790, // 10 USD difference
            timestamp: Date.now(),
            volume: 500000
        }));
    }
    async waitForOpportunity(timeout = 5000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timeout waiting for opportunity'));
            }, timeout);
            // Listen for arbitrage opportunity
            this.redis.subscribe('arbitrage-opportunity', (message) => {
                clearTimeout(timer);
                resolve(JSON.parse(message));
            });
        });
    }
    async executeArbitrage(opportunity) {
        // Mock arbitrage execution
        return {
            success: Math.random() > 0.1, // 90% success rate
            profit: opportunity.netProfit * (Math.random() * 0.2 + 0.9), // 90-110% of expected
            gasUsed: Math.floor(Math.random() * 200000 + 100000),
            executionTime: Math.floor(Math.random() * 5000 + 2000)
        };
    }
    getRedis() {
        return this.redis;
    }
    getBlockchain() {
        return this.blockchain;
    }
    async cleanup() {
        for (const [name, service] of this.services.entries()) {
            await this.stopService(name);
        }
        this.redis.clear();
        this.blockchain.clear();
    }
}
exports.TestEnvironment = TestEnvironment;
//# sourceMappingURL=index.js.map
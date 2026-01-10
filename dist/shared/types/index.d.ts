export interface Chain {
    id: number;
    name: string;
    rpcUrl: string;
    wsUrl?: string;
    blockTime: number;
    nativeToken: string;
}
export interface Dex {
    name: string;
    chain: string;
    factoryAddress: string;
    routerAddress: string;
    fee: number;
}
export interface Token {
    address: string;
    symbol: string;
    decimals: number;
    chainId: number;
}
export interface Pair {
    address: string;
    token0: Token;
    token1: Token;
    dex: Dex;
    reserve0: string;
    reserve1: string;
    blockNumber: number;
    lastUpdate: number;
}
export interface PriceUpdate {
    pairKey: string;
    dex: string;
    chain: string;
    token0: string;
    token1: string;
    price: number;
    reserve0: string;
    reserve1: string;
    blockNumber: number;
    timestamp: number;
    latency: number;
}
export interface ArbitrageOpportunity {
    id: string;
    type: 'cross-dex' | 'triangular' | 'cross-chain' | 'predictive';
    buyDex: string;
    sellDex: string;
    buyChain: string;
    sellChain?: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    expectedProfit: number;
    profitPercentage: number;
    gasEstimate: number;
    confidence: number;
    timestamp: number;
    blockNumber: number;
    path?: string[];
    bridgeRequired?: boolean;
    bridgeCost?: number;
}
export interface SwapEvent {
    pairAddress: string;
    sender: string;
    recipient: string;
    amount0In: string;
    amount1In: string;
    amount0Out: string;
    amount1Out: string;
    to: string;
    blockNumber: number;
    transactionHash: string;
    timestamp: number;
    dex: string;
    chain: string;
    usdValue?: number;
}
export interface WhaleTransaction {
    transactionHash: string;
    address: string;
    token: string;
    amount: number;
    usdValue: number;
    direction: 'buy' | 'sell';
    dex: string;
    chain: string;
    timestamp: number;
    impact: number;
}
export interface MessageEvent {
    type: string;
    data: any;
    timestamp: number;
    source: string;
    correlationId?: string;
}
export interface ServiceHealth {
    service: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memoryUsage: number;
    cpuUsage: number;
    lastHeartbeat: number;
    error?: string;
}
export interface PerformanceMetrics {
    eventLatency: number;
    detectionLatency: number;
    cacheHitRate: number;
    opportunitiesDetected: number;
    opportunitiesExecuted: number;
    successRate: number;
    timestamp: number;
}
export interface PredictionResult {
    type: 'price' | 'pattern' | 'orderbook' | 'crosschain';
    direction: number;
    confidence: number;
    magnitude?: number;
    timeHorizon: number;
    timestamp: number;
}
export interface MLModelMetrics {
    modelName: string;
    accuracy: number;
    precision: number;
    recall: number;
    f1Score: number;
    trainingTime: number;
    lastRetrained: number;
}
export interface ServiceConfig {
    name: string;
    version: string;
    environment: 'development' | 'staging' | 'production';
    chains: Chain[];
    dexes: Dex[];
    tokens: Token[];
    redis: {
        url: string;
        password?: string;
    };
    monitoring: {
        enabled: boolean;
        interval: number;
        endpoints: string[];
    };
}
export interface DetectorConfig extends ServiceConfig {
    batchSize: number;
    batchTimeout: number;
    eventFilters: {
        minUsdValue: number;
        samplingRate: number;
    };
    cache: {
        ttl: number;
        maxSize: number;
    };
}
export interface ExecutionConfig extends ServiceConfig {
    wallet: {
        encryptedKey: string;
        address: string;
    };
    gas: {
        maxGasPrice: number;
        priorityFee: number;
    };
    mev: {
        enabled: boolean;
        flashbotsUrl?: string;
    };
}
export declare class ArbitrageError extends Error {
    code: string;
    service: string;
    retryable: boolean;
    constructor(message: string, code: string, service: string, retryable?: boolean);
}
export declare class NetworkError extends ArbitrageError {
    constructor(message: string, service: string);
}
export declare class ValidationError extends ArbitrageError {
    field: string;
    constructor(message: string, service: string, field: string);
}
//# sourceMappingURL=index.d.ts.map
export declare class RedisMock {
    private data;
    private pubSubChannels;
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    setex(key: string, ttl: number, value: any): Promise<void>;
    del(...keys: string[]): Promise<number>;
    exists(key: string): Promise<boolean>;
    publish(channel: string, message: any): Promise<number>;
    subscribe(channel: string, callback: Function): Promise<void>;
    unsubscribe(channel: string, callback?: Function): Promise<void>;
    keys(pattern: string): Promise<string[]>;
    hset(key: string, field: string, value: any): Promise<number>;
    hget(key: string, field: string): Promise<any>;
    hgetall(key: string): Promise<any>;
    lpush(key: string, value: any): Promise<number>;
    lrange(key: string, start: number, end: number): Promise<any[]>;
    ltrim(key: string, start: number, end: number): Promise<void>;
    llen(key: string): Promise<number>;
    rpop(key: string): Promise<any>;
    expire(key: string, ttl: number): Promise<number>;
    ping(): Promise<boolean>;
    disconnect(): Promise<void>;
    getData(): Map<string, any>;
    clear(): void;
}
export declare class BlockchainMock {
    private blocks;
    private transactions;
    private logs;
    private networkFailure;
    getBlockNumber(): Promise<number>;
    getBlock(blockNumber: number): Promise<any>;
    getTransaction(hash: string): Promise<any>;
    getLogs(filter: any): Promise<any[]>;
    addBlock(block: any): void;
    addTransaction(tx: any): void;
    addLog(log: any): void;
    setNetworkFailure(failure: boolean): void;
    clear(): void;
}
export declare class WebSocketMock {
    private listeners;
    private readyState;
    private sentMessages;
    constructor(url?: string);
    addEventListener(event: string, listener: Function): void;
    removeEventListener(event: string, listener: Function): void;
    send(message: any): void;
    close(): void;
    private emit;
    getSentMessages(): any[];
    simulateMessage(message: any): void;
    simulateError(error: any): void;
    getReadyState(): number;
    clear(): void;
}
export declare const mockTokens: {
    WETH: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
        chain: string;
    };
    USDC: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
        chain: string;
    };
    WBNB: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
        chain: string;
    };
    BUSD: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
        chain: string;
    };
};
export declare const mockDexes: {
    uniswap: {
        name: string;
        chain: string;
        factory: string;
        fee: number;
        enabled: boolean;
    };
    pancakeswap: {
        name: string;
        chain: string;
        factory: string;
        fee: number;
        enabled: boolean;
    };
};
export declare const mockPriceUpdate: {
    dex: string;
    chain: string;
    pair: string;
    pairAddress: string;
    token0: string;
    token1: string;
    price0: number;
    price1: number;
    timestamp: number;
    blockNumber: number;
};
export declare const mockArbitrageOpportunity: {
    id: string;
    sourceChain: string;
    targetChain: string;
    sourceDex: string;
    targetDex: string;
    tokenAddress: string;
    amount: number;
    priceDifference: number;
    percentageDifference: number;
    estimatedProfit: number;
    gasCost: number;
    netProfit: number;
    confidence: number;
    timestamp: number;
    expiresAt: number;
};
export declare const mockSwapEvent: {
    dex: string;
    chain: string;
    pair: string;
    pairAddress: string;
    sender: string;
    to: string;
    amount0In: number;
    amount1In: number;
    amount0Out: number;
    amount1Out: number;
    timestamp: number;
    blockNumber: number;
};
export declare function createMockPriceUpdate(overrides?: Partial<typeof mockPriceUpdate>): any;
export declare function createMockArbitrageOpportunity(overrides?: Partial<typeof mockArbitrageOpportunity>): any;
export declare function createMockSwapEvent(overrides?: Partial<typeof mockSwapEvent>): any;
export declare function delay(ms: number): Promise<void>;
export declare function generateRandomAddress(): string;
export declare function generateRandomHash(): string;
export declare function measurePerformance<T>(operation: () => Promise<T>, iterations?: number): Promise<{
    result: T;
    averageTime: number;
    minTime: number;
    maxTime: number;
    totalTime: number;
}>;
export declare function getMemoryUsage(): NodeJS.MemoryUsage;
export declare function formatBytes(bytes: number): string;
export declare class TestEnvironment {
    private redis;
    private blockchain;
    private services;
    constructor();
    static create(): Promise<TestEnvironment>;
    private initialize;
    private setupMockData;
    startService(serviceName: string, serviceClass: any, config?: any): Promise<any>;
    stopService(serviceName: string): Promise<void>;
    setupArbitrageOpportunity(): Promise<void>;
    waitForOpportunity(timeout?: number): Promise<any>;
    executeArbitrage(opportunity: any): Promise<any>;
    getRedis(): RedisMock;
    getBlockchain(): BlockchainMock;
    cleanup(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map
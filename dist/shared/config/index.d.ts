import { Chain, Dex, Token } from '../types';
export declare const CHAINS: Record<string, Chain>;
export declare const DEXES: Record<string, Dex[]>;
export declare const CORE_TOKENS: Record<string, Token[]>;
export declare const SERVICE_CONFIGS: {
    redis: {
        url: string;
        password: string | undefined;
    };
    monitoring: {
        enabled: boolean;
        interval: number;
        endpoints: string[];
    };
};
export declare const PERFORMANCE_THRESHOLDS: {
    maxEventLatency: number;
    minCacheHitRate: number;
    maxMemoryUsage: number;
    maxCpuUsage: number;
    maxFalsePositiveRate: number;
};
export declare const ARBITRAGE_CONFIG: {
    minProfitPercentage: number;
    maxGasPrice: number;
    confidenceThreshold: number;
    maxTradeSize: string;
    triangularEnabled: boolean;
    crossChainEnabled: boolean;
    predictiveEnabled: boolean;
};
export declare const EVENT_CONFIG: {
    syncEvents: {
        enabled: boolean;
        priority: string;
    };
    swapEvents: {
        enabled: boolean;
        priority: string;
        minAmountUSD: number;
        samplingRate: number;
    };
};
//# sourceMappingURL=index.d.ts.map
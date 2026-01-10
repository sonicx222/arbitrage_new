import { ethers } from 'ethers';
import WebSocket from 'ws';
import { PerformanceLogger } from './index';
import { Dex, Token, PriceUpdate, ArbitrageOpportunity, SwapEvent, Pair } from '../../types/src';
export interface DetectorConfig {
    chain: string;
    enabled: boolean;
    wsUrl?: string;
    rpcUrl?: string;
    batchSize?: number;
    batchTimeout?: number;
    healthCheckInterval?: number;
}
export declare abstract class BaseDetector {
    protected provider: ethers.JsonRpcProvider;
    protected wsProvider: WebSocket | null;
    protected redis: Promise<import("./redis").RedisClient>;
    protected logger: any;
    protected perfLogger: PerformanceLogger;
    protected dexes: Dex[];
    protected tokens: Token[];
    protected pairs: Map<string, Pair>;
    protected monitoredPairs: Set<string>;
    protected isRunning: boolean;
    protected config: DetectorConfig;
    protected chain: string;
    constructor(config: DetectorConfig);
    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    abstract connectWebSocket(): Promise<void>;
    abstract subscribeToEvents(): Promise<void>;
    abstract getHealth(): Promise<any>;
    protected initializePairs(): Promise<void>;
    protected getPairAddress(dex: Dex, token0: Token, token1: Token): Promise<string | null>;
    protected publishPriceUpdate(update: PriceUpdate): Promise<void>;
    protected publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void>;
    protected publishSwapEvent(swapEvent: SwapEvent): Promise<void>;
    protected calculateArbitrageOpportunity(sourceUpdate: PriceUpdate, targetUpdate: PriceUpdate): ArbitrageOpportunity | null;
    protected validateOpportunity(opportunity: ArbitrageOpportunity): boolean;
    protected getStats(): any;
    protected sleep(ms: number): Promise<void>;
    protected formatError(error: any): string;
    protected isValidAddress(address: string): boolean;
    protected normalizeAddress(address: string): string;
}
//# sourceMappingURL=base-detector.d.ts.map
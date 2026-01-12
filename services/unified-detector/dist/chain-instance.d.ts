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
import { EventEmitter } from 'events';
import { PerformanceLogger, RedisStreamsClient } from '../../../shared/core/src';
import { ChainStats } from './unified-detector';
export interface ChainInstanceConfig {
    chainId: string;
    partitionId: string;
    streamsClient: RedisStreamsClient;
    perfLogger: PerformanceLogger;
    wsUrl?: string;
    rpcUrl?: string;
}
export declare class ChainDetectorInstance extends EventEmitter {
    private logger;
    private perfLogger;
    private streamsClient;
    private chainId;
    private partitionId;
    private chainConfig;
    private detectorConfig;
    private provider;
    private wsManager;
    private dexes;
    private tokens;
    private tokenMetadata;
    private pairs;
    private pairsByAddress;
    private status;
    private eventsProcessed;
    private opportunitiesFound;
    private lastBlockNumber;
    private lastBlockTimestamp;
    private blockLatencies;
    private isRunning;
    private reconnectAttempts;
    private readonly MAX_RECONNECT_ATTEMPTS;
    constructor(config: ChainInstanceConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private initializeWebSocket;
    private handleConnectionError;
    private initializePairs;
    private generatePairAddress;
    private subscribeToEvents;
    private handleWebSocketMessage;
    private handleSyncEvent;
    private handleSwapEvent;
    private handleNewBlock;
    private emitPriceUpdate;
    private publishPriceUpdate;
    private checkArbitrageOpportunity;
    private isSameTokenPair;
    private calculateArbitrage;
    private emitOpportunity;
    private getPairKey;
    private getTokenSymbol;
    isConnected(): boolean;
    getChainId(): string;
    getStatus(): string;
    getStats(): ChainStats;
}
//# sourceMappingURL=chain-instance.d.ts.map
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
import { PerformanceLogger, RedisStreamsClient } from '@arbitrage/core';
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
    private isStopping;
    private reconnectAttempts;
    private readonly MAX_RECONNECT_ATTEMPTS;
    private startPromise;
    private stopPromise;
    constructor(config: ChainInstanceConfig);
    start(): Promise<void>;
    /**
     * P0-NEW-3 FIX: Internal start implementation separated for promise tracking
     */
    private performStart;
    stop(): Promise<void>;
    /**
     * P0-NEW-4 FIX: Internal stop implementation separated for promise tracking
     */
    private performStop;
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
    /**
     * Create a deep snapshot of a single pair for thread-safe arbitrage detection.
     * Captures all mutable values at a point in time.
     */
    private createPairSnapshot;
    /**
     * Create deep snapshots of all pairs for thread-safe iteration.
     * This prevents race conditions where concurrent Sync events could
     * modify pair reserves while we're iterating for arbitrage detection.
     */
    private createPairsSnapshot;
    private checkArbitrageOpportunity;
    /**
     * Check if two pairs represent the same token pair (in either order).
     * Returns { sameOrder: boolean, reverseOrder: boolean }
     */
    private isSameTokenPair;
    /**
     * Check if token order is reversed between two pairs.
     */
    private isReverseOrder;
    /**
     * Get minimum profit threshold for this chain from config.
     * Uses ARBITRAGE_CONFIG.chainMinProfits for consistency with base-detector.ts.
     */
    private getMinProfitThreshold;
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
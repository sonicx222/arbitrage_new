import { ethers } from 'ethers';
import { RedisClient, PerformanceLogger, BatchedEvent, WebSocketManager, WebSocketMessage, RedisStreamsClient, StreamBatcher, SwapEventFilter, WhaleAlert, VolumeAggregate, ServiceStateManager, PairDiscoveryService, PairCacheService } from './index';
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
/**
 * Extended pair interface with reserve data
 */
export interface ExtendedPair extends Pair {
    reserve0: string;
    reserve1: string;
    blockNumber: number;
    lastUpdate: number;
}
/**
 * Snapshot of pair data for thread-safe arbitrage detection.
 * Captures reserve values at a point in time to avoid race conditions
 * when reserves are updated by concurrent processSyncEvent calls.
 */
export interface PairSnapshot {
    address: string;
    dex: string;
    token0: string;
    token1: string;
    reserve0: string;
    reserve1: string;
    fee: number;
}
export declare abstract class BaseDetector {
    protected provider: ethers.JsonRpcProvider;
    protected wsManager: WebSocketManager | null;
    protected redis: RedisClient | null;
    protected streamsClient: RedisStreamsClient | null;
    protected logger: any;
    protected perfLogger: PerformanceLogger;
    protected eventBatcher: any;
    protected priceUpdateBatcher: StreamBatcher<any> | null;
    protected swapEventBatcher: StreamBatcher<any> | null;
    protected whaleAlertBatcher: StreamBatcher<any> | null;
    protected swapEventFilter: SwapEventFilter | null;
    protected pairDiscoveryService: PairDiscoveryService | null;
    protected pairCacheService: PairCacheService | null;
    protected dexes: Dex[];
    protected tokens: Token[];
    protected pairs: Map<string, Pair>;
    protected monitoredPairs: Set<string>;
    protected isRunning: boolean;
    protected pairsByAddress: Map<string, Pair>;
    protected stopPromise: Promise<void> | null;
    protected stateManager: ServiceStateManager;
    protected healthMonitoringInterval: NodeJS.Timeout | null;
    protected isStopping: boolean;
    protected config: DetectorConfig;
    protected chain: string;
    protected tokenMetadata: any;
    constructor(config: DetectorConfig);
    protected initializeRedis(): Promise<void>;
    /**
     * S2.2.5: Initialize pair discovery and caching services.
     * Sets up the provider for factory contract queries and initializes cache.
     */
    protected initializePairServices(): Promise<void>;
    /**
     * Start the detector service.
     * Uses ServiceStateManager to prevent race conditions.
     * Override onStart() for chain-specific initialization.
     */
    start(): Promise<void>;
    /**
     * Stop the detector service.
     * Uses ServiceStateManager to prevent race conditions.
     * Override onStop() for chain-specific cleanup.
     */
    stop(): Promise<void>;
    /**
     * Internal cleanup method called by stop()
     * Note: State cleanup (isStopping, stopPromise) is handled in stop()
     */
    private performCleanup;
    /**
     * Hook for chain-specific initialization.
     * Override in subclass for custom setup.
     */
    protected onStart(): Promise<void>;
    /**
     * Hook for chain-specific cleanup.
     * Override in subclass for custom cleanup.
     */
    protected onStop(): Promise<void>;
    /**
     * Get service health status.
     * Override in subclass for chain-specific health info.
     */
    getHealth(): Promise<any>;
    /**
     * Start health monitoring interval
     */
    protected startHealthMonitoring(): void;
    /**
     * Get minimum profit threshold for this chain.
     * Override in subclass for chain-specific thresholds.
     */
    getMinProfitThreshold(): number;
    /**
     * Get chain-specific detector config.
     * Override in subclass if needed.
     */
    protected getChainDetectorConfig(): any;
    /**
     * Process Sync event (reserve update).
     * Default implementation - can be overridden for chain-specific behavior.
     */
    protected processSyncEvent(log: any, pair: Pair): Promise<void>;
    /**
     * Process Swap event (trade).
     * Default implementation - can be overridden for chain-specific behavior.
     */
    protected processSwapEvent(log: any, pair: Pair): Promise<void>;
    /**
     * Check for intra-DEX arbitrage opportunities.
     * Default implementation using pair snapshots for thread safety.
     */
    protected checkIntraDexArbitrage(pair: Pair): Promise<void>;
    /**
     * Check for whale activity.
     * Default implementation using chain config thresholds.
     */
    protected checkWhaleActivity(swapEvent: SwapEvent): Promise<void>;
    /**
     * Estimate USD value of a swap.
     * Default implementation - should be overridden for chain-specific tokens.
     */
    protected estimateUsdValue(pair: Pair, amount0In: string, amount1In: string, amount0Out: string, amount1Out: string): Promise<number>;
    /**
     * Calculate price impact of a swap.
     * Default implementation using reserve ratios.
     */
    protected calculatePriceImpact(swapEvent: SwapEvent): Promise<number>;
    protected initializePairs(): Promise<void>;
    /**
     * S2.2.5: Get pair address using cache-first strategy.
     * 1. Check Redis cache for existing pair address
     * 2. On miss, query factory contract via PairDiscoveryService
     * 3. Cache the result for future lookups
     * 4. Fall back to CREATE2 computation if factory query fails
     */
    protected getPairAddress(dex: Dex, token0: Token, token1: Token): Promise<string | null>;
    protected calculateArbitrageOpportunity(sourceUpdate: PriceUpdate, targetUpdate: PriceUpdate): ArbitrageOpportunity | null;
    protected validateOpportunity(opportunity: ArbitrageOpportunity): boolean;
    protected connectWebSocket(): Promise<void>;
    protected subscribeToEvents(): Promise<void>;
    protected handleWebSocketMessage(message: WebSocketMessage): void;
    /**
     * Process a log event (public for testing).
     * Uses O(1) lookup via pairsByAddress map.
     */
    processLogEvent(log: any): Promise<void>;
    protected processBatchedEvents(batch: BatchedEvent): Promise<void>;
    protected calculatePrice(pair: Pair): number;
    /**
     * Create a snapshot of pair data for thread-safe arbitrage detection.
     * This captures reserve values at a point in time to avoid race conditions.
     * @param pair The pair to snapshot
     * @returns PairSnapshot with immutable reserve values, or null if reserves not available
     */
    protected createPairSnapshot(pair: Pair): PairSnapshot | null;
    /**
     * Calculate price from a snapshot (thread-safe).
     * Uses pre-captured reserve values that won't change during calculation.
     */
    protected calculatePriceFromSnapshot(snapshot: PairSnapshot): number;
    /**
     * Create snapshots of all pairs for thread-safe iteration.
     * Should be called at the start of arbitrage detection to capture
     * a consistent view of all pair reserves.
     */
    protected createPairsSnapshot(): Map<string, PairSnapshot>;
    protected publishPriceUpdate(update: PriceUpdate): Promise<void>;
    protected publishSwapEvent(swapEvent: SwapEvent): Promise<void>;
    protected publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void>;
    protected publishWhaleTransaction(whaleTransaction: any): Promise<void>;
    protected publishWhaleAlert(alert: WhaleAlert): Promise<void>;
    protected publishVolumeAggregate(aggregate: VolumeAggregate): Promise<void>;
    protected cleanupStreamBatchers(): Promise<void>;
    protected getBatcherStats(): Record<string, any>;
    protected getStats(): any;
    /**
     * Publish with retry and exponential backoff (P0-6 fix).
     * Prevents silent failures for critical alerts like whale transactions.
     */
    protected publishWithRetry(publishFn: () => Promise<void>, operationName: string, maxRetries?: number): Promise<void>;
    protected sleep(ms: number): Promise<void>;
    protected formatError(error: any): string;
    protected isValidAddress(address: string): boolean;
    protected normalizeAddress(address: string): string;
}
//# sourceMappingURL=base-detector.d.ts.map
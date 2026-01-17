import { ethers } from 'ethers';
import { RedisClient, PerformanceLogger, // P2-FIX: Import Logger type
EventBatcher, BatchedEvent, WebSocketManager, WebSocketMessage, RedisStreamsClient, StreamBatcher, SwapEventFilter, WhaleAlert, VolumeAggregate, ServiceStateManager, PairDiscoveryService, PairCacheService } from './index';
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
/**
 * Logger interface for BaseDetector DI.
 */
export interface BaseDetectorLogger {
    info: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/**
 * Dependencies that can be injected into BaseDetector.
 * This enables proper testing without Jest mock hoisting issues.
 */
export interface BaseDetectorDeps {
    /** Logger instance - if provided, used instead of createLogger() */
    logger?: BaseDetectorLogger;
    /** Performance logger instance - if provided, used instead of getPerformanceLogger() */
    perfLogger?: PerformanceLogger;
}
export declare abstract class BaseDetector {
    protected provider: ethers.JsonRpcProvider;
    protected wsManager: WebSocketManager | null;
    protected redis: RedisClient | null;
    protected streamsClient: RedisStreamsClient | null;
    protected logger: BaseDetectorLogger;
    protected perfLogger: PerformanceLogger;
    protected eventBatcher: EventBatcher | null;
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
    /**
     * T1.1: Token Pair Index for O(1) arbitrage detection.
     * Maps normalized token pair key to array of pairs with those tokens.
     * Key format: "tokenA_tokenB" where tokenA < tokenB (alphabetically sorted, lowercase)
     * This enables O(1) lookup instead of O(n) scan when checking for arbitrage.
     */
    protected pairsByTokens: Map<string, Pair[]>;
    protected stopPromise: Promise<void> | null;
    protected stateManager: ServiceStateManager;
    protected healthMonitoringInterval: NodeJS.Timeout | null;
    protected isStopping: boolean;
    protected config: DetectorConfig;
    protected chain: string;
    protected tokenMetadata: any;
    constructor(config: DetectorConfig, deps?: BaseDetectorDeps);
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
     * P1-FIX: Self-clears interval when stopping to prevent memory leak
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
     *
     * P0-1 FIX (2026-01-16): True atomic updates via immutable replacement.
     * Object.assign is NOT atomic in JavaScript - it iterates properties sequentially.
     * A concurrent reader could observe partial updates (new reserve0, old reserve1).
     * Fix: Create new immutable pair object and atomically swap references in maps.
     */
    protected processSyncEvent(log: any, pair: Pair): Promise<void>;
    /**
     * Process Swap event (trade).
     * Default implementation - can be overridden for chain-specific behavior.
     */
    protected processSwapEvent(log: any, pair: Pair): Promise<void>;
    /**
     * Check for intra-DEX arbitrage opportunities.
     * T1.1 OPTIMIZED: Uses token pair index for O(1) lookup instead of O(n) iteration.
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
    /**
     * T1.1: Generate normalized token pair key for O(1) index lookup.
     * Tokens are sorted alphabetically (lowercase) to ensure consistent key
     * regardless of token order in the pair.
     * @param token0 First token address
     * @param token1 Second token address
     * @returns Normalized key "tokenA_tokenB" where tokenA < tokenB
     */
    protected getTokenPairKey(token0: string, token1: string): string;
    /**
     * T1.1: Add a pair to the token pair index.
     * Called during pair initialization to build the index.
     */
    protected addPairToTokenIndex(pair: Pair): void;
    /**
     * T1.1: Remove a pair from the token pair index.
     */
    protected removePairFromTokenIndex(pair: Pair): void;
    /**
     * T1.1: Get all pairs for a given token combination.
     * Returns pairs on different DEXs that trade the same tokens.
     * @param token0 First token address
     * @param token1 Second token address
     * @returns Array of pairs trading these tokens (may be empty)
     */
    protected getPairsForTokens(token0: string, token1: string): Pair[];
    /**
     * P0-1 FIX: Update a pair reference in the token index atomically.
     * Replaces the old pair reference with the new one in-place.
     * @param oldPair The old pair reference to replace
     * @param newPair The new pair reference
     */
    protected updatePairInTokenIndex(oldPair: Pair, newPair: Pair): void;
    /**
     * P0-1 FIX: Find the key for a pair in the pairs map.
     * @param pair The pair to find
     * @returns The key if found, null otherwise
     */
    protected findPairKey(pair: Pair): string | null;
}
//# sourceMappingURL=base-detector.d.ts.map
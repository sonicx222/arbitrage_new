/**
 * Smart Swap Event Filter
 *
 * Implements S1.2 from IMPLEMENTATION_PLAN.md
 * Hypothesis: 99% event reduction with 100% signal retention through smart filtering
 *
 * Features:
 * - Edge filter: Filter out dust/zero amount swaps
 * - Value filter: Filter based on minimum USD value
 * - Dedup filter: Deduplicate swaps by transaction hash + pair
 * - Whale detection: Alert for swaps above $50K threshold
 * - Volume aggregation: 5-second window aggregation per pair
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */
import { SwapEvent } from '../../types';
export interface SwapEventFilterConfig {
    minUsdValue: number;
    whaleThreshold: number;
    dedupWindowMs: number;
    aggregationWindowMs: number;
    maxDedupCacheSize: number;
    cleanupIntervalMs: number;
}
export interface FilterResult {
    passed: boolean;
    event: SwapEvent;
    filterReason?: FilterReason;
    isWhale: boolean;
    processingTimeMs: number;
}
export type FilterReason = 'zero_amount' | 'below_min_value' | 'duplicate' | 'invalid_event' | 'invalid_value';
export interface VolumeAggregate {
    pairAddress: string;
    chain: string;
    dex: string;
    swapCount: number;
    totalUsdVolume: number;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
    windowStartMs: number;
    windowEndMs: number;
}
export interface WhaleAlert {
    event: SwapEvent;
    usdValue: number;
    timestamp: number;
    chain: string;
    dex: string;
    pairAddress: string;
}
export interface FilterStats {
    totalProcessed: number;
    totalPassed: number;
    totalFiltered: number;
    whaleAlerts: number;
    filterRate: number;
    filterReasons: Record<FilterReason, number>;
    avgProcessingTimeMs: number;
    volumeAggregatesEmitted: number;
}
export interface BatchResult {
    passed: FilterResult[];
    filtered: FilterResult[];
    whaleAlerts: WhaleAlert[];
}
type WhaleAlertHandler = (alert: WhaleAlert) => void;
type VolumeAggregateHandler = (aggregate: VolumeAggregate) => void;
export declare class SwapEventFilter {
    private config;
    private dedupCache;
    private aggregationBuckets;
    private aggregationTimer;
    private cleanupTimer;
    private destroyed;
    private stats;
    private totalProcessingTimeMs;
    private whaleAlertHandlers;
    private volumeAggregateHandlers;
    constructor(config?: Partial<SwapEventFilterConfig>);
    getConfig(): SwapEventFilterConfig;
    updateConfig(updates: Partial<SwapEventFilterConfig>): void;
    private validateConfigValues;
    processEvent(event: SwapEvent): FilterResult;
    processBatch(events: SwapEvent[]): BatchResult;
    private isValidEvent;
    private isZeroAmount;
    private getDedupKey;
    private isDuplicate;
    private estimateUsdValue;
    private createFilteredResult;
    private emitWhaleAlert;
    onWhaleAlert(handler: WhaleAlertHandler): () => void;
    private addToAggregationBucket;
    private calculateEffectivePrice;
    private startAggregationTimer;
    private restartAggregationTimer;
    private flushAggregationBuckets;
    onVolumeAggregate(handler: VolumeAggregateHandler): () => void;
    getAggregationBucketCount(): number;
    private startCleanupTimer;
    private restartCleanupTimer;
    private cleanupDedupCache;
    private enforceCacheSizeLimit;
    getDedupCacheSize(): number;
    private updateFilterRate;
    private updateAvgProcessingTime;
    getStats(): FilterStats;
    resetStats(): void;
    getPrometheusMetrics(): string;
    destroy(): void;
}
export declare function getSwapEventFilter(config?: Partial<SwapEventFilterConfig>): SwapEventFilter;
export declare function resetSwapEventFilter(): void;
export {};
//# sourceMappingURL=swap-event-filter.d.ts.map
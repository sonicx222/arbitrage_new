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

import type { SwapEvent } from '@arbitrage/types';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';

const logger = createLogger('swap-event-filter');

// =============================================================================
// Types
// =============================================================================

export interface SwapEventFilterConfig {
  minUsdValue: number;           // Minimum USD value to pass filter (default: 10)
  whaleThreshold: number;        // USD value to trigger whale alert (default: 50000)
  dedupWindowMs: number;         // Deduplication window in ms (default: 5000)
  aggregationWindowMs: number;   // Volume aggregation window in ms (default: 5000)
  maxDedupCacheSize: number;     // Maximum dedup cache entries (default: 10000)
  cleanupIntervalMs: number;     // Cleanup interval in ms (default: 30000)
}

export interface FilterResult {
  passed: boolean;
  event: SwapEvent;
  filterReason?: FilterReason;
  isWhale: boolean;
  processingTimeMs: number;
}

export type FilterReason =
  | 'zero_amount'
  | 'below_min_value'
  | 'duplicate'
  | 'invalid_event'
  | 'invalid_value';

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

// =============================================================================
// Volume Aggregation Bucket
// =============================================================================

interface AggregationBucket {
  pairAddress: string;
  chain: string;
  dex: string;
  swapCount: number;
  totalUsdVolume: number;
  prices: number[];
  windowStartMs: number;
}

// =============================================================================
// Swap Event Filter
// =============================================================================

export class SwapEventFilter {
  private config: SwapEventFilterConfig;
  private dedupCache: Map<string, number> = new Map(); // key -> timestamp
  private aggregationBuckets: Map<string, AggregationBucket> = new Map(); // pairAddress -> bucket
  private aggregationTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private destroyed = false; // Guard against use after destroy

  // Statistics
  private stats: FilterStats = {
    totalProcessed: 0,
    totalPassed: 0,
    totalFiltered: 0,
    whaleAlerts: 0,
    filterRate: 0,
    filterReasons: {
      zero_amount: 0,
      below_min_value: 0,
      duplicate: 0,
      invalid_event: 0,
      invalid_value: 0
    },
    avgProcessingTimeMs: 0,
    volumeAggregatesEmitted: 0
  };
  private totalProcessingTimeMs = 0;

  // Event handlers
  private whaleAlertHandlers: WhaleAlertHandler[] = [];
  private volumeAggregateHandlers: VolumeAggregateHandler[] = [];

  constructor(config: Partial<SwapEventFilterConfig> = {}) {
    // Validate provided config values
    this.validateConfigValues(config);

    this.config = {
      minUsdValue: config.minUsdValue ?? 10,
      whaleThreshold: config.whaleThreshold ?? 50000,
      dedupWindowMs: config.dedupWindowMs ?? 5000,
      aggregationWindowMs: config.aggregationWindowMs ?? 5000,
      maxDedupCacheSize: config.maxDedupCacheSize ?? 10000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 30000
    };

    this.startAggregationTimer();
    this.startCleanupTimer();

    logger.info('SwapEventFilter initialized', { config: this.config });
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getConfig(): SwapEventFilterConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SwapEventFilterConfig>): void {
    // Validate config updates
    this.validateConfigValues(updates);

    const oldConfig = this.config;
    this.config = { ...this.config, ...updates };

    // Restart timers if their intervals changed
    if (updates.aggregationWindowMs !== undefined &&
        updates.aggregationWindowMs !== oldConfig.aggregationWindowMs) {
      this.restartAggregationTimer();
    }

    if (updates.cleanupIntervalMs !== undefined &&
        updates.cleanupIntervalMs !== oldConfig.cleanupIntervalMs) {
      this.restartCleanupTimer();
    }

    logger.info('SwapEventFilter config updated', { config: this.config });
  }

  private validateConfigValues(config: Partial<SwapEventFilterConfig>): void {
    if (config.minUsdValue !== undefined && config.minUsdValue < 0) {
      throw new Error('minUsdValue must be non-negative');
    }
    if (config.whaleThreshold !== undefined && config.whaleThreshold <= 0) {
      throw new Error('whaleThreshold must be positive');
    }
    if (config.dedupWindowMs !== undefined && config.dedupWindowMs <= 0) {
      throw new Error('dedupWindowMs must be positive');
    }
    if (config.aggregationWindowMs !== undefined && config.aggregationWindowMs <= 0) {
      throw new Error('aggregationWindowMs must be positive');
    }
    if (config.maxDedupCacheSize !== undefined && config.maxDedupCacheSize <= 0) {
      throw new Error('maxDedupCacheSize must be positive');
    }
    if (config.cleanupIntervalMs !== undefined && config.cleanupIntervalMs <= 0) {
      throw new Error('cleanupIntervalMs must be positive');
    }
  }

  // ===========================================================================
  // Event Processing
  // ===========================================================================

  processEvent(event: SwapEvent): FilterResult {
    const startTime = performance.now();

    // Guard against use after destroy
    if (this.destroyed) {
      logger.warn('processEvent called on destroyed filter');
      return {
        passed: false,
        event,
        filterReason: 'invalid_event',
        isWhale: false,
        processingTimeMs: 0
      };
    }

    try {
      this.stats.totalProcessed++;

      // Validate event structure
      if (!this.isValidEvent(event)) {
        return this.createFilteredResult(event, 'invalid_event', startTime);
      }

      // Get USD value (use provided or estimate)
      const usdValue = event.usdValue ?? this.estimateUsdValue(event);

      // Check for invalid values
      if (usdValue < 0) {
        return this.createFilteredResult(event, 'invalid_value', startTime);
      }

      // Edge filter: zero amounts
      if (this.isZeroAmount(event)) {
        return this.createFilteredResult(event, 'zero_amount', startTime);
      }

      // Value filter: below minimum
      if (usdValue < this.config.minUsdValue) {
        return this.createFilteredResult(event, 'below_min_value', startTime);
      }

      // Dedup filter
      const dedupKey = this.getDedupKey(event);
      if (this.isDuplicate(dedupKey)) {
        return this.createFilteredResult(event, 'duplicate', startTime);
      }

      // Mark as seen for dedup
      this.dedupCache.set(dedupKey, Date.now());

      // Enforce max cache size inline to prevent unbounded growth
      if (this.dedupCache.size > this.config.maxDedupCacheSize) {
        this.enforceCacheSizeLimit();
      }

      // Check for whale
      const isWhale = usdValue >= this.config.whaleThreshold;
      if (isWhale) {
        this.emitWhaleAlert(event, usdValue);
      }

      // Add to aggregation bucket
      this.addToAggregationBucket(event, usdValue);

      // Update stats
      this.stats.totalPassed++;
      this.updateFilterRate();

      const processingTimeMs = performance.now() - startTime;
      this.updateAvgProcessingTime(processingTimeMs);

      return {
        passed: true,
        event,
        isWhale,
        processingTimeMs
      };
    } catch (error) {
      logger.error('Error processing swap event', { error });
      return this.createFilteredResult(event, 'invalid_event', startTime);
    }
  }

  processBatch(events: SwapEvent[]): BatchResult {
    const passed: FilterResult[] = [];
    const filtered: FilterResult[] = [];
    const whaleAlerts: WhaleAlert[] = [];

    for (const event of events) {
      const result = this.processEvent(event);

      if (result.passed) {
        passed.push(result);

        if (result.isWhale) {
          const usdValue = event.usdValue ?? this.estimateUsdValue(event);
          whaleAlerts.push({
            event,
            usdValue,
            timestamp: Date.now(),
            chain: event.chain,
            dex: event.dex,
            pairAddress: event.pairAddress
          });
        }
      } else {
        filtered.push(result);
      }
    }

    return { passed, filtered, whaleAlerts };
  }

  // ===========================================================================
  // Filters
  // ===========================================================================

  private isValidEvent(event: SwapEvent): boolean {
    return !!(
      event &&
      event.pairAddress &&
      event.transactionHash &&
      typeof event.blockNumber === 'number'
    );
  }

  private isZeroAmount(event: SwapEvent): boolean {
    try {
      const amount0In = BigInt(event.amount0In || '0');
      const amount1In = BigInt(event.amount1In || '0');
      const amount0Out = BigInt(event.amount0Out || '0');
      const amount1Out = BigInt(event.amount1Out || '0');

      return (
        amount0In === 0n &&
        amount1In === 0n &&
        amount0Out === 0n &&
        amount1Out === 0n
      );
    } catch {
      // Invalid BigInt input - treat as zero amount (will be filtered)
      return true;
    }
  }

  private getDedupKey(event: SwapEvent): string {
    return `${event.transactionHash}:${event.pairAddress}`;
  }

  private isDuplicate(dedupKey: string): boolean {
    const lastSeen = this.dedupCache.get(dedupKey);
    if (!lastSeen) {
      return false;
    }

    const age = Date.now() - lastSeen;
    return age < this.config.dedupWindowMs;
  }

  /**
   * Estimate USD value from raw swap amounts.
   *
   * @known-limitation This heuristic assumes one side of the swap is a stablecoin
   * at $1 parity. It infers token decimals from the magnitude of the raw amount
   * string length. This means:
   * - Non-stablecoin pairs (e.g., ETH/WBTC) will have inaccurate USD estimates
   * - The estimate is only suitable for coarse filtering (whale detection, dust filtering)
   *
   * For accurate USD estimation, callers should provide `event.usdValue` from a price
   * oracle or use the PriceOracle module directly.
   */
  private estimateUsdValue(event: SwapEvent): number {
    // Fallback estimation when usdValue is not provided
    // This is a simplified estimation - real implementation would use price oracles
    try {
      const amount0In = this.normalizeTokenAmount(event.amount0In || '0');
      const amount1In = this.normalizeTokenAmount(event.amount1In || '0');
      const amount0Out = this.normalizeTokenAmount(event.amount0Out || '0');
      const amount1Out = this.normalizeTokenAmount(event.amount1Out || '0');

      // Simple heuristic: assume one side is stablecoin at $1
      // This is imprecise but provides a reasonable filter
      const maxAmount = Math.max(amount0In, amount1In, amount0Out, amount1Out);
      return maxAmount > 0 ? maxAmount : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Infer token decimals from the magnitude of a raw amount string and normalize
   * to a human-readable value. Common ERC-20 decimals:
   * - 18 decimals: ETH, WETH, DAI, most tokens (amounts > 1e15 for even $1)
   * - 8 decimals: WBTC (amounts > 1e5 for even $1)
   * - 6 decimals: USDC, USDT (amounts > 1e3 for even $1)
   *
   * Uses the integer digit count of the raw value to pick the most likely decimals.
   * This prevents USDC whale swaps (6 decimals) from being underestimated by 10^12x.
   */
  private normalizeTokenAmount(rawAmount: string): number {
    const value = parseFloat(rawAmount);
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }

    // Count the number of integer digits (order of magnitude)
    const integerDigits = Math.floor(Math.log10(value)) + 1;

    // Heuristic: infer decimals from magnitude of the raw value
    // 18-decimal tokens: a $1 swap is ~1e18, so raw values typically have 19+ digits
    // 8-decimal tokens: a $1 swap is ~1e8, so raw values typically have 9-15 digits
    // 6-decimal tokens: a $1 swap is ~1e6, so raw values typically have 7-8 digits
    // Values with fewer digits are likely already in human-readable form or dust
    let decimals: number;
    if (integerDigits > 15) {
      decimals = 18;
    } else if (integerDigits > 10) {
      decimals = 8;
    } else if (integerDigits > 3) {
      decimals = 6;
    } else {
      // Very small raw value — likely already normalized or dust
      decimals = 0;
    }

    return value / Math.pow(10, decimals);
  }

  private createFilteredResult(
    event: SwapEvent,
    reason: FilterReason,
    startTime: number
  ): FilterResult {
    this.stats.totalFiltered++;
    this.stats.filterReasons[reason]++;
    this.updateFilterRate();

    const processingTimeMs = performance.now() - startTime;
    this.updateAvgProcessingTime(processingTimeMs);

    return {
      passed: false,
      event,
      filterReason: reason,
      isWhale: false,
      processingTimeMs
    };
  }

  // ===========================================================================
  // Whale Detection
  // ===========================================================================

  private emitWhaleAlert(event: SwapEvent, usdValue: number): void {
    this.stats.whaleAlerts++;

    const alert: WhaleAlert = {
      event,
      usdValue,
      timestamp: Date.now(),
      chain: event.chain,
      dex: event.dex,
      pairAddress: event.pairAddress
    };

    logger.info('Whale alert detected', {
      usdValue,
      chain: event.chain,
      dex: event.dex,
      pair: event.pairAddress
    });

    for (const handler of this.whaleAlertHandlers) {
      try {
        handler(alert);
      } catch (error) {
        logger.error('Whale alert handler error', { error });
      }
    }
  }

  onWhaleAlert(handler: WhaleAlertHandler): () => void {
    if (this.destroyed) {
      logger.warn('onWhaleAlert called on destroyed filter');
      return () => {}; // No-op unsubscribe
    }
    this.whaleAlertHandlers.push(handler);
    // Return unsubscribe function
    return () => {
      const index = this.whaleAlertHandlers.indexOf(handler);
      if (index > -1) {
        this.whaleAlertHandlers.splice(index, 1);
      }
    };
  }

  // ===========================================================================
  // Volume Aggregation
  // ===========================================================================

  private addToAggregationBucket(event: SwapEvent, usdValue: number): void {
    const key = event.pairAddress;
    let bucket = this.aggregationBuckets.get(key);

    if (!bucket) {
      bucket = {
        pairAddress: event.pairAddress,
        chain: event.chain,
        dex: event.dex,
        swapCount: 0,
        totalUsdVolume: 0,
        prices: [],
        windowStartMs: Date.now()
      };
      this.aggregationBuckets.set(key, bucket);
    }

    bucket.swapCount++;
    bucket.totalUsdVolume += usdValue;

    // Calculate effective price from swap
    const price = this.calculateEffectivePrice(event);
    if (price > 0) {
      bucket.prices.push(price);
    }
  }

  private calculateEffectivePrice(event: SwapEvent): number {
    try {
      const amount0In = parseFloat(event.amount0In || '0');
      const amount1In = parseFloat(event.amount1In || '0');
      const amount0Out = parseFloat(event.amount0Out || '0');
      const amount1Out = parseFloat(event.amount1Out || '0');

      // Calculate price based on swap direction
      if (amount0In > 0 && amount1Out > 0) {
        return amount1Out / amount0In;
      } else if (amount1In > 0 && amount0Out > 0) {
        return amount0Out / amount1In;
      }

      return 0;
    } catch {
      return 0;
    }
  }

  private startAggregationTimer(): void {
    this.aggregationTimer = setInterval(() => {
      if (!this.destroyed) {
        this.flushAggregationBuckets();
      }
    }, this.config.aggregationWindowMs);
  }

  private restartAggregationTimer(): void {
    this.aggregationTimer = clearIntervalSafe(this.aggregationTimer);
    if (!this.destroyed) {
      this.startAggregationTimer();
    }
  }

  private flushAggregationBuckets(): void {
    const now = Date.now();

    for (const [key, bucket] of this.aggregationBuckets.entries()) {
      if (bucket.swapCount === 0) {
        continue;
      }

      const aggregate: VolumeAggregate = {
        pairAddress: bucket.pairAddress,
        chain: bucket.chain,
        dex: bucket.dex,
        swapCount: bucket.swapCount,
        totalUsdVolume: bucket.totalUsdVolume,
        minPrice: bucket.prices.length > 0 ? bucket.prices.reduce((a, b) => a < b ? a : b, bucket.prices[0]) : 0,
        maxPrice: bucket.prices.length > 0 ? bucket.prices.reduce((a, b) => a > b ? a : b, bucket.prices[0]) : 0,
        avgPrice: bucket.prices.length > 0
          ? bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length
          : 0,
        windowStartMs: bucket.windowStartMs,
        windowEndMs: now
      };

      this.stats.volumeAggregatesEmitted++;

      for (const handler of this.volumeAggregateHandlers) {
        try {
          handler(aggregate);
        } catch (error) {
          logger.error('Volume aggregate handler error', { error });
        }
      }

      // Clear bucket
      this.aggregationBuckets.delete(key);
    }
  }

  onVolumeAggregate(handler: VolumeAggregateHandler): () => void {
    if (this.destroyed) {
      logger.warn('onVolumeAggregate called on destroyed filter');
      return () => {}; // No-op unsubscribe
    }
    this.volumeAggregateHandlers.push(handler);
    // Return unsubscribe function
    return () => {
      const index = this.volumeAggregateHandlers.indexOf(handler);
      if (index > -1) {
        this.volumeAggregateHandlers.splice(index, 1);
      }
    };
  }

  getAggregationBucketCount(): number {
    return this.aggregationBuckets.size;
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      if (!this.destroyed) {
        this.cleanupDedupCache();
      }
    }, this.config.cleanupIntervalMs);
  }

  private restartCleanupTimer(): void {
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);
    if (!this.destroyed) {
      this.startCleanupTimer();
    }
  }

  private cleanupDedupCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, timestamp] of this.dedupCache.entries()) {
      if (now - timestamp > this.config.dedupWindowMs) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.dedupCache.delete(key);
    }

    // Also enforce max cache size
    this.enforceCacheSizeLimit();

    logger.debug('Dedup cache cleaned', {
      removed: expiredKeys.length,
      remaining: this.dedupCache.size
    });
  }

  private enforceCacheSizeLimit(): void {
    if (this.dedupCache.size <= this.config.maxDedupCacheSize) {
      return;
    }

    const entries = Array.from(this.dedupCache.entries());
    entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp (oldest first)

    const toRemove = entries.slice(0, this.dedupCache.size - this.config.maxDedupCacheSize);
    for (const [key] of toRemove) {
      this.dedupCache.delete(key);
    }
  }

  getDedupCacheSize(): number {
    return this.dedupCache.size;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  private updateFilterRate(): void {
    if (this.stats.totalProcessed > 0) {
      this.stats.filterRate = (this.stats.totalFiltered / this.stats.totalProcessed) * 100;
    }
  }

  private updateAvgProcessingTime(newTime: number): void {
    this.totalProcessingTimeMs += newTime;
    this.stats.avgProcessingTimeMs = this.totalProcessingTimeMs / this.stats.totalProcessed;
  }

  getStats(): FilterStats {
    // Deep copy to prevent external mutation of internal state
    return {
      ...this.stats,
      filterReasons: { ...this.stats.filterReasons }
    };
  }

  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      totalPassed: 0,
      totalFiltered: 0,
      whaleAlerts: 0,
      filterRate: 0,
      filterReasons: {
        zero_amount: 0,
        below_min_value: 0,
        duplicate: 0,
        invalid_event: 0,
        invalid_value: 0
      },
      avgProcessingTimeMs: 0,
      volumeAggregatesEmitted: 0
    };
    this.totalProcessingTimeMs = 0;
  }

  // ===========================================================================
  // Prometheus Metrics
  // ===========================================================================

  getPrometheusMetrics(): string {
    const lines: string[] = [];

    lines.push('# HELP swap_filter_total_processed Total swap events processed');
    lines.push('# TYPE swap_filter_total_processed counter');
    lines.push(`swap_filter_total_processed ${this.stats.totalProcessed}`);

    lines.push('# HELP swap_filter_total_passed Total swap events that passed filter');
    lines.push('# TYPE swap_filter_total_passed counter');
    lines.push(`swap_filter_total_passed ${this.stats.totalPassed}`);

    lines.push('# HELP swap_filter_total_filtered Total swap events filtered out');
    lines.push('# TYPE swap_filter_total_filtered counter');
    lines.push(`swap_filter_total_filtered ${this.stats.totalFiltered}`);

    lines.push('# HELP swap_filter_whale_alerts Total whale alerts triggered');
    lines.push('# TYPE swap_filter_whale_alerts counter');
    lines.push(`swap_filter_whale_alerts ${this.stats.whaleAlerts}`);

    lines.push('# HELP swap_filter_rate Percentage of events filtered');
    lines.push('# TYPE swap_filter_rate gauge');
    lines.push(`swap_filter_rate ${this.stats.filterRate.toFixed(2)}`);

    lines.push('# HELP swap_filter_avg_processing_time_ms Average processing time per event');
    lines.push('# TYPE swap_filter_avg_processing_time_ms gauge');
    lines.push(`swap_filter_avg_processing_time_ms ${this.stats.avgProcessingTimeMs.toFixed(4)}`);

    lines.push('# HELP swap_filter_dedup_cache_size Current dedup cache size');
    lines.push('# TYPE swap_filter_dedup_cache_size gauge');
    lines.push(`swap_filter_dedup_cache_size ${this.dedupCache.size}`);

    // Filter reasons breakdown
    lines.push('# HELP swap_filter_reason_count Count by filter reason');
    lines.push('# TYPE swap_filter_reason_count counter');
    for (const [reason, count] of Object.entries(this.stats.filterReasons)) {
      lines.push(`swap_filter_reason_count{reason="${reason}"} ${count}`);
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  destroy(): void {
    if (this.destroyed) {
      return; // Already destroyed
    }
    this.destroyed = true;

    this.aggregationTimer = clearIntervalSafe(this.aggregationTimer);
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);

    // Flush any remaining aggregations
    this.flushAggregationBuckets();

    this.dedupCache.clear();
    this.aggregationBuckets.clear();
    this.whaleAlertHandlers = [];
    this.volumeAggregateHandlers = [];

    logger.info('SwapEventFilter destroyed');
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let filterInstance: SwapEventFilter | null = null;
let initializingFilter = false; // Race condition guard

export function getSwapEventFilter(config?: Partial<SwapEventFilterConfig>): SwapEventFilter {
  // Return existing instance if available
  if (filterInstance) {
    return filterInstance;
  }

  // Prevent concurrent initialization (race condition fix)
  if (initializingFilter) {
    // Wait and return - synchronous guard for sync function
    // In practice, construction is fast enough that this is unlikely to race
    throw new Error('SwapEventFilter is being initialized by another caller');
  }

  initializingFilter = true;
  try {
    // Double-check after acquiring guard
    if (!filterInstance) {
      filterInstance = new SwapEventFilter(config);
    }
    return filterInstance;
  } finally {
    initializingFilter = false;
  }
}

export function resetSwapEventFilter(): void {
  initializingFilter = false; // Clear initialization flag
  if (filterInstance) {
    filterInstance.destroy();
    filterInstance = null;
  }
}

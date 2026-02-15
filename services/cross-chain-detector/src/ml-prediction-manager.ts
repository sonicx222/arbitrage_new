/**
 * ML Prediction Manager Module
 *
 * Responsible for managing ML predictions for cross-chain arbitrage detection.
 * Handles price history tracking, prediction caching, and confidence calculation.
 *
 * FIX #1: Added single-flight pattern to prevent race conditions in concurrent predictions
 * FIX #4: Changed from Array.shift() to circular buffer for O(1) price history updates
 *
 * @see ADR-014: Modular Detector Components
 */

import {
  getLSTMPredictor,
  LSTMPredictor,
  PredictionResult,
  PriceHistory
} from '@arbitrage/ml';
import { PriceUpdate } from '@arbitrage/types';
import { Logger, MLPredictionConfig } from './types';

// =============================================================================
// Types
// =============================================================================

export interface MLPredictionManagerConfig {
  /** Logger instance - FIX #16: Use consistent Logger type */
  logger: Logger;
  /** ML configuration */
  mlConfig: MLPredictionConfig;
  /** Maximum price history entries per pair (default: 100) */
  priceHistoryMaxLength?: number;
  /** Maximum number of price history keys to track (default: 10000) */
  maxPriceHistoryKeys?: number;
  /** TTL for price history entries in ms (default: 10 minutes) */
  priceHistoryTtlMs?: number;
}

export interface MLPredictionManager {
  /** Initialize the ML predictor */
  initialize(): Promise<boolean>;

  /** Check if ML predictor is ready */
  isReady(): boolean;

  /** Track a price update for ML history */
  trackPriceUpdate(update: PriceUpdate): void;

  /** Get cached ML prediction for a chain:pairKey */
  getCachedPrediction(chain: string, pairKey: string, currentPrice: number): Promise<PredictionResult | null>;

  /** Pre-fetch predictions for multiple pairs in parallel */
  prefetchPredictions(pairs: Array<{ chain: string; pairKey: string; price: number }>): Promise<Map<string, PredictionResult | null>>;

  /** Cleanup expired cache entries */
  cleanup(): void;

  /** Clear all caches */
  clear(): void;

  /** Calculate volatility from price history */
  calculateVolatility(chain: string, pairKey: string): number;

  /** Get price history for a pair */
  getPriceHistory(chain: string, pairKey: string): PriceHistory[] | undefined;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PRICE_HISTORY_MAX_LENGTH = 100;
const DEFAULT_MAX_PRICE_HISTORY_KEYS = 10000;
const DEFAULT_PRICE_HISTORY_TTL_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an MLPredictionManager instance.
 *
 * @param config - Manager configuration
 * @returns MLPredictionManager instance
 */
export function createMLPredictionManager(config: MLPredictionManagerConfig): MLPredictionManager {
  const {
    logger,
    mlConfig,
    priceHistoryMaxLength = DEFAULT_PRICE_HISTORY_MAX_LENGTH,
    maxPriceHistoryKeys = DEFAULT_MAX_PRICE_HISTORY_KEYS,
    priceHistoryTtlMs = DEFAULT_PRICE_HISTORY_TTL_MS,
  } = config;

  // Internal state
  let mlPredictor: LSTMPredictor | null = null;
  let isInitialized = false;

  // FIX #4: Circular buffer structure for O(1) price history updates
  // Instead of Array.shift() which is O(n), we use head/size tracking
  interface CircularPriceHistory {
    buffer: PriceHistory[];
    head: number;      // Next write position
    size: number;      // Current number of entries
    lastAccess: number;
  }

  // Price history cache by "chain:pairKey" with circular buffer
  const priceHistoryCache = new Map<string, CircularPriceHistory>();

  // ML prediction cache with TTL
  const predictionCache = new Map<string, { prediction: PredictionResult; timestamp: number }>();

  // FIX #1: Single-flight pattern - track pending predictions to prevent race conditions
  const pendingPredictions = new Map<string, Promise<PredictionResult | null>>();

  // Counter for periodic cleanup
  let updateCounter = 0;
  const CLEANUP_FREQUENCY = 1000; // Cleanup every 1000 updates

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async function initialize(): Promise<boolean> {
    if (!mlConfig.enabled) {
      logger.info('ML predictions disabled by configuration');
      return false;
    }

    try {
      mlPredictor = getLSTMPredictor();
      isInitialized = true;
      logger.info('ML predictor initialized (TensorFlow.js LSTM)');
      return true;
    } catch (error) {
      logger.warn('ML predictor initialization failed, continuing without ML predictions', {
        error: (error as Error).message,
      });
      mlPredictor = null;
      isInitialized = false;
      return false;
    }
  }

  function isReady(): boolean {
    return mlConfig.enabled && isInitialized && mlPredictor !== null;
  }

  // ===========================================================================
  // Price History Tracking
  // ===========================================================================

  /**
   * FIX #4: Helper to get ordered array from circular buffer
   * Returns prices in chronological order (oldest to newest)
   */
  function getOrderedHistory(entry: CircularPriceHistory): PriceHistory[] {
    if (entry.size === 0) return [];

    const result: PriceHistory[] = new Array(entry.size);
    const startIdx = (entry.head - entry.size + priceHistoryMaxLength) % priceHistoryMaxLength;

    for (let i = 0; i < entry.size; i++) {
      const bufferIdx = (startIdx + i) % priceHistoryMaxLength;
      result[i] = entry.buffer[bufferIdx];
    }

    return result;
  }

  function trackPriceUpdate(update: PriceUpdate): void {
    if (!mlConfig.enabled) return;

    const historyKey = `${update.chain}:${update.pairKey}`;
    const now = Date.now();

    let entry = priceHistoryCache.get(historyKey);
    if (!entry) {
      // FIX #4: Initialize circular buffer with pre-allocated array
      entry = {
        buffer: new Array(priceHistoryMaxLength),
        head: 0,
        size: 0,
        lastAccess: now
      };
      priceHistoryCache.set(historyKey, entry);
    }

    // Update last access time
    entry.lastAccess = now;

    // Add new price point using circular buffer - O(1) operation
    const pricePoint: PriceHistory = {
      timestamp: update.timestamp,
      price: update.price,
      volume: 0, // Volume not available in PriceUpdate
      high: update.price,
      low: update.price,
    };

    // FIX #4: Write to current head position and advance
    entry.buffer[entry.head] = pricePoint;
    entry.head = (entry.head + 1) % priceHistoryMaxLength;
    entry.size = Math.min(entry.size + 1, priceHistoryMaxLength);

    // Periodic cleanup to bound total cache size
    updateCounter++;
    if (updateCounter >= CLEANUP_FREQUENCY) {
      updateCounter = 0;
      cleanupPriceHistoryCache();
    }
  }

  /**
   * Cleanup stale price history entries based on TTL and max keys.
   * FIX: Prevents unbounded memory growth from priceHistoryCache.
   */
  function cleanupPriceHistoryCache(): void {
    const now = Date.now();
    let removedCount = 0;

    // First pass: remove entries older than TTL
    for (const [key, entry] of priceHistoryCache) {
      if (now - entry.lastAccess > priceHistoryTtlMs) {
        priceHistoryCache.delete(key);
        removedCount++;
      }
    }

    // Second pass: if still over limit, remove oldest entries
    if (priceHistoryCache.size > maxPriceHistoryKeys) {
      const entries = Array.from(priceHistoryCache.entries());
      entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);

      const toRemove = entries.slice(0, entries.length - maxPriceHistoryKeys);
      for (const [key] of toRemove) {
        priceHistoryCache.delete(key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug('Cleaned up price history cache', {
        removed: removedCount,
        remaining: priceHistoryCache.size,
      });
    }
  }

  function getPriceHistory(chain: string, pairKey: string): PriceHistory[] | undefined {
    const entry = priceHistoryCache.get(`${chain}:${pairKey}`);
    if (!entry || entry.size === 0) return undefined;
    // FIX #4: Convert circular buffer to ordered array
    return getOrderedHistory(entry);
  }

  // ===========================================================================
  // Prediction Management
  // ===========================================================================

  /**
   * FIX #1: Internal prediction fetcher - separated for single-flight pattern
   */
  async function fetchPredictionInternal(
    cacheKey: string,
    chain: string,
    pairKey: string,
    currentPrice: number
  ): Promise<PredictionResult | null> {
    const now = Date.now();

    // Get price history for this pair using circular buffer
    const entry = priceHistoryCache.get(cacheKey);
    if (!entry || entry.size < 10) {
      // Not enough history for meaningful prediction
      return null;
    }

    // FIX #4: Convert circular buffer to ordered array for ML
    const priceHistory = getOrderedHistory(entry);

    try {
      // Use Promise.race to enforce latency timeout
      const predictionPromise = mlPredictor!.predictPrice(priceHistory, {
        currentPrice,
        volume24h: 0,
        marketCap: 0,
        volatility: calculateVolatilityInternal(priceHistory),
      });

      // FIX P0-1: Store timeoutId to clear timer when predictionPromise wins the race
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), mlConfig.maxLatencyMs);
      });

      let prediction: Awaited<typeof predictionPromise> | null;
      try {
        prediction = await Promise.race([predictionPromise, timeoutPromise]);
      } finally {
        // FIX P0-1: Always clear timeout to prevent orphaned timer accumulation
        clearTimeout(timeoutId!);
      }

      if (prediction) {
        // Cache successful prediction
        predictionCache.set(cacheKey, { prediction, timestamp: now });
        return prediction;
      }

      // Prediction timed out - expected behavior, no logging needed
      // Monitor via metrics if tracking is required
      return null;
    } catch {
      // Prediction failed - expected under load, no logging needed
      // Errors here are operational (timeout, model busy), not bugs
      return null;
    }
  }

  /**
   * FIX #1: Single-flight pattern to prevent race conditions
   * If a prediction is already being fetched for a key, return the pending promise
   * instead of starting a new fetch. This prevents cache coherence issues when
   * multiple detection cycles overlap.
   *
   * FIX 5.3: Race condition analysis - The pattern is safe because:
   * 1. Cache check (predictionCache.get) is atomic in Node.js
   * 2. Pending check (pendingPredictions.get) is atomic
   * 3. Cache write (predictionCache.set) happens within the tracked promise
   * 4. Concurrent requests either get cache hit, pending promise, or start new fetch
   * 5. No partial reads/writes due to JS single-threaded event loop
   */
  async function getCachedPrediction(
    chain: string,
    pairKey: string,
    currentPrice: number
  ): Promise<PredictionResult | null> {
    if (!isReady()) {
      return null;
    }

    const cacheKey = `${chain}:${pairKey}`;
    const now = Date.now();

    // Check cache first
    const cached = predictionCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < mlConfig.cacheTtlMs) {
      return cached.prediction;
    }

    // FIX #1: Single-flight pattern - return pending promise if one exists
    const pending = pendingPredictions.get(cacheKey);
    if (pending) {
      return pending;
    }

    // Create new prediction promise and track it
    const predictionPromise = fetchPredictionInternal(cacheKey, chain, pairKey, currentPrice);
    pendingPredictions.set(cacheKey, predictionPromise);

    try {
      return await predictionPromise;
    } finally {
      // Always clean up pending tracker
      pendingPredictions.delete(cacheKey);
    }
  }

  async function prefetchPredictions(
    pairs: Array<{ chain: string; pairKey: string; price: number }>
  ): Promise<Map<string, PredictionResult | null>> {
    const results = new Map<string, PredictionResult | null>();

    if (!isReady()) {
      return results;
    }

    // FIX RACE-2: Build list of unique keys to fetch, then batch-write results
    // This avoids the issue where null could mean "pending" vs "failed" vs "no prediction"
    const keysToFetch: Array<{ cacheKey: string; chain: string; pairKey: string; price: number }> = [];
    const seenKeys = new Set<string>();

    for (const { chain, pairKey, price } of pairs) {
      const cacheKey = `${chain}:${pairKey}`;

      // Skip duplicates
      if (seenKeys.has(cacheKey)) continue;
      seenKeys.add(cacheKey);

      keysToFetch.push({ cacheKey, chain, pairKey, price });
    }

    if (keysToFetch.length === 0) {
      return results;
    }

    // Fetch all predictions in parallel
    const predictionResults = await Promise.all(
      keysToFetch.map(async ({ cacheKey, chain, pairKey, price }) => {
        try {
          const prediction = await getCachedPrediction(chain, pairKey, price);
          return { cacheKey, prediction };
        } catch {
          return { cacheKey, prediction: null };
        }
      })
    );

    // Batch-write all results synchronously after Promise.all completes
    for (const { cacheKey, prediction } of predictionResults) {
      results.set(cacheKey, prediction);
    }

    return results;
  }

  // ===========================================================================
  // Volatility Calculation
  // ===========================================================================

  function calculateVolatilityInternal(priceHistory: PriceHistory[]): number {
    if (priceHistory.length < 2) return 0;

    const returns: number[] = [];
    for (let i = 1; i < priceHistory.length; i++) {
      const prevPrice = priceHistory[i - 1].price;
      if (prevPrice > 0) {
        returns.push((priceHistory[i].price - prevPrice) / prevPrice);
      }
    }

    // FIX: Guard against empty returns array
    if (returns.length === 0) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance);
  }

  function calculateVolatility(chain: string, pairKey: string): number {
    const entry = priceHistoryCache.get(`${chain}:${pairKey}`);
    if (!entry || entry.size === 0) return 0;
    // FIX #4: Convert circular buffer to ordered array for volatility calculation
    return calculateVolatilityInternal(getOrderedHistory(entry));
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  function cleanup(): void {
    const now = Date.now();
    const ttl = mlConfig.cacheTtlMs;

    for (const [key, entry] of predictionCache) {
      if (now - entry.timestamp > ttl) {
        predictionCache.delete(key);
      }
    }
  }

  function clear(): void {
    priceHistoryCache.clear();
    predictionCache.clear();
    logger.info('MLPredictionManager cleared');
  }

  // ===========================================================================
  // Return Public Interface
  // ===========================================================================

  return {
    initialize,
    isReady,
    trackPriceUpdate,
    getCachedPrediction,
    prefetchPredictions,
    cleanup,
    clear,
    calculateVolatility,
    getPriceHistory,
  };
}

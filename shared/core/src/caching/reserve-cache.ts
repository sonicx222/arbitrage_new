/**
 * Reserve Data Cache with Event-Driven Invalidation
 *
 * Caches pair reserve data from Sync events to reduce RPC calls.
 * Primary update path is via onSyncEvent() - event-driven invalidation.
 * TTL provides fallback protection against missed events.
 *
 * Key Design Decisions:
 * - In-memory only (no Redis) for fastest access in hot path
 * - O(1) Map lookups with LRU eviction
 * - Short TTL (5s default) as safety net for missed events
 * - Minimal allocations in hot-path methods
 *
 * Expected Impact:
 * - 60-80% reduction in eth_call(getReserves) RPC calls
 * - Cache hit rate >80% after warmup
 *
 * @see ADR-022: Reserve Data Caching with Event-Driven Invalidation
 * @see docs/reports/RPC_DATA_OPTIMIZATION_RESEARCH.md
 */

import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import type { Resettable } from '@arbitrage/types';

const logger = createLogger('reserve-cache');

// =============================================================================
// Types
// =============================================================================

/**
 * Cached reserve data for a trading pair.
 */
export interface CachedReserve {
  /** Reserve0 as bigint string for precision */
  reserve0: string;
  /** Reserve1 as bigint string for precision */
  reserve1: string;
  /** Block number when reserves were captured */
  blockNumber: number;
  /** Unix timestamp when cache entry was created/updated */
  timestamp: number;
  /** Source of the reserve data */
  source: 'sync_event' | 'rpc_call';
}

/**
 * Configuration for ReserveCache.
 */
export interface ReserveCacheConfig {
  /** Maximum entries before LRU eviction (default: 5000) */
  maxEntries: number;
  /** TTL in milliseconds for cache entries (default: 5000ms = 5s) */
  ttlMs: number;
  /** Enable metrics collection (default: true) */
  enableMetrics: boolean;
  /** Interval for metrics logging in ms (default: 60000ms = 1 min) */
  metricsIntervalMs: number;
}

/**
 * Statistics for monitoring cache performance.
 */
export interface ReserveCacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Entries rejected due to TTL expiration */
  staleRejects: number;
  /** LRU evictions */
  evictions: number;
  /** Updates from Sync events (primary path) */
  syncUpdates: number;
  /** Updates from RPC fallback calls */
  rpcFallbacks: number;
  /** Current number of entries */
  entriesCount: number;
}

// =============================================================================
// LRU Node for Doubly-Linked List
// =============================================================================

interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

// =============================================================================
// Reserve Cache Implementation
// =============================================================================

/**
 * In-memory reserve data cache with LRU eviction and TTL.
 *
 * Thread Safety: Safe for single-threaded Node.js event loop.
 * The cache is designed for the unified-detector hot path.
 */
export class ReserveCache implements Resettable {
  private readonly config: ReserveCacheConfig;

  // Main cache storage: key → reserve data
  private cache: Map<string, CachedReserve> = new Map();

  // LRU tracking: key → node (for O(1) removal)
  private nodeMap: Map<string, LRUNode> = new Map();

  // LRU doubly-linked list head/tail
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;

  // Statistics
  private stats: ReserveCacheStats = {
    hits: 0,
    misses: 0,
    staleRejects: 0,
    evictions: 0,
    syncUpdates: 0,
    rpcFallbacks: 0,
    entriesCount: 0,
  };

  // Metrics logging interval
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(config?: Partial<ReserveCacheConfig>) {
    this.config = {
      maxEntries: 5000,
      ttlMs: 5000, // 5 seconds - short TTL as safety net
      enableMetrics: true,
      metricsIntervalMs: 60000, // Log metrics every minute
      ...config,
    };

    // Start metrics logging if enabled
    if (this.config.enableMetrics && this.config.metricsIntervalMs > 0) {
      this.startMetricsLogging();
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get cached reserves for a pair.
   *
   * HOT PATH - Called frequently during arbitrage detection.
   * Returns undefined for cache miss or stale entry (caller handles RPC fallback).
   *
   * @param chainId - Chain identifier (e.g., 'ethereum', 'arbitrum')
   * @param pairAddress - Pair contract address (lowercase)
   * @returns Cached reserve data or undefined if miss/stale
   */
  get(chainId: string, pairAddress: string): CachedReserve | undefined {
    const key = this.makeKey(chainId, pairAddress);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL
    const age = Date.now() - entry.timestamp;
    if (age > this.config.ttlMs) {
      // Entry is stale - remove it and return miss
      this.stats.staleRejects++;
      this.removeEntry(key);
      return undefined;
    }

    // Cache hit - move to front of LRU list
    this.stats.hits++;
    this.moveToFront(key);
    return entry;
  }

  /**
   * Update cache from Sync event.
   *
   * HOT PATH - Called on every Sync event (100-1000/sec).
   * This is the primary update path (event-driven invalidation).
   *
   * @param chainId - Chain identifier
   * @param pairAddress - Pair contract address (lowercase)
   * @param reserve0 - Reserve0 as string (bigint precision)
   * @param reserve1 - Reserve1 as string (bigint precision)
   * @param blockNumber - Block number of the Sync event
   */
  onSyncEvent(
    chainId: string,
    pairAddress: string,
    reserve0: string,
    reserve1: string,
    blockNumber: number
  ): void {
    // Fix #16: Lightweight O(1) input validation for hot path
    // Guard against corrupt/empty Sync event data without expensive parsing
    if (!reserve0 || !reserve1) {
      logger.warn('onSyncEvent: empty reserve string', { chainId, pairAddress });
      return;
    }
    if (!(blockNumber > 0)) {
      logger.warn('onSyncEvent: invalid blockNumber', { chainId, pairAddress, blockNumber });
      return;
    }

    const key = this.makeKey(chainId, pairAddress);

    const entry: CachedReserve = {
      reserve0,
      reserve1,
      blockNumber,
      timestamp: Date.now(),
      source: 'sync_event',
    };

    this.setEntry(key, entry);
    this.stats.syncUpdates++;
  }

  /**
   * Update cache from RPC fallback call.
   *
   * Called when cache miss occurs and RPC fetch is performed.
   * Lower priority than Sync events (may be overwritten by newer Sync).
   *
   * @param chainId - Chain identifier
   * @param pairAddress - Pair contract address (lowercase)
   * @param reserve0 - Reserve0 as string (bigint precision)
   * @param reserve1 - Reserve1 as string (bigint precision)
   * @param blockNumber - Block number (if known) or 0
   */
  setFromRpc(
    chainId: string,
    pairAddress: string,
    reserve0: string,
    reserve1: string,
    blockNumber: number = 0
  ): void {
    const key = this.makeKey(chainId, pairAddress);
    const existing = this.cache.get(key);

    // Don't overwrite newer Sync event data with older RPC data
    if (existing && existing.source === 'sync_event') {
      // RPC without block info (blockNumber=0) should not overwrite known sync data
      if (blockNumber === 0) {
        return;
      }
      if (existing.blockNumber >= blockNumber) {
        return; // Existing data is newer, skip
      }
    }

    const entry: CachedReserve = {
      reserve0,
      reserve1,
      blockNumber,
      timestamp: Date.now(),
      source: 'rpc_call',
    };

    this.setEntry(key, entry);
    this.stats.rpcFallbacks++;
  }

  /**
   * Check if a pair is in the cache (regardless of staleness).
   * Useful for determining if we've ever seen this pair.
   */
  has(chainId: string, pairAddress: string): boolean {
    const key = this.makeKey(chainId, pairAddress);
    return this.cache.has(key);
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): ReserveCacheStats {
    return {
      ...this.stats,
      entriesCount: this.cache.size,
    };
  }

  /**
   * Get cache hit ratio (hits / total lookups).
   */
  getHitRatio(): number {
    const total = this.stats.hits + this.stats.misses + this.stats.staleRejects;
    if (total === 0) return 0;
    return this.stats.hits / total;
  }

  /**
   * Get current cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
    this.nodeMap.clear();
    this.head = null;
    this.tail = null;
    logger.info('Reserve cache cleared');
  }

  /**
   * Reset state for test isolation.
   * Clears cache and resets statistics.
   */
  resetState(): void {
    this.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      staleRejects: 0,
      evictions: 0,
      syncUpdates: 0,
      rpcFallbacks: 0,
      entriesCount: 0,
    };
  }

  /**
   * Stop metrics logging and clean up resources.
   */
  dispose(): void {
    this.metricsInterval = clearIntervalSafe(this.metricsInterval);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Generate cache key from chain and pair address.
   * Format: "chainId:pairAddress"
   */
  private makeKey(chainId: string, pairAddress: string): string {
    return `${chainId}:${pairAddress}`;
  }

  /**
   * Set entry in cache with LRU tracking.
   */
  private setEntry(key: string, entry: CachedReserve): void {
    const existing = this.cache.has(key);

    // Update cache
    this.cache.set(key, entry);

    if (existing) {
      // Move existing entry to front
      this.moveToFront(key);
    } else {
      // Add new entry to front
      this.addToFront(key);

      // Evict if over capacity
      while (this.cache.size > this.config.maxEntries) {
        this.evictLRU();
      }
    }
  }

  /**
   * Remove entry from cache and LRU list.
   */
  private removeEntry(key: string): void {
    this.cache.delete(key);
    this.removeFromList(key);
  }

  /**
   * Add new node to front of LRU list.
   */
  private addToFront(key: string): void {
    const node: LRUNode = { key, prev: null, next: this.head };

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }

    this.nodeMap.set(key, node);
  }

  /**
   * Move existing node to front of LRU list.
   */
  private moveToFront(key: string): void {
    const node = this.nodeMap.get(key);
    if (!node || node === this.head) return;

    // Remove from current position
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
    if (node === this.tail) {
      this.tail = node.prev;
    }

    // Move to front
    node.prev = null;
    node.next = this.head;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
  }

  /**
   * Remove node from LRU list.
   */
  private removeFromList(key: string): void {
    const node = this.nodeMap.get(key);
    if (!node) return;

    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    this.nodeMap.delete(key);
  }

  /**
   * Evict least recently used entry.
   */
  private evictLRU(): void {
    if (!this.tail) return;

    const key = this.tail.key;
    this.removeEntry(key);
    this.stats.evictions++;
  }

  /**
   * Start periodic metrics logging.
   */
  private startMetricsLogging(): void {
    this.metricsInterval = setInterval(() => {
      const stats = this.getStats();
      const hitRatio = this.getHitRatio();

      logger.info('Reserve cache metrics', {
        hitRate: `${(hitRatio * 100).toFixed(1)}%`,
        entries: stats.entriesCount,
        hits: stats.hits,
        misses: stats.misses,
        staleRejects: stats.staleRejects,
        syncUpdates: stats.syncUpdates,
        rpcFallbacks: stats.rpcFallbacks,
        evictions: stats.evictions,
      });
    }, this.config.metricsIntervalMs);

    // Don't let metrics interval prevent process exit
    this.metricsInterval.unref();
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let reserveCacheInstance: ReserveCache | null = null;

/**
 * Get or create the singleton ReserveCache instance.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns ReserveCache singleton instance
 */
export function getReserveCache(config?: Partial<ReserveCacheConfig>): ReserveCache {
  if (!reserveCacheInstance) {
    reserveCacheInstance = new ReserveCache(config);
    logger.info('ReserveCache singleton created', {
      maxEntries: reserveCacheInstance['config'].maxEntries,
      ttlMs: reserveCacheInstance['config'].ttlMs,
    });
  } else if (config) {
    logger.warn('getReserveCache called with config but instance already exists. Config ignored.');
  }

  return reserveCacheInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetReserveCache(): void {
  if (reserveCacheInstance) {
    reserveCacheInstance.dispose();
    reserveCacheInstance = null;
  }
}

/**
 * Create a new ReserveCache instance (non-singleton).
 * Useful for testing or isolated use cases.
 *
 * @param config - Optional configuration
 * @returns New ReserveCache instance
 */
export function createReserveCache(config?: Partial<ReserveCacheConfig>): ReserveCache {
  return new ReserveCache(config);
}

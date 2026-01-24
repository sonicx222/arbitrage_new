/**
 * Caching Module
 *
 * Consolidated cache management utilities including:
 * - HierarchicalCache: Multi-tier caching (L1 memory + L2 Redis)
 * - SharedMemoryCache: In-process SharedArrayBuffer cache
 * - CacheCoherencyManager: Distributed cache consistency via gossip protocol
 * - PairCacheService: Trading pair address caching with TTL
 * - PriceMatrix: O(1) price lookup matrix
 * - GasPriceCache: Gas price tracking and caching
 * - CorrelationAnalyzer: Predictive cache warming via co-occurrence tracking (Task 2.2.1)
 *
 * @module caching
 */

// Hierarchical Cache (L1/L2/L3)
export {
  HierarchicalCache,
  createHierarchicalCache,
  getHierarchicalCache,
  LRUQueue
} from './hierarchical-cache';

// Shared Memory Cache (SharedArrayBuffer)
export {
  SharedMemoryCache,
  createSharedMemoryCache,
  getSharedMemoryCache
} from './shared-memory-cache';
export type {
  SharedCacheConfig,
  SharedCacheEntry
} from './shared-memory-cache';

// Cache Coherency Manager (Gossip Protocol)
export {
  CacheCoherencyManager,
  createCacheCoherencyManager,
  getCacheCoherencyManager,
  resetCacheCoherencyManager
} from './cache-coherency-manager';
export type {
  NodeInfo,
  GossipMessage,
  CacheOperation,
  CoherencyConfig
} from './cache-coherency-manager';

// Pair Cache Service (S2.2.5)
export {
  PairCacheService,
  getPairCacheService,
  resetPairCacheService
} from './pair-cache';
export type {
  PairCacheConfig,
  CachedPairData,
  PairCacheStats,
  CacheLookupResult,
  PairCacheServiceDeps
} from './pair-cache';

// Price Matrix (O(1) lookups)
export {
  PriceMatrix,
  PriceIndexMapper,
  getPriceMatrix,
  resetPriceMatrix
} from './price-matrix';
export type {
  PriceMatrixConfig,
  PriceEntry,
  MemoryUsage,
  PriceMatrixStats,
  BatchUpdate
} from './price-matrix';

// Gas Price Cache (ADR-012, ADR-013)
export {
  GasPriceCache,
  getGasPriceCache,
  resetGasPriceCache,
  GAS_UNITS,
  DEFAULT_TRADE_AMOUNT_USD,
  FALLBACK_GAS_COSTS_ETH,
  FALLBACK_GAS_SCALING_PER_STEP
} from './gas-price-cache';
export type {
  GasPriceData,
  NativeTokenPrice,
  GasCostEstimate,
  GasPriceCacheConfig
} from './gas-price-cache';

// Correlation Analyzer (Task 2.2.1 - Predictive Cache Warming)
export {
  CorrelationAnalyzer,
  createCorrelationAnalyzer,
  getCorrelationAnalyzer,
  resetCorrelationAnalyzer
} from './correlation-analyzer';
export type {
  CorrelationAnalyzerConfig,
  PairCorrelation,
  CorrelationStats
} from './correlation-analyzer';

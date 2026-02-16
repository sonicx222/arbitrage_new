/**
 * Provider Health Scorer
 *
 * S3.3: Tracks health metrics for RPC providers and enables intelligent
 * fallback selection based on latency, reliability, and data freshness.
 *
 * Updated with 6-Provider Shield budget tracking:
 * - Track monthly/daily CU usage per provider
 * - Proactive throttling at 80% capacity
 * - Time-based provider priority rotation
 *
 * Features:
 * - Track latency, success rate, and block freshness per provider
 * - Weighted scoring for intelligent provider selection
 * - Rolling windows for metrics to prevent stale data
 * - Budget tracking for proactive rate limit avoidance
 * - Singleton pattern for shared access across WebSocket managers
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see docs/reports/RPC_DEEP_DIVE_ANALYSIS.md
 */

import { createLogger, Logger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { PROVIDER_CONFIGS } from '@arbitrage/config';

/**
 * Provider budget configuration from 6-Provider Shield analysis
 */
export interface ProviderBudgetConfig {
  /** Provider name (e.g., 'drpc', 'ankr') */
  name: string;
  /** Monthly compute unit limit */
  monthlyLimitCU: number;
  /** Daily limit (for providers like Infura with daily reset) */
  dailyLimitCU?: number;
  /** Whether this provider has daily reset (like Infura) */
  hasDailyReset?: boolean;
  /** RPS limit for this provider */
  rpsLimit: number;
}

/**
 * Provider budget tracking state
 */
export interface ProviderBudgetState {
  /** Compute units used this month */
  monthlyUsedCU: number;
  /** Compute units used today (for daily-reset providers) */
  dailyUsedCU: number;
  /** Last reset timestamp (month start) */
  lastMonthlyReset: number;
  /** Last daily reset timestamp */
  lastDailyReset: number;
  /** Request count this month */
  monthlyRequestCount: number;
  /** Request count today */
  dailyRequestCount: number;
  /** Whether provider should be throttled (>80% capacity) */
  shouldThrottle: boolean;
  /** Estimated days remaining at current usage rate */
  estimatedDaysRemaining: number;
}

/**
 * Derive budget configurations from the canonical PROVIDER_CONFIGS.
 * This ensures a single source of truth for provider data from @arbitrage/config.
 * This avoids duplication while allowing budget-specific extensions.
 *
 * NOTE: PROVIDER_CONFIGS may be undefined in test environments where
 * @arbitrage/config fails to initialize (e.g., missing REDIS_URL before
 * setupTestEnv() runs). We handle this gracefully by returning an empty
 * object, which means budget tracking won't work but won't crash either.
 */
function deriveBudgetConfigs(): Record<string, ProviderBudgetConfig> {
  // Guard against undefined PROVIDER_CONFIGS (can happen in test environments
  // due to module loading order - config validates before env vars are set)
  if (!PROVIDER_CONFIGS || typeof PROVIDER_CONFIGS !== 'object') {
    return {};
  }

  const budgets: Record<string, ProviderBudgetConfig> = {};

  for (const [key, config] of Object.entries(PROVIDER_CONFIGS)) {
    budgets[key] = {
      name: config.name,
      monthlyLimitCU: config.monthlyCapacityCU,
      rpsLimit: config.rpsLimit,
      // Add daily reset for Infura-like providers
      ...(config.dailyReset ? {
        dailyLimitCU: 3_000_000, // Infura: 3M/day
        hasDailyReset: true
      } : {})
    };
  }

  return budgets;
}

/**
 * Default provider budget configurations derived from PROVIDER_CONFIGS.
 * Single source of truth from @arbitrage/config package.
 */
export const DEFAULT_PROVIDER_BUDGETS: Record<string, ProviderBudgetConfig> = deriveBudgetConfigs();

/**
 * Compute unit costs by RPC method (Alchemy reference).
 * Used to estimate CU consumption per request.
 *
 * @see https://docs.alchemy.com/reference/compute-units
 */
export const METHOD_CU_COSTS: Record<string, number> = {
  // Free methods
  'eth_chainId': 0,
  'net_version': 0,
  'web3_clientVersion': 0,

  // Light methods (10-20 CU)
  'eth_blockNumber': 10,
  'eth_gasPrice': 10,
  'eth_maxPriorityFeePerGas': 10,
  'eth_feeHistory': 10,
  'eth_syncing': 10,
  'eth_getBalance': 19,
  'eth_getTransactionCount': 26,
  'eth_getCode': 26,
  'eth_getStorageAt': 17,

  // Medium methods (15-30 CU)
  'eth_getBlockByNumber': 16,
  'eth_getBlockByHash': 16,
  'eth_getTransactionByHash': 17,
  'eth_getTransactionReceipt': 15,
  'eth_call': 26,

  // Heavy methods (50+ CU)
  'eth_getLogs': 75,
  'eth_estimateGas': 87,
  'eth_createAccessList': 100,
  'debug_traceTransaction': 300,
  'debug_traceCall': 300,
  'trace_block': 500,
  'trace_transaction': 300,

  // Transaction methods (high CU)
  'eth_sendRawTransaction': 200,

  // Subscription methods (per-second cost)
  'eth_subscribe': 10,
  'eth_unsubscribe': 10,

  // Solana methods (approximate Helius/Triton costs)
  'getAccountInfo': 10,
  'getBalance': 10,
  'getBlock': 50,
  'getBlockHeight': 10,
  'getLatestBlockhash': 10,
  'getProgramAccounts': 100,
  'getSignaturesForAddress': 75,
  'getSlot': 10,
  'getTransaction': 30,
  'sendTransaction': 200,
  'simulateTransaction': 100,

  // Default for unknown methods
  'default': 20
};

/**
 * Health metrics for a single provider
 */
export interface ProviderHealthMetrics {
  /** Provider WebSocket/RPC URL */
  url: string;
  /** Chain identifier */
  chainId: string;

  // Latency tracking (rolling window)
  /** Average latency in ms */
  avgLatencyMs: number;
  /** 95th percentile latency in ms */
  p95LatencyMs: number;
  /** Recent latency samples */
  latencySamples: number[];

  // Reliability tracking
  /** Total successful operations */
  successCount: number;
  /** Total failed operations */
  failureCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Rate limit events encountered */
  rateLimitCount: number;
  /** Connection drop count */
  connectionDropCount: number;

  // Timing
  /** Timestamp of last successful operation */
  lastSuccessTime: number;
  /** Timestamp of last failure */
  lastFailureTime: number;
  /** Timestamp of last block received */
  lastBlockTime: number;

  // Block freshness
  /** Last block number seen */
  lastBlockNumber: number;
  /** Estimated blocks behind head */
  blocksBehind: number;

  // Computed scores (0-100)
  /** Latency score (lower latency = higher score) */
  latencyScore: number;
  /** Reliability score (higher success rate = higher score) */
  reliabilityScore: number;
  /** Freshness score (more recent blocks = higher score) */
  freshnessScore: number;
  /** Overall weighted score */
  overallScore: number;
}

/**
 * Configuration for the health scorer
 */
export interface ProviderHealthScorerConfig {
  /** Weight for latency in overall score (default: 0.3) */
  latencyWeight?: number;
  /** Weight for reliability in overall score (default: 0.4) */
  reliabilityWeight?: number;
  /** Weight for freshness in overall score (default: 0.3) */
  freshnessWeight?: number;

  // Thresholds
  /** Maximum acceptable latency in ms (default: 2000) */
  maxAcceptableLatencyMs?: number;
  /** Maximum acceptable block delay in ms (default: 30000) */
  maxAcceptableBlockDelayMs?: number;
  /** Minimum acceptable reliability (default: 0.95 = 95%) */
  minReliabilityPercent?: number;

  // Rolling window sizes
  /** Number of latency samples to keep (default: 100) */
  latencySampleWindow?: number;
  /** Window for reliability calculation (default: 1000) */
  reliabilityWindow?: number;

  // Decay settings
  /** How often to decay old metrics in ms (default: 60000) */
  decayIntervalMs?: number;
  /** Decay factor for old counts (default: 0.9) */
  decayFactor?: number;
}

/**
 * Provider Health Scorer - tracks and scores RPC provider health
 */
export class ProviderHealthScorer {
  private metrics: Map<string, ProviderHealthMetrics> = new Map();
  private config: Required<ProviderHealthScorerConfig>;
  private logger: Logger;
  private decayTimer: NodeJS.Timeout | null = null;

  /** Budget tracking for 6-Provider Shield */
  private providerBudgets: Map<string, ProviderBudgetState> = new Map();
  private budgetConfigs: Record<string, ProviderBudgetConfig> = DEFAULT_PROVIDER_BUDGETS;

  /** P3 FIX #28: Cache best block per chain to avoid O(n) scan on every recordBlock() */
  private bestBlockByChain: Map<string, number> = new Map();

  /**
   * Performance optimization: Cached date values to avoid repeated new Date() calls.
   * Refreshed every minute (sufficient for budget calculations).
   */
  private cachedUtcHour = 0;
  private cachedDayOfMonth = 1;
  private lastDateCacheUpdate = 0;
  private static readonly DATE_CACHE_TTL_MS = 60000; // Refresh every 60 seconds

  constructor(config: ProviderHealthScorerConfig = {}) {
    this.config = {
      latencyWeight: config.latencyWeight ?? 0.3,
      reliabilityWeight: config.reliabilityWeight ?? 0.4,
      freshnessWeight: config.freshnessWeight ?? 0.3,
      maxAcceptableLatencyMs: config.maxAcceptableLatencyMs ?? 2000,
      maxAcceptableBlockDelayMs: config.maxAcceptableBlockDelayMs ?? 30000,
      minReliabilityPercent: config.minReliabilityPercent ?? 0.95,
      latencySampleWindow: config.latencySampleWindow ?? 100,
      reliabilityWindow: config.reliabilityWindow ?? 1000,
      decayIntervalMs: config.decayIntervalMs ?? 60000,
      decayFactor: config.decayFactor ?? 0.9
    };

    this.logger = createLogger('provider-health-scorer');

    // Start periodic decay
    this.startDecay();
  }

  /**
   * Get or create metrics for a provider
   */
  private getOrCreateMetrics(url: string, chainId: string): ProviderHealthMetrics {
    const key = this.makeKey(url, chainId);
    let metrics = this.metrics.get(key);

    if (!metrics) {
      metrics = this.createEmptyMetrics(url, chainId);
      this.metrics.set(key, metrics);
    }

    return metrics;
  }

  /**
   * Create empty metrics object.
   * P1 FIX #8: Stores masked URL to prevent API key leakage in metrics/logs.
   */
  private createEmptyMetrics(url: string, chainId: string): ProviderHealthMetrics {
    return {
      url: this.maskUrl(url),
      chainId,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      latencySamples: [],
      successCount: 0,
      failureCount: 0,
      successRate: 1.0, // Assume healthy until proven otherwise
      rateLimitCount: 0,
      connectionDropCount: 0,
      lastSuccessTime: 0,
      lastFailureTime: 0,
      lastBlockTime: 0,
      lastBlockNumber: 0,
      blocksBehind: 0,
      latencyScore: 100,
      reliabilityScore: 100,
      freshnessScore: 100,
      overallScore: 100
    };
  }

  /**
   * Make a unique key for provider metrics
   */
  private makeKey(url: string, chainId: string): string {
    return `${chainId}:${url}`;
  }

  /**
   * P1 FIX #8: Mask a provider URL to redact API keys before logging or storing.
   * Replaces path segments that look like API keys (long hex/alphanumeric strings)
   * with a truncated form, and redacts query-string auth tokens.
   * Returns the original URL unchanged if there's nothing to mask.
   *
   * Examples:
   *   wss://eth-mainnet.g.alchemy.com/v2/abcdef1234567890abcdef -> wss://eth-mainnet.g.alchemy.com/v2/abcde...
   *   https://rpc.ankr.com/eth/abc123longkey -> https://rpc.ankr.com/eth/abc12...
   *   wss://test.com -> wss://test.com (unchanged)
   */
  private maskUrl(url: string): string {
    const keyPattern = /\/([a-zA-Z0-9_-]{12,})/g;
    const authParamPattern = /[?&](key|token|secret|auth|api_key)=/i;

    // Quick check: skip URL parsing if nothing to mask
    if (!keyPattern.test(url) && !authParamPattern.test(url)) {
      return url;
    }

    // Reset lastIndex after test()
    keyPattern.lastIndex = 0;

    try {
      const parsed = new URL(url);
      // Mask path segments that look like API keys (>12 chars alphanumeric/hex)
      parsed.pathname = parsed.pathname.replace(
        /\/([a-zA-Z0-9_-]{12,})/g,
        (_, key) => `/${key.slice(0, 5)}...`
      );
      // Mask query-string auth tokens
      for (const [key] of parsed.searchParams) {
        if (/key|token|secret|auth|api/i.test(key)) {
          parsed.searchParams.set(key, '***');
        }
      }
      return parsed.toString();
    } catch {
      // If URL parsing fails, mask conservatively
      return url.replace(/\/([a-zA-Z0-9_-]{12,})/g, (_, key) => `/${key.slice(0, 5)}...`);
    }
  }

  /**
   * Record a successful operation with latency
   */
  recordSuccess(url: string, chainId: string, latencyMs: number): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    // Update success tracking
    metrics.successCount++;
    metrics.lastSuccessTime = Date.now();

    // Update latency tracking
    metrics.latencySamples.push(latencyMs);
    if (metrics.latencySamples.length > this.config.latencySampleWindow) {
      metrics.latencySamples.shift();
    }

    // Recalculate latency stats
    this.updateLatencyStats(metrics);

    // Recalculate scores
    this.updateScores(metrics);
  }

  /**
   * Record a failed operation
   */
  recordFailure(url: string, chainId: string, errorType: string): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    metrics.failureCount++;
    metrics.lastFailureTime = Date.now();

    if (errorType === 'rate_limit') {
      metrics.rateLimitCount++;
    } else if (errorType === 'connection_drop') {
      metrics.connectionDropCount++;
    }

    // Recalculate scores
    this.updateScores(metrics);

    this.logger.debug('Recorded failure', {
      url: this.maskUrl(url),
      chainId,
      errorType,
      successRate: metrics.successRate
    });
  }

  /**
   * Record a rate limit event
   */
  recordRateLimit(url: string, chainId: string): void {
    this.recordFailure(url, chainId, 'rate_limit');
  }

  /**
   * Record a connection drop
   */
  recordConnectionDrop(url: string, chainId: string): void {
    this.recordFailure(url, chainId, 'connection_drop');
  }

  /**
   * Record a block number received
   */
  recordBlock(url: string, chainId: string, blockNumber: number): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    metrics.lastBlockNumber = blockNumber;
    metrics.lastBlockTime = Date.now();

    // P3 FIX #28: Update best block cache
    const currentBest = this.bestBlockByChain.get(chainId) ?? 0;
    if (blockNumber > currentBest) {
      this.bestBlockByChain.set(chainId, blockNumber);
    }

    // Calculate blocks behind (compare to best known for this chain)
    const bestBlock = this.getBestBlockForChain(chainId);
    metrics.blocksBehind = Math.max(0, bestBlock - blockNumber);

    // Recalculate scores
    this.updateScores(metrics);
  }

  /**
   * Get the best (highest) block number known for a chain.
   * P3 FIX #28: Uses cached value instead of O(n) scan.
   */
  private getBestBlockForChain(chainId: string): number {
    return this.bestBlockByChain.get(chainId) ?? 0;
  }

  /**
   * Update latency statistics from samples.
   * P2 FIX #11: Uses quickselect (O(n) average) instead of full sort (O(n log n)) to find P95.
   * P2 FIX #15: Uses ?? instead of || for P95 fallback (0 is a valid latency).
   */
  private updateLatencyStats(metrics: ProviderHealthMetrics): void {
    const samples = metrics.latencySamples;
    if (samples.length === 0) return;

    // Calculate average
    const sum = samples.reduce((a, b) => a + b, 0);
    metrics.avgLatencyMs = sum / samples.length;

    // Calculate P95 using quickselect (O(n) average vs O(n log n) full sort)
    const p95Index = Math.floor(samples.length * 0.95);
    metrics.p95LatencyMs = this.quickSelect(samples, p95Index) ?? metrics.avgLatencyMs;
  }

  /**
   * P2 FIX #11: Quickselect algorithm to find the k-th smallest element in O(n) average.
   * Operates on a copy to avoid mutating the original samples array.
   */
  private quickSelect(arr: number[], k: number): number {
    if (arr.length === 0 || k >= arr.length) return 0;
    if (arr.length === 1) return arr[0];

    // Work on a shallow copy to avoid mutating latencySamples
    const a = arr.slice();
    let lo = 0;
    let hi = a.length - 1;

    while (lo < hi) {
      const pivot = a[lo + ((hi - lo) >> 1)];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) {
          const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
    return a[k];
  }

  /**
   * Update all scores for a provider
   */
  private updateScores(metrics: ProviderHealthMetrics): void {
    // Calculate success rate
    const totalOps = metrics.successCount + metrics.failureCount;
    metrics.successRate = totalOps > 0
      ? metrics.successCount / totalOps
      : 1.0;

    // Latency score (100 = 0ms, 0 = maxAcceptableLatencyMs+)
    const latencyRatio = metrics.avgLatencyMs / this.config.maxAcceptableLatencyMs;
    metrics.latencyScore = Math.max(0, Math.min(100, (1 - latencyRatio) * 100));

    // Reliability score (based on success rate)
    metrics.reliabilityScore = metrics.successRate * 100;

    // Freshness score (based on time since last block and blocks behind)
    const timeSinceBlock = metrics.lastBlockTime > 0
      ? Date.now() - metrics.lastBlockTime
      : this.config.maxAcceptableBlockDelayMs;
    const freshnessRatio = Math.min(1, timeSinceBlock / this.config.maxAcceptableBlockDelayMs);
    const blockPenalty = Math.min(50, metrics.blocksBehind * 10); // Lose 10 points per block behind
    metrics.freshnessScore = Math.max(0, (1 - freshnessRatio) * 100 - blockPenalty);

    // Overall weighted score
    metrics.overallScore =
      metrics.latencyScore * this.config.latencyWeight +
      metrics.reliabilityScore * this.config.reliabilityWeight +
      metrics.freshnessScore * this.config.freshnessWeight;
  }

  /**
   * Get health score for a specific provider
   */
  getHealthScore(url: string, chainId: string): number {
    const key = this.makeKey(url, chainId);
    const metrics = this.metrics.get(key);
    return metrics?.overallScore ?? 50; // Default to neutral score
  }

  /**
   * Get full metrics for a provider
   */
  getMetrics(url: string, chainId: string): ProviderHealthMetrics | null {
    const key = this.makeKey(url, chainId);
    const metrics = this.metrics.get(key);
    return metrics ? { ...metrics } : null;
  }

  /**
   * Get all metrics for a chain
   */
  getChainMetrics(chainId: string): ProviderHealthMetrics[] {
    const result: ProviderHealthMetrics[] = [];

    for (const metrics of this.metrics.values()) {
      if (metrics.chainId === chainId) {
        result.push({ ...metrics });
      }
    }

    return result.sort((a, b) => b.overallScore - a.overallScore);
  }

  /**
   * Select the best provider from a list of candidates
   */
  selectBestProvider(chainId: string, candidates: string[]): string {
    if (candidates.length === 0) {
      throw new Error('No candidate providers provided');
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    let bestUrl = candidates[0];
    let bestScore = this.getHealthScore(candidates[0], chainId);

    for (let i = 1; i < candidates.length; i++) {
      const url = candidates[i];
      const score = this.getHealthScore(url, chainId);

      if (score > bestScore) {
        bestScore = score;
        bestUrl = url;
      }
    }

    this.logger.debug('Selected best provider', {
      chainId,
      selectedUrl: this.maskUrl(bestUrl),
      score: bestScore,
      candidateCount: candidates.length
    });

    return bestUrl;
  }

  /**
   * Check if a provider meets minimum health requirements
   */
  isProviderHealthy(url: string, chainId: string): boolean {
    const metrics = this.getMetrics(url, chainId);
    if (!metrics) return true; // Unknown providers are assumed healthy

    return (
      metrics.successRate >= this.config.minReliabilityPercent &&
      metrics.avgLatencyMs <= this.config.maxAcceptableLatencyMs
    );
  }

  /**
   * Get providers sorted by health score (best first)
   */
  getRankedProviders(chainId: string, urls: string[]): string[] {
    return [...urls].sort((a, b) => {
      const scoreA = this.getHealthScore(a, chainId);
      const scoreB = this.getHealthScore(b, chainId);
      return scoreB - scoreA;
    });
  }

  /**
   * Start periodic decay of old metrics
   */
  private startDecay(): void {
    this.stopDecay();

    this.decayTimer = setInterval(() => {
      this.decayMetrics();
    }, this.config.decayIntervalMs);
  }

  /**
   * Stop periodic decay
   */
  private stopDecay(): void {
    this.decayTimer = clearIntervalSafe(this.decayTimer);
  }

  /**
   * Apply decay to metrics to prevent stale data from dominating
   */
  private decayMetrics(): void {
    const decayFactor = this.config.decayFactor;

    for (const metrics of this.metrics.values()) {
      // Decay counts towards zero
      metrics.successCount = Math.floor(metrics.successCount * decayFactor);
      metrics.failureCount = Math.floor(metrics.failureCount * decayFactor);
      metrics.rateLimitCount = Math.floor(metrics.rateLimitCount * decayFactor);
      metrics.connectionDropCount = Math.floor(metrics.connectionDropCount * decayFactor);

      // Recalculate scores after decay
      this.updateScores(metrics);
    }
  }

  /**
   * Clear all metrics (for testing or reset)
   */
  clear(): void {
    this.metrics.clear();
    this.bestBlockByChain.clear();
  }

  /**
   * Shutdown the scorer
   */
  shutdown(): void {
    this.stopDecay();
    this.clear();
    this.providerBudgets.clear();
  }

  // ===========================================================================
  // PERFORMANCE: CACHED DATE ACCESSORS
  // ===========================================================================

  /**
   * Refresh cached date values if stale.
   * Called lazily when date values are needed.
   */
  private refreshDateCacheIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastDateCacheUpdate > ProviderHealthScorer.DATE_CACHE_TTL_MS) {
      const date = new Date();
      this.cachedUtcHour = date.getUTCHours();
      // P2 FIX #14: Use getUTCDate() for consistent UTC-based budget calculations
      this.cachedDayOfMonth = date.getUTCDate();
      this.lastDateCacheUpdate = now;
    }
  }

  /**
   * Get cached UTC hour (0-23). Refreshes cache if stale.
   * Use this instead of new Date().getUTCHours() in hot paths.
   */
  private getCachedUtcHour(): number {
    this.refreshDateCacheIfNeeded();
    return this.cachedUtcHour;
  }

  /**
   * Get cached day of month (1-31). Refreshes cache if stale.
   * Use this instead of new Date().getDate() in hot paths.
   */
  private getCachedDayOfMonth(): number {
    this.refreshDateCacheIfNeeded();
    return this.cachedDayOfMonth;
  }

  // ===========================================================================
  // BUDGET TRACKING FOR 6-PROVIDER SHIELD
  // ===========================================================================

  /**
   * Record a request for budget tracking.
   * Call this for every RPC request to track usage against provider limits.
   *
   * @param providerName - Provider identifier (e.g., 'drpc', 'ankr')
   * @param method - RPC method called (for CU estimation)
   * @param customCU - Optional custom CU cost (overrides method-based estimation)
   */
  recordRequest(providerName: string, method = 'default', customCU?: number): void {
    const normalizedName = providerName.toLowerCase();
    const config = this.budgetConfigs[normalizedName];

    if (!config) {
      // Unknown provider, skip budget tracking
      return;
    }

    const state = this.getOrCreateBudgetState(normalizedName);
    const now = Date.now();

    // Check for daily reset (for Infura-like providers)
    if (config.hasDailyReset) {
      const hoursSinceReset = (now - state.lastDailyReset) / (1000 * 60 * 60);
      if (hoursSinceReset >= 24) {
        state.dailyUsedCU = 0;
        state.dailyRequestCount = 0;
        state.lastDailyReset = now;
        this.logger.debug('Daily budget reset', { provider: normalizedName });
      }
    }

    // Check for monthly reset
    const daysSinceReset = (now - state.lastMonthlyReset) / (1000 * 60 * 60 * 24);
    if (daysSinceReset >= 30) {
      state.monthlyUsedCU = 0;
      state.monthlyRequestCount = 0;
      state.lastMonthlyReset = now;
      this.logger.debug('Monthly budget reset', { provider: normalizedName });
    }

    // Estimate CU cost
    const cuCost = customCU ?? METHOD_CU_COSTS[method] ?? METHOD_CU_COSTS.default;

    // Update usage
    state.monthlyUsedCU += cuCost;
    state.monthlyRequestCount++;
    state.dailyUsedCU += cuCost;
    state.dailyRequestCount++;

    // Calculate throttle status
    this.updateBudgetStatus(normalizedName, state, config);
  }

  /**
   * Get or create budget state for a provider
   */
  private getOrCreateBudgetState(providerName: string): ProviderBudgetState {
    let state = this.providerBudgets.get(providerName);

    if (!state) {
      const now = Date.now();
      state = {
        monthlyUsedCU: 0,
        dailyUsedCU: 0,
        lastMonthlyReset: now,
        lastDailyReset: now,
        monthlyRequestCount: 0,
        dailyRequestCount: 0,
        shouldThrottle: false,
        estimatedDaysRemaining: 30
      };
      this.providerBudgets.set(providerName, state);
    }

    return state;
  }

  /**
   * Update budget status and throttle recommendation
   */
  private updateBudgetStatus(
    providerName: string,
    state: ProviderBudgetState,
    config: ProviderBudgetConfig
  ): void {
    // Handle unlimited providers (e.g., PublicNode with Infinity capacity)
    // These providers should never be throttled based on CU usage
    if (!Number.isFinite(config.monthlyLimitCU)) {
      state.shouldThrottle = false;
      state.estimatedDaysRemaining = Infinity;
      return;
    }

    const dayOfMonth = this.getCachedDayOfMonth();
    const daysInMonth = 30;
    const daysRemaining = daysInMonth - dayOfMonth;

    // Calculate usage percentage
    const monthlyUsagePercent = (state.monthlyUsedCU / config.monthlyLimitCU) * 100;
    const dailyUsagePercent = config.dailyLimitCU
      ? (state.dailyUsedCU / config.dailyLimitCU) * 100
      : 0;

    // Estimate daily burn rate
    const now = Date.now();
    const daysSinceReset = Math.max(1, (now - state.lastMonthlyReset) / (1000 * 60 * 60 * 24));
    const dailyBurnRate = state.monthlyUsedCU / daysSinceReset;

    // Estimate days remaining at current burn rate
    const remaining = config.monthlyLimitCU - state.monthlyUsedCU;
    state.estimatedDaysRemaining = dailyBurnRate > 0
      ? Math.floor(remaining / dailyBurnRate)
      : daysRemaining;

    // Determine if throttling is needed
    // Throttle if: >80% monthly used OR daily limit exceeded OR will exhaust before month end
    state.shouldThrottle =
      monthlyUsagePercent > 80 ||
      dailyUsagePercent > 90 ||
      state.estimatedDaysRemaining < daysRemaining;

    if (state.shouldThrottle && monthlyUsagePercent > 70) {
      this.logger.warn('Provider approaching budget limit', {
        provider: providerName,
        monthlyUsagePercent: monthlyUsagePercent.toFixed(1),
        dailyUsagePercent: dailyUsagePercent.toFixed(1),
        estimatedDaysRemaining: state.estimatedDaysRemaining
      });
    }
  }

  /**
   * Check if a provider should be throttled due to budget constraints
   *
   * @param providerName - Provider identifier
   * @returns true if provider should be deprioritized
   */
  shouldThrottleProvider(providerName: string): boolean {
    const state = this.providerBudgets.get(providerName.toLowerCase());
    return state?.shouldThrottle ?? false;
  }

  /**
   * Get budget status for a provider
   *
   * @param providerName - Provider identifier
   * @returns Budget state or null if not tracked
   */
  getProviderBudget(providerName: string): ProviderBudgetState | null {
    const state = this.providerBudgets.get(providerName.toLowerCase());
    return state ? { ...state } : null;
  }

  /**
   * Get budget status for all providers
   */
  getAllProviderBudgets(): Record<string, ProviderBudgetState> {
    const result: Record<string, ProviderBudgetState> = {};
    for (const [name, state] of this.providerBudgets) {
      result[name] = { ...state };
    }
    return result;
  }

  /**
   * Select the best provider considering both health scores and budget constraints
   *
   * @param chainId - Chain identifier
   * @param candidates - List of candidate URLs
   * @param providerExtractor - Function to extract provider name from URL
   * @returns Best available URL considering health and budget
   */
  selectBestProviderWithBudget(
    chainId: string,
    candidates: string[],
    providerExtractor: (url: string) => string
  ): string {
    if (candidates.length === 0) {
      throw new Error('No candidate providers provided');
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Score each candidate considering both health and budget
    let bestUrl = candidates[0];
    let bestScore = -Infinity;

    for (const url of candidates) {
      const healthScore = this.getHealthScore(url, chainId);
      const providerName = providerExtractor(url);
      const shouldThrottle = this.shouldThrottleProvider(providerName);

      // Penalize throttled providers by 50%
      const effectiveScore = shouldThrottle ? healthScore * 0.5 : healthScore;

      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestUrl = url;
      }
    }

    this.logger.debug('Selected best provider with budget consideration', {
      chainId,
      selectedUrl: this.maskUrl(bestUrl),
      score: bestScore,
      candidateCount: candidates.length
    });

    return bestUrl;
  }

  /**
   * Get providers ordered by priority considering time of day and budget.
   *
   * Implements time-based load distribution from RPC_DEEP_DIVE_ANALYSIS.md:
   * - Early UTC (00:00-08:00): Infura primary (fresh daily allocation)
   * - Mid-day UTC (08:00-20:00): dRPC primary (highest capacity)
   * - Late UTC (20:00-24:00): Ankr/PublicNode (absorb Infura overflow)
   *
   * @returns Provider names in priority order (throttled providers moved to end)
   */
  getTimeBasedProviderPriority(): string[] {
    const hour = this.getCachedUtcHour();
    let basePriority: string[];

    if (hour < 8) {
      // Early UTC: Use Infura first (fresh daily allocation)
      basePriority = ['infura', 'drpc', 'ankr', 'publicnode', 'alchemy', 'quicknode', 'blastapi'];
    } else if (hour < 20) {
      // Mid-day: Use dRPC primary (highest capacity)
      basePriority = ['drpc', 'ankr', 'publicnode', 'infura', 'alchemy', 'quicknode', 'blastapi'];
    } else {
      // Late UTC: Spread across Ankr/PublicNode
      basePriority = ['ankr', 'publicnode', 'drpc', 'alchemy', 'infura', 'quicknode', 'blastapi'];
    }

    // Re-order based on throttle status (move throttled providers to end)
    const throttled: string[] = [];
    const notThrottled: string[] = [];

    for (const provider of basePriority) {
      if (this.shouldThrottleProvider(provider)) {
        throttled.push(provider);
      } else {
        notThrottled.push(provider);
      }
    }

    return [...notThrottled, ...throttled];
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalProviders: number;
    providersByChain: Record<string, number>;
    avgOverallScore: number;
    unhealthyProviders: number;
  } {
    const chainCounts: Record<string, number> = {};
    let totalScore = 0;
    let unhealthyCount = 0;

    for (const metrics of this.metrics.values()) {
      chainCounts[metrics.chainId] = (chainCounts[metrics.chainId] ?? 0) + 1;
      totalScore += metrics.overallScore;

      if (!this.isProviderHealthy(metrics.url, metrics.chainId)) {
        unhealthyCount++;
      }
    }

    return {
      totalProviders: this.metrics.size,
      providersByChain: chainCounts,
      avgOverallScore: this.metrics.size > 0 ? totalScore / this.metrics.size : 100,
      unhealthyProviders: unhealthyCount
    };
  }
}

// Singleton instance
let healthScorerInstance: ProviderHealthScorer | null = null;

/**
 * Get the singleton health scorer instance
 */
export function getProviderHealthScorer(): ProviderHealthScorer {
  if (!healthScorerInstance) {
    healthScorerInstance = new ProviderHealthScorer();
  }
  return healthScorerInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetProviderHealthScorer(): void {
  if (healthScorerInstance) {
    healthScorerInstance.shutdown();
    healthScorerInstance = null;
  }
}

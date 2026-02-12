/**
 * Simulation Service
 *
 * Manages multiple simulation providers with:
 * - Health scoring and automatic failover
 * - Provider priority and selection based on performance
 * - Metrics aggregation across providers
 *
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

import { getErrorMessage, clearIntervalSafe } from '@arbitrage/core';
import type { Logger } from '../../types';
import {
  ISimulationService,
  ISimulationProvider,
  SimulationServiceConfig,
  SimulationRequest,
  SimulationResult,
  SimulationMetrics,
  SimulationProviderHealth,
  SimulationProviderType,
  SIMULATION_DEFAULTS,
  createCancellableTimeout,
  isDeprecatedChain,
  getDeprecationWarning,
  isSolanaChain,
} from './types';

// =============================================================================
// Service Configuration
// =============================================================================

export interface SimulationServiceOptions {
  /** Simulation providers to use */
  providers: ISimulationProvider[];
  /** Logger instance */
  logger: Logger;
  /** Service configuration */
  config?: SimulationServiceConfig;
}

// =============================================================================
// Simulation Service Implementation
// =============================================================================

/**
 * Simulation service that manages multiple providers
 *
 * Provides intelligent provider selection based on:
 * - Provider health status
 * - Response latency
 * - Success rate
 * - Configured priority
 */
/**
 * Fix PERF 10.3: Increased cache TTL from 1s to 5s for hot-path optimization.
 * Provider health changes are relatively slow (network issues, rate limits),
 * so 5s is still responsive while reducing re-sorting overhead by 5x.
 * Additionally, the cache is invalidated immediately on any provider failure,
 * so stale orderings don't persist when health degrades.
 */
const PROVIDER_ORDER_CACHE_TTL_MS = 5000;

// Maximum cache size to prevent unbounded memory growth
const MAX_CACHE_SIZE = 500;

/**
 * Fix 4.2: Periodic cache cleanup interval.
 * Runs every 30 seconds to remove expired entries even when no simulations are running.
 * This prevents stale entries from accumulating.
 */
const CACHE_CLEANUP_INTERVAL_MS = 30000;

/** Cache entry for simulation results */
interface CacheEntry {
  result: SimulationResult;
  expiresAt: number;
}

export class SimulationService implements ISimulationService {
  private readonly providers: Map<SimulationProviderType, ISimulationProvider>;
  private readonly logger: Logger;
  private readonly config: Required<SimulationServiceConfig>;

  // Internal metrics
  private fallbackUsedCount = 0;
  private cacheHitsCount = 0;
  private stopped = false;

  // Provider order cache for hot-path optimization
  private cachedProviderOrder: ISimulationProvider[] = [];
  private providerOrderCacheTime = 0;

  // Fix 10.4: Cache for hasEnabledProvider check (hot-path optimization)
  private hasEnabledProviderCache = false;
  private hasEnabledProviderCacheTime = 0;

  // Simulation result cache for request deduplication
  private readonly simulationCache = new Map<string, CacheEntry>();

  /**
   * Fix 5.1: Pending request map for request coalescing.
   * If two requests for the same key arrive simultaneously:
   * - First request starts simulation, stores promise in pendingRequests
   * - Second request finds pending promise, awaits it instead of starting new simulation
   * This prevents wasted work under high load and avoids race conditions.
   */
  private readonly pendingRequests = new Map<string, Promise<SimulationResult>>();

  /**
   * Fix 4.2: Periodic cache cleanup interval.
   * Prevents stale entries from accumulating when no simulations are running.
   */
  private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: SimulationServiceOptions) {
    this.logger = options.logger;

    // Store providers by type
    this.providers = new Map();
    for (const provider of options.providers) {
      this.providers.set(provider.type, provider);
    }

    // Merge config with defaults
    this.config = {
      minProfitForSimulation: options.config?.minProfitForSimulation ?? SIMULATION_DEFAULTS.minProfitForSimulation,
      bypassForTimeCritical: options.config?.bypassForTimeCritical ?? true,
      timeCriticalThresholdMs: options.config?.timeCriticalThresholdMs ?? SIMULATION_DEFAULTS.timeCriticalThresholdMs,
      providerPriority: options.config?.providerPriority ?? SIMULATION_DEFAULTS.providerPriority,
      useFallback: options.config?.useFallback ?? true,
      cacheTtlMs: options.config?.cacheTtlMs ?? SIMULATION_DEFAULTS.cacheTtlMs,
      // Fix 10.4: Added configurable health check interval
      healthCheckIntervalMs: options.config?.healthCheckIntervalMs ?? SIMULATION_DEFAULTS.healthCheckIntervalMs,
    };

    // Fix 7.2: Validate provider priority configuration
    this.validateProviderPriority();

    // Fix 4.2: Start periodic cache cleanup
    this.startCacheCleanup();

    this.logger.info('SimulationService initialized', {
      providers: Array.from(this.providers.keys()),
      config: this.config,
    });
  }

  /**
   * Fix 4.2: Start periodic cache cleanup.
   * Removes expired entries even when no simulations are running.
   */
  private startCacheCleanup(): void {
    // Avoid multiple intervals
    if (this.cacheCleanupInterval) {
      return;
    }

    this.cacheCleanupInterval = setInterval(() => {
      // Self-clear if stopped (per code conventions)
      if (this.stopped) {
        this.cacheCleanupInterval = clearIntervalSafe(this.cacheCleanupInterval);
        return;
      }

      // Cleanup expired entries
      this.cleanupCache();

      this.logger.debug('Periodic cache cleanup', {
        cacheSize: this.simulationCache.size,
      });
    }, CACHE_CLEANUP_INTERVAL_MS);
  }

  /**
   * Fix 7.2: Validate provider priority configuration.
   * Warns about invalid or unregistered provider types.
   *
   * Note: 'helius' is valid but not included in providerPriority by default
   * since it's only used for Solana chains (routed automatically).
   */
  private validateProviderPriority(): void {
    const validTypes: SimulationProviderType[] = ['tenderly', 'alchemy', 'local', 'helius'];
    const registeredProviders = Array.from(this.providers.keys());

    for (const type of this.config.providerPriority) {
      if (!validTypes.includes(type)) {
        this.logger.error(`Invalid provider type '${type}' in providerPriority`, {
          validTypes,
          configuredPriority: this.config.providerPriority,
        });
      } else if (!registeredProviders.includes(type)) {
        this.logger.warn(`Provider '${type}' in priority but not registered`, {
          registeredProviders,
          configuredPriority: this.config.providerPriority,
        });
      }
    }
  }

  /**
   * Initialize the service.
   *
   * Fix 10.2: Pre-warm provider health status during initialization.
   * This ensures the first simulation request doesn't start with all
   * providers showing healthy=false and successRate=0.
   */
  async initialize(): Promise<void> {
    // Fix 10.2: Pre-warm provider health status
    // Run health checks in parallel for faster startup
    const healthCheckPromises: Promise<void>[] = [];
    for (const [type, provider] of this.providers) {
      if (provider.isEnabled()) {
        healthCheckPromises.push(
          provider.healthCheck()
            .then((result) => {
              this.logger.debug('Provider health check warmup complete', {
                provider: type,
                healthy: result.healthy,
                message: result.message,
              });
            })
            .catch((err) => {
              // Non-fatal: log and continue - provider will be marked unhealthy
              this.logger.warn('Provider health check warmup failed', {
                provider: type,
                error: err instanceof Error ? err.message : String(err),
              });
            })
        );
      }
    }

    // Wait for all health checks to complete (with timeout protection)
    if (healthCheckPromises.length > 0) {
      await Promise.allSettled(healthCheckPromises);
    }

    this.logger.info('SimulationService initialization complete', {
      providerCount: this.providers.size,
      enabledProviders: Array.from(this.providers.entries())
        .filter(([_, p]) => p.isEnabled())
        .map(([type, _]) => type),
    });
  }

  /**
   * Simulate a transaction using the best available provider.
   *
   * Fix 5.1: Implements request coalescing to prevent duplicate simulations.
   * If a simulation for the same request is already in progress, the caller
   * waits for that result instead of starting a duplicate simulation.
   *
   * Chain Routing (Solana Enhancement):
   * - Solana chains are routed to HeliusSimulationProvider automatically
   * - EVM chains use Tenderly/Alchemy/Local providers with health-based selection
   */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    if (this.stopped) {
      return this.createErrorResult('Simulation service is stopped');
    }

    // Fix: Warn about deprecated chains (e.g., Goerli)
    if (isDeprecatedChain(request.chain)) {
      const warning = getDeprecationWarning(request.chain);
      this.logger.warn('Deprecated chain detected', {
        chain: request.chain,
        warning,
        hint: 'Update to a supported chain to avoid unexpected behavior',
      });
    }

    // Check cache first (only for successful results)
    const cacheKey = this.getCacheKey(request);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.cacheHitsCount++;
      this.logger.debug('Simulation cache hit', { cacheKey });
      return cached;
    }

    // Fix 5.1: Check if simulation is already in progress for this key
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      this.logger.debug('Simulation request coalesced', { cacheKey });
      return pending;
    }

    // Chain routing: Solana uses Helius provider, EVM uses standard providers
    let simulationPromise: Promise<SimulationResult>;

    if (isSolanaChain(request.chain)) {
      simulationPromise = this.executeSolanaSimulation(request, cacheKey);
    } else {
      simulationPromise = this.executeSimulationWithFallback(request, cacheKey);
    }

    // Fix 5.1: Store in pending map for request coalescing
    this.pendingRequests.set(cacheKey, simulationPromise);

    try {
      return await simulationPromise;
    } finally {
      // Fix 5.1: Always clean up pending request
      this.pendingRequests.delete(cacheKey);
    }
  }

  /**
   * Execute simulation for Solana chain using Helius provider.
   *
   * Solana simulation is routed separately because:
   * 1. Different provider (Helius instead of Tenderly/Alchemy)
   * 2. Different transaction format (base64 encoded instead of EVM tx)
   * 3. Different result format (program logs instead of EVM logs)
   */
  private async executeSolanaSimulation(
    request: SimulationRequest,
    cacheKey: string
  ): Promise<SimulationResult> {
    // Get Helius provider
    const heliusProvider = this.providers.get('helius');

    if (!heliusProvider || !heliusProvider.isEnabled()) {
      this.logger.warn('Solana simulation requested but Helius provider not available', {
        chain: request.chain,
        hasProvider: !!heliusProvider,
        isEnabled: heliusProvider?.isEnabled(),
      });
      return this.createErrorResult(
        'Solana simulation not available: Helius provider not configured'
      );
    }

    // Execute simulation with Helius
    const result = await this.tryProvider(heliusProvider, request);

    // Cache successful results
    if (result.success) {
      this.addToCache(cacheKey, result);
    }

    return result;
  }

  /**
   * Fix 5.1: Internal method that executes simulation with fallback logic.
   * Extracted from simulate() to support request coalescing.
   */
  private async executeSimulationWithFallback(
    request: SimulationRequest,
    cacheKey: string
  ): Promise<SimulationResult> {
    // Get ordered list of providers to try
    const orderedProviders = this.getOrderedProviders();

    if (orderedProviders.length === 0) {
      return this.createErrorResult('No simulation providers available');
    }

    // Try primary provider
    const primaryProvider = orderedProviders[0];
    const primaryResult = await this.tryProvider(primaryProvider, request);

    // If successful (even if tx would revert), cache and return result
    if (primaryResult.success) {
      this.addToCache(cacheKey, primaryResult);
      return primaryResult;
    }

    // If fallback disabled, return primary result
    if (!this.config.useFallback) {
      return primaryResult;
    }

    // Try fallback providers
    let lastResult = primaryResult;
    let lastProvider = primaryProvider;

    for (let i = 1; i < orderedProviders.length; i++) {
      const fallbackProvider = orderedProviders[i];

      this.logger.debug('Trying fallback provider', {
        primary: primaryProvider.type,
        fallback: fallbackProvider.type,
        reason: lastResult.error,
      });

      const fallbackResult = await this.tryProvider(fallbackProvider, request);

      if (fallbackResult.success) {
        this.fallbackUsedCount++;
        this.logger.info('Fallback provider succeeded', {
          provider: fallbackProvider.type,
        });
        this.addToCache(cacheKey, fallbackResult);
        return fallbackResult;
      }

      lastResult = fallbackResult;
      lastProvider = fallbackProvider;
    }

    // All providers failed
    return this.createErrorResult(
      `All simulation providers failed. Last error: ${lastResult.error}`,
      lastProvider.type
    );
  }

  /**
   * Check if simulation should be performed for an opportunity.
   *
   * Hot-path optimization: Uses hasEnabledProvider() instead of getOrderedProviders()
   * to avoid full provider scoring on every call.
   */
  shouldSimulate(expectedProfit: number, opportunityAge: number): boolean {
    // Check if any providers are available (fast check, no sorting)
    if (!this.hasEnabledProvider()) {
      return false;
    }

    // Check minimum profit threshold
    if (expectedProfit < this.config.minProfitForSimulation) {
      return false;
    }

    // Check time-critical bypass
    if (this.config.bypassForTimeCritical) {
      if (opportunityAge > this.config.timeCriticalThresholdMs) {
        this.logger.debug('Skipping simulation for time-critical opportunity', {
          opportunityAge,
          threshold: this.config.timeCriticalThresholdMs,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Fast check if any provider is enabled.
   * Used by shouldSimulate() to avoid expensive getOrderedProviders() call.
   *
   * Fix 10.4: Uses caching to avoid iteration on every shouldSimulate() call.
   * Cache is invalidated when provider order is invalidated (on failure).
   *
   * Analysis Note (Finding 10.4): This optimization is ALREADY implemented.
   * The hasEnabledProviderCache avoids O(n) provider iteration on hot-path.
   */
  private hasEnabledProvider(): boolean {
    const now = Date.now();

    // Return cached value if still valid
    if (now - this.hasEnabledProviderCacheTime < PROVIDER_ORDER_CACHE_TTL_MS) {
      return this.hasEnabledProviderCache;
    }

    // Recalculate and cache
    let hasEnabled = false;
    for (const provider of this.providers.values()) {
      if (provider.isEnabled()) {
        hasEnabled = true;
        break;
      }
    }

    this.hasEnabledProviderCache = hasEnabled;
    this.hasEnabledProviderCacheTime = now;

    return hasEnabled;
  }

  /**
   * Get aggregated metrics from all providers
   */
  getAggregatedMetrics(): SimulationMetrics {
    let totalSimulations = 0;
    let successfulSimulations = 0;
    let failedSimulations = 0;
    let predictedReverts = 0;
    let cacheHits = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const provider of this.providers.values()) {
      const metrics = provider.getMetrics();
      totalSimulations += metrics.totalSimulations;
      successfulSimulations += metrics.successfulSimulations;
      failedSimulations += metrics.failedSimulations;
      predictedReverts += metrics.predictedReverts;
      cacheHits += metrics.cacheHits;

      if (metrics.successfulSimulations > 0) {
        latencySum += metrics.averageLatencyMs * metrics.successfulSimulations;
        latencyCount += metrics.successfulSimulations;
      }
    }

    return {
      totalSimulations,
      successfulSimulations,
      failedSimulations,
      predictedReverts,
      averageLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
      fallbackUsed: this.fallbackUsedCount,
      cacheHits: cacheHits + this.cacheHitsCount, // Include service-level cache hits
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get health status of all providers
   */
  getProvidersHealth(): Map<SimulationProviderType, SimulationProviderHealth> {
    const healthMap = new Map<SimulationProviderType, SimulationProviderHealth>();

    for (const [type, provider] of this.providers) {
      healthMap.set(type, provider.getHealth());
    }

    return healthMap;
  }

  /**
   * Stop the service
   *
   * Fix 4.2: Also clears the cache cleanup interval.
   */
  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    // Fix 4.2: Stop periodic cache cleanup
    this.cacheCleanupInterval = clearIntervalSafe(this.cacheCleanupInterval);

    // Clear the cache to free memory
    this.simulationCache.clear();

    // Fix 5.1: Clear pending requests (they will reject on next await)
    this.pendingRequests.clear();

    this.logger.info('SimulationService stopped');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Try to simulate using a specific provider with timeout protection.
   *
   * Fix 3.1: Uses provider-specific timeout instead of global default.
   * This allows fine-tuning timeouts per provider (e.g., shorter for local,
   * longer for Tenderly when rate-limited).
   *
   * Fix 4.1: Uses createCancellableTimeout to prevent timer leaks.
   * The timeout is always cancelled in the finally block, ensuring
   * no orphaned timers accumulate over time.
   *
   * Uses Promise.race() to prevent hanging provider requests from blocking
   * execution indefinitely. This is critical for arbitrage trading where
   * timing determines profitability.
   *
   * @param provider - The simulation provider to use
   * @param request - The simulation request
   * @returns SimulationResult (success or error with timeout info)
   */
  private async tryProvider(
    provider: ISimulationProvider,
    request: SimulationRequest
  ): Promise<SimulationResult> {
    // Fix 3.1: Use provider-specific timeout from health metrics,
    // falling back to default if no latency data yet
    const health = provider.getHealth();
    const timeoutMs = health.averageLatencyMs > 0
      ? Math.max(health.averageLatencyMs * 3, SIMULATION_DEFAULTS.timeoutMs) // 3x avg latency or default
      : SIMULATION_DEFAULTS.timeoutMs;
    const startTime = Date.now();

    // Fix 4.1: Use cancellable timeout to prevent timer leaks
    const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<SimulationResult>(
      timeoutMs,
      `Simulation timeout after ${timeoutMs}ms`
    );

    try {
      const result = await Promise.race([
        provider.simulate(request),
        timeoutPromise,
      ]);

      // Fix 5.1: Invalidate cache on failure so degraded providers get re-scored quickly
      if (!result.success) {
        this.invalidateProviderOrderCache();
      }

      return result;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const isTimeout = errorMessage.includes('timeout');

      this.logger.error('Provider simulation error', {
        provider: provider.type,
        error: errorMessage,
        isTimeout,
        elapsedMs: Date.now() - startTime,
      });

      // Fix 5.1: Invalidate cache on error so degraded providers get re-scored quickly
      this.invalidateProviderOrderCache();

      return this.createErrorResult(errorMessage, provider.type);
    } finally {
      // Fix 4.1: Always cancel the timeout to prevent timer leak
      cancelTimeout();
    }
  }

  /**
   * Fix 5.1: Invalidate provider order cache.
   *
   * Called when a provider fails to ensure degraded providers are
   * re-scored quickly rather than waiting for the cache TTL to expire.
   * This is important for hot-path arbitrage where provider health
   * can change rapidly.
   *
   * Fix 10.4: Also invalidates hasEnabledProvider cache.
   */
  private invalidateProviderOrderCache(): void {
    this.cachedProviderOrder = [];
    this.providerOrderCacheTime = 0;
    // Fix 10.4: Also invalidate hasEnabledProvider cache
    this.hasEnabledProviderCacheTime = 0;
  }

  /**
   * Get providers ordered by health score
   *
   * Scoring considers:
   * 1. Health status (healthy > unhealthy)
   * 2. Success rate (higher is better)
   * 3. Latency (lower is better)
   * 4. Configured priority (as tiebreaker)
   *
   * Uses caching to avoid recalculation on every call (hot-path optimization)
   */
  private getOrderedProviders(): ISimulationProvider[] {
    const now = Date.now();

    // Return cached order if still valid
    if (
      this.cachedProviderOrder.length > 0 &&
      now - this.providerOrderCacheTime < PROVIDER_ORDER_CACHE_TTL_MS
    ) {
      return this.cachedProviderOrder;
    }

    const enabledProviders: ISimulationProvider[] = [];

    for (const provider of this.providers.values()) {
      if (provider.isEnabled()) {
        enabledProviders.push(provider);
      }
    }

    // Score and sort providers
    const scoredProviders = enabledProviders.map((provider) => ({
      provider,
      score: this.calculateProviderScore(provider),
    }));

    scoredProviders.sort((a, b) => b.score - a.score);

    // Update cache
    this.cachedProviderOrder = scoredProviders.map((sp) => sp.provider);
    this.providerOrderCacheTime = now;

    return this.cachedProviderOrder;
  }

  /**
   * Calculate a score for provider selection
   *
   * Higher score = better choice
   */
  private calculateProviderScore(provider: ISimulationProvider): number {
    const health = provider.getHealth();
    let score = 0;

    // Health status: +100 if healthy
    if (health.healthy) {
      score += 100;
    }

    // Success rate: up to +50 based on success rate
    score += health.successRate * 50;

    // Latency: up to +30 based on inverse latency
    // Normalize: 100ms = 30 points, 500ms = 6 points
    if (health.averageLatencyMs > 0) {
      const latencyScore = Math.min(30, 3000 / health.averageLatencyMs);
      score += latencyScore;
    } else {
      score += 15; // Default if no latency data
    }

    // Priority bonus: +20 for first in priority list, descending
    const priorityIndex = this.config.providerPriority.indexOf(provider.type);
    if (priorityIndex >= 0) {
      score += 20 - priorityIndex * 5;
    }

    return score;
  }

  /**
   * Create error result
   *
   * @param error - Error message
   * @param provider - Provider that caused the error (defaults to first in priority)
   */
  private createErrorResult(error: string, provider?: SimulationProviderType): SimulationResult {
    return {
      success: false,
      wouldRevert: false,
      error,
      provider: provider ?? this.config.providerPriority[0] ?? 'local',
      latencyMs: 0,
    };
  }

  // ===========================================================================
  // Cache Methods
  // ===========================================================================

  /**
   * Generate cache key from simulation request.
   *
   * Fix 9.4 + Fix 4.3: Improved key generation to avoid collisions.
   * Uses length-prefixed fields for ALL values to prevent collisions.
   *
   * Analysis Note (Finding 10.3): Cache key optimization is ALREADY implemented.
   * The length-prefixed format avoids expensive JSON.stringify() and provides
   * O(1) key construction with collision-proof semantics.
   *
   * Key is based on chain, transaction params, and block number.
   */
  private getCacheKey(request: SimulationRequest): string {
    const tx = request.transaction;

    // Extract values, normalizing addresses to lowercase
    const chain = request.chain;
    const from = (tx.from?.toString() ?? '').toLowerCase();
    const to = (tx.to?.toString() ?? '').toLowerCase();
    const data = tx.data?.toString() ?? '';
    const value = tx.value?.toString() ?? '0';
    const block = request.blockNumber?.toString() ?? 'latest';

    // Fix 4.3: Use length-prefixed format for ALL fields to prevent collisions
    // Even though chain names are controlled internally, this makes the cache
    // key format completely collision-proof and consistent.
    // Format: len:chain|len:from|len:to|len:data|len:value|len:block
    return [
      `${chain.length}:${chain}`,
      `${from.length}:${from}`,
      `${to.length}:${to}`,
      `${data.length}:${data}`,
      `${value.length}:${value}`,
      `${block.length}:${block}`,
    ].join('|');
  }

  /**
   * Get result from cache if valid
   */
  private getFromCache(key: string): SimulationResult | null {
    const entry = this.simulationCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      // Expired, remove from cache
      this.simulationCache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Add result to cache
   *
   * Only caches successful results (not errors).
   * Enforces a hard limit on cache size to prevent memory leaks.
   */
  private addToCache(key: string, result: SimulationResult): void {
    if (!result.success) return; // Don't cache failures

    const entry: CacheEntry = {
      result,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    };

    this.simulationCache.set(key, entry);

    // Deterministic cleanup when cache exceeds threshold
    // Cleanup at 80% capacity to avoid cleanup on every add
    if (this.simulationCache.size >= MAX_CACHE_SIZE * 0.8) {
      this.cleanupCache();
    }

    // Hard limit: if still over max after cleanup, evict oldest entries
    if (this.simulationCache.size >= MAX_CACHE_SIZE) {
      this.evictOldestEntries(this.simulationCache.size - MAX_CACHE_SIZE + 50);
    }
  }

  /**
   * Remove expired entries from cache
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.simulationCache) {
      if (now > entry.expiresAt) {
        this.simulationCache.delete(key);
      }
    }
  }

  /**
   * Evict oldest entries when cache is at capacity.
   * Uses insertion order (Map guarantees iteration order).
   */
  private evictOldestEntries(count: number): void {
    let evicted = 0;
    for (const key of this.simulationCache.keys()) {
      if (evicted >= count) break;
      this.simulationCache.delete(key);
      evicted++;
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a simulation service with providers
 */
export function createSimulationService(options: SimulationServiceOptions): SimulationService {
  return new SimulationService(options);
}

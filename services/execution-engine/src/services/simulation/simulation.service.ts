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

import { getErrorMessage } from '@arbitrage/core';
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
// Cache TTL for provider ordering (1 second for hot-path optimization)
const PROVIDER_ORDER_CACHE_TTL_MS = 1000;

// Maximum cache size to prevent unbounded memory growth
const MAX_CACHE_SIZE = 500;

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

  // Simulation result cache for request deduplication
  private readonly simulationCache = new Map<string, CacheEntry>();

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
    };

    this.logger.info('SimulationService initialized', {
      providers: Array.from(this.providers.keys()),
      config: this.config,
    });
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    this.logger.info('SimulationService initialization complete', {
      providerCount: this.providers.size,
    });
  }

  /**
   * Simulate a transaction using the best available provider
   */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    if (this.stopped) {
      return this.createErrorResult('Simulation service is stopped');
    }

    // Check cache first (only for successful results)
    const cacheKey = this.getCacheKey(request);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.cacheHitsCount++;
      this.logger.debug('Simulation cache hit', { cacheKey });
      return cached;
    }

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
   */
  private hasEnabledProvider(): boolean {
    for (const provider of this.providers.values()) {
      if (provider.isEnabled()) {
        return true;
      }
    }
    return false;
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
   */
  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.logger.info('SimulationService stopped');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Try to simulate using a specific provider
   */
  private async tryProvider(
    provider: ISimulationProvider,
    request: SimulationRequest
  ): Promise<SimulationResult> {
    try {
      return await provider.simulate(request);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error('Provider simulation error', {
        provider: provider.type,
        error: errorMessage,
      });
      return this.createErrorResult(errorMessage, provider.type);
    }
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
   * Generate cache key from simulation request
   *
   * Key is based on chain, transaction params, and block number
   */
  private getCacheKey(request: SimulationRequest): string {
    const tx = request.transaction;
    // Create deterministic key from request params
    const parts = [
      request.chain,
      tx.from?.toString().toLowerCase() ?? '',
      tx.to?.toString().toLowerCase() ?? '',
      tx.data?.toString() ?? '',
      tx.value?.toString() ?? '0',
      request.blockNumber?.toString() ?? 'latest',
    ];
    return parts.join(':');
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

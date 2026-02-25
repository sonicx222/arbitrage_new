/**
 * WarmCache Use Case (Enhancement #2)
 *
 * Orchestrates predictive cache warming based on correlation data.
 * Follows Use Case Pattern from Clean Architecture.
 *
 * @see docs/architecture/adr/ADR-005-hierarchical-cache.md - Predictive warming
 * @see warming/domain/cache-warmer.interface.ts - ICacheWarmer contract
 *
 * @package @arbitrage/core
 * @module warming/application/use-cases
 */

import { ICacheWarmer, ICorrelationTracker } from '../../domain';
import { WarmCacheRequest, WarmCacheResponse } from '../dtos/warm-cache.dto';
import { getErrorMessage } from '../../../resilience/error-handling';
/**
 * Use Case: Warm cache for correlated trading pairs
 *
 * Responsibilities:
 * - Validate warming request
 * - Query correlation tracker for related pairs
 * - Trigger cache warmer to fetch and promote pairs
 * - Return warming result with metrics
 *
 * Dependencies (injected):
 * - ICacheWarmer - performs actual warming
 * - ICorrelationTracker - provides correlation data
 *
 * Performance:
 * - Target: <10ms for 5 pairs
 * - Async operation, does not block hot path
 *
 * @example
 * ```typescript
 * const useCase = new WarmCacheUseCase(cacheWarmer, correlationTracker);
 *
 * const request = WarmCacheRequest.create({
 *   sourcePair: 'WETH_USDT',
 *   maxPairsToWarm: 5,
 *   minCorrelationScore: 0.3,
 * });
 *
 * const response = await useCase.execute(request);
 * console.log(response.pairsWarmed); // 4
 * console.log(response.getEffectiveness()); // 80%
 * ```
 */
export class WarmCacheUseCase {
  constructor(
    private readonly cacheWarmer: ICacheWarmer,
    private readonly correlationTracker: ICorrelationTracker
  ) {}

  /**
   * Execute cache warming
   *
   * Algorithm:
   * 1. Validate request (handled by DTO)
   * 2. Query correlation tracker for top N correlated pairs
   * 3. If no correlations found, return early (no warming needed)
   * 4. Trigger cache warmer with source pair
   * 5. Map ICacheWarmer result to WarmCacheResponse
   * 6. Handle errors gracefully
   *
   * @param request - Validated warming request
   * @returns Warming response with metrics
   */
  async execute(request: WarmCacheRequest): Promise<WarmCacheResponse> {
    const startTime = performance.now();

    try {
      // Check if there are any correlations to warm
      const correlatedPairs = this.correlationTracker.getPairsToWarm(
        request.sourcePair,
        request.maxPairsToWarm,
        request.minCorrelationScore
      );

      if (correlatedPairs.length === 0) {
        // No correlated pairs found, nothing to warm
        const durationMs = performance.now() - startTime;
        return WarmCacheResponse.success({
          sourcePair: request.sourcePair,
          pairsAttempted: 0,
          pairsWarmed: 0,
          pairsAlreadyInL1: 0,
          pairsNotFound: 0,
          durationMs,
        });
      }

      // Update cache warmer config to match request
      this.cacheWarmer.updateConfig({
        maxPairsPerWarm: request.maxPairsToWarm,
        minCorrelationScore: request.minCorrelationScore,
        timeoutMs: request.timeoutMs,
        asyncWarming: true,
        enabled: true,
      });

      // Trigger warming
      const warmingResult = await this.cacheWarmer.warmForPair(request.sourcePair);

      // Map domain result to DTO response
      const durationMs = performance.now() - startTime;
      return WarmCacheResponse.success({
        sourcePair: request.sourcePair,
        pairsAttempted: warmingResult.pairsAttempted,
        pairsWarmed: warmingResult.pairsWarmed,
        pairsAlreadyInL1: warmingResult.pairsAlreadyInL1,
        pairsNotFound: warmingResult.pairsNotFound,
        durationMs,
      });
    } catch (error) {
      // Handle errors gracefully
      const durationMs = performance.now() - startTime;
      const errorMessage = getErrorMessage(error);
      return WarmCacheResponse.failure(
        request.sourcePair,
        errorMessage,
        durationMs
      );
    }
  }

  /**
   * Execute warming for multiple pairs (batch operation)
   *
   * Useful for:
   * - Startup cache warming
   * - Scheduled warming of hot pairs
   * - Manual warming triggers
   *
   * @param pairs - Array of pairs to warm
   * @returns Array of warming responses
   */
  async executeBatch(pairs: string[]): Promise<WarmCacheResponse[]> {
    const requests = pairs.map(pair =>
      WarmCacheRequest.create({ sourcePair: pair })
    );

    // Execute all warming operations in parallel
    return Promise.all(requests.map(req => this.execute(req)));
  }

  /**
   * Check if warming is currently enabled
   *
   * @returns True if warming is enabled
   */
  isEnabled(): boolean {
    return this.cacheWarmer.getConfig().enabled;
  }

  /**
   * Get warming statistics
   *
   * @returns Warming stats from cache warmer
   */
  getStats() {
    return this.cacheWarmer.getStats();
  }
}

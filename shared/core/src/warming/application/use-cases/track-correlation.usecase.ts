/**
 * TrackCorrelation Use Case (Enhancement #2)
 *
 * Records price update correlations for predictive warming.
 * Follows Use Case Pattern from Clean Architecture.
 *
 * @see docs/architecture/adr/ADR-005-hierarchical-cache.md - Predictive warming
 * @see warming/domain/correlation-tracker.interface.ts - ICorrelationTracker contract
 *
 * @package @arbitrage/core
 * @module warming/application/use-cases
 */

import { ICorrelationTracker } from '../../domain';
import {
  TrackCorrelationRequest,
  TrackCorrelationResponse,
  GetCorrelatedPairsRequest,
  GetCorrelatedPairsResponse,
} from '../dtos/track-correlation.dto';

/**
 * Use Case: Track correlation between trading pairs
 *
 * Responsibilities:
 * - Validate correlation tracking request
 * - Record price update in correlation tracker
 * - Update co-occurrence counts
 * - Return tracking result with metrics
 *
 * Dependencies (injected):
 * - ICorrelationTracker - tracks pair correlations
 *
 * Performance:
 * - HOT PATH operation - must complete in <50μs
 * - Called on every price update (100-500/sec)
 * - Zero allocations in hot path
 *
 * @example
 * ```typescript
 * const useCase = new TrackCorrelationUseCase(correlationTracker);
 *
 * const request = TrackCorrelationRequest.create({
 *   pair: 'WETH_USDT',
 *   timestamp: Date.now(),
 * });
 *
 * const response = await useCase.execute(request);
 * console.log(response.correlationsUpdated); // 3
 * console.log(response.isWithinTarget()); // true (<50μs)
 * ```
 */
export class TrackCorrelationUseCase {
  constructor(private readonly correlationTracker: ICorrelationTracker) {}

  /**
   * Execute correlation tracking (HOT PATH)
   *
   * This is called on EVERY price update, so must be extremely fast.
   *
   * Algorithm:
   * 1. Validate request (handled by DTO)
   * 2. Record price update in correlation tracker
   * 3. Tracker updates co-occurrence counts internally
   * 4. Return tracking result with duration
   *
   * Performance:
   * - Target: <50μs
   * - Uses high-resolution timer (performance.now())
   * - Minimal error handling to avoid overhead
   *
   * @param request - Validated tracking request
   * @returns Tracking response with metrics
   */
  execute(request: TrackCorrelationRequest): TrackCorrelationResponse {
    const startTime = performance.now();

    try {
      // Record price update (hot path)
      const result = this.correlationTracker.recordPriceUpdate(
        request.pair,
        request.timestamp
      );

      // Calculate duration in microseconds
      const durationMs = performance.now() - startTime;
      const durationUs = durationMs * 1000;

      return TrackCorrelationResponse.success({
        pair: request.pair,
        correlationsUpdated: result.correlationsUpdated,
        durationUs,
      });
    } catch (error) {
      // Minimal error handling for hot path
      const durationMs = performance.now() - startTime;
      const durationUs = durationMs * 1000;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return TrackCorrelationResponse.failure(request.pair, errorMessage, durationUs);
    }
  }

  /**
   * Get correlated pairs for a source pair (background operation)
   *
   * This is NOT hot path - used by warming use case to get pairs to warm.
   *
   * @param request - Validated request for correlated pairs
   * @returns Response with correlated pairs
   */
  getCorrelatedPairs(request: GetCorrelatedPairsRequest): GetCorrelatedPairsResponse {
    const startTime = performance.now();

    const correlations = this.correlationTracker.getPairsToWarm(
      request.sourcePair,
      request.topN,
      request.minScore
    );

    const correlatedPairs = correlations.map(c => ({
      pair: c.pair,
      score: c.score,
      coOccurrences: c.coOccurrences,
    }));

    const durationMs = performance.now() - startTime;

    return new GetCorrelatedPairsResponse(
      request.sourcePair,
      correlatedPairs,
      durationMs
    );
  }

  /**
   * Batch track correlations for multiple pairs
   *
   * Useful for:
   * - Processing batch price updates
   * - Backfilling correlation data
   *
   * @param pairs - Array of pairs with timestamps
   * @returns Array of tracking responses
   */
  executeBatch(
    pairs: Array<{ pair: string; timestamp: number }>
  ): TrackCorrelationResponse[] {
    return pairs.map(p => {
      const request = TrackCorrelationRequest.create(p);
      return this.execute(request);
    });
  }

  /**
   * Get correlation score between two specific pairs
   *
   * @param pair1 - First pair
   * @param pair2 - Second pair
   * @returns Correlation score (0.0-1.0) or undefined if no correlation
   */
  getCorrelationScore(pair1: string, pair2: string): number | undefined {
    return this.correlationTracker.getCorrelationScore(pair1, pair2);
  }

  /**
   * Get all pairs currently being tracked
   *
   * @returns Array of tracked pair identifiers
   */
  getTrackedPairs(): string[] {
    return this.correlationTracker.getTrackedPairs();
  }

  /**
   * Get correlation tracking statistics
   *
   * @returns Statistics for monitoring
   */
  getStats() {
    return this.correlationTracker.getStats();
  }

  /**
   * Reset all correlation data
   *
   * Used for testing and when correlation patterns change significantly.
   */
  reset(): void {
    this.correlationTracker.reset();
  }
}

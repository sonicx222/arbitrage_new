/**
 * DTOs for TrackCorrelation Use Case
 *
 * Data Transfer Objects with validation for correlation tracking operations.
 *
 * @package @arbitrage/core
 * @module warming/application/dtos
 */

import { ValidationError } from './warm-cache.dto';

/**
 * Request to track correlation for a price update
 */
export class TrackCorrelationRequest {
  private constructor(
    public readonly pair: string,
    public readonly timestamp: number
  ) {
    Object.freeze(this);
  }

  /**
   * Create validated request
   *
   * @throws {ValidationError} If validation fails
   */
  static create(params: {
    pair: string;
    timestamp?: number;
  }): TrackCorrelationRequest {
    // Validate pair
    if (!params.pair || params.pair.trim().length === 0) {
      throw new ValidationError('pair', 'Pair cannot be empty');
    }

    if (!params.pair.includes('_')) {
      throw new ValidationError(
        'pair',
        'Pair must be in format TOKEN1_TOKEN2 (e.g., WETH_USDT)'
      );
    }

    // Validate timestamp
    const timestamp = params.timestamp ?? Date.now();
    if (timestamp < 0) {
      throw new ValidationError('timestamp', 'Timestamp cannot be negative');
    }

    const now = Date.now();
    const maxFuture = now + 60000; // Max 1 minute in future
    const maxPast = now - 86400000; // Max 24 hours in past

    if (timestamp > maxFuture) {
      throw new ValidationError(
        'timestamp',
        'Timestamp cannot be more than 1 minute in the future'
      );
    }

    if (timestamp < maxPast) {
      throw new ValidationError(
        'timestamp',
        'Timestamp cannot be more than 24 hours in the past'
      );
    }

    return new TrackCorrelationRequest(params.pair, timestamp);
  }

  /**
   * Get age of this update in milliseconds
   */
  getAgeMs(): number {
    return Date.now() - this.timestamp;
  }

  /**
   * Check if update is recent (within time window)
   */
  isRecent(windowMs: number = 60000): boolean {
    return this.getAgeMs() < windowMs;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `TrackCorrelationRequest[${this.pair}@${this.timestamp}]`;
  }
}

/**
 * Response from track correlation operation
 */
export class TrackCorrelationResponse {
  constructor(
    public readonly success: boolean,
    public readonly pair: string,
    public readonly correlationsUpdated: number,
    public readonly durationUs: number,
    public readonly timestamp: number,
    public readonly error?: string
  ) {
    Object.freeze(this);
  }

  /**
   * Create successful response
   */
  static success(params: {
    pair: string;
    correlationsUpdated: number;
    durationUs: number;
  }): TrackCorrelationResponse {
    return new TrackCorrelationResponse(
      true,
      params.pair,
      params.correlationsUpdated,
      params.durationUs,
      Date.now()
    );
  }

  /**
   * Create failure response
   */
  static failure(
    pair: string,
    error: string,
    durationUs: number
  ): TrackCorrelationResponse {
    return new TrackCorrelationResponse(
      false,
      pair,
      0,
      durationUs,
      Date.now(),
      error
    );
  }

  /**
   * Check if operation was fast enough (<50μs target)
   */
  isWithinTarget(targetUs: number = 50): boolean {
    return this.durationUs < targetUs;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    if (!this.success) {
      return `TrackCorrelationResponse[FAILED: ${this.error}]`;
    }
    return `TrackCorrelationResponse[${this.pair}, ${this.correlationsUpdated} updated, ${this.durationUs.toFixed(2)}μs]`;
  }
}

/**
 * Request to get correlated pairs for warming
 */
export class GetCorrelatedPairsRequest {
  private constructor(
    public readonly sourcePair: string,
    public readonly topN: number = 5,
    public readonly minScore: number = 0.3
  ) {
    Object.freeze(this);
  }

  /**
   * Create validated request
   *
   * @throws {ValidationError} If validation fails
   */
  static create(params: {
    sourcePair: string;
    topN?: number;
    minScore?: number;
  }): GetCorrelatedPairsRequest {
    // Validate sourcePair
    if (!params.sourcePair || params.sourcePair.trim().length === 0) {
      throw new ValidationError('sourcePair', 'Source pair cannot be empty');
    }

    // Validate topN
    const topN = params.topN ?? 5;
    if (topN < 1 || topN > 50) {
      throw new ValidationError('topN', 'topN must be between 1 and 50');
    }

    // Validate minScore
    const minScore = params.minScore ?? 0.3;
    if (minScore < 0 || minScore > 1) {
      throw new ValidationError(
        'minScore',
        'minScore must be between 0.0 and 1.0'
      );
    }

    return new GetCorrelatedPairsRequest(params.sourcePair, topN, minScore);
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `GetCorrelatedPairsRequest[${this.sourcePair}, top=${this.topN}, min=${this.minScore}]`;
  }
}

/**
 * Response with correlated pairs
 */
export class GetCorrelatedPairsResponse {
  constructor(
    public readonly sourcePair: string,
    public readonly correlatedPairs: Array<{
      pair: string;
      score: number;
      coOccurrences: number;
    }>,
    public readonly durationMs: number
  ) {
    Object.freeze(this);
  }

  /**
   * Get number of correlated pairs found
   */
  getCount(): number {
    return this.correlatedPairs.length;
  }

  /**
   * Get average correlation score
   */
  getAverageScore(): number {
    if (this.correlatedPairs.length === 0) return 0;
    const sum = this.correlatedPairs.reduce((acc, p) => acc + p.score, 0);
    return sum / this.correlatedPairs.length;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `GetCorrelatedPairsResponse[${this.sourcePair}, ${this.getCount()} pairs, avg=${this.getAverageScore().toFixed(3)}]`;
  }
}

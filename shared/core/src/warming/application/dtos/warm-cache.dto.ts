/**
 * DTOs for WarmCache Use Case
 *
 * Data Transfer Objects with validation for cache warming operations.
 *
 * @package @arbitrage/core
 * @module warming/application/dtos
 */

/**
 * Request to warm cache for a trading pair
 */
export class WarmCacheRequest {
  private constructor(
    public readonly sourcePair: string,
    public readonly maxPairsToWarm: number = 5,
    public readonly minCorrelationScore: number = 0.3,
    public readonly timeoutMs: number = 50
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
    maxPairsToWarm?: number;
    minCorrelationScore?: number;
    timeoutMs?: number;
  }): WarmCacheRequest {
    // Validate sourcePair
    if (!params.sourcePair || params.sourcePair.trim().length === 0) {
      throw new ValidationError('sourcePair', 'Source pair cannot be empty');
    }

    if (!params.sourcePair.includes('_')) {
      throw new ValidationError(
        'sourcePair',
        'Source pair must be in format TOKEN1_TOKEN2 (e.g., WETH_USDT)'
      );
    }

    // Validate maxPairsToWarm
    const maxPairs = params.maxPairsToWarm ?? 5;
    if (maxPairs < 1 || maxPairs > 20) {
      throw new ValidationError(
        'maxPairsToWarm',
        'maxPairsToWarm must be between 1 and 20'
      );
    }

    // Validate minCorrelationScore
    const minScore = params.minCorrelationScore ?? 0.3;
    if (minScore < 0 || minScore > 1) {
      throw new ValidationError(
        'minCorrelationScore',
        'minCorrelationScore must be between 0.0 and 1.0'
      );
    }

    // Validate timeoutMs
    const timeout = params.timeoutMs ?? 50;
    if (timeout < 1 || timeout > 5000) {
      throw new ValidationError(
        'timeoutMs',
        'timeoutMs must be between 1 and 5000 milliseconds'
      );
    }

    return new WarmCacheRequest(params.sourcePair, maxPairs, minScore, timeout);
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `WarmCacheRequest[${this.sourcePair}, max=${this.maxPairsToWarm}, minScore=${this.minCorrelationScore}]`;
  }
}

/**
 * Response from warm cache operation
 */
export class WarmCacheResponse {
  constructor(
    public readonly success: boolean,
    public readonly sourcePair: string,
    public readonly pairsAttempted: number,
    public readonly pairsWarmed: number,
    public readonly pairsAlreadyInL1: number,
    public readonly pairsNotFound: number,
    public readonly durationMs: number,
    public readonly timestamp: number,
    public readonly error?: string
  ) {
    Object.freeze(this);
  }

  /**
   * Create successful response
   */
  static success(params: {
    sourcePair: string;
    pairsAttempted: number;
    pairsWarmed: number;
    pairsAlreadyInL1: number;
    pairsNotFound: number;
    durationMs: number;
  }): WarmCacheResponse {
    return new WarmCacheResponse(
      true,
      params.sourcePair,
      params.pairsAttempted,
      params.pairsWarmed,
      params.pairsAlreadyInL1,
      params.pairsNotFound,
      params.durationMs,
      Date.now()
    );
  }

  /**
   * Create failure response
   */
  static failure(
    sourcePair: string,
    error: string,
    durationMs: number
  ): WarmCacheResponse {
    return new WarmCacheResponse(
      false,
      sourcePair,
      0,
      0,
      0,
      0,
      durationMs,
      Date.now(),
      error
    );
  }

  /**
   * Get warming effectiveness percentage
   */
  getEffectiveness(): number {
    if (this.pairsAttempted === 0) return 0;
    return (this.pairsWarmed / this.pairsAttempted) * 100;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    if (!this.success) {
      return `WarmCacheResponse[FAILED: ${this.error}]`;
    }
    return `WarmCacheResponse[${this.pairsWarmed}/${this.pairsAttempted} warmed, ${this.durationMs.toFixed(2)}ms]`;
  }
}

/**
 * Validation error for DTOs
 */
export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(`Validation failed for '${field}': ${message}`);
    this.name = 'ValidationError';
  }
}

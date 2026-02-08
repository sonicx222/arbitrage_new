/**
 * Domain Models for Predictive Cache Warming
 *
 * Value objects and domain entities following DDD principles.
 *
 * @package @arbitrage/core
 * @module warming/domain
 */

/**
 * Value Object: Warming Trigger
 *
 * Immutable representation of what triggered a warming operation.
 */
export class WarmingTrigger {
  private constructor(
    public readonly sourcePair: string,
    public readonly triggerType: 'price_update' | 'manual' | 'scheduled',
    public readonly timestamp: number,
    public readonly metadata?: Record<string, unknown>
  ) {
    Object.freeze(this);
  }

  /**
   * Create warming trigger from price update event
   */
  static fromPriceUpdate(pair: string, timestamp: number): WarmingTrigger {
    return new WarmingTrigger(pair, 'price_update', timestamp);
  }

  /**
   * Create warming trigger from manual request
   */
  static fromManual(pair: string, timestamp: number, metadata?: Record<string, unknown>): WarmingTrigger {
    return new WarmingTrigger(pair, 'manual', timestamp, metadata);
  }

  /**
   * Create warming trigger from scheduled task
   */
  static fromScheduled(pair: string, timestamp: number): WarmingTrigger {
    return new WarmingTrigger(pair, 'scheduled', timestamp);
  }

  /**
   * Check if trigger is recent (within time window)
   */
  isRecent(windowMs: number): boolean {
    return Date.now() - this.timestamp < windowMs;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `WarmingTrigger[${this.triggerType}:${this.sourcePair}@${this.timestamp}]`;
  }
}

/**
 * Value Object: Warming Event
 *
 * Immutable representation of a warming operation that occurred.
 * Used for event sourcing and audit trails.
 */
export class WarmingEvent {
  private constructor(
    public readonly eventId: string,
    public readonly trigger: WarmingTrigger,
    public readonly pairsWarmed: string[],
    public readonly durationMs: number,
    public readonly success: boolean,
    public readonly timestamp: number,
    public readonly errors?: string[]
  ) {
    Object.freeze(this);
  }

  /**
   * Create successful warming event
   */
  static success(
    trigger: WarmingTrigger,
    pairsWarmed: string[],
    durationMs: number
  ): WarmingEvent {
    return new WarmingEvent(
      WarmingEvent.generateEventId(),
      trigger,
      pairsWarmed,
      durationMs,
      true,
      Date.now()
    );
  }

  /**
   * Create failed warming event
   */
  static failure(
    trigger: WarmingTrigger,
    errors: string[],
    durationMs: number
  ): WarmingEvent {
    return new WarmingEvent(
      WarmingEvent.generateEventId(),
      trigger,
      [],
      durationMs,
      false,
      Date.now(),
      errors
    );
  }

  /**
   * Generate unique event ID
   */
  private static generateEventId(): string {
    return `warming-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Convert to JSON for logging
   */
  toJSON(): object {
    return {
      eventId: this.eventId,
      trigger: this.trigger.toString(),
      pairsWarmed: this.pairsWarmed,
      durationMs: this.durationMs,
      success: this.success,
      timestamp: this.timestamp,
      errors: this.errors,
    };
  }
}

/**
 * Value Object: Correlation Pair
 *
 * Immutable representation of a pair correlation relationship.
 */
export class CorrelationPair {
  private constructor(
    public readonly pair1: string,
    public readonly pair2: string,
    public readonly score: number,
    public readonly coOccurrences: number,
    public readonly lastSeenTimestamp: number
  ) {
    if (score < 0 || score > 1) {
      throw new Error(`Invalid correlation score: ${score}. Must be 0.0-1.0`);
    }
    Object.freeze(this);
  }

  /**
   * Create correlation pair with validation (P1-6 fix)
   *
   * Validates:
   * - Non-empty pair addresses
   * - No self-correlation
   * - Valid score range (0-1)
   * - Non-negative co-occurrences
   * - No future timestamps
   *
   * @throws Error if validation fails
   */
  static create(
    pair1: string,
    pair2: string,
    score: number,
    coOccurrences: number,
    lastSeenTimestamp: number
  ): CorrelationPair {
    // P1-6: Validate pair addresses
    if (!pair1 || pair1.trim().length === 0) {
      throw new Error('pair1 cannot be empty');
    }
    if (!pair2 || pair2.trim().length === 0) {
      throw new Error('pair2 cannot be empty');
    }

    // P1-6: Prevent self-correlation
    if (pair1 === pair2) {
      throw new Error(`Cannot correlate pair with itself: ${pair1}`);
    }

    // P1-6: Validate co-occurrences
    if (!Number.isFinite(coOccurrences) || coOccurrences < 0) {
      throw new Error(`coOccurrences must be non-negative finite number, got: ${coOccurrences}`);
    }

    // P1-6: Validate timestamp (no future timestamps)
    if (!Number.isFinite(lastSeenTimestamp) || lastSeenTimestamp > Date.now()) {
      throw new Error(`lastSeenTimestamp cannot be in the future, got: ${lastSeenTimestamp}`);
    }

    return new CorrelationPair(pair1, pair2, score, coOccurrences, lastSeenTimestamp);
  }

  /**
   * Check if correlation is strong (score >= threshold)
   */
  isStrong(threshold: number = 0.7): boolean {
    return this.score >= threshold;
  }

  /**
   * Check if correlation is recent
   */
  isRecent(windowMs: number): boolean {
    return Date.now() - this.lastSeenTimestamp < windowMs;
  }

  /**
   * Get canonical key for this correlation (order-independent)
   */
  getKey(): string {
    const [p1, p2] = [this.pair1, this.pair2].sort();
    return `${p1}:${p2}`;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `CorrelationPair[${this.pair1}<->${this.pair2}:score=${this.score.toFixed(3)}]`;
  }
}

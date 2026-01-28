/**
 * T4.3 Fix 6.1/9.1: Unified Direction Type System
 *
 * Provides a single source of truth for direction types used across ML models.
 * Fixes inconsistency where LSTMPredictor uses 'up'/'down'/'sideways' while
 * OrderflowPredictor uses 'bullish'/'bearish'/'neutral'.
 *
 * This module provides:
 * - Unified type definitions
 * - Bidirectional mapping functions
 * - Conversion helpers for interoperability
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Price direction as used by LSTMPredictor.
 * Represents predicted price movement relative to current price.
 */
export type PriceDirection = 'up' | 'down' | 'sideways';

/**
 * Market direction as used by OrderflowPredictor.
 * Represents market sentiment/momentum.
 */
export type MarketDirection = 'bullish' | 'bearish' | 'neutral';

/**
 * Opportunity direction as used by MLOpportunityScorer.
 * Represents the action being considered.
 */
export type OpportunityDirection = 'buy' | 'sell';

/**
 * Unified direction type that can represent any direction concept.
 * Use specific types when context is clear; use this for generic operations.
 */
export type UnifiedDirection = PriceDirection | MarketDirection;

// =============================================================================
// Direction Mapper Class
// =============================================================================

/**
 * DirectionMapper provides bidirectional conversion between direction types.
 *
 * Mapping semantics:
 * - 'up' ↔ 'bullish' (positive price expectation)
 * - 'down' ↔ 'bearish' (negative price expectation)
 * - 'sideways' ↔ 'neutral' (no clear direction)
 *
 * Usage:
 * ```typescript
 * const mapper = DirectionMapper.getInstance();
 * const market = mapper.priceToMarket('up'); // 'bullish'
 * const price = mapper.marketToPrice('bearish'); // 'down'
 * const aligned = mapper.isAligned('up', 'buy'); // true
 * ```
 */
export class DirectionMapper {
  private static instance: DirectionMapper | null = null;

  // Lookup tables for O(1) conversion
  private readonly priceToMarketMap: Map<PriceDirection, MarketDirection>;
  private readonly marketToPriceMap: Map<MarketDirection, PriceDirection>;

  private constructor() {
    this.priceToMarketMap = new Map([
      ['up', 'bullish'],
      ['down', 'bearish'],
      ['sideways', 'neutral']
    ]);

    this.marketToPriceMap = new Map([
      ['bullish', 'up'],
      ['bearish', 'down'],
      ['neutral', 'sideways']
    ]);
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): DirectionMapper {
    if (!DirectionMapper.instance) {
      DirectionMapper.instance = new DirectionMapper();
    }
    return DirectionMapper.instance;
  }

  /**
   * Reset singleton (for testing).
   */
  static reset(): void {
    DirectionMapper.instance = null;
  }

  // ===========================================================================
  // Conversion Methods
  // ===========================================================================

  /**
   * Convert price direction to market direction.
   */
  priceToMarket(direction: PriceDirection): MarketDirection {
    return this.priceToMarketMap.get(direction) ?? 'neutral';
  }

  /**
   * Convert market direction to price direction.
   */
  marketToPrice(direction: MarketDirection): PriceDirection {
    return this.marketToPriceMap.get(direction) ?? 'sideways';
  }

  // ===========================================================================
  // Numeric Conversion Methods
  // ===========================================================================

  /**
   * Convert price direction to numeric value.
   * @returns 1 (up), -1 (down), or 0 (sideways)
   */
  priceToNumeric(direction: PriceDirection): number {
    switch (direction) {
      case 'up': return 1;
      case 'down': return -1;
      case 'sideways': return 0;
    }
  }

  /**
   * Convert market direction to numeric value.
   * @returns 1 (bullish), -1 (bearish), or 0 (neutral)
   */
  marketToNumeric(direction: MarketDirection): number {
    switch (direction) {
      case 'bullish': return 1;
      case 'bearish': return -1;
      case 'neutral': return 0;
    }
  }

  /**
   * Convert numeric value to price direction.
   * @param value - Positive = up, negative = down, zero/near-zero = sideways
   * @param threshold - Threshold for determining sideways (default: 0.1)
   */
  numericToPrice(value: number, threshold = 0.1): PriceDirection {
    if (value > threshold) return 'up';
    if (value < -threshold) return 'down';
    return 'sideways';
  }

  /**
   * Convert numeric value to market direction.
   * @param value - Positive = bullish, negative = bearish, zero/near-zero = neutral
   * @param threshold - Threshold for determining neutral (default: 0.1)
   */
  numericToMarket(value: number, threshold = 0.1): MarketDirection {
    if (value > threshold) return 'bullish';
    if (value < -threshold) return 'bearish';
    return 'neutral';
  }

  // ===========================================================================
  // Alignment Check Methods
  // ===========================================================================

  /**
   * Check if a price direction aligns with an opportunity direction.
   *
   * Alignment rules:
   * - 'up' aligns with 'buy' (expect price increase → buy is favorable)
   * - 'down' aligns with 'sell' (expect price decrease → sell is favorable)
   * - 'sideways' is considered neutral (aligns with both)
   */
  isPriceAligned(priceDir: PriceDirection, oppDir: OpportunityDirection): boolean {
    if (priceDir === 'sideways') return true;
    if (oppDir === 'buy') return priceDir === 'up';
    if (oppDir === 'sell') return priceDir === 'down';
    return false;
  }

  /**
   * Check if a market direction aligns with an opportunity direction.
   *
   * Alignment rules:
   * - 'bullish' aligns with 'buy'
   * - 'bearish' aligns with 'sell'
   * - 'neutral' is considered neutral (aligns with both)
   */
  isMarketAligned(marketDir: MarketDirection, oppDir: OpportunityDirection): boolean {
    if (marketDir === 'neutral') return true;
    if (oppDir === 'buy') return marketDir === 'bullish';
    if (oppDir === 'sell') return marketDir === 'bearish';
    return false;
  }

  /**
   * Check if two directions (of any type) are aligned with each other.
   * Converts to numeric and compares signs.
   */
  areDirectionsAligned(dir1: UnifiedDirection, dir2: UnifiedDirection): boolean {
    const num1 = this.toNumeric(dir1);
    const num2 = this.toNumeric(dir2);

    // Neutral directions align with everything
    if (num1 === 0 || num2 === 0) return true;

    // Same sign = aligned
    return Math.sign(num1) === Math.sign(num2);
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Convert any direction type to numeric.
   */
  toNumeric(direction: UnifiedDirection): number {
    if (this.isPriceDirection(direction)) {
      return this.priceToNumeric(direction);
    }
    return this.marketToNumeric(direction as MarketDirection);
  }

  /**
   * Type guard for PriceDirection.
   */
  isPriceDirection(direction: string): direction is PriceDirection {
    return direction === 'up' || direction === 'down' || direction === 'sideways';
  }

  /**
   * Type guard for MarketDirection.
   */
  isMarketDirection(direction: string): direction is MarketDirection {
    return direction === 'bullish' || direction === 'bearish' || direction === 'neutral';
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get the singleton DirectionMapper instance.
 */
export function getDirectionMapper(): DirectionMapper {
  return DirectionMapper.getInstance();
}

/**
 * Convert price direction to market direction.
 */
export function priceToMarketDirection(direction: PriceDirection): MarketDirection {
  return DirectionMapper.getInstance().priceToMarket(direction);
}

/**
 * Convert market direction to price direction.
 */
export function marketToPriceDirection(direction: MarketDirection): PriceDirection {
  return DirectionMapper.getInstance().marketToPrice(direction);
}

/**
 * Check if price direction aligns with opportunity direction.
 */
export function isPriceDirectionAligned(
  priceDir: PriceDirection,
  oppDir: OpportunityDirection
): boolean {
  return DirectionMapper.getInstance().isPriceAligned(priceDir, oppDir);
}

/**
 * Check if market direction aligns with opportunity direction.
 */
export function isMarketDirectionAligned(
  marketDir: MarketDirection,
  oppDir: OpportunityDirection
): boolean {
  return DirectionMapper.getInstance().isMarketAligned(marketDir, oppDir);
}

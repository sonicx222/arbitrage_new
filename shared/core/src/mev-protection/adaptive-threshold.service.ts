/**
 * Adaptive Threshold Service
 *
 * Task 3.2: Adaptive Risk Scoring
 *
 * Tracks sandwich attack patterns and adapts MEV risk thresholds dynamically.
 *
 * Strategy:
 * - Track sandwich attacks (front-run + our tx + back-run) per chain + DEX
 * - Adapt thresholds when 5+ attacks detected in 24h (30% reduction)
 * - Gradual decay back to defaults if no attacks
 * - Redis storage with FIFO pruning (max 10K events, 7-day retention)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.2
 * @module mev-protection/adaptive-threshold-service
 */

import { createLogger } from '../logger';
import { getRedisClient } from '../redis';

const logger = createLogger('adaptive-threshold-service');

// =============================================================================
// Types
// =============================================================================

/**
 * Sandwich attack event
 *
 * Records a confirmed sandwich attack where our transaction was sandwiched
 * between a front-run and back-run by an MEV bot.
 */
export interface SandwichAttackEvent {
  /** Event ID (timestamp-based for uniqueness) */
  id: string;
  /** Chain identifier (e.g., 'ethereum', 'bsc') */
  chain: string;
  /** DEX protocol (e.g., 'uniswap_v2', 'pancakeswap') */
  dex: string;
  /** Our transaction hash (victim) */
  ourTxHash: string;
  /** Front-run transaction hash */
  frontRunTxHash: string;
  /** Back-run transaction hash */
  backRunTxHash: string;
  /** Attack timestamp (milliseconds) */
  timestamp: number;
  /** Estimated MEV extracted in USD */
  mevExtractedUsd: number;
}

/**
 * Threshold adjustment for a chain + DEX pair
 *
 * Contains multipliers to apply to base risk thresholds.
 * Multiplier < 1.0 = stricter thresholds (more conservative)
 * Multiplier = 1.0 = default thresholds (no adaptation)
 */
export interface ThresholdAdjustment {
  /** Chain identifier */
  chain: string;
  /** DEX protocol */
  dex: string;
  /** Profit threshold multiplier (e.g., 0.7 = require 30% less profit to trade) */
  profitMultiplier: number;
  /** Slippage threshold multiplier (e.g., 0.7 = accept 30% less slippage) */
  slippageMultiplier: number;
  /** Number of attacks in active window */
  attackCount: number;
  /** Last attack timestamp */
  lastAttackTimestamp: number;
  /** Adjustment expires at (timestamp) */
  expiresAt: number;
}

/**
 * Configuration for adaptive thresholds
 */
export interface AdaptiveThresholdConfig {
  /** Enable adaptive risk scoring (feature flag) */
  enabled: boolean;
  /** Attack count threshold to trigger adaptation (default: 5) */
  attackThreshold: number;
  /** Active time window for counting attacks in milliseconds (default: 24h) */
  activeWindowMs: number;
  /** Threshold reduction percentage when attacks detected (default: 0.30 = 30%) */
  reductionPercent: number;
  /** Decay rate per day when no attacks (default: 0.10 = 10% per day) */
  decayRatePerDay: number;
  /** Maximum events to store (FIFO pruning) */
  maxEvents: number;
  /** Event retention period in milliseconds (default: 7 days) */
  retentionMs: number;
}

// =============================================================================
// Defaults
// =============================================================================

export const ADAPTIVE_THRESHOLD_DEFAULTS: AdaptiveThresholdConfig = {
  enabled: false, // Feature flag - opt-in
  attackThreshold: 5, // 5+ attacks triggers adaptation
  activeWindowMs: 24 * 60 * 60 * 1000, // 24 hours
  reductionPercent: 0.30, // 30% reduction in thresholds
  decayRatePerDay: 0.10, // 10% decay per day back to defaults
  maxEvents: 10_000, // ~1MB storage
  retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Adaptive Threshold Service
 *
 * Tracks sandwich attacks and adapts risk thresholds per chain + DEX.
 *
 * Usage:
 * ```typescript
 * const service = new AdaptiveThresholdService(config);
 *
 * // Record attack
 * await service.recordAttack({
 *   chain: 'ethereum',
 *   dex: 'uniswap_v2',
 *   ourTxHash: '0x...',
 *   frontRunTxHash: '0x...',
 *   backRunTxHash: '0x...',
 *   mevExtractedUsd: 150
 * });
 *
 * // Get adjusted thresholds
 * const adjustment = await service.getAdjustment('ethereum', 'uniswap_v2');
 * const adjustedMinProfit = baseMinProfit * adjustment.profitMultiplier;
 * ```
 */
export class AdaptiveThresholdService {
  private readonly config: AdaptiveThresholdConfig;
  private readonly redis: Promise<any>;

  // Redis key prefixes
  private readonly EVENTS_KEY = 'adaptive:sandwich_attacks';
  private readonly ADJUSTMENTS_KEY = 'adaptive:threshold_adjustments';

  constructor(config?: Partial<AdaptiveThresholdConfig>) {
    this.config = {
      ...ADAPTIVE_THRESHOLD_DEFAULTS,
      ...config,
    };
    this.redis = getRedisClient();
  }

  /**
   * Record a sandwich attack event
   *
   * Stores the event in Redis and updates the threshold adjustment
   * for the affected chain + DEX pair.
   *
   * @param event - Attack event details (without id and timestamp)
   * @throws {Error} If Redis write fails
   */
  async recordAttack(event: Omit<SandwichAttackEvent, 'id' | 'timestamp'>): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const now = Date.now();
    const fullEvent: SandwichAttackEvent = {
      ...event,
      id: `${now}-${event.chain}-${event.dex}`,
      timestamp: now,
    };

    try {
      const redis = await this.redis;

      // Add event to sorted set (score = timestamp for time-based queries)
      await redis.zadd(this.EVENTS_KEY, now, JSON.stringify(fullEvent));

      // Prune old events (beyond retention window)
      const cutoff = now - this.config.retentionMs;
      await redis.zremrangebyscore(this.EVENTS_KEY, '-inf', cutoff);

      // Prune by count (FIFO if over max)
      const count = await redis.zcard(this.EVENTS_KEY);
      if (count > this.config.maxEvents) {
        const removeCount = count - this.config.maxEvents;
        await redis.zpopmin(this.EVENTS_KEY, removeCount);
      }

      // Set expiry on the sorted set (7 days)
      await redis.expire(this.EVENTS_KEY, Math.ceil(this.config.retentionMs / 1000));

      logger.info('Recorded sandwich attack', {
        chain: event.chain,
        dex: event.dex,
        mevUsd: fullEvent.mevExtractedUsd,
        eventId: fullEvent.id,
      });

      // Update threshold adjustment for this chain + DEX
      await this.updateAdjustment(event.chain, event.dex);
    } catch (error) {
      logger.error('Failed to record sandwich attack', { error, event });
      throw error; // Write operation - throw on error (per codebase pattern)
    }
  }

  /**
   * Get current threshold adjustment for a chain + DEX
   *
   * Returns adjustment multipliers based on recent attack history.
   * Falls back to default multipliers (1.0) on error or when no attacks.
   *
   * @param chain - Chain identifier
   * @param dex - DEX protocol
   * @returns Threshold adjustment (defaults to 1.0 multipliers if none)
   */
  async getAdjustment(chain: string, dex: string): Promise<ThresholdAdjustment> {
    if (!this.config.enabled) {
      return this.createDefaultAdjustment(chain, dex);
    }

    try {
      const redis = await this.redis;
      const key = `${this.ADJUSTMENTS_KEY}:${chain}:${dex}`;
      const cached = await redis.get(key);

      if (cached) {
        const adjustment = JSON.parse(cached) as ThresholdAdjustment;

        // Check if adjustment has expired
        if (Date.now() < adjustment.expiresAt) {
          // Apply decay if no recent attacks
          return this.applyDecay(adjustment);
        }
      }

      // No valid adjustment - return default
      return this.createDefaultAdjustment(chain, dex);
    } catch (error) {
      logger.warn('Failed to get threshold adjustment, using defaults', { error, chain, dex });
      return this.createDefaultAdjustment(chain, dex); // Read operation - return default on error
    }
  }

  /**
   * Get all current adjustments (for monitoring/debugging)
   *
   * Returns a map of all active threshold adjustments across all chain+DEX pairs.
   *
   * @returns Record of chain:dex -> ThresholdAdjustment
   */
  async getAllAdjustments(): Promise<Record<string, ThresholdAdjustment>> {
    if (!this.config.enabled) {
      return {};
    }

    try {
      const redis = await this.redis;
      const pattern = `${this.ADJUSTMENTS_KEY}:*`;
      const keys: string[] = [];

      // Use SCAN instead of KEYS (per codebase pattern - never block Redis)
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const resultKeys of stream) {
        keys.push(...resultKeys);
      }

      const adjustments: Record<string, ThresholdAdjustment> = {};
      for (const key of keys) {
        const cached = await redis.get(key);
        if (cached) {
          const adjustment = JSON.parse(cached) as ThresholdAdjustment;
          const compositeKey = `${adjustment.chain}:${adjustment.dex}`;
          adjustments[compositeKey] = this.applyDecay(adjustment);
        }
      }

      return adjustments;
    } catch (error) {
      logger.warn('Failed to get all adjustments', { error });
      return {}; // Read operation - return empty on error
    }
  }

  /**
   * Clear all attack history and adjustments (for testing)
   *
   * Removes all stored events and threshold adjustments from Redis.
   *
   * @throws {Error} If Redis delete fails
   */
  async clear(): Promise<void> {
    try {
      const redis = await this.redis;
      await redis.del(this.EVENTS_KEY);

      // Delete all adjustment keys
      const pattern = `${this.ADJUSTMENTS_KEY}:*`;
      const keys: string[] = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const resultKeys of stream) {
        keys.push(...resultKeys);
      }

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      logger.info('Cleared adaptive threshold data');
    } catch (error) {
      logger.error('Failed to clear adaptive threshold data', { error });
      throw error; // Write operation - throw on error
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Update threshold adjustment for a chain + DEX based on recent attacks
   *
   * Counts attacks in the active window and calculates appropriate multipliers.
   * Stores the adjustment in Redis with TTL.
   *
   * @param chain - Chain identifier
   * @param dex - DEX protocol
   */
  private async updateAdjustment(chain: string, dex: string): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.config.activeWindowMs;

    try {
      const redis = await this.redis;

      // Get all events in active window
      const events = await redis.zrangebyscore(
        this.EVENTS_KEY,
        windowStart,
        now,
        'WITHSCORES'
      );

      let attackCount = 0;
      let lastAttackTimestamp = 0;

      // Filter events by chain + DEX
      for (let i = 0; i < events.length; i += 2) {
        const eventData = JSON.parse(events[i]) as SandwichAttackEvent;
        if (eventData.chain === chain && eventData.dex === dex) {
          attackCount++;
          lastAttackTimestamp = Math.max(lastAttackTimestamp, eventData.timestamp);
        }
      }

      // Calculate adjustment
      let profitMultiplier = 1.0;
      let slippageMultiplier = 1.0;
      const expiresAt = now + this.config.activeWindowMs;

      if (attackCount >= this.config.attackThreshold) {
        // Reduce thresholds (make more conservative)
        profitMultiplier = 1.0 - this.config.reductionPercent;
        slippageMultiplier = 1.0 - this.config.reductionPercent;

        logger.warn('Adaptive threshold triggered - tightening risk parameters', {
          chain,
          dex,
          attackCount,
          profitMultiplier,
          slippageMultiplier,
        });
      }

      const adjustment: ThresholdAdjustment = {
        chain,
        dex,
        profitMultiplier,
        slippageMultiplier,
        attackCount,
        lastAttackTimestamp,
        expiresAt,
      };

      // Store adjustment with TTL
      const key = `${this.ADJUSTMENTS_KEY}:${chain}:${dex}`;
      const ttlSeconds = Math.ceil(this.config.activeWindowMs / 1000) + 3600; // +1h buffer
      await redis.set(key, JSON.stringify(adjustment), 'EX', ttlSeconds);
    } catch (error) {
      logger.error('Failed to update threshold adjustment', { error, chain, dex });
      // Don't throw - this is a best-effort update
    }
  }

  /**
   * Apply decay to adjustment if no recent attacks
   *
   * Gradually moves multipliers back toward 1.0 (defaults) based on
   * time since last attack and configured decay rate.
   *
   * Uses true exponential decay: gap(t) = gap(0) * (1 - rate)^t
   * This ensures smooth, continuous convergence toward 1.0 without
   * cliff effects that occur with linear decay when decayAmount >= 1.
   *
   * @param adjustment - Current adjustment
   * @returns Adjustment with decay applied
   */
  private applyDecay(adjustment: ThresholdAdjustment): ThresholdAdjustment {
    const now = Date.now();
    const timeSinceLastAttack = now - adjustment.lastAttackTimestamp;
    const daysSinceAttack = timeSinceLastAttack / (24 * 60 * 60 * 1000);

    // Exponential decay: remaining gap shrinks by (1-rate) each day
    // multiplier(t) = 1.0 - (1.0 - initial) * (1.0 - rate)^t
    const retentionFactor = Math.pow(1.0 - this.config.decayRatePerDay, daysSinceAttack);
    const decayedProfitMultiplier = Math.min(
      1.0,
      1.0 - (1.0 - adjustment.profitMultiplier) * retentionFactor
    );
    const decayedSlippageMultiplier = Math.min(
      1.0,
      1.0 - (1.0 - adjustment.slippageMultiplier) * retentionFactor
    );

    return {
      ...adjustment,
      profitMultiplier: decayedProfitMultiplier,
      slippageMultiplier: decayedSlippageMultiplier,
    };
  }

  /**
   * Create default adjustment (no adaptation)
   *
   * @param chain - Chain identifier
   * @param dex - DEX protocol
   * @returns Default adjustment with 1.0 multipliers
   */
  private createDefaultAdjustment(chain: string, dex: string): ThresholdAdjustment {
    return {
      chain,
      dex,
      profitMultiplier: 1.0,
      slippageMultiplier: 1.0,
      attackCount: 0,
      lastAttackTimestamp: 0,
      expiresAt: Date.now() + this.config.activeWindowMs,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create adaptive threshold service with configuration
 *
 * Factory function for dependency injection and testing.
 *
 * @param config - Optional configuration overrides
 * @returns AdaptiveThresholdService instance
 */
export function createAdaptiveThresholdService(
  config?: Partial<AdaptiveThresholdConfig>
): AdaptiveThresholdService {
  return new AdaptiveThresholdService(config);
}

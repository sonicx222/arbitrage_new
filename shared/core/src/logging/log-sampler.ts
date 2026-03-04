/**
 * Log Sampler — Token-Bucket Rate Limiter for High-Frequency Log Events
 *
 * At LOG_LEVEL=debug, price update events fire 1000+/sec, making logs
 * unusable for live analysis. This sampler limits output to a configurable
 * rate (default 100/sec) with optional probabilistic sampling beyond the cap.
 *
 * O(1) per call: single Map lookup + integer comparison. No allocations
 * on the hot path (reuses existing counter objects).
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Issue H
 * @see ADR-022: Hot-Path Memory Budget
 * @module logging/log-sampler
 */

/** Configuration for the LogSampler. */
export interface LogSamplerConfig {
  /**
   * Maximum log entries per second before sampling kicks in.
   * Events within this budget are always logged.
   * @default 100
   */
  maxPerSec?: number;

  /**
   * Probability (0–1) of logging an event that exceeds maxPerSec.
   * 0 = drop all excess, 1 = log all (no sampling), 0.01 = 1% sample.
   * @default 0.01
   */
  sampleRate?: number;
}

/** Internal counter entry — reused to avoid per-call allocation. */
interface CounterEntry {
  count: number;
  windowStart: number;
}

/**
 * Token-bucket rate limiter for high-frequency debug log events.
 *
 * @example
 * ```typescript
 * const sampler = new LogSampler({ maxPerSec: 100, sampleRate: 0.01 });
 *
 * if (debugEnabled && sampler.shouldLog('price-update')) {
 *   pLog.debug('Price update', { chain, dex, price });
 * }
 * ```
 */
export class LogSampler {
  private readonly maxPerSec: number;
  private readonly sampleRate: number;
  private readonly counters = new Map<string, CounterEntry>();

  constructor(config?: LogSamplerConfig) {
    this.maxPerSec = config?.maxPerSec ?? 100;
    this.sampleRate = config?.sampleRate ?? 0.01;
  }

  /**
   * Determine whether a log event with the given key should be emitted.
   *
   * - Events within the per-second budget are always allowed.
   * - Events beyond the budget are allowed with probability `sampleRate`.
   * - Window resets every 1000ms.
   *
   * @param key - Event category key (e.g., 'price-update', 'opportunity')
   * @returns true if the event should be logged
   */
  shouldLog(key: string): boolean {
    const now = Date.now();
    let entry = this.counters.get(key);

    if (!entry) {
      // First event for this key — create entry (one-time allocation per key)
      entry = { count: 0, windowStart: now };
      this.counters.set(key, entry);
    } else if (now - entry.windowStart >= 1000) {
      // Window expired — reset in-place (no allocation)
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count++;

    if (entry.count <= this.maxPerSec) {
      return true;
    }

    // Beyond budget: probabilistic sampling
    return Math.random() < this.sampleRate;
  }

  /**
   * Reset all counters. Useful for testing.
   */
  reset(): void {
    this.counters.clear();
  }
}

// LOG-OPT Fix 4: Default sampler for price update events (100/sec + 1% sampling)
export const defaultPriceUpdateSampler = new LogSampler({ maxPerSec: 100, sampleRate: 0.01 });

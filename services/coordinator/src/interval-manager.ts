/**
 * P2-11: IntervalManager - Extracted from coordinator.ts
 *
 * Provides centralized management of setInterval handles.
 * Eliminates repetitive cleanup patterns and ensures proper cleanup on shutdown.
 *
 * Features:
 * - Named interval registration for debugging
 * - Single-call cleanup of all intervals
 * - Safe re-registration (clears existing interval before setting new)
 * - Statistics for monitoring
 *
 * @see docs/research/REFACTORING_IMPLEMENTATION_PLAN.md P2-11
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Logger interface for IntervalManager.
 */
export interface IntervalManagerLogger {
  debug: (message: string, meta?: object) => void;
}

/**
 * Interval registration options.
 */
export interface IntervalOptions {
  /** Human-readable name for logging/debugging */
  name: string;
  /** Interval callback function */
  callback: () => void | Promise<void>;
  /** Interval period in milliseconds */
  intervalMs: number;
  /** Whether to run callback immediately before starting interval (default: false) */
  runImmediately?: boolean;
}

/**
 * Statistics about managed intervals.
 */
export interface IntervalStats {
  /** Number of active intervals */
  activeCount: number;
  /** Names of all active intervals */
  activeNames: string[];
}

// =============================================================================
// IntervalManager Class
// =============================================================================

/**
 * P2-11: IntervalManager - Centralized interval lifecycle management.
 *
 * Replaces the repetitive pattern:
 * ```typescript
 * if (this.someInterval) {
 *   clearInterval(this.someInterval);
 *   this.someInterval = null;
 * }
 * ```
 *
 * With a cleaner API:
 * ```typescript
 * intervalManager.register({
 *   name: 'metrics-update',
 *   callback: () => this.updateMetrics(),
 *   intervalMs: 5000,
 * });
 *
 * // Later...
 * await intervalManager.clearAll();
 * ```
 *
 * @example
 * ```typescript
 * const intervalManager = new IntervalManager(logger);
 *
 * // Register intervals
 * intervalManager.register({
 *   name: 'health-check',
 *   callback: () => this.checkHealth(),
 *   intervalMs: 10000,
 * });
 *
 * intervalManager.register({
 *   name: 'metrics-update',
 *   callback: () => this.updateMetrics(),
 *   intervalMs: 5000,
 *   runImmediately: true,
 * });
 *
 * // Get stats
 * const stats = intervalManager.getStats();
 * console.log(`Active intervals: ${stats.activeCount}`);
 *
 * // Cleanup on shutdown
 * await intervalManager.clearAll();
 * ```
 */
export class IntervalManager {
  private readonly logger?: IntervalManagerLogger;
  private readonly intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(logger?: IntervalManagerLogger) {
    this.logger = logger;
  }

  /**
   * Register a new interval.
   *
   * If an interval with the same name already exists, it will be cleared first.
   * This allows safe re-registration without creating duplicate intervals.
   *
   * @param options - Interval registration options
   */
  register(options: IntervalOptions): void {
    const { name, callback, intervalMs, runImmediately = false } = options;

    // Clear existing interval if present (safe re-registration)
    this.clear(name);

    // Wrap callback to handle async errors
    const wrappedCallback = async (): Promise<void> => {
      try {
        await callback();
      } catch (error) {
        this.logger?.debug(`Interval '${name}' callback error`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Run immediately if requested
    if (runImmediately) {
      void wrappedCallback();
    }

    // Register interval
    const handle = setInterval(wrappedCallback, intervalMs);
    this.intervals.set(name, handle);

    this.logger?.debug('Interval registered', { name, intervalMs });
  }

  /**
   * Clear a specific interval by name.
   *
   * @param name - Name of the interval to clear
   * @returns True if interval was found and cleared, false if not found
   */
  clear(name: string): boolean {
    const handle = this.intervals.get(name);
    if (handle) {
      clearInterval(handle);
      this.intervals.delete(name);
      this.logger?.debug('Interval cleared', { name });
      return true;
    }
    return false;
  }

  /**
   * Clear all registered intervals.
   *
   * This method is synchronous but returns a Promise for consistency
   * with async shutdown patterns.
   */
  async clearAll(): Promise<void> {
    const names = Array.from(this.intervals.keys());

    for (const [name, handle] of this.intervals) {
      clearInterval(handle);
      this.logger?.debug('Interval cleared', { name });
    }

    this.intervals.clear();

    this.logger?.debug('All intervals cleared', { count: names.length, names });
  }

  /**
   * Check if an interval is registered.
   *
   * @param name - Name of the interval to check
   * @returns True if interval is registered
   */
  has(name: string): boolean {
    return this.intervals.has(name);
  }

  /**
   * Get statistics about managed intervals.
   */
  getStats(): IntervalStats {
    return {
      activeCount: this.intervals.size,
      activeNames: Array.from(this.intervals.keys()),
    };
  }
}

/**
 * Factory function to create an IntervalManager.
 */
export function createIntervalManager(logger?: IntervalManagerLogger): IntervalManager {
  return new IntervalManager(logger);
}

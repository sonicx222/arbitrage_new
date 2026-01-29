/**
 * Interval Manager
 *
 * Utility for managing multiple named intervals with automatic cleanup.
 * Replaces scattered setInterval/clearInterval patterns found in:
 * - services/coordinator/src/coordinator.ts (5+ intervals)
 * - services/execution-engine/src/engine.ts (6+ intervals)
 * - Various detectors
 *
 * @example
 * ```typescript
 * class MyService {
 *   private intervals = new IntervalManager();
 *
 *   async start(): Promise<void> {
 *     this.intervals.set('healthCheck', () => this.checkHealth(), 5000);
 *     this.intervals.set('metrics', () => this.updateMetrics(), 30000);
 *     this.intervals.set('cleanup', () => this.performCleanup(), 60000);
 *   }
 *
 *   async stop(): Promise<void> {
 *     this.intervals.clearAll(); // Clears all intervals at once
 *   }
 * }
 * ```
 */

export interface IntervalInfo {
  /** Interval name */
  name: string;
  /** Interval duration in milliseconds */
  intervalMs: number;
  /** When the interval was created */
  createdAt: number;
  /** Number of times the callback has been invoked */
  invocationCount: number;
}

export interface IntervalManagerStats {
  /** Number of active intervals */
  activeCount: number;
  /** List of active interval names */
  activeNames: string[];
  /** Detailed info for each interval */
  intervals: IntervalInfo[];
}

/**
 * Manages multiple named intervals with automatic cleanup.
 *
 * Benefits over manual interval management:
 * - Named intervals prevent duplicate registrations
 * - Single clearAll() for cleanup
 * - Stats/debugging support
 * - Type-safe async callback support
 */
export class IntervalManager {
  private intervals = new Map<string, NodeJS.Timeout>();
  private intervalInfo = new Map<string, IntervalInfo>();

  /**
   * Set a named interval. If an interval with the same name exists,
   * it will be cleared first.
   *
   * @param name - Unique name for the interval
   * @param callback - Function to call on each interval
   * @param intervalMs - Interval duration in milliseconds
   * @param runImmediately - If true, runs callback immediately before starting interval
   */
  set(
    name: string,
    callback: () => void | Promise<void>,
    intervalMs: number,
    runImmediately = false
  ): void {
    // Clear existing interval with same name
    if (this.intervals.has(name)) {
      this.clear(name);
    }

    // Create wrapper that tracks invocations and handles async
    let invocationCount = 0;
    const wrappedCallback = (): void => {
      invocationCount++;
      const info = this.intervalInfo.get(name);
      if (info) {
        info.invocationCount = invocationCount;
      }

      // Execute callback (handle both sync and async)
      try {
        const result = callback();
        // If it's a promise, catch errors to prevent unhandled rejections
        if (result instanceof Promise) {
          result.catch(() => {
            // Errors are expected to be handled by the callback itself
            // This is just a safety net to prevent unhandled rejection crashes
          });
        }
      } catch {
        // Sync errors are also swallowed - callbacks should handle their own errors
      }
    };

    // Run immediately if requested
    if (runImmediately) {
      wrappedCallback();
    }

    // Set the interval
    const intervalId = setInterval(wrappedCallback, intervalMs);
    this.intervals.set(name, intervalId);
    this.intervalInfo.set(name, {
      name,
      intervalMs,
      createdAt: Date.now(),
      invocationCount,
    });
  }

  /**
   * Clear a specific named interval.
   *
   * @param name - Name of the interval to clear
   * @returns true if interval was found and cleared, false otherwise
   */
  clear(name: string): boolean {
    const intervalId = this.intervals.get(name);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(name);
      this.intervalInfo.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Clear all intervals.
   */
  clearAll(): void {
    for (const intervalId of this.intervals.values()) {
      clearInterval(intervalId);
    }
    this.intervals.clear();
    this.intervalInfo.clear();
  }

  /**
   * Check if an interval exists.
   *
   * @param name - Interval name to check
   */
  has(name: string): boolean {
    return this.intervals.has(name);
  }

  /**
   * Get the number of active intervals.
   */
  size(): number {
    return this.intervals.size;
  }

  /**
   * Get names of all active intervals.
   */
  getNames(): string[] {
    return Array.from(this.intervals.keys());
  }

  /**
   * Get detailed stats about all intervals.
   */
  getStats(): IntervalManagerStats {
    return {
      activeCount: this.intervals.size,
      activeNames: this.getNames(),
      intervals: Array.from(this.intervalInfo.values()),
    };
  }

  /**
   * Alias for clearAll() for semantic clarity in stop() methods.
   */
  stop(): void {
    this.clearAll();
  }
}

/**
 * Create a new IntervalManager instance.
 */
export function createIntervalManager(): IntervalManager {
  return new IntervalManager();
}

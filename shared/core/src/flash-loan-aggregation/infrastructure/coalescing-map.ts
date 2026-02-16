/**
 * Request Coalescing Map
 *
 * Encapsulates the atomic check-and-set pattern with finally-based cleanup
 * for deduplicating concurrent async operations by key.
 *
 * R2: Extracted from duplicate patterns in:
 * - flashloan-aggregator.impl.ts (pending rankings)
 * - onchain-liquidity.validator.ts (pending liquidity checks)
 *
 * Pattern:
 * 1. Check if a promise is already pending for the key
 * 2. If so, return the existing promise (coalesce)
 * 3. If not, create a new promise and store it atomically
 * 4. Clean up the stored promise when it settles (via finally)
 *
 * The same-promise guard in cleanup prevents replacing a newer promise
 * that was set between creation and settlement.
 *
 * @see flashloan-aggregator.impl.ts
 * @see onchain-liquidity.validator.ts
 */

/**
 * A map that coalesces concurrent async operations for the same key.
 *
 * When multiple callers request the same key concurrently, only one
 * operation executes and all callers receive the same result.
 */
export class CoalescingMap<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  /**
   * Get the pending promise count (for testing/debugging).
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Execute an async operation, coalescing concurrent calls for the same key.
   *
   * If a promise is already pending for the given key, returns it.
   * Otherwise, creates a new promise via the factory and stores it.
   * The promise is automatically removed from the map when it settles.
   *
   * @param key - The key to coalesce on
   * @param factory - Factory function that creates the promise (called only if no pending)
   * @returns The result of the operation
   */
  async getOrCreate(key: K, factory: () => Promise<V>): Promise<V> {
    let pending = this.pending.get(key);
    if (!pending) {
      // Create new promise and store atomically
      pending = factory();
      this.pending.set(key, pending);

      // Cleanup on completion (regardless of success/failure)
      pending.finally(() => {
        // Only delete if this is still the same promise (not replaced)
        if (this.pending.get(key) === pending) {
          this.pending.delete(key);
        }
      });
    }

    return pending;
  }

  /**
   * Clear all pending operations.
   */
  clear(): void {
    this.pending.clear();
  }
}

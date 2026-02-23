/**
 * Generic Object Pool for reducing GC pressure on hot paths.
 *
 * Pre-allocates reusable objects to avoid transient allocations in tight loops.
 * At 1000+ events/sec, object allocation and GC collection cause P99 latency spikes.
 *
 * Design constraints:
 * - acquire() and release() must be allocation-free (no closures, no new objects)
 * - Pool size is bounded (maxSize) to prevent unbounded memory growth
 * - Objects are reset via a caller-provided resetFn (not cleared to undefined)
 *
 * @example
 * ```typescript
 * interface DetectionEvent {
 *   chain: string;
 *   pair: string;
 *   price: number;
 *   timestamp: number;
 * }
 *
 * const pool = new ObjectPool<DetectionEvent>(
 *   () => ({ chain: '', pair: '', price: 0, timestamp: 0 }),
 *   (obj) => { obj.chain = ''; obj.pair = ''; obj.price = 0; obj.timestamp = 0; },
 *   100
 * );
 *
 * const event = pool.acquire();
 * event.chain = 'ethereum';
 * event.price = 1500.5;
 * // ... use event ...
 * pool.release(event);
 * ```
 */
export class ObjectPool<T> {
  private readonly pool: T[];
  private readonly createFn: () => T;
  private readonly resetFn: (obj: T) => void;
  private readonly maxSize: number;
  private poolSize: number;

  // Stats for monitoring
  private acquireCount = 0;
  private releaseCount = 0;
  private createCount = 0;
  private discardCount = 0;

  /**
   * @param createFn - Factory function to create a new object when pool is empty
   * @param resetFn - Function to reset an object's fields before returning to pool
   * @param maxSize - Maximum number of objects to keep in the pool (default: 100)
   * @param preAllocate - Number of objects to pre-allocate (default: maxSize / 2)
   */
  constructor(
    createFn: () => T,
    resetFn: (obj: T) => void,
    maxSize: number = 100,
    preAllocate?: number
  ) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.maxSize = maxSize;
    this.pool = [];
    this.poolSize = 0;

    // Pre-allocate objects
    const toPreAllocate = preAllocate ?? Math.floor(maxSize / 2);
    for (let i = 0; i < toPreAllocate; i++) {
      this.pool.push(createFn());
      this.poolSize++;
      this.createCount++;
    }
  }

  /**
   * Acquire an object from the pool, or create a new one if pool is empty.
   * O(1) operation — pops from pre-allocated array.
   */
  acquire(): T {
    this.acquireCount++;

    if (this.poolSize > 0) {
      this.poolSize--;
      return this.pool[this.poolSize]; // Pop from end (no splice/shift)
    }

    // Pool empty: create new object
    this.createCount++;
    return this.createFn();
  }

  /**
   * Return an object to the pool for reuse.
   * Resets the object's fields via resetFn before pooling.
   * If pool is at capacity, the object is discarded (GC'd).
   * O(1) operation.
   */
  release(obj: T): void {
    this.releaseCount++;

    if (this.poolSize >= this.maxSize) {
      // Pool full: discard (let GC collect)
      this.discardCount++;
      return;
    }

    // Reset fields for reuse
    this.resetFn(obj);

    // Return to pool
    this.pool[this.poolSize] = obj;
    this.poolSize++;
  }

  /**
   * Get the number of objects currently available in the pool.
   */
  available(): number {
    return this.poolSize;
  }

  /**
   * Get pool statistics for monitoring.
   */
  getStats(): {
    available: number;
    maxSize: number;
    acquireCount: number;
    releaseCount: number;
    createCount: number;
    discardCount: number;
    hitRate: number;
  } {
    const hitRate = this.acquireCount > 0
      ? (this.acquireCount - (this.createCount - (this.maxSize))) / this.acquireCount
      : 0;

    return {
      available: this.poolSize,
      maxSize: this.maxSize,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      createCount: this.createCount,
      discardCount: this.discardCount,
      hitRate: Math.max(0, Math.min(1, hitRate)),
    };
  }

  /**
   * Reset pool statistics.
   */
  resetStats(): void {
    this.acquireCount = 0;
    this.releaseCount = 0;
    this.createCount = this.poolSize; // Current pool objects count as created
    this.discardCount = 0;
  }

  /**
   * Clear the pool entirely.
   */
  clear(): void {
    this.pool.length = 0;
    this.poolSize = 0;
  }
}

/**
 * Numeric Rolling Window - O(1) Average Computation
 *
 * A high-performance circular buffer optimized for numeric statistics:
 * - O(1) push operation with automatic overwrite
 * - O(1) average computation via running sum
 * - Memory-efficient: uses Float64Array
 * - Cache-friendly: contiguous memory layout
 *
 * Features:
 * - Maintains running sum for instant average calculation
 * - Fixed capacity with automatic oldest-value eviction
 * - Handles overflow/underflow gracefully
 *
 * Used by:
 * - partition-solana/arbitrage-detector.ts (latency tracking)
 * - Any service needing fast rolling statistics
 *
 * Comparison with CircularBuffer<number>:
 * - This class uses Float64Array for better memory layout and cache performance
 * - O(1) average vs O(n) for generic CircularBuffer.reduce()
 * - Trade-off: Fixed to numbers only, no generic type support
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Statistics about the numeric buffer state
 */
export interface NumericRollingWindowStats {
  /** Current number of samples */
  count: number;
  /** Maximum capacity */
  capacity: number;
  /** Running sum of all values */
  sum: number;
  /** Average value (0 if empty) */
  average: number;
  /** Fill ratio (0-1) */
  fillRatio: number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Efficient circular buffer for numeric samples with O(1) average.
 *
 * Uses Float64Array for memory efficiency and cache locality.
 * Maintains a running sum for instant average calculation.
 *
 * @example
 * ```typescript
 * const window = new NumericRollingWindow(100);
 *
 * // Track latencies
 * window.push(15.5);
 * window.push(12.3);
 * window.push(18.7);
 *
 * // Get instant average (O(1))
 * console.log(window.average()); // 15.5
 * ```
 */
export class NumericRollingWindow {
  private readonly buffer: Float64Array;
  private readonly maxSize: number;
  private readonly recalibrationInterval: number;
  private index = 0;
  private count = 0;
  private sum = 0;
  private pushCount = 0;

  /**
   * Create a new NumericRollingWindow.
   *
   * @param maxSize - Maximum number of samples to track (must be positive)
   * @throws Error if maxSize is not positive
   */
  constructor(maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error('NumericRollingWindow maxSize must be a positive integer');
    }
    this.maxSize = maxSize;
    this.buffer = new Float64Array(maxSize);
    this.recalibrationInterval = maxSize * 100;
  }

  /**
   * Add a value to the buffer. O(1)
   *
   * If buffer is full, overwrites the oldest value and adjusts the sum.
   *
   * @param value - Numeric value to add
   */
  push(value: number): void {
    // Guard against NaN poisoning the running sum.
    // Callers may pass computed values (e.g., Date.now() - undefined) that yield NaN.
    // Silently dropping a bad sample is safer than crashing the detector.
    if (Number.isNaN(value)) return;

    // If buffer is full, subtract the value being overwritten from sum
    if (this.count === this.maxSize) {
      this.sum -= this.buffer[this.index];
    } else {
      this.count++;
    }

    // Add new value
    this.buffer[this.index] = value;
    this.sum += value;

    // Move to next position (circular)
    this.index = (this.index + 1) % this.maxSize;

    // Periodic recalibration to mitigate floating-point drift
    this.pushCount++;
    if (this.pushCount >= this.recalibrationInterval) {
      this.recalibrateSum();
      this.pushCount = 0;
    }
  }

  /**
   * Recompute sum from buffer contents to correct floating-point drift.
   * Called periodically (every capacity * 100 pushes) to keep running sum accurate.
   */
  private recalibrateSum(): void {
    let newSum = 0;
    for (let i = 0; i < this.count; i++) {
      newSum += this.buffer[i];
    }
    this.sum = newSum;
  }

  /**
   * Get the average of all values in the buffer. O(1)
   *
   * @returns Average value, or 0 if buffer is empty
   */
  average(): number {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  /**
   * Get the sum of all values in the buffer. O(1)
   *
   * @returns Sum of all values
   */
  getSum(): number {
    return this.sum;
  }

  /**
   * Get current number of samples in buffer.
   */
  get size(): number {
    return this.count;
  }

  /**
   * Get maximum capacity of buffer.
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Check if buffer is empty.
   */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Check if buffer is full.
   */
  get isFull(): boolean {
    return this.count === this.maxSize;
  }

  /**
   * Clear the buffer and reset statistics.
   */
  clear(): void {
    this.buffer.fill(0);
    this.index = 0;
    this.count = 0;
    this.sum = 0;
    this.pushCount = 0;
  }

  /**
   * Get buffer statistics.
   *
   * @returns Statistics about the buffer state
   */
  getStats(): NumericRollingWindowStats {
    return {
      count: this.count,
      capacity: this.maxSize,
      sum: this.sum,
      average: this.average(),
      fillRatio: this.maxSize > 0 ? this.count / this.maxSize : 0,
    };
  }

  /**
   * Get all values in order from oldest to newest. O(n)
   *
   * Note: For hot-path code, prefer using average() directly.
   *
   * @returns Array of all values in chronological order
   */
  toArray(): number[] {
    if (this.count === 0) return [];

    const result: number[] = new Array(this.count);
    const startIndex = this.count === this.maxSize
      ? this.index // Full buffer: oldest is at current index
      : 0; // Partial buffer: oldest is at 0

    for (let i = 0; i < this.count; i++) {
      const bufferIndex = (startIndex + i) % this.maxSize;
      result[i] = this.buffer[bufferIndex];
    }

    return result;
  }

  /**
   * Calculate min value. O(n)
   *
   * @returns Minimum value, or Infinity if empty
   */
  min(): number {
    if (this.count === 0) return Infinity;

    let minVal = this.buffer[0];
    for (let i = 1; i < this.count; i++) {
      if (this.buffer[i] < minVal) {
        minVal = this.buffer[i];
      }
    }
    return minVal;
  }

  /**
   * Calculate max value. O(n)
   *
   * @returns Maximum value, or -Infinity if empty
   */
  max(): number {
    if (this.count === 0) return -Infinity;

    let maxVal = this.buffer[0];
    for (let i = 1; i < this.count; i++) {
      if (this.buffer[i] > maxVal) {
        maxVal = this.buffer[i];
      }
    }
    return maxVal;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a numeric rolling window for latency/performance tracking.
 *
 * @param maxSize - Maximum number of samples
 * @returns A new NumericRollingWindow instance
 */
export function createNumericRollingWindow(maxSize: number): NumericRollingWindow {
  return new NumericRollingWindow(maxSize);
}

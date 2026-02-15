/**
 * MinHeap Implementation
 *
 * High-performance heap data structure for efficient partial sorting.
 * Used for O(n log k) selection of k smallest/largest elements
 * instead of O(n log n) full sort or O(n*k) selection sort.
 *
 * Performance example (cleanup of 1000 opportunities removing 100 oldest):
 * - Selection sort: O(1000 * 100) = 100,000 operations
 * - MinHeap: O(1000 * log(100)) = ~7,000 operations (14x faster)
 *
 * Note: For hot-path code, ADR-022 recommends inline implementations
 * rather than class-based data structures. This module targets non-hot-path
 * consumers (cleanup, analytics, ranking).
 *
 * @see ADR-022 (Hot-Path Performance Rules)
 */

/**
 * MinHeap implementation for efficient partial sorting.
 *
 * @example
 * // Find 10 oldest opportunities from 1000
 * const heap = new MinHeap<Opportunity>((a, b) => a.timestamp - b.timestamp);
 * for (const opp of opportunities) {
 *   heap.push(opp);
 * }
 * // heap now contains all items, extractAll() returns them sorted (oldest first)
 *
 * @example
 * // Keep only 10 most recent (largest timestamps) - use inverted comparison
 * const heap = new MinHeap<Opportunity>((a, b) => b.timestamp - a.timestamp);
 * for (const opp of opportunities) {
 *   heap.push(opp);
 *   if (heap.size > 10) heap.pop(); // Remove oldest
 * }
 */
export class MinHeap<T> {
  private heap: T[] = [];
  private compare: (a: T, b: T) => number;

  /**
   * Create a new MinHeap.
   * @param compareFn - Comparison function. Returns negative if a < b, positive if a > b, 0 if equal.
   */
  constructor(compareFn: (a: T, b: T) => number) {
    this.compare = compareFn;
  }

  /**
   * Number of elements in the heap.
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Check if heap is empty.
   */
  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Peek at the minimum element without removing it.
   * @returns The minimum element, or undefined if heap is empty
   */
  peek(): T | undefined {
    return this.heap[0];
  }

  /**
   * Add an element to the heap. O(log n)
   * @param value - Element to add
   */
  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return the minimum element. O(log n)
   * @returns The minimum element, or undefined if heap is empty
   */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return min;
  }

  /**
   * Extract all elements in sorted order (ascending). O(n log n)
   * Note: This empties the heap.
   * @returns Array of all elements in sorted order
   */
  extractAll(): T[] {
    const result: T[] = [];
    while (!this.isEmpty) {
      result.push(this.pop()!);
    }
    return result;
  }

  /**
   * Clear all elements from the heap. O(1)
   */
  clear(): void {
    this.heap = [];
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parentIndex]) >= 0) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.compare(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }
      if (rightChild < length && this.compare(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }
      if (smallest === index) break;

      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}

/**
 * Find the k smallest elements from an iterable. O(n log k)
 * More efficient than full sort for large n with small k.
 *
 * @param items - Iterable of items to search
 * @param k - Number of smallest items to find
 * @param compareFn - Comparison function (same as Array.sort)
 * @returns Array of k smallest items in sorted order (ascending)
 *
 * @example
 * // Find 10 oldest opportunities
 * const oldest = findKSmallest(
 *   opportunities.values(),
 *   10,
 *   (a, b) => a.timestamp - b.timestamp
 * );
 */
export function findKSmallest<T>(
  items: Iterable<T>,
  k: number,
  compareFn: (a: T, b: T) => number
): T[] {
  if (k <= 0) return [];

  // Use max-heap to track k smallest (by keeping largest at top, we can efficiently discard)
  // Invert comparison to create max-heap from min-heap
  const maxHeap = new MinHeap<T>((a, b) => compareFn(b, a));

  for (const item of items) {
    maxHeap.push(item);
    if (maxHeap.size > k) {
      maxHeap.pop(); // Remove largest
    }
  }

  // Extract and reverse to get ascending order
  return maxHeap.extractAll().reverse();
}

/**
 * Find the k largest elements from an iterable. O(n log k)
 * More efficient than full sort for large n with small k.
 *
 * @param items - Iterable of items to search
 * @param k - Number of largest items to find
 * @param compareFn - Comparison function (same as Array.sort)
 * @returns Array of k largest items in sorted order (descending, largest first)
 *
 * @example
 * // Find 10 most profitable opportunities
 * const mostProfitable = findKLargest(
 *   opportunities.values(),
 *   10,
 *   (a, b) => a.profitPercentage - b.profitPercentage
 * );
 */
export function findKLargest<T>(
  items: Iterable<T>,
  k: number,
  compareFn: (a: T, b: T) => number
): T[] {
  if (k <= 0) return [];

  // Use min-heap to track k largest (by keeping smallest at top, we can efficiently discard)
  const minHeap = new MinHeap<T>(compareFn);

  for (const item of items) {
    minHeap.push(item);
    if (minHeap.size > k) {
      minHeap.pop(); // Remove smallest
    }
  }

  // Extract and reverse to get descending order (largest first)
  return minHeap.extractAll().reverse();
}

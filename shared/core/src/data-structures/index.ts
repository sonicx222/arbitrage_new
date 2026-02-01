/**
 * Data Structures Module
 *
 * High-performance data structures optimized for DeFi arbitrage trading:
 * - O(1) operations for hot-path code
 * - Memory-efficient fixed allocations
 * - GC-friendly slot clearing
 * - O(n log k) partial sorting for efficient cleanup
 *
 * @see ARCHITECTURE_V2.md Section 4.2 (Data Structures)
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

// Generic Circular Buffer (FIFO queue and rolling window)
export {
  CircularBuffer,
  createFifoBuffer,
  createRollingWindow,
} from './circular-buffer';

export type {
  CircularBufferConfig,
  CircularBufferStats,
} from './circular-buffer';

// LRU Cache (R1 extraction)
export {
  LRUCache,
  createLRUCache,
} from './lru-cache';

export type {
  LRUCacheStats,
} from './lru-cache';

// Numeric Rolling Window with O(1) average (R1 extraction)
export {
  NumericRollingWindow,
  createNumericRollingWindow,
} from './numeric-rolling-window';

export type {
  NumericRollingWindowStats,
} from './numeric-rolling-window';

// Min Heap for k-smallest/largest operations
export {
  MinHeap,
  findKSmallest,
  findKLargest,
} from './min-heap';

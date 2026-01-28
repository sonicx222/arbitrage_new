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
 */

export {
  CircularBuffer,
  createFifoBuffer,
  createRollingWindow,
} from './circular-buffer';

export type {
  CircularBufferConfig,
  CircularBufferStats,
} from './circular-buffer';

export {
  MinHeap,
  findKSmallest,
  findKLargest,
} from './min-heap';

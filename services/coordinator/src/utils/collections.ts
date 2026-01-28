/**
 * Collection Utilities for Coordinator Service
 *
 * Re-exports from @arbitrage/core for centralized data structure management.
 * FIX 10.5: MinHeap consolidated to shared/core to avoid duplication.
 *
 * @see shared/core/src/data-structures/min-heap.ts for implementation
 */

export { MinHeap, findKSmallest, findKLargest } from '@arbitrage/core';

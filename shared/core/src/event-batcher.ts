// Event Batching Infrastructure
// Optimizes event processing by batching similar events and reducing redundant operations

import { createLogger } from './logger';

const logger = createLogger('event-batcher');

/**
 * Parse EVENT_BATCHER_TIMEOUT_MS from env. Returns the parsed integer,
 * preserving 0 as a valid value. Falls back to `defaultMs` on NaN.
 * BUG-009 FIX: Single source of truth — previously duplicated in constructor and singleton factory.
 */
function parseEventBatcherTimeoutMs(defaultMs: number = 1): number {
  const parsed = parseInt(process.env.EVENT_BATCHER_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(parsed) ? defaultMs : parsed;
}

export interface BatchedEvent<T = any> {
  pairKey: string;
  events: T[];
  timestamp: number;
  batchSize: number;
}

export interface BatchConfig {
  maxBatchSize: number;
  maxWaitTime: number; // milliseconds
  enableDeduplication: boolean;
  enablePrioritization: boolean;
  // P1-3 fix: Maximum queue size to prevent unbounded memory growth
  maxQueueSize?: number;
}

export class EventBatcher<T = any> {
  private batches: Map<string, {
    events: T[];
    keys: Set<string>; // P1-2 FIX: O(1) dedup lookup instead of O(n) array scan
    timeout: NodeJS.Timeout;
    created: number;
  }> = new Map();
  private config: Required<BatchConfig>;
  private onBatchReady: (batch: BatchedEvent<T>) => void;
  private processingQueue: BatchedEvent<T>[] = [];
  private isProcessing = false;
  // P2-FIX: Mutex lock to prevent TOCTOU race condition in processQueue
  private processingLock: Promise<void> | null = null;
  // P1-3 fix: Track dropped batches for monitoring
  private droppedBatches = 0;

  constructor(
    config: Partial<BatchConfig> = {},
    onBatchReady: (batch: BatchedEvent<T>) => void
  ) {
    this.config = {
      // Q-NEW-3 FIX: Use ?? instead of || for numeric defaults.
      // || treats explicit 0 as falsy; ?? only replaces null/undefined.
      maxBatchSize: config.maxBatchSize ?? 10,
      // T1.3: Reduced from 50ms to 1ms for ultra-low latency detection
      // This reduces batch wait time by 98%, enabling fastest opportunity detection
      // Tunable via EVENT_BATCHER_TIMEOUT_MS env var (read once at construction)
      // BUG-008 FIX: Use helper to handle NaN from empty string while preserving 0
      // BUG-009 FIX: Deduplicated — uses shared parseEventBatcherTimeoutMs()
      maxWaitTime: config.maxWaitTime ?? parseEventBatcherTimeoutMs(1),
      enableDeduplication: config.enableDeduplication !== false,
      enablePrioritization: config.enablePrioritization !== false,
      // P1-3 fix: Default max queue size to prevent unbounded growth
      maxQueueSize: config.maxQueueSize ?? 1000
    };
    this.onBatchReady = onBatchReady;

    logger.info('EventBatcher initialized', {
      maxBatchSize: this.config.maxBatchSize,
      maxWaitTime: this.config.maxWaitTime,
      maxQueueSize: this.config.maxQueueSize
    });
  }

  addEvent(event: T, pairKey?: string): void {
    const key = pairKey || this.extractPairKey(event);
    if (!key) {
      logger.warn('Unable to extract pair key from event, processing immediately', { event });
      this.processEventImmediately(event);
      return;
    }

    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        events: [],
        keys: new Set<string>(),
        timeout: setTimeout(() => this.flushBatch(key), this.config.maxWaitTime),
        created: Date.now()
      };
      this.batches.set(key, batch);
    }

    // P1-2 FIX: O(1) deduplication using Set instead of O(n) array scan
    if (this.config.enableDeduplication) {
      const eventKey = this.getEventKey(event);
      if (batch.keys.has(eventKey)) {
        logger.debug('Duplicate event detected, skipping', { pairKey: key });
        return;
      }
      batch.keys.add(eventKey);
    }

    batch.events.push(event);

    // Check if batch is full
    if (batch.events.length >= this.config.maxBatchSize) {
      this.flushBatch(key);
    }
  }

  addEvents(events: T[], pairKey?: string): void {
    for (const event of events) {
      this.addEvent(event, pairKey);
    }
  }

  flushBatch(pairKey: string): void {
    const batch = this.batches.get(pairKey);
    if (!batch || batch.events.length === 0) {
      return;
    }

    // Clear timeout
    clearTimeout(batch.timeout);

    // Remove from batches map
    this.batches.delete(pairKey);

    // Create batched event
    const batchedEvent: BatchedEvent<T> = {
      pairKey,
      events: batch.events,
      timestamp: Date.now(),
      batchSize: batch.events.length
    };

    // P1-3 fix: Check queue size limit before adding
    // PERF-007 FIX: Use shift() instead of splice() to avoid O(n) intermediate array allocation
    if (this.processingQueue.length >= this.config.maxQueueSize) {
      // Drop oldest batches to make room (FIFO eviction)
      const toRemove = this.processingQueue.length - this.config.maxQueueSize + 1;
      for (let d = 0; d < toRemove; d++) {
        this.processingQueue.shift();
      }
      this.droppedBatches += toRemove;

      logger.warn('Processing queue at capacity, dropping oldest batches', {
        dropped: toRemove,
        totalDropped: this.droppedBatches,
        queueSize: this.processingQueue.length
      });
    }

    // Add to processing queue
    this.processingQueue.push(batchedEvent);

    // Sort by priority if enabled
    if (this.config.enablePrioritization) {
      this.sortProcessingQueue();
    }

    // Process queue
    this.processQueue();

    logger.debug(`Flushed batch for ${pairKey}: ${batch.events.length} events`);
  }

  /**
   * Flush all pending batches and process remaining queue items.
   * BUG FIX: Made async to properly await processQueue() completion.
   */
  async flushAll(): Promise<void> {
    // Q-NEW-1 FIX: Flush each batch into the processingQueue before clearing.
    // Previously, events in pending batches were permanently lost during shutdown
    // because batches.clear() was called without moving events to the queue.
    const keys = [...this.batches.keys()];
    for (const key of keys) {
      this.flushBatch(key);
    }

    // Process any remaining items in the queue
    await this.processQueue();
  }

  getStats(): {
    activeBatches: number;
    queuedBatches: number;
    totalEventsProcessed: number;
    averageBatchSize: number;
    // P1-3 fix: Track dropped batches for monitoring
    droppedBatches: number;
    maxQueueSize: number;
  } {
    let totalEvents = 0;
    let totalBatches = 0;

    for (const batch of this.batches.values()) {
      totalEvents += batch.events.length;
      totalBatches++;
    }

    for (const queuedBatch of this.processingQueue) {
      totalEvents += queuedBatch.events.length;
      totalBatches++;
    }

    return {
      activeBatches: this.batches.size,
      queuedBatches: this.processingQueue.length,
      totalEventsProcessed: totalEvents,
      averageBatchSize: totalBatches > 0 ? totalEvents / totalBatches : 0,
      // P1-3 fix: Include dropped batches in stats
      droppedBatches: this.droppedBatches,
      maxQueueSize: this.config.maxQueueSize
    };
  }

  private extractPairKey(event: T): string {
    // Duck-typing: inspect event shape at runtime to extract pair key
    const e = event as Record<string, any>;
    if (e.pairKey) {
      return e.pairKey;
    }

    if (e.address && e.topics) {
      return `contract_${e.address}`;
    }

    return 'unknown_pair';
  }

  private getEventKey(event: T): string {
    // Duck-typing: inspect event shape at runtime for dedup key
    const e = event as Record<string, any>;
    if (e.transactionHash && e.logIndex !== undefined) {
      return `${e.transactionHash}_${e.logIndex}`;
    }

    if (e.id) {
      return e.id;
    }

    // FIX #3: Intermediate field checks before expensive JSON.stringify fallback
    // Build a composite key from commonly available fields on price/sync events
    const pairAddr = e.pairAddress || e.address || '';
    const block = e.blockNumber ?? '';
    const ts = e.timestamp ?? '';
    if (pairAddr && (block !== '' || ts !== '')) {
      return `${pairAddr}_${block}_${ts}`;
    }

    if (e.pairKey && ts !== '') {
      return `${e.pairKey}_${ts}`;
    }

    // PERF-002: Last resort — build composite key from available primitive fields
    // Much cheaper than JSON.stringify for dedup purposes
    const parts: string[] = [];
    for (const key of Object.keys(e)) {
      const val = e[key];
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'bigint') {
        parts.push(`${key}:${val}`);
      }
    }
    return parts.length > 0 ? parts.join('|') : `fallback_${Date.now()}_${Math.random()}`;
  }

  /**
   * Insert the last element in the queue into its correct sorted position.
   * Uses binary search + insertion instead of full Array.sort() for O(log n)
   * insertion vs O(n log n) full sort. Maintains: batch size desc, then timestamp asc.
   */
  private sortProcessingQueue(): void {
    if (this.processingQueue.length <= 1) {
      return;
    }

    // The newly added element is always the last one
    const item = this.processingQueue.pop()!;

    // Binary search for the correct insertion position
    let low = 0;
    let high = this.processingQueue.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const midItem = this.processingQueue[mid];

      // Compare: larger batchSize first, then older timestamp first
      if (midItem.batchSize > item.batchSize ||
          (midItem.batchSize === item.batchSize && midItem.timestamp <= item.timestamp)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Insert at the correct position
    this.processingQueue.splice(low, 0, item);
  }

  /**
   * Process the queue with mutex lock to prevent TOCTOU race condition.
   * P2-FIX: Uses Promise-based lock to ensure only one processQueue runs at a time.
   */
  private async processQueue(): Promise<void> {
    // If queue is empty, nothing to do
    if (this.processingQueue.length === 0) {
      return;
    }

    // P2-FIX: Wait for any existing processing to complete before starting
    // This prevents the TOCTOU race between checking isProcessing and setting it
    if (this.processingLock) {
      await this.processingLock;
      // After waiting, check if queue is still non-empty (might have been processed)
      if (this.processingQueue.length === 0) {
        return;
      }
    }

    // Atomic check-and-set using synchronous flag + promise
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    // Create a lock promise that resolves when processing completes
    let resolveLock: () => void;
    this.processingLock = new Promise<void>(resolve => {
      resolveLock = resolve;
    });

    try {
      while (this.processingQueue.length > 0) {
        const batch = this.processingQueue.shift();
        if (batch) {
          await this.onBatchReady(batch);
        }
      }
    } finally {
      this.isProcessing = false;
      this.processingLock = null;
      resolveLock!();
    }
  }

  /**
   * Process an event immediately without batching.
   * P3-FIX: Handle async callback errors to prevent unhandled rejections.
   */
  private processEventImmediately(event: T): void {
    // For events that can't be batched, process immediately
    const batchedEvent: BatchedEvent<T> = {
      pairKey: 'immediate',
      events: [event],
      timestamp: Date.now(),
      batchSize: 1
    };

    // P3-FIX: Handle async callback errors - onBatchReady may return Promise
    Promise.resolve(this.onBatchReady(batchedEvent)).catch(error => {
      logger.error('Failed to process immediate event', { error, pairKey: batchedEvent.pairKey });
    });
  }

  /**
   * Cleanup method.
   * P2-2 fix: Made async to properly wait for pending processing to complete.
   */
  async destroy(): Promise<void> {
    logger.info('Destroying EventBatcher');

    // P2-2 fix: Wait for any pending processing to complete first
    if (this.processingLock) {
      logger.debug('Waiting for pending processing to complete');
      await this.processingLock;
    }

    // Flush all remaining batches (now properly awaited)
    await this.flushAll();

    // P2-2 fix: Wait again in case flushAll triggered more processing
    if (this.processingLock) {
      await this.processingLock;
    }

    // Clear any remaining timeouts (double-check)
    for (const batch of this.batches.values()) {
      if (batch.timeout) {
        clearTimeout(batch.timeout);
      }
    }

    // Clear all data structures
    this.batches.clear();
    this.processingQueue.length = 0;

    logger.info('EventBatcher destroyed successfully');
  }
}

// Factory function for creating configured batchers
export function createEventBatcher<T = any>(
  config: Partial<BatchConfig>,
  onBatchReady: (batch: BatchedEvent<T>) => void
): EventBatcher<T> {
  return new EventBatcher<T>(config, onBatchReady);
}

// =============================================================================
// Singleton Instance (P0-3 FIX: Thread-safe pattern with reset support)
// =============================================================================

/**
 * P0-3 FIX: Singleton instance with initialization guard.
 * Note: JavaScript is single-threaded, so no async mutex needed for synchronous constructors.
 * The guard variable prevents re-initialization during destroy/create cycles.
 */
let defaultEventBatcher: EventBatcher | null = null;
let isInitializing = false;

/**
 * Get the default singleton EventBatcher instance.
 * Creates one if it doesn't exist.
 *
 * P0-3 FIX: Added guard against re-initialization during destroy cycle.
 */
export function getDefaultEventBatcher(): EventBatcher {
  // Guard against concurrent initialization (defensive, though JS is single-threaded)
  if (isInitializing) {
    throw new Error('EventBatcher singleton is being initialized - recursive call detected');
  }

  if (!defaultEventBatcher) {
    isInitializing = true;
    try {
      defaultEventBatcher = new EventBatcher(
        {
          maxBatchSize: 25, // Optimized for high-throughput
          // T1.3: Reduced from 25ms to 1ms for ultra-low latency detection
          // Tunable via EVENT_BATCHER_TIMEOUT_MS env var
          // BUG-008 FIX: Use helper to handle NaN while preserving 0
          // BUG-009 FIX: Deduplicated — uses shared parseEventBatcherTimeoutMs()
          maxWaitTime: parseEventBatcherTimeoutMs(1),
          enableDeduplication: true,
          enablePrioritization: true
        },
        (batch) => {
          // Default batch processor - would be customized per use case
          logger.info(`Processing batch: ${batch.pairKey} (${batch.batchSize} events)`);
        }
      );
    } finally {
      isInitializing = false;
    }
  }
  return defaultEventBatcher;
}

/**
 * P0-3 FIX: Reset the singleton instance.
 * Required for testing and for cleanup during service shutdown.
 *
 * @returns Promise that resolves when destroy is complete
 */
export async function resetDefaultEventBatcher(): Promise<void> {
  if (defaultEventBatcher) {
    const instance = defaultEventBatcher;
    defaultEventBatcher = null;
    await instance.destroy();
  }
}
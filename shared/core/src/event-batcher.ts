// Event Batching Infrastructure
// Optimizes event processing by batching similar events and reducing redundant operations

import { createLogger } from './logger';

const logger = createLogger('event-batcher');

export interface BatchedEvent {
  pairKey: string;
  events: any[];
  timestamp: number;
  batchSize: number;
}

export interface BatchConfig {
  maxBatchSize: number;
  maxWaitTime: number; // milliseconds
  enableDeduplication: boolean;
  enablePrioritization: boolean;
}

export class EventBatcher {
  private batches: Map<string, {
    events: any[];
    timeout: NodeJS.Timeout;
    created: number;
  }> = new Map();
  private config: BatchConfig;
  private onBatchReady: (batch: BatchedEvent) => void;
  private processingQueue: BatchedEvent[] = [];
  private isProcessing = false;

  constructor(
    config: Partial<BatchConfig> = {},
    onBatchReady: (batch: BatchedEvent) => void
  ) {
    this.config = {
      maxBatchSize: config.maxBatchSize || 10,
      maxWaitTime: config.maxWaitTime || 50, // 50ms for ultra-fast processing
      enableDeduplication: config.enableDeduplication !== false,
      enablePrioritization: config.enablePrioritization !== false
    };
    this.onBatchReady = onBatchReady;

    logger.info('EventBatcher initialized', {
      maxBatchSize: this.config.maxBatchSize,
      maxWaitTime: this.config.maxWaitTime
    });
  }

  addEvent(event: any, pairKey?: string): void {
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
        timeout: setTimeout(() => this.flushBatch(key), this.config.maxWaitTime),
        created: Date.now()
      };
      this.batches.set(key, batch);
    }

    // Deduplication logic
    if (this.config.enableDeduplication) {
      const isDuplicate = this.isDuplicateEvent(batch.events, event);
      if (isDuplicate) {
        logger.debug('Duplicate event detected, skipping', { pairKey: key });
        return;
      }
    }

    batch.events.push(event);

    // Check if batch is full
    if (batch.events.length >= this.config.maxBatchSize) {
      this.flushBatch(key);
    }
  }

  addEvents(events: any[], pairKey?: string): void {
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
    const batchedEvent: BatchedEvent = {
      pairKey,
      events: batch.events,
      timestamp: Date.now(),
      batchSize: batch.events.length
    };

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

  flushAll(): void {
    // Clear all pending timeouts to prevent memory leaks
    for (const batch of this.batches.values()) {
      if (batch.timeout) {
        clearTimeout(batch.timeout);
      }
    }

    // Clear all batches
    this.batches.clear();

    // Process any remaining items in the queue
    this.processQueue();
  }

  getStats(): {
    activeBatches: number;
    queuedBatches: number;
    totalEventsProcessed: number;
    averageBatchSize: number;
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
      averageBatchSize: totalBatches > 0 ? totalEvents / totalBatches : 0
    };
  }

  private extractPairKey(event: any): string {
    // Extract pair key from different event types
    if (event.pairKey) {
      return event.pairKey;
    }

    if (event.address && event.topics) {
      // This looks like a blockchain log event
      // We would need to map contract addresses to pair keys
      // For now, return a generic key
      return `contract_${event.address}`;
    }

    // Fallback
    return 'unknown_pair';
  }

  private isDuplicateEvent(existingEvents: any[], newEvent: any): boolean {
    // Simple deduplication based on event hash or key properties
    // In production, this would be more sophisticated
    const newEventKey = this.getEventKey(newEvent);

    for (const existingEvent of existingEvents) {
      const existingEventKey = this.getEventKey(existingEvent);
      if (existingEventKey === newEventKey) {
        return true;
      }
    }

    return false;
  }

  private getEventKey(event: any): string {
    // Generate a unique key for event deduplication
    if (event.transactionHash && event.logIndex !== undefined) {
      return `${event.transactionHash}_${event.logIndex}`;
    }

    if (event.id) {
      return event.id;
    }

    // Fallback to JSON stringification (expensive but works)
    return JSON.stringify(event);
  }

  private sortProcessingQueue(): void {
    // Sort by batch size (larger batches first) and then by age (older first)
    this.processingQueue.sort((a, b) => {
      // Prioritize larger batches
      if (a.batchSize !== b.batchSize) {
        return b.batchSize - a.batchSize;
      }

      // Then by timestamp (older first)
      return a.timestamp - b.timestamp;
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.processingQueue.length > 0) {
        const batch = this.processingQueue.shift();
        if (batch) {
          await this.onBatchReady(batch);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private processEventImmediately(event: any): void {
    // For events that can't be batched, process immediately
    const batchedEvent: BatchedEvent = {
      pairKey: 'immediate',
      events: [event],
      timestamp: Date.now(),
      batchSize: 1
    };

    this.onBatchReady(batchedEvent);
  }

  // Cleanup method
  destroy(): void {
    logger.info('Destroying EventBatcher');

    // Flush all remaining batches
    this.flushAll();

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
export function createEventBatcher(
  config: Partial<BatchConfig>,
  onBatchReady: (batch: BatchedEvent) => void
): EventBatcher {
  return new EventBatcher(config, onBatchReady);
}

// Singleton instance
let defaultEventBatcher: EventBatcher | null = null;

export function getDefaultEventBatcher(): EventBatcher {
  if (!defaultEventBatcher) {
    defaultEventBatcher = new EventBatcher(
      {
        maxBatchSize: 25, // Optimized for high-throughput
        maxWaitTime: 25,  // 25ms for ultra-fast processing
        enableDeduplication: true,
        enablePrioritization: true
      },
      (batch) => {
        // Default batch processor - would be customized per use case
        logger.info(`Processing batch: ${batch.pairKey} (${batch.batchSize} events)`);
      }
    );
  }
  return defaultEventBatcher;
}
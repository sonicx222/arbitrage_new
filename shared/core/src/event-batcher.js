"use strict";
// Event Batching Infrastructure
// Optimizes event processing by batching similar events and reducing redundant operations
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBatcher = void 0;
exports.createEventBatcher = createEventBatcher;
exports.getDefaultEventBatcher = getDefaultEventBatcher;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('event-batcher');
class EventBatcher {
    constructor(config = {}, onBatchReady) {
        this.batches = new Map();
        this.processingQueue = [];
        this.isProcessing = false;
        // P2-FIX: Mutex lock to prevent TOCTOU race condition in processQueue
        this.processingLock = null;
        // P1-3 fix: Track dropped batches for monitoring
        this.droppedBatches = 0;
        this.config = {
            maxBatchSize: config.maxBatchSize || 10,
            // T1.3: Reduced from 50ms to 5ms for ultra-low latency detection
            // This reduces batch wait time by 90%, enabling faster opportunity detection
            maxWaitTime: config.maxWaitTime || 5,
            enableDeduplication: config.enableDeduplication !== false,
            enablePrioritization: config.enablePrioritization !== false,
            // P1-3 fix: Default max queue size to prevent unbounded growth
            maxQueueSize: config.maxQueueSize || 1000
        };
        this.onBatchReady = onBatchReady;
        logger.info('EventBatcher initialized', {
            maxBatchSize: this.config.maxBatchSize,
            maxWaitTime: this.config.maxWaitTime,
            maxQueueSize: this.config.maxQueueSize
        });
    }
    addEvent(event, pairKey) {
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
    addEvents(events, pairKey) {
        for (const event of events) {
            this.addEvent(event, pairKey);
        }
    }
    flushBatch(pairKey) {
        const batch = this.batches.get(pairKey);
        if (!batch || batch.events.length === 0) {
            return;
        }
        // Clear timeout
        clearTimeout(batch.timeout);
        // Remove from batches map
        this.batches.delete(pairKey);
        // Create batched event
        const batchedEvent = {
            pairKey,
            events: batch.events,
            timestamp: Date.now(),
            batchSize: batch.events.length
        };
        // P1-3 fix: Check queue size limit before adding
        if (this.processingQueue.length >= this.config.maxQueueSize) {
            // Drop oldest batches to make room (FIFO eviction)
            const toRemove = this.processingQueue.length - this.config.maxQueueSize + 1;
            const removed = this.processingQueue.splice(0, toRemove);
            this.droppedBatches += removed.length;
            logger.warn('Processing queue at capacity, dropping oldest batches', {
                dropped: removed.length,
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
    async flushAll() {
        // Clear all pending timeouts to prevent memory leaks
        for (const batch of this.batches.values()) {
            if (batch.timeout) {
                clearTimeout(batch.timeout);
            }
        }
        // Clear all batches
        this.batches.clear();
        // Process any remaining items in the queue
        await this.processQueue();
    }
    getStats() {
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
    extractPairKey(event) {
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
    isDuplicateEvent(existingEvents, newEvent) {
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
    getEventKey(event) {
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
    sortProcessingQueue() {
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
    /**
     * Process the queue with mutex lock to prevent TOCTOU race condition.
     * P2-FIX: Uses Promise-based lock to ensure only one processQueue runs at a time.
     */
    async processQueue() {
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
        let resolveLock;
        this.processingLock = new Promise(resolve => {
            resolveLock = resolve;
        });
        try {
            while (this.processingQueue.length > 0) {
                const batch = this.processingQueue.shift();
                if (batch) {
                    await this.onBatchReady(batch);
                }
            }
        }
        finally {
            this.isProcessing = false;
            this.processingLock = null;
            resolveLock();
        }
    }
    processEventImmediately(event) {
        // For events that can't be batched, process immediately
        const batchedEvent = {
            pairKey: 'immediate',
            events: [event],
            timestamp: Date.now(),
            batchSize: 1
        };
        this.onBatchReady(batchedEvent);
    }
    /**
     * Cleanup method.
     * P2-2 fix: Made async to properly wait for pending processing to complete.
     */
    async destroy() {
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
exports.EventBatcher = EventBatcher;
// Factory function for creating configured batchers
function createEventBatcher(config, onBatchReady) {
    return new EventBatcher(config, onBatchReady);
}
// Singleton instance
let defaultEventBatcher = null;
function getDefaultEventBatcher() {
    if (!defaultEventBatcher) {
        defaultEventBatcher = new EventBatcher({
            maxBatchSize: 25, // Optimized for high-throughput
            // T1.3: Reduced from 25ms to 5ms for ultra-low latency detection
            maxWaitTime: 5, // 5ms for minimal latency
            enableDeduplication: true,
            enablePrioritization: true
        }, (batch) => {
            // Default batch processor - would be customized per use case
            logger.info(`Processing batch: ${batch.pairKey} (${batch.batchSize} events)`);
        });
    }
    return defaultEventBatcher;
}
//# sourceMappingURL=event-batcher.js.map
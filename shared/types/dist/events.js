"use strict";
/**
 * Event Type Registry
 * P2-1-FIX: Centralized event types to prevent stringly-typed events
 *
 * This registry provides type-safe event names and payloads for the entire system.
 * Use these constants instead of string literals for event names.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventTypes = exports.PubSubChannels = exports.RedisStreams = void 0;
exports.createEvent = createEvent;
exports.isEventType = isEventType;
// ============================================================================
// Redis Stream Names (ADR-002)
// ============================================================================
exports.RedisStreams = {
    // Core event streams
    PRICE_UPDATES: 'stream:price-updates',
    SWAP_EVENTS: 'stream:swap-events',
    ARBITRAGE_OPPORTUNITIES: 'stream:arbitrage-opportunities',
    WHALE_TRANSACTIONS: 'stream:whale-transactions',
    // Service coordination streams
    SERVICE_HEALTH: 'stream:service-health',
    SERVICE_EVENTS: 'stream:service-events',
    COORDINATOR_EVENTS: 'stream:coordinator-events',
    // Execution streams
    EXECUTION_REQUESTS: 'stream:execution-requests',
    EXECUTION_RESULTS: 'stream:execution-results',
    // Dead letter queue
    DEAD_LETTER_QUEUE: 'stream:dlq',
};
// ============================================================================
// Redis Pub/Sub Channels (Legacy/Fallback)
// ============================================================================
exports.PubSubChannels = {
    // Price channels
    PRICE_UPDATE: 'price:update',
    PRICE_BATCH: 'price:batch',
    // Arbitrage channels
    ARBITRAGE_DETECTED: 'arbitrage:detected',
    ARBITRAGE_EXECUTED: 'arbitrage:executed',
    ARBITRAGE_FAILED: 'arbitrage:failed',
    // Service channels
    SERVICE_HEALTH: 'service:health',
    SERVICE_DEGRADED: 'service:degraded',
    SERVICE_RECOVERED: 'service:recovered',
    SERVICE_ALERT: 'service:alert',
    // Whale channels
    WHALE_ALERT: 'whale:alert',
    WHALE_TRANSACTION: 'whale:transaction',
};
// ============================================================================
// Event Types
// ============================================================================
exports.EventTypes = {
    // Price events
    PRICE_UPDATE: 'price:update',
    PRICE_BATCH: 'price:batch',
    PRICE_STALE: 'price:stale',
    // Arbitrage events
    ARBITRAGE_DETECTED: 'arbitrage:detected',
    ARBITRAGE_VALIDATED: 'arbitrage:validated',
    ARBITRAGE_EXECUTING: 'arbitrage:executing',
    ARBITRAGE_EXECUTED: 'arbitrage:executed',
    ARBITRAGE_FAILED: 'arbitrage:failed',
    ARBITRAGE_EXPIRED: 'arbitrage:expired',
    // Service events
    SERVICE_STARTING: 'service:starting',
    SERVICE_STARTED: 'service:started',
    SERVICE_STOPPING: 'service:stopping',
    SERVICE_STOPPED: 'service:stopped',
    SERVICE_HEALTHY: 'service:healthy',
    SERVICE_DEGRADED: 'service:degraded',
    SERVICE_UNHEALTHY: 'service:unhealthy',
    SERVICE_RECOVERED: 'service:recovered',
    SERVICE_ALERT: 'service:alert',
    // Health check events
    HEALTH_CHECK_PASSED: 'health:passed',
    HEALTH_CHECK_FAILED: 'health:failed',
    HEALTH_HEARTBEAT: 'health:heartbeat',
    // Circuit breaker events
    CIRCUIT_OPENED: 'circuit:opened',
    CIRCUIT_CLOSED: 'circuit:closed',
    CIRCUIT_HALF_OPEN: 'circuit:half-open',
    // WebSocket events
    WS_CONNECTED: 'ws:connected',
    WS_DISCONNECTED: 'ws:disconnected',
    WS_RECONNECTING: 'ws:reconnecting',
    WS_MESSAGE: 'ws:message',
    WS_ERROR: 'ws:error',
    // Chain events
    CHAIN_CONNECTED: 'chain:connected',
    CHAIN_DISCONNECTED: 'chain:disconnected',
    CHAIN_BLOCK: 'chain:block',
    CHAIN_REORG: 'chain:reorg',
    // Whale events
    WHALE_ALERT: 'whale:alert',
    WHALE_TRANSACTION: 'whale:transaction',
    // Error events
    ERROR_OCCURRED: 'error:occurred',
    ERROR_RECOVERED: 'error:recovered',
    ERROR_FATAL: 'error:fatal',
};
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Create a properly typed event with timestamp and correlation ID
 */
function createEvent(type, source, data, correlationId) {
    return {
        type,
        timestamp: Date.now(),
        source,
        correlationId,
        ...data,
    };
}
/**
 * Type guard to check if an event is of a specific type
 */
function isEventType(event, type) {
    return event.type === type;
}
//# sourceMappingURL=events.js.map
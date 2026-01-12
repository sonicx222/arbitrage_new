/**
 * Event Type Registry
 * P2-1-FIX: Centralized event types to prevent stringly-typed events
 *
 * This registry provides type-safe event names and payloads for the entire system.
 * Use these constants instead of string literals for event names.
 */
export declare const RedisStreams: {
    readonly PRICE_UPDATES: "stream:price-updates";
    readonly SWAP_EVENTS: "stream:swap-events";
    readonly ARBITRAGE_OPPORTUNITIES: "stream:arbitrage-opportunities";
    readonly WHALE_TRANSACTIONS: "stream:whale-transactions";
    readonly SERVICE_HEALTH: "stream:service-health";
    readonly SERVICE_EVENTS: "stream:service-events";
    readonly COORDINATOR_EVENTS: "stream:coordinator-events";
    readonly EXECUTION_REQUESTS: "stream:execution-requests";
    readonly EXECUTION_RESULTS: "stream:execution-results";
    readonly DEAD_LETTER_QUEUE: "stream:dlq";
};
export type RedisStreamName = typeof RedisStreams[keyof typeof RedisStreams];
export declare const PubSubChannels: {
    readonly PRICE_UPDATE: "price:update";
    readonly PRICE_BATCH: "price:batch";
    readonly ARBITRAGE_DETECTED: "arbitrage:detected";
    readonly ARBITRAGE_EXECUTED: "arbitrage:executed";
    readonly ARBITRAGE_FAILED: "arbitrage:failed";
    readonly SERVICE_HEALTH: "service:health";
    readonly SERVICE_DEGRADED: "service:degraded";
    readonly SERVICE_RECOVERED: "service:recovered";
    readonly SERVICE_ALERT: "service:alert";
    readonly WHALE_ALERT: "whale:alert";
    readonly WHALE_TRANSACTION: "whale:transaction";
};
export type PubSubChannelName = typeof PubSubChannels[keyof typeof PubSubChannels];
export declare const EventTypes: {
    readonly PRICE_UPDATE: "price:update";
    readonly PRICE_BATCH: "price:batch";
    readonly PRICE_STALE: "price:stale";
    readonly ARBITRAGE_DETECTED: "arbitrage:detected";
    readonly ARBITRAGE_VALIDATED: "arbitrage:validated";
    readonly ARBITRAGE_EXECUTING: "arbitrage:executing";
    readonly ARBITRAGE_EXECUTED: "arbitrage:executed";
    readonly ARBITRAGE_FAILED: "arbitrage:failed";
    readonly ARBITRAGE_EXPIRED: "arbitrage:expired";
    readonly SERVICE_STARTING: "service:starting";
    readonly SERVICE_STARTED: "service:started";
    readonly SERVICE_STOPPING: "service:stopping";
    readonly SERVICE_STOPPED: "service:stopped";
    readonly SERVICE_HEALTHY: "service:healthy";
    readonly SERVICE_DEGRADED: "service:degraded";
    readonly SERVICE_UNHEALTHY: "service:unhealthy";
    readonly SERVICE_RECOVERED: "service:recovered";
    readonly SERVICE_ALERT: "service:alert";
    readonly HEALTH_CHECK_PASSED: "health:passed";
    readonly HEALTH_CHECK_FAILED: "health:failed";
    readonly HEALTH_HEARTBEAT: "health:heartbeat";
    readonly CIRCUIT_OPENED: "circuit:opened";
    readonly CIRCUIT_CLOSED: "circuit:closed";
    readonly CIRCUIT_HALF_OPEN: "circuit:half-open";
    readonly WS_CONNECTED: "ws:connected";
    readonly WS_DISCONNECTED: "ws:disconnected";
    readonly WS_RECONNECTING: "ws:reconnecting";
    readonly WS_MESSAGE: "ws:message";
    readonly WS_ERROR: "ws:error";
    readonly CHAIN_CONNECTED: "chain:connected";
    readonly CHAIN_DISCONNECTED: "chain:disconnected";
    readonly CHAIN_BLOCK: "chain:block";
    readonly CHAIN_REORG: "chain:reorg";
    readonly WHALE_ALERT: "whale:alert";
    readonly WHALE_TRANSACTION: "whale:transaction";
    readonly ERROR_OCCURRED: "error:occurred";
    readonly ERROR_RECOVERED: "error:recovered";
    readonly ERROR_FATAL: "error:fatal";
};
export type EventType = typeof EventTypes[keyof typeof EventTypes];
export interface BaseEvent {
    type: EventType;
    timestamp: number;
    source: string;
    correlationId?: string;
}
export interface PriceUpdateEvent extends BaseEvent {
    type: typeof EventTypes.PRICE_UPDATE;
    data: {
        pairKey: string;
        chain: string;
        dex: string;
        price: number;
        reserve0: string;
        reserve1: string;
        blockNumber: number;
    };
}
export interface ArbitrageDetectedEvent extends BaseEvent {
    type: typeof EventTypes.ARBITRAGE_DETECTED;
    data: {
        opportunityId: string;
        type: string;
        chain?: string;
        buyDex?: string;
        sellDex?: string;
        expectedProfit: number;
        confidence: number;
    };
}
export interface ServiceHealthEvent extends BaseEvent {
    type: typeof EventTypes.SERVICE_HEALTHY | typeof EventTypes.SERVICE_DEGRADED | typeof EventTypes.SERVICE_UNHEALTHY;
    data: {
        service: string;
        status: 'healthy' | 'degraded' | 'unhealthy';
        uptime: number;
        memoryUsage: number;
        cpuUsage: number;
        error?: string;
    };
}
export interface WhaleAlertEvent extends BaseEvent {
    type: typeof EventTypes.WHALE_ALERT;
    data: {
        transactionHash: string;
        address: string;
        token: string;
        amount: number;
        usdValue: number;
        direction: 'buy' | 'sell';
        impact: number;
    };
}
export interface ErrorEvent extends BaseEvent {
    type: typeof EventTypes.ERROR_OCCURRED | typeof EventTypes.ERROR_RECOVERED | typeof EventTypes.ERROR_FATAL;
    data: {
        errorCode: string;
        message: string;
        service: string;
        stack?: string;
        recoverable: boolean;
    };
}
export type SystemEvent = PriceUpdateEvent | ArbitrageDetectedEvent | ServiceHealthEvent | WhaleAlertEvent | ErrorEvent | BaseEvent;
/**
 * Create a properly typed event with timestamp and correlation ID
 */
export declare function createEvent<T extends BaseEvent>(type: T['type'], source: string, data: Omit<T, 'type' | 'timestamp' | 'source' | 'correlationId'>, correlationId?: string): T;
/**
 * Type guard to check if an event is of a specific type
 */
export declare function isEventType<T extends BaseEvent>(event: SystemEvent, type: T['type']): event is T;
//# sourceMappingURL=events.d.ts.map
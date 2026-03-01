/**
 * Event Type Registry
 * P2-1-FIX: Centralized event types to prevent stringly-typed events
 *
 * This registry provides type-safe event names and payloads for the entire system.
 * Use these constants instead of string literals for event names.
 */

// ============================================================================
// Redis Stream Names (ADR-002)
// ============================================================================
export const RedisStreams = {
  // Core event streams
  PRICE_UPDATES: 'stream:price-updates',
  SWAP_EVENTS: 'stream:swap-events',
  OPPORTUNITIES: 'stream:opportunities',
  WHALE_ALERTS: 'stream:whale-alerts',

  // Service coordination streams
  SERVICE_HEALTH: 'stream:service-health',
  SERVICE_EVENTS: 'stream:service-events',
  COORDINATOR_EVENTS: 'stream:coordinator-events',
  HEALTH: 'stream:health',
  HEALTH_ALERTS: 'stream:health-alerts',

  // Execution streams
  EXECUTION_REQUESTS: 'stream:execution-requests',
  EXECUTION_RESULTS: 'stream:execution-results',

  // Mempool & detection streams
  PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
  VOLUME_AGGREGATES: 'stream:volume-aggregates',

  // System coordination streams
  CIRCUIT_BREAKER: 'stream:circuit-breaker',
  SYSTEM_FAILOVER: 'stream:system-failover',
  SYSTEM_COMMANDS: 'stream:system-commands',

  // P1 Fix CA-001: Self-healing system streams (created on-demand by expert-self-healing-manager)
  SYSTEM_FAILURES: 'stream:system-failures',
  SYSTEM_CONTROL: 'stream:system-control',
  SYSTEM_SCALING: 'stream:system-scaling',

  // Fast lane (coordinator bypass for high-confidence opportunities)
  FAST_LANE: 'stream:fast-lane',

  // Dead letter queue
  DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
  DLQ_ALERTS: 'stream:dlq-alerts',
  FORWARDING_DLQ: 'stream:forwarding-dlq',
} as const;

export type RedisStreamName = typeof RedisStreams[keyof typeof RedisStreams];

// ============================================================================
// Event Types
// ============================================================================
export const EventTypes = {
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
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// ============================================================================
// Event Payloads
// ============================================================================

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

// Union type for all events
export type SystemEvent =
  | PriceUpdateEvent
  | ArbitrageDetectedEvent
  | ServiceHealthEvent
  | WhaleAlertEvent
  | ErrorEvent
  | BaseEvent;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a properly typed event with timestamp and correlation ID
 */
export function createEvent<T extends BaseEvent>(
  type: T['type'],
  source: string,
  data: Omit<T, 'type' | 'timestamp' | 'source' | 'correlationId'>,
  correlationId?: string
): T {
  return {
    type,
    timestamp: Date.now(),
    source,
    correlationId,
    ...data,
  } as T;
}

/**
 * Type guard to check if an event is of a specific type
 */
export function isEventType<T extends BaseEvent>(
  event: SystemEvent,
  type: T['type']
): event is T {
  return event.type === type;
}

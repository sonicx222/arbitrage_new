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
/**
 * P3 Fix CA-004/CA-019: Lifecycle legend for stream constants.
 *
 * [ACTIVE]    — Receives traffic in normal operation (pre-created by coordinator)
 * [ON-DEMAND] — Created when first published to (by resilience/self-healing subsystems)
 * [IDLE]      — Consumer groups registered but no producer wired yet in dev mode
 */
export const RedisStreams = {
  // Core event streams
  PRICE_UPDATES: 'stream:price-updates',              // [ACTIVE] Producers: partition services
  SWAP_EVENTS: 'stream:swap-events',                   // [IDLE] Future: DEX swap event ingestion
  OPPORTUNITIES: 'stream:opportunities',               // [ACTIVE] Producers: partition detectors
  WHALE_ALERTS: 'stream:whale-alerts',                 // [IDLE] Future: whale transaction alerts

  // Service coordination streams
  SERVICE_HEALTH: 'stream:service-health',             // [IDLE] Reserved for per-service health
  SERVICE_EVENTS: 'stream:service-events',             // [IDLE] Reserved for service lifecycle events
  COORDINATOR_EVENTS: 'stream:coordinator-events',     // [IDLE] Reserved for coordinator broadcasts
  HEALTH: 'stream:health',                             // [ACTIVE] Producers: all services (heartbeat)
  HEALTH_ALERTS: 'stream:health-alerts',               // [ON-DEMAND] Producer: enhanced-health-monitor

  // Execution streams
  EXECUTION_REQUESTS: 'stream:execution-requests',     // [ACTIVE] Producer: coordinator
  EXECUTION_RESULTS: 'stream:execution-results',       // [ACTIVE] Producer: execution-engine

  // Mempool & detection streams
  PENDING_OPPORTUNITIES: 'stream:pending-opportunities', // [IDLE] Future: mempool-detector
  VOLUME_AGGREGATES: 'stream:volume-aggregates',       // [IDLE] Future: volume aggregation

  // System coordination streams
  CIRCUIT_BREAKER: 'stream:circuit-breaker',           // [IDLE] Reserved for circuit breaker events
  SYSTEM_FAILOVER: 'stream:system-failover',           // [ON-DEMAND] Producer: cross-region-health
  SYSTEM_COMMANDS: 'stream:system-commands',           // [ON-DEMAND] Producer: enhanced-health-monitor

  // Self-healing system streams
  SYSTEM_FAILURES: 'stream:system-failures',           // [ON-DEMAND] Producer: expert-self-healing-manager
  SYSTEM_CONTROL: 'stream:system-control',             // [ON-DEMAND] Producer: expert-self-healing-manager
  SYSTEM_SCALING: 'stream:system-scaling',             // [ON-DEMAND] Producer: expert-self-healing-manager

  // Degradation events
  SERVICE_DEGRADATION: 'stream:service-degradation',   // [ON-DEMAND] Producers: graceful-degradation, self-healing-manager

  // Fast lane (coordinator bypass for high-confidence opportunities)
  FAST_LANE: 'stream:fast-lane',                       // [ACTIVE] Producer: partition detectors (high-confidence)

  // Dead letter queue
  DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',       // [ACTIVE] Producer: stream-consumer (failed messages)
  DLQ_ALERTS: 'stream:dlq-alerts',                     // [ON-DEMAND] Producer: dead-letter-queue manager
  FORWARDING_DLQ: 'stream:forwarding-dlq',             // [ON-DEMAND] Producer: DLQ forwarding failures
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

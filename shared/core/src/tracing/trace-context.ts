/**
 * Trace Context Propagation for Cross-Service Operations.
 *
 * Provides lightweight trace context generation and propagation for
 * correlating logs and operations across the arbitrage microservices.
 * Trace context is propagated through Redis Streams message headers.
 *
 * Design decisions:
 * - No heavy OTEL SDK dependency; uses crypto.randomBytes for ID generation
 * - Compatible with W3C Trace Context format (32-char traceId, 16-char spanId)
 * - Context travels as flat fields in Redis Streams messages for zero-overhead extraction
 *
 * @custom:version 1.0.0
 * @see ADR-002 for event pipeline architecture
 */

import { randomBytes } from 'crypto';

// =============================================================================
// Types
// =============================================================================

/**
 * Trace context for cross-service correlation.
 *
 * Fields follow W3C Trace Context semantics:
 * - traceId: 32-hex-char identifier for the entire operation chain
 * - spanId: 16-hex-char identifier for this specific operation
 * - parentSpanId: spanId of the caller (if any)
 * - serviceName: originating service name
 * - timestamp: creation time in milliseconds
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  serviceName: string;
  timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Prefix for trace context fields in Redis Streams messages */
const TRACE_PREFIX = '_trace_';

/** Field names used when propagating context through messages */
export const TRACE_FIELDS = {
  traceId: `${TRACE_PREFIX}traceId`,
  spanId: `${TRACE_PREFIX}spanId`,
  parentSpanId: `${TRACE_PREFIX}parentSpanId`,
  serviceName: `${TRACE_PREFIX}serviceName`,
  timestamp: `${TRACE_PREFIX}timestamp`,
} as const;

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a W3C-compatible trace ID (32 hex characters / 16 bytes).
 *
 * @returns 32-character lowercase hex string
 */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a W3C-compatible span ID (16 hex characters / 8 bytes).
 *
 * @returns 16-character lowercase hex string
 */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

// =============================================================================
// Context Lifecycle
// =============================================================================

/**
 * Create a new root trace context for a service operation.
 *
 * Call this at the entry point of a new operation (e.g., when a service
 * receives an external event or starts a new detection cycle).
 *
 * @param serviceName - Name of the originating service
 * @returns Fresh TraceContext with new traceId and spanId
 *
 * @example
 * ```typescript
 * const ctx = createTraceContext('partition-asia-fast');
 * logger.info('Detection cycle started', { traceId: ctx.traceId });
 * ```
 */
export function createTraceContext(serviceName: string): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    serviceName,
    timestamp: Date.now(),
  };
}

/**
 * Create a child span context that inherits the parent's traceId.
 *
 * Use this when a service processes a message from another service
 * and wants to continue the trace with a new span.
 *
 * @param parent - The parent trace context
 * @param serviceName - Name of the current service
 * @returns New TraceContext with same traceId but new spanId
 *
 * @example
 * ```typescript
 * const parentCtx = extractContext(message);
 * if (parentCtx) {
 *   const childCtx = createChildContext(parentCtx, 'execution-engine');
 *   logger.info('Executing opportunity', { traceId: childCtx.traceId, spanId: childCtx.spanId });
 * }
 * ```
 */
export function createChildContext(parent: TraceContext, serviceName: string): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    serviceName,
    timestamp: Date.now(),
  };
}

// =============================================================================
// Propagation (inject/extract for Redis Streams messages)
// =============================================================================

/**
 * Inject trace context into a message for cross-service propagation.
 *
 * Adds trace fields as flat keys with the `_trace_` prefix so they
 * travel alongside the message payload in Redis Streams.
 *
 * @param message - The message payload to enrich
 * @param context - The trace context to inject
 * @returns New message object with trace fields added (does not mutate input)
 *
 * @example
 * ```typescript
 * const ctx = createTraceContext('unified-detector');
 * const enriched = propagateContext({ type: 'price_update', price: '1.23' }, ctx);
 * await streamsClient.xadd('prices', enriched);
 * ```
 */
export function propagateContext(
  message: Record<string, unknown>,
  context: TraceContext,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...message };

  enriched[TRACE_FIELDS.traceId] = context.traceId;
  enriched[TRACE_FIELDS.spanId] = context.spanId;
  enriched[TRACE_FIELDS.serviceName] = context.serviceName;
  enriched[TRACE_FIELDS.timestamp] = String(context.timestamp);

  if (context.parentSpanId) {
    enriched[TRACE_FIELDS.parentSpanId] = context.parentSpanId;
  }

  return enriched;
}

/**
 * Extract trace context from an incoming message.
 *
 * Returns null if the message does not contain valid trace fields,
 * allowing callers to fall back to creating a new root context.
 *
 * @param message - The incoming message (e.g., from Redis Streams)
 * @returns Extracted TraceContext, or null if not present
 *
 * @example
 * ```typescript
 * const parentCtx = extractContext(incomingMessage);
 * const ctx = parentCtx
 *   ? createChildContext(parentCtx, 'execution-engine')
 *   : createTraceContext('execution-engine');
 * ```
 */
export function extractContext(message: Record<string, unknown>): TraceContext | null {
  const traceId = message[TRACE_FIELDS.traceId];
  const spanId = message[TRACE_FIELDS.spanId];
  const serviceName = message[TRACE_FIELDS.serviceName];
  const timestamp = message[TRACE_FIELDS.timestamp];

  // All required fields must be present and be strings
  if (
    typeof traceId !== 'string' ||
    typeof spanId !== 'string' ||
    typeof serviceName !== 'string'
  ) {
    return null;
  }

  // Validate traceId format (32 hex chars)
  if (!/^[0-9a-f]{32}$/.test(traceId)) {
    return null;
  }

  // Validate spanId format (16 hex chars)
  if (!/^[0-9a-f]{16}$/.test(spanId)) {
    return null;
  }

  const parentSpanId = message[TRACE_FIELDS.parentSpanId];
  const parsedTimestamp = typeof timestamp === 'string' ? parseInt(timestamp, 10) : NaN;

  const context: TraceContext = {
    traceId,
    spanId,
    serviceName,
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
  };

  if (typeof parentSpanId === 'string' && /^[0-9a-f]{16}$/.test(parentSpanId)) {
    context.parentSpanId = parentSpanId;
  }

  return context;
}

/**
 * Strip trace context fields from a message.
 *
 * Useful when you want to process the business payload without
 * trace metadata cluttering the object.
 *
 * @param message - Message potentially containing trace fields
 * @returns New message object without trace fields
 */
export function stripTraceFields(message: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message)) {
    if (!key.startsWith(TRACE_PREFIX)) {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

/**
 * Tracing Module
 *
 * Provides lightweight trace context propagation for cross-service
 * log correlation. Context is propagated through Redis Streams messages.
 *
 * @custom:version 1.0.0
 * @see ADR-002 for event pipeline architecture
 */

export {
  createTraceContext,
  createChildContext,
  propagateContext,
  extractContext,
  stripTraceFields,
  generateTraceId,
  generateSpanId,
  TRACE_FIELDS,
} from './trace-context';

export type { TraceContext } from './trace-context';

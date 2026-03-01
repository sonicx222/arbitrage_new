/**
 * Stream Serialization Utilities
 *
 * Converts ArbitrageOpportunity objects to flat string maps suitable
 * for Redis Stream XADD operations. Extracts the duplicated mapping
 * logic from coordinator.ts and opportunity-router.ts into a single
 * source of truth.
 *
 * Design notes:
 * - `type` and `chain` use `||` intentionally: empty string should
 *   also trigger the default value ('simple' / 'unknown').
 * - `timestamp` uses `||` intentionally: empty string should trigger
 *   Date.now() fallback.
 * - All other string fields use `??` (nullish coalescing) to preserve
 *   empty strings as valid values.
 *
 * @see coordinator.ts forwardOpportunityToExecution()
 * @see opportunities/opportunity-router.ts forwardToExecutionEngine()
 * @see OP-3 FIX: Trace context propagation through serialized messages
 */
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { TraceContext } from '@arbitrage/core/tracing';

/**
 * Serialize an ArbitrageOpportunity into a flat Record<string, string>
 * suitable for Redis Stream XADD.
 *
 * OP-3 FIX: Now accepts optional trace context for cross-service correlation.
 * Trace fields use the `_trace_` prefix per the trace-context module convention.
 *
 * @param opportunity - The opportunity to serialize
 * @param instanceId - The forwarding service's instance ID
 * @param traceContext - Optional trace context for cross-service correlation
 * @returns Flat string map for Redis Stream message data
 */
export function serializeOpportunityForStream(
  opportunity: ArbitrageOpportunity,
  instanceId: string,
  traceContext?: TraceContext,
): Record<string, string> {
  const result: Record<string, string> = {
    id: opportunity.id,
    type: opportunity.type || 'simple',
    chain: opportunity.chain || 'unknown',
    // Use ?? for consistency: only replace null/undefined, not empty string.
    // For these string fields || and ?? behave identically in practice.
    buyDex: opportunity.buyDex ?? '',
    sellDex: opportunity.sellDex ?? '',
    profitPercentage: opportunity.profitPercentage?.toString() ?? '0',
    confidence: opportunity.confidence?.toString() ?? '0',
    timestamp: opportunity.timestamp?.toString() || Date.now().toString(),
    tokenIn: opportunity.tokenIn ?? '',
    tokenOut: opportunity.tokenOut ?? '',
    amountIn: opportunity.amountIn ?? '',
    // F1 FIX: Serialize fields required by execution engine validation.
    // expectedProfit/estimatedProfit are needed for business rule checks (LOW_PROFIT gate).
    // buyChain/sellChain are required for cross-chain opportunity validation.
    // gasEstimate is needed for execution cost calculations.
    expectedProfit: opportunity.expectedProfit?.toString() ?? '0',
    estimatedProfit: opportunity.estimatedProfit?.toString() ?? '0',
    gasEstimate: opportunity.gasEstimate ?? '0',
    // F1 FIX: Only serialize expiresAt when it has a numeric value.
    // Previously used `?? ''` which produced an empty string that passes the
    // `!== undefined && !== null` gate in validation.ts but fails NUMERIC_PATTERN,
    // causing every opportunity with undefined expiresAt to be rejected as INVALID_EXPIRES_AT.
    ...(opportunity.expiresAt != null
      ? { expiresAt: opportunity.expiresAt.toString() }
      : {}),
    // F1 FIX: Serialize cross-chain fields when present.
    // validateCrossChainFields() requires truthy buyChain/sellChain strings.
    ...(opportunity.buyChain ? { buyChain: opportunity.buyChain } : {}),
    ...(opportunity.sellChain ? { sellChain: opportunity.sellChain } : {}),
    forwardedBy: instanceId,
    forwardedAt: Date.now().toString(),
    // Phase 0 instrumentation: serialize pipeline timestamps as JSON string
    ...(opportunity.pipelineTimestamps
      ? { pipelineTimestamps: JSON.stringify(opportunity.pipelineTimestamps) }
      : {}),
  };

  // OP-3 FIX: Inject trace context fields for cross-service correlation.
  // Uses _trace_ prefix per shared/core/src/tracing/trace-context.ts convention.
  if (traceContext) {
    result._trace_traceId = traceContext.traceId;
    result._trace_spanId = traceContext.spanId;
    result._trace_serviceName = traceContext.serviceName;
    result._trace_timestamp = String(traceContext.timestamp);
    if (traceContext.parentSpanId) {
      result._trace_parentSpanId = traceContext.parentSpanId;
    }
  }

  return result;
}

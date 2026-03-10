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
 * - `timestamp` uses `??` (P3-003): preserves explicit 0; null/undefined
 *   falls back to Date.now().
 * - All other string fields use `??` (nullish coalescing) to preserve
 *   empty strings as valid values.
 *
 * @see coordinator.ts forwardOpportunityToExecution()
 * @see opportunities/opportunity-router.ts forwardToExecutionEngine()
 * @see OP-3 FIX: Trace context propagation through serialized messages
 */
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { TraceContext } from '@arbitrage/core/tracing';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('stream-serialization');

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
// P3-004: Track malformed opportunities to avoid log spam (once per missing field combo)
const _warnedMissingFields = new Set<string>();

export function serializeOpportunityForStream(
  opportunity: ArbitrageOpportunity,
  instanceId: string,
  traceContext?: TraceContext,
): Record<string, string> {
  // P3-004 FIX: Lightweight publish-side validation — catch malformed opportunities
  // before they enter EXECUTION_REQUESTS and get rejected into DLQ by consumer validation.
  // Does not throw — logs once per missing-field pattern to avoid hot-path impact.
  const missing: string[] = [];
  if (!opportunity.id) missing.push('id');
  if (!opportunity.chain) missing.push('chain');
  if (!opportunity.buyDex) missing.push('buyDex');
  if (!opportunity.sellDex) missing.push('sellDex');
  if (missing.length > 0) {
    const key = missing.join(',');
    if (!_warnedMissingFields.has(key)) {
      _warnedMissingFields.add(key);
      logger.warn('Missing required fields in opportunity', { opportunityId: opportunity.id ?? 'unknown', missingFields: key });
    }
  }

  const result: Record<string, string> = {
    id: opportunity.id,
    type: opportunity.type || 'simple',
    chain: opportunity.chain || 'unknown',
    // Use ?? for consistency: only replace null/undefined, not empty string.
    // For these string fields || and ?? behave identically in practice.
    buyDex: opportunity.buyDex ?? '',
    sellDex: opportunity.sellDex ?? '',
    // SA-1N-003 FIX: Guard against NaN/Infinity producing poison stream messages
    profitPercentage: (opportunity.profitPercentage != null && isFinite(opportunity.profitPercentage))
      ? opportunity.profitPercentage.toString() : '0',
    confidence: (opportunity.confidence != null && isFinite(opportunity.confidence))
      ? opportunity.confidence.toString() : '0',
    // P3-003 FIX: Use ?? instead of || so explicit timestamp 0 is preserved (not replaced by Date.now())
    timestamp: (opportunity.timestamp ?? Date.now()).toString(),
    tokenIn: opportunity.tokenIn ?? '',
    tokenOut: opportunity.tokenOut ?? '',
    amountIn: opportunity.amountIn ?? '',
    // F1 FIX: Serialize fields required by execution engine validation.
    // expectedProfit/estimatedProfit are needed for business rule checks (LOW_PROFIT gate).
    // buyChain/sellChain are required for cross-chain opportunity validation.
    // gasEstimate is needed for execution cost calculations.
    expectedProfit: (opportunity.expectedProfit != null && isFinite(opportunity.expectedProfit))
      ? opportunity.expectedProfit.toString() : '0',
    estimatedProfit: (opportunity.estimatedProfit != null && isFinite(opportunity.estimatedProfit))
      ? opportunity.estimatedProfit.toString() : '0',
    gasEstimate: opportunity.gasEstimate ?? '0',
    forwardedBy: instanceId,
    forwardedAt: Date.now().toString(),
  };

  // L-11 FIX: Use if-guards instead of spread operators to avoid
  // temporary object allocation per serialized opportunity (~300-400/s at peak).
  if (opportunity.expiresAt != null) {
    result.expiresAt = opportunity.expiresAt.toString();
  }
  if (opportunity.buyChain) {
    result.buyChain = opportunity.buyChain;
  }
  if (opportunity.sellChain) {
    result.sellChain = opportunity.sellChain;
  }
  if (opportunity.pipelineTimestamps) {
    result.pipelineTimestamps = JSON.stringify(opportunity.pipelineTimestamps);
  }

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

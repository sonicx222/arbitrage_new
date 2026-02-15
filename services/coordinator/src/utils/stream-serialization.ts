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
 */
import type { ArbitrageOpportunity } from '@arbitrage/types';

/**
 * Serialize an ArbitrageOpportunity into a flat Record<string, string>
 * suitable for Redis Stream XADD.
 *
 * @param opportunity - The opportunity to serialize
 * @param instanceId - The forwarding service's instance ID
 * @returns Flat string map for Redis Stream message data
 */
export function serializeOpportunityForStream(
  opportunity: ArbitrageOpportunity,
  instanceId: string,
): Record<string, string> {
  return {
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
    expiresAt: opportunity.expiresAt?.toString() ?? '',
    tokenIn: opportunity.tokenIn ?? '',
    tokenOut: opportunity.tokenOut ?? '',
    amountIn: opportunity.amountIn ?? '',
    forwardedBy: instanceId,
    forwardedAt: Date.now().toString(),
  };
}

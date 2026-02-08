/**
 * Flash Loan Aggregation - Data Transfer Objects (DTOs)
 *
 * Request/Response objects for application layer use cases.
 * Following Clean Architecture: DTOs cross layer boundaries.
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Application Layer
 */

import type { FlashLoanProtocol } from '../../../../../services/execution-engine/src/strategies/flash-loan-providers/types';
import type { ProviderSelection, LiquidityCheck, ProviderScore } from '../domain';

// =============================================================================
// Select Provider Use Case DTOs
// =============================================================================

/**
 * Select Provider Request
 *
 * Input data for SelectProviderUseCase.
 */
export interface SelectProviderRequest {
  /** Chain identifier */
  readonly chain: string;

  /** Token address for flash loan */
  readonly asset: string;

  /** Flash loan amount in wei */
  readonly amount: bigint;

  /** Estimated opportunity value in USD (for threshold checks) */
  readonly estimatedValueUsd: number;

  /** RPC provider for liquidity checks (optional) */
  readonly rpcProvider?: unknown; // ethers.JsonRpcProvider
}

/**
 * Select Provider Response
 *
 * Output data from SelectProviderUseCase.
 */
export interface SelectProviderResponse {
  /** Whether selection was successful */
  readonly success: boolean;

  /** Selected protocol (null if failed) */
  readonly protocol: FlashLoanProtocol | null;

  /** Provider score breakdown (null if failed) */
  readonly score: {
    readonly total: number;
    readonly fees: number;
    readonly liquidity: number;
    readonly reliability: number;
    readonly latency: number;
  } | null;

  /** Liquidity check result (null if not performed) */
  readonly liquidityCheck: {
    readonly performed: boolean;
    readonly sufficient: boolean;
    readonly available: string; // bigint as string for JSON serialization
    readonly required: string; // bigint as string for JSON serialization
    readonly latencyMs: number;
  } | null;

  /** Selection reason */
  readonly reason: string;

  /** Selection latency in milliseconds */
  readonly latencyMs: number;

  /** Alternative providers considered */
  readonly alternatives: ReadonlyArray<{
    readonly protocol: FlashLoanProtocol;
    readonly score: number;
  }>;
}

/**
 * Convert domain ProviderSelection to DTO
 */
export function toSelectProviderResponse(
  selection: ProviderSelection
): SelectProviderResponse {
  return {
    success: selection.isSuccess,
    protocol: selection.protocol,
    score: selection.score
      ? {
          total: selection.score.totalScore,
          fees: selection.score.feeScore,
          liquidity: selection.score.liquidityScore,
          reliability: selection.score.reliabilityScore,
          latency: selection.score.latencyScore,
        }
      : null,
    liquidityCheck: selection.liquidityCheck
      ? {
          performed: selection.liquidityCheck.checkPerformed,
          sufficient: selection.liquidityCheck.hasSufficientLiquidity,
          available: selection.liquidityCheck.availableLiquidity.toString(),
          required: selection.liquidityCheck.requiredLiquidity.toString(),
          latencyMs: selection.liquidityCheck.checkLatencyMs,
        }
      : null,
    reason: selection.selectionReason,
    latencyMs: selection.selectionLatencyMs,
    alternatives: selection.rankedAlternatives.map((alt) => ({
      protocol: alt.protocol,
      score: alt.score.totalScore,
    })),
  };
}

// =============================================================================
// Validate Liquidity Use Case DTOs
// =============================================================================

/**
 * Validate Liquidity Request
 *
 * Input data for ValidateLiquidityUseCase.
 */
export interface ValidateLiquidityRequest {
  /** Protocol to check */
  readonly protocol: FlashLoanProtocol;

  /** Chain identifier */
  readonly chain: string;

  /** Pool address */
  readonly poolAddress: string;

  /** Token address to check */
  readonly asset: string;

  /** Required amount in wei */
  readonly amount: bigint;

  /** RPC provider for on-chain call */
  readonly rpcProvider: unknown; // ethers.JsonRpcProvider
}

/**
 * Validate Liquidity Response
 *
 * Output data from ValidateLiquidityUseCase.
 */
export interface ValidateLiquidityResponse {
  /** Whether check was successful */
  readonly success: boolean;

  /** Whether provider has sufficient liquidity */
  readonly hasSufficientLiquidity: boolean;

  /** Available liquidity (as string for JSON) */
  readonly availableLiquidity: string;

  /** Required liquidity (as string for JSON) */
  readonly requiredLiquidity: string;

  /** Safety margin as percentage */
  readonly marginPercent: number;

  /** Check latency in milliseconds */
  readonly latencyMs: number;

  /** Error message (if check failed) */
  readonly error?: string;
}

/**
 * Convert domain LiquidityCheck to DTO
 */
export function toValidateLiquidityResponse(
  check: LiquidityCheck
): ValidateLiquidityResponse {
  return {
    success: check.checkPerformed && !check.error,
    hasSufficientLiquidity: check.hasSufficientLiquidity,
    availableLiquidity: check.availableLiquidity.toString(),
    requiredLiquidity: check.requiredLiquidity.toString(),
    marginPercent: check.getMarginPercent(),
    latencyMs: check.checkLatencyMs,
    error: check.error,
  };
}

// =============================================================================
// Track Provider Metrics Use Case DTOs
// =============================================================================

/**
 * Track Provider Metrics Request
 *
 * Input data for TrackProviderMetricsUseCase.
 */
export interface TrackProviderMetricsRequest {
  /** Protocol that was used */
  readonly protocol: FlashLoanProtocol;

  /** Chain identifier */
  readonly chain: string;

  /** Event type */
  readonly eventType: 'selection' | 'execution';

  /** Selection/execution reason */
  readonly reason?: string;

  /** Whether execution succeeded (for execution events) */
  readonly success?: boolean;

  /** Execution latency (for execution events) */
  readonly latencyMs?: number;

  /** Error message (for failed executions) */
  readonly error?: string;

  /** Error type classification */
  readonly errorType?: 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown';

  /** Event timestamp */
  readonly timestamp: number;
}

/**
 * Track Provider Metrics Response
 *
 * Output data from TrackProviderMetricsUseCase.
 */
export interface TrackProviderMetricsResponse {
  /** Whether tracking succeeded */
  readonly success: boolean;

  /** Error message (if tracking failed) */
  readonly error?: string;
}

// =============================================================================
// Get Aggregated Metrics Use Case DTOs
// =============================================================================

/**
 * Get Aggregated Metrics Request
 *
 * Input data for GetAggregatedMetricsUseCase.
 */
export interface GetAggregatedMetricsRequest {
  /** Optional protocol filter */
  readonly protocol?: FlashLoanProtocol;

  /** Optional chain filter */
  readonly chain?: string;
}

/**
 * Get Aggregated Metrics Response
 *
 * Output data from GetAggregatedMetricsUseCase.
 */
export interface GetAggregatedMetricsResponse {
  /** Total selections */
  readonly totalSelections: number;

  /** Selections with liquidity checks */
  readonly selectionsWithLiquidityCheck: number;

  /** Fallbacks triggered */
  readonly fallbacksTriggered: number;

  /** Average selection latency */
  readonly avgSelectionLatencyMs: number;

  /** P95 selection latency */
  readonly p95SelectionLatencyMs: number;

  /** Per-provider statistics */
  readonly byProvider: Record<string, {
    readonly timesSelected: number;
    readonly successRate: number;
    readonly avgLatencyMs: number;
  }>;
}

/**
 * Flash Loan Aggregation - Data Transfer Objects (DTOs)
 *
 * Request/Response objects for application layer use cases.
 * Following Clean Architecture: DTOs cross layer boundaries.
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type { FlashLoanProtocol } from '../domain/models';
import type { ProviderSelection } from '../domain';

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


/**
 * Select Provider Use Case
 *
 * Application layer orchestration for provider selection.
 * Coordinates domain services to select optimal flash loan provider.
 *
 * Performance Target: <10ms (cold path)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Use Case Pattern
 */

import type {
  IFlashLoanAggregator,
  IProviderRanker,
  ILiquidityValidator,
  IAggregatorMetrics,
  IOpportunityContext,
} from '../domain';
import type {
  SelectProviderRequest,
  SelectProviderResponse,
} from './dtos';
import { toSelectProviderResponse } from './dtos';

/**
 * Select Provider Use Case Dependencies
 *
 * Dependencies injected via constructor (Dependency Inversion).
 */
export interface SelectProviderUseCaseDependencies {
  /** Flash loan aggregator (main orchestrator) */
  readonly aggregator: IFlashLoanAggregator;

  /** Metrics tracker (optional) */
  readonly metrics?: IAggregatorMetrics;
}

/**
 * Select Provider Use Case
 *
 * Orchestrates provider selection for a flash loan opportunity.
 *
 * Responsibilities:
 * - Validate input data
 * - Build opportunity context from request
 * - Delegate to aggregator for selection
 * - Convert domain result to DTO
 * - Track metrics (if enabled)
 *
 * Following Use Case Pattern:
 * - Single public method: execute()
 * - Input: DTO (SelectProviderRequest)
 * - Output: DTO (SelectProviderResponse)
 * - Orchestrates domain services
 * - No business logic (delegates to domain)
 *
 * @example
 * ```typescript
 * const useCase = new SelectProviderUseCase({ aggregator, metrics });
 *
 * const request: SelectProviderRequest = {
 *   chain: 'ethereum',
 *   asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
 *   amount: BigInt(100000e6), // 100K USDC
 *   estimatedValueUsd: 100000,
 *   rpcProvider,
 * };
 *
 * const response = await useCase.execute(request);
 *
 * if (response.success) {
 *   console.log('Selected:', response.protocol);
 *   console.log('Score:', response.score);
 * } else {
 *   console.log('Failed:', response.reason);
 * }
 * ```
 */
export class SelectProviderUseCase {
  constructor(
    private readonly deps: SelectProviderUseCaseDependencies
  ) {}

  /**
   * Execute use case
   *
   * Process:
   * 1. Validate request
   * 2. Build opportunity context
   * 3. Delegate to aggregator
   * 4. Convert result to DTO
   * 5. Track metrics (if enabled)
   *
   * @param request - Provider selection request
   * @returns Provider selection response
   */
  async execute(
    request: SelectProviderRequest
  ): Promise<SelectProviderResponse> {
    // Validate request
    this.validateRequest(request);

    // Build opportunity context
    const context = this.buildContext(request);

    // Build minimal opportunity object for aggregator
    const opportunity = {
      id: `temp-${Date.now()}`, // Temporary ID for metrics
      chain: request.chain,
      tokenIn: request.asset,
      amountIn: request.amount.toString(),
      expectedProfit: request.estimatedValueUsd,
      buyChain: request.chain,
      buyPrice: 0, // Not needed for provider selection
      sellPrice: 0, // Not needed for provider selection
    };

    // Delegate to aggregator
    const selection = await this.deps.aggregator.selectProvider(
      opportunity as any, // Type assertion - aggregator expects full ArbitrageOpportunity
      context as any // Type assertion - aggregator expects full StrategyContext
    );

    // Convert domain result to DTO
    const response = toSelectProviderResponse(selection);

    return response;
  }

  /**
   * Validate request data
   */
  private validateRequest(request: SelectProviderRequest): void {
    if (!request.chain) {
      throw new Error('SelectProviderRequest: chain is required');
    }

    if (!request.asset || !request.asset.startsWith('0x')) {
      throw new Error(`SelectProviderRequest: invalid asset address: ${request.asset}`);
    }

    if (request.amount <= 0n) {
      throw new Error(`SelectProviderRequest: amount must be positive: ${request.amount}`);
    }

    if (request.estimatedValueUsd < 0) {
      throw new Error(`SelectProviderRequest: estimatedValueUsd must be non-negative: ${request.estimatedValueUsd}`);
    }
  }

  /**
   * Build opportunity context from request
   */
  private buildContext(request: SelectProviderRequest): IOpportunityContext {
    return {
      chain: request.chain,
      rpcProviders: request.rpcProvider
        ? new Map([[request.chain, request.rpcProvider]])
        : undefined,
      estimatedValueUsd: request.estimatedValueUsd,
    };
  }
}

/**
 * Factory function to create use case
 */
export function createSelectProviderUseCase(
  deps: SelectProviderUseCaseDependencies
): SelectProviderUseCase {
  return new SelectProviderUseCase(deps);
}

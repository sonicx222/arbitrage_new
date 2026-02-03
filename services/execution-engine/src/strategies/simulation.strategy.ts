/**
 * Simulation Execution Strategy
 *
 * Simulates arbitrage execution for local development and testing.
 * Bypasses blockchain transactions while maintaining realistic behavior.
 *
 * Use cases:
 * - Local development and testing
 * - Integration testing with full pipeline
 * - Performance testing and benchmarking
 * - Demo/presentation purposes
 *
 * ## Fix 1.1: Context Validation
 * Unlike real strategies, SimulationStrategy intentionally skips full context
 * validation (wallet, provider) since no real transactions occur. However,
 * it now logs warnings when context is incomplete to help catch configuration
 * issues during testing.
 *
 * ## Fix 4.3: Stats Tracking
 * SimulationStrategy now updates ctx.stats to ensure metrics remain consistent
 * between simulation and production modes.
 *
 * @see engine.ts (parent service)
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  StrategyContext,
  ExecutionResult,
  Logger,
  ResolvedSimulationConfig
} from '../types';
import { createErrorResult, createSuccessResult, ExecutionErrorCode } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

export class SimulationStrategy extends BaseExecutionStrategy {
  private readonly config: ResolvedSimulationConfig;

  constructor(logger: Logger, config: ResolvedSimulationConfig) {
    super(logger);
    this.config = config;
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const chain = opportunity.buyChain || 'ethereum';
    const dex = opportunity.buyDex || 'unknown';
    // P0-001 FIX: Use ?? to preserve 0 as valid profit (|| treats 0 as falsy)
    const expectedProfit = opportunity.expectedProfit ?? 0;

    // Fix 1.1: Validate basic opportunity structure (consistent with real strategies)
    if (!opportunity.id) {
      return createErrorResult(
        opportunity.id || 'unknown',
        ExecutionErrorCode.INVALID_OPPORTUNITY,
        chain,
        dex
      );
    }

    // Fix 1.1: Log warning if context is incomplete (helps catch config issues in tests)
    // This mirrors real strategy validation without failing (since no real tx occurs)
    if (!ctx.wallets?.get(chain)) {
      this.logger.debug('SimulationStrategy: No wallet for chain (expected in simulation mode)', {
        chain,
        opportunityId: opportunity.id,
      });
    }
    if (!ctx.providers?.get(chain)) {
      this.logger.debug('SimulationStrategy: No provider for chain (expected in simulation mode)', {
        chain,
        opportunityId: opportunity.id,
      });
    }

    // Fix 4.3: Track simulation skip in stats (simulations skipped because we're in simulation mode)
    ctx.stats.simulationsSkipped++;

    // Simulate execution latency
    await this.simulateLatency(this.config.executionLatencyMs);

    // Determine simulated success based on configured rate
    const isSuccess = Math.random() < this.config.successRate;

    // Calculate simulated values
    const simulatedGasUsed = this.config.gasUsed;
    const simulatedGasCost = expectedProfit * this.config.gasCostMultiplier;

    // Apply profit variance
    const variance = this.config.profitVariance;
    const profitMultiplier = 1 + (Math.random() * 2 - 1) * variance;
    const simulatedProfit = isSuccess ? (expectedProfit * profitMultiplier) - simulatedGasCost : 0;

    // Generate simulated transaction hash
    const simulatedTxHash = this.generateSimulatedTxHash();

    // Fix 4.3: Update execution stats to match real strategy behavior
    if (isSuccess) {
      ctx.stats.successfulExecutions++;
    } else {
      ctx.stats.failedExecutions++;
    }

    // Log simulated execution if enabled
    if (this.config.logSimulatedExecutions) {
      // Finding 6.2 Fix: Removed emoji per code conventions
      this.logger.info('SIMULATED execution completed', {
        opportunityId: opportunity.id,
        success: isSuccess,
        expectedProfit,
        simulatedProfit,
        simulatedGasCost,
        simulatedTxHash,
        type: opportunity.type
      });
    }

    // Fix 6.2: Use createSuccessResult/createErrorResult helpers for consistency
    // This ensures SimulationStrategy produces results identical in structure to real strategies
    if (isSuccess) {
      return createSuccessResult(
        opportunity.id,
        simulatedTxHash,
        chain,
        dex,
        {
          actualProfit: simulatedProfit,
          gasUsed: simulatedGasUsed,
          gasCost: simulatedGasCost,
        }
      );
    } else {
      return createErrorResult(
        opportunity.id,
        'Simulated execution failure (random)',
        chain,
        dex
      );
    }
  }

  /**
   * Simulate network/execution latency for realistic testing.
   */
  private async simulateLatency(baseLatencyMs: number): Promise<void> {
    const variance = 0.3;
    const actualLatency = baseLatencyMs * (1 + (Math.random() * 2 - 1) * variance);
    await new Promise(resolve => setTimeout(resolve, actualLatency));
  }

  /**
   * Generate a realistic-looking simulated transaction hash.
   */
  private generateSimulatedTxHash(): string {
    const bytes = new Array(32).fill(0).map(() => Math.floor(Math.random() * 256));
    return '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

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
 * @see engine.ts (parent service)
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  StrategyContext,
  ExecutionResult,
  Logger,
  ResolvedSimulationConfig
} from '../types';
import { BaseExecutionStrategy } from './base.strategy';

export class SimulationStrategy extends BaseExecutionStrategy {
  private readonly config: ResolvedSimulationConfig;

  constructor(logger: Logger, config: ResolvedSimulationConfig) {
    super(logger);
    this.config = config;
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    _ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const chain = opportunity.buyChain || 'ethereum';
    const expectedProfit = opportunity.expectedProfit || 0;

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

    const result: ExecutionResult = {
      opportunityId: opportunity.id,
      success: isSuccess,
      transactionHash: isSuccess ? simulatedTxHash : undefined,
      actualProfit: isSuccess ? simulatedProfit : undefined,
      gasUsed: isSuccess ? simulatedGasUsed : undefined,
      gasCost: isSuccess ? simulatedGasCost : undefined,
      error: isSuccess ? undefined : 'Simulated execution failure (random)',
      timestamp: Date.now(),
      chain,
      dex: opportunity.buyDex || 'unknown'
    };

    // Log simulated execution if enabled
    if (this.config.logSimulatedExecutions) {
      // Finding 6.2 Fix: Removed emoji per code conventions
      this.logger.info('SIMULATED execution completed', {
        opportunityId: opportunity.id,
        success: isSuccess,
        expectedProfit,
        simulatedProfit: result.actualProfit,
        simulatedGasCost,
        simulatedTxHash: result.transactionHash,
        type: opportunity.type
      });
    }

    return result;
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

/**
 * Execution Strategy Factory
 *
 * Provides a clean factory pattern for strategy selection and dispatch.
 * Encapsulates the strategy selection logic that was previously in engine.ts.
 *
 * Benefits:
 * - Single Responsibility: Strategy selection logic in one place
 * - Extensibility: Easy to add new strategy types
 * - Testability: Strategy selection can be tested independently
 * - Type Safety: Proper typing for strategy resolution
 *
 * @see engine.ts (consumer)
 * @see ARCHITECTURE_V2.md Section 4.3 (Strategy Pattern)
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  ExecutionStrategy,
  StrategyContext,
  ExecutionResult,
  Logger
} from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Strategy type identifiers
 */
export type StrategyType = 'simulation' | 'cross-chain' | 'intra-chain';

/**
 * Strategy resolution result
 */
export interface StrategyResolution {
  /** Resolved strategy type */
  type: StrategyType;
  /** The strategy instance to use */
  strategy: ExecutionStrategy;
  /** Why this strategy was selected */
  reason: string;
}

/**
 * Factory configuration
 */
export interface StrategyFactoryConfig {
  /** Logger instance */
  logger: Logger;
  /** Whether simulation mode is active */
  isSimulationMode: boolean;
}

/**
 * Registered strategies
 */
export interface RegisteredStrategies {
  simulation?: ExecutionStrategy;
  crossChain?: ExecutionStrategy;
  intraChain?: ExecutionStrategy;
}

// =============================================================================
// Strategy Factory Implementation
// =============================================================================

/**
 * Factory for selecting and executing the appropriate strategy.
 *
 * Strategy selection order:
 * 1. Simulation strategy (if simulation mode enabled)
 * 2. Cross-chain strategy (if opportunity.type === 'cross-chain')
 * 3. Intra-chain strategy (default)
 */
export class ExecutionStrategyFactory {
  private readonly logger: Logger;
  private isSimulationMode: boolean;

  private strategies: RegisteredStrategies = {};

  constructor(config: StrategyFactoryConfig) {
    this.logger = config.logger;
    this.isSimulationMode = config.isSimulationMode;
  }

  // ===========================================================================
  // Strategy Registration
  // ===========================================================================

  /**
   * Register the simulation strategy.
   */
  registerSimulationStrategy(strategy: ExecutionStrategy): void {
    this.strategies.simulation = strategy;
    this.logger.debug('Registered simulation strategy');
  }

  /**
   * Register the cross-chain strategy.
   */
  registerCrossChainStrategy(strategy: ExecutionStrategy): void {
    this.strategies.crossChain = strategy;
    this.logger.debug('Registered cross-chain strategy');
  }

  /**
   * Register the intra-chain strategy.
   */
  registerIntraChainStrategy(strategy: ExecutionStrategy): void {
    this.strategies.intraChain = strategy;
    this.logger.debug('Registered intra-chain strategy');
  }

  /**
   * Register multiple strategies at once.
   */
  registerStrategies(strategies: RegisteredStrategies): void {
    if (strategies.simulation) {
      this.registerSimulationStrategy(strategies.simulation);
    }
    if (strategies.crossChain) {
      this.registerCrossChainStrategy(strategies.crossChain);
    }
    if (strategies.intraChain) {
      this.registerIntraChainStrategy(strategies.intraChain);
    }
  }

  // ===========================================================================
  // Mode Control
  // ===========================================================================

  /**
   * Enable or disable simulation mode.
   *
   * When simulation mode is enabled, all opportunities use the simulation
   * strategy regardless of type.
   */
  setSimulationMode(enabled: boolean): void {
    const previous = this.isSimulationMode;
    this.isSimulationMode = enabled;

    if (previous !== enabled) {
      this.logger.info('Strategy factory simulation mode changed', {
        previous,
        current: enabled,
      });
    }
  }

  /**
   * Check if simulation mode is active.
   */
  getSimulationMode(): boolean {
    return this.isSimulationMode;
  }

  // ===========================================================================
  // Strategy Resolution
  // ===========================================================================

  /**
   * Resolve the appropriate strategy for an opportunity.
   *
   * @param opportunity - The opportunity to execute
   * @returns Strategy resolution with selected strategy and reason
   * @throws Error if no suitable strategy is available
   */
  resolve(opportunity: ArbitrageOpportunity): StrategyResolution {
    // Priority 1: Simulation mode overrides everything
    if (this.isSimulationMode) {
      if (!this.strategies.simulation) {
        throw new Error('Simulation mode enabled but no simulation strategy registered');
      }
      return {
        type: 'simulation',
        strategy: this.strategies.simulation,
        reason: 'Simulation mode is active',
      };
    }

    // Priority 2: Cross-chain opportunities
    if (opportunity.type === 'cross-chain') {
      if (!this.strategies.crossChain) {
        throw new Error('Cross-chain opportunity but no cross-chain strategy registered');
      }
      return {
        type: 'cross-chain',
        strategy: this.strategies.crossChain,
        reason: 'Opportunity type is cross-chain',
      };
    }

    // Priority 3: Default to intra-chain
    if (!this.strategies.intraChain) {
      throw new Error('No intra-chain strategy registered');
    }
    return {
      type: 'intra-chain',
      strategy: this.strategies.intraChain,
      reason: 'Default intra-chain execution',
    };
  }

  /**
   * Execute an opportunity using the appropriate strategy.
   *
   * This is a convenience method that combines resolve() and execute().
   *
   * @param opportunity - The opportunity to execute
   * @param context - Strategy execution context
   * @returns Execution result
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    context: StrategyContext
  ): Promise<ExecutionResult> {
    const resolution = this.resolve(opportunity);

    this.logger.debug('Strategy resolved', {
      opportunityId: opportunity.id,
      strategyType: resolution.type,
      reason: resolution.reason,
    });

    return resolution.strategy.execute(opportunity, context);
  }

  // ===========================================================================
  // Introspection
  // ===========================================================================

  /**
   * Check if a strategy type is registered.
   */
  hasStrategy(type: StrategyType): boolean {
    switch (type) {
      case 'simulation':
        return !!this.strategies.simulation;
      case 'cross-chain':
        return !!this.strategies.crossChain;
      case 'intra-chain':
        return !!this.strategies.intraChain;
      default:
        return false;
    }
  }

  /**
   * Get list of registered strategy types.
   */
  getRegisteredTypes(): StrategyType[] {
    const types: StrategyType[] = [];
    if (this.strategies.simulation) types.push('simulation');
    if (this.strategies.crossChain) types.push('cross-chain');
    if (this.strategies.intraChain) types.push('intra-chain');
    return types;
  }

  /**
   * Check if factory can handle any opportunities.
   */
  isReady(): boolean {
    // At minimum, need intra-chain strategy
    return !!this.strategies.intraChain;
  }

  /**
   * Clear all registered strategies.
   */
  clear(): void {
    this.strategies = {};
    this.logger.debug('All strategies cleared');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an ExecutionStrategyFactory.
 *
 * @param config - Factory configuration
 * @returns New factory instance
 */
export function createStrategyFactory(config: StrategyFactoryConfig): ExecutionStrategyFactory {
  return new ExecutionStrategyFactory(config);
}

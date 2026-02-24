/**
 * Execution Strategy Factory
 *
 * Provides a clean factory pattern for strategy selection and dispatch.
 * Encapsulates the strategy selection logic that was previously in engine.ts.
 *
 * ## Chain Support Scope
 *
 * This execution engine supports both EVM chains and Solana:
 *
 * - **EVM Chains**: Ethereum, BSC, Arbitrum, Base, Polygon, Optimism,
 *   Avalanche, Fantom, zkSync, Linea - Use flash loan and MEV strategies
 * - **Solana**: Uses SolanaExecutionStrategy with Jupiter V6 + Jito bundles
 *
 * @see ADR-034 for Solana execution architecture
 *
 * Benefits:
 * - Single Responsibility: Strategy selection logic in one place
 * - Extensibility: Easy to add new strategy types
 * - Testability: Strategy selection can be tested independently
 * - Type Safety: Proper typing for strategy resolution
 *
 * ## Important: "Simulation" Naming Clarification (Doc 1.4)
 *
 * The system has TWO distinct "simulation" concepts - do not confuse them:
 *
 * ### 1. SimulationStrategy (Dev/Test Mode)
 * - **Purpose**: Dry-run mode for development and testing
 * - **Location**: simulation.strategy.ts
 * - **Config**: SimulationConfig in types.ts (enabled, successRate, etc.)
 * - **Behavior**: Does NOT execute real transactions. Returns mock results.
 * - **Use Case**: Testing strategy selection, integration tests, dev environment
 *
 * ### 2. ISimulationService (Pre-flight Transaction Simulation)
 * - **Purpose**: Verify transaction will succeed BEFORE submitting to mempool
 * - **Location**: services/simulation/types.ts
 * - **Providers**: Tenderly, Alchemy, custom providers
 * - **Behavior**: Simulates the transaction against current chain state
 * - **Use Case**: Preventing failed transactions, MEV detection, gas estimation
 *
 * ### How They Interact
 * - SimulationStrategy REPLACES real execution (for testing)
 * - ISimulationService PRECEDES real execution (for safety)
 * - Both can be enabled simultaneously (simulation mode + pre-flight checks)
 * - Production typically has: SimulationStrategy OFF, ISimulationService ON
 *
 * @see engine.ts (consumer)
 * @see ARCHITECTURE_V2.md Section 4.3 (Strategy Pattern)
 * @see types.ts SimulationConfig (for SimulationStrategy config)
 * @see services/simulation/types.ts ISimulationService (for pre-flight simulation)
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
 * Strategy type identifiers.
 *
 * Fix 2.1 & 2.2: Added 'triangular' and 'quadrilateral' types per docs/strategies.md.
 * - triangular: 3-hop arbitrage (A -> B -> C -> A), uses flash-loan strategy
 * - quadrilateral: 4-hop arbitrage (A -> B -> C -> D -> A), uses flash-loan strategy
 *
 * Both triangular and quadrilateral route to flash-loan strategy since they require
 * capital-free execution via flash loans. The flash-loan strategy supports N-hop
 * swap paths via buildNHopSwapSteps().
 */
// P0 Fix #1: Added 'backrun' and 'uniswapx' strategy types
// Phase 3 #29: Added 'solana' for Solana-native execution via Jupiter/Jito
// Phase 3 #31: Added 'statistical' for statistical arbitrage strategies
export type StrategyType = 'simulation' | 'cross-chain' | 'intra-chain' | 'flash-loan' | 'triangular' | 'quadrilateral' | 'backrun' | 'uniswapx' | 'solana' | 'statistical';

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
  /**
   * Hybrid execution mode (Solution S4).
   *
   * When enabled:
   * - Real strategy selection logic is used (not SimulationStrategy)
   * - Strategies execute real validation and pre-execution logic
   * - Only the final transaction submission is mocked
   *
   * This allows testing the full strategy routing and execution logic
   * without making real blockchain transactions.
   *
   * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S4
   */
  isHybridMode?: boolean;
}

/**
 * Registered strategies
 */
export interface RegisteredStrategies {
  simulation?: ExecutionStrategy;
  crossChain?: ExecutionStrategy;
  intraChain?: ExecutionStrategy;
  flashLoan?: ExecutionStrategy;
  /** P0 Fix #1: MEV-Share backrun strategy (Ethereum only) */
  backrun?: ExecutionStrategy;
  /** P0 Fix #1: UniswapX Dutch auction filler strategy */
  uniswapx?: ExecutionStrategy;
  /** Phase 3 #29: Solana-native execution via Jupiter/Jito */
  solana?: ExecutionStrategy;
  /** Phase 3 #31: Statistical arbitrage (mean-reversion, cointegration) */
  statistical?: ExecutionStrategy;
}

// =============================================================================
// Strategy Factory Implementation
// =============================================================================

/**
 * Factory for selecting and executing the appropriate strategy.
 *
 * Strategy selection order (priority high to low):
 * 1. Simulation strategy - if simulation mode is enabled (overrides all)
 * 2. Flash loan strategy - if opportunity.type === 'flash-loan' or opportunity.useFlashLoan === true
 * 3. Cross-chain strategy - if opportunity.type === 'cross-chain'
 * 4. Intra-chain strategy - default fallback for same-chain opportunities
 *
 * @see resolve() method for implementation details
 */
export class ExecutionStrategyFactory {
  private readonly logger: Logger;
  private isSimulationMode: boolean;
  private isHybridMode: boolean;

  private strategies: RegisteredStrategies = {};

  constructor(config: StrategyFactoryConfig) {
    this.logger = config.logger;
    this.isSimulationMode = config.isSimulationMode;
    this.isHybridMode = config.isHybridMode ?? false;
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
   * Register the flash loan strategy.
   */
  registerFlashLoanStrategy(strategy: ExecutionStrategy): void {
    this.strategies.flashLoan = strategy;
    this.logger.debug('Registered flash-loan strategy');
  }

  /**
   * P0 Fix #1: Register the backrun strategy (MEV-Share backrunning).
   */
  registerBackrunStrategy(strategy: ExecutionStrategy): void {
    this.strategies.backrun = strategy;
    this.logger.debug('Registered backrun strategy');
  }

  /**
   * P0 Fix #1: Register the UniswapX filler strategy.
   */
  registerUniswapXStrategy(strategy: ExecutionStrategy): void {
    this.strategies.uniswapx = strategy;
    this.logger.debug('Registered uniswapx strategy');
  }

  /**
   * Phase 3 #29: Register the Solana execution strategy (Jupiter/Jito).
   */
  registerSolanaStrategy(strategy: ExecutionStrategy): void {
    this.strategies.solana = strategy;
    this.logger.debug('Registered solana strategy');
  }

  /**
   * Phase 3 #31: Register the statistical arbitrage strategy.
   */
  registerStatisticalStrategy(strategy: ExecutionStrategy): void {
    this.strategies.statistical = strategy;
    this.logger.debug('Registered statistical strategy');
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
    if (strategies.flashLoan) {
      this.registerFlashLoanStrategy(strategies.flashLoan);
    }
    if (strategies.backrun) {
      this.registerBackrunStrategy(strategies.backrun);
    }
    if (strategies.uniswapx) {
      this.registerUniswapXStrategy(strategies.uniswapx);
    }
    if (strategies.solana) {
      this.registerSolanaStrategy(strategies.solana);
    }
    if (strategies.statistical) {
      this.registerStatisticalStrategy(strategies.statistical);
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

  /**
   * Enable or disable hybrid execution mode.
   *
   * Hybrid mode uses real strategy selection but mocks transaction submission.
   * This allows testing strategy routing and execution logic without
   * real blockchain transactions.
   *
   * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S4
   */
  setHybridMode(enabled: boolean): void {
    const previous = this.isHybridMode;
    this.isHybridMode = enabled;

    if (previous !== enabled) {
      this.logger.info('Strategy factory hybrid mode changed', {
        previous,
        current: enabled,
      });
    }
  }

  /**
   * Check if hybrid execution mode is active.
   */
  getHybridMode(): boolean {
    return this.isHybridMode;
  }

  // ===========================================================================
  // Strategy Resolution
  // ===========================================================================

  /**
   * Resolve the appropriate strategy for an opportunity.
   *
   * Strategy selection order:
   * 1. Simulation strategy (if simulation mode enabled)
   * 2. Flash loan strategy (if opportunity.type === 'flash-loan' or opportunity.useFlashLoan)
   * 3. Cross-chain strategy (if opportunity.type === 'cross-chain' OR buyChain !== sellChain)
   * 4. Intra-chain strategy (default)
   *
   * Fix 1.3: Added implicit cross-chain detection based on buyChain/sellChain mismatch.
   * This ensures opportunities with different buy/sell chains are correctly routed
   * even without explicit type annotation.
   *
   * @param opportunity - The opportunity to execute
   * @returns Strategy resolution with selected strategy and reason
   * @throws Error if no suitable strategy is available
   */
  resolve(opportunity: ArbitrageOpportunity): StrategyResolution {
    // Priority 1: Simulation mode overrides everything (unless hybrid mode is active)
    // Hybrid mode uses real strategy selection with mocked transaction submission
    if (this.isSimulationMode && !this.isHybridMode) {
      if (!this.strategies.simulation) {
        throw new Error('[ERR_NO_STRATEGY] Simulation mode enabled but no simulation strategy registered');
      }
      return {
        type: 'simulation',
        strategy: this.strategies.simulation,
        reason: 'Simulation mode is active',
      };
    }

    // Log if hybrid mode is active (simulation mode enabled but using real strategies)
    if (this.isHybridMode) {
      this.logger.debug('Hybrid mode: using real strategy selection', {
        opportunityId: opportunity.id,
        opportunityType: opportunity.type,
      });
    }

    // Priority 2: Flash loan opportunities (including triangular and quadrilateral)
    // Fix 2.1 & 2.2: Added support for 'triangular' and 'quadrilateral' types
    // These multi-hop arbitrage strategies require flash loans for capital-free execution
    const isFlashLoanOpportunity =
      opportunity.type === 'flash-loan' ||
      opportunity.type === 'triangular' ||
      opportunity.type === 'quadrilateral' ||
      opportunity.useFlashLoan === true;

    if (isFlashLoanOpportunity) {
      if (!this.strategies.flashLoan) {
        throw new Error('[ERR_NO_STRATEGY] Flash loan opportunity but no flash-loan strategy registered');
      }

      // Determine the resolved type for logging/metrics
      let resolvedType: StrategyType = 'flash-loan';
      let reason = 'Opportunity requires flash loan execution';

      if (opportunity.type === 'triangular') {
        resolvedType = 'triangular';
        reason = 'Triangular arbitrage (3-hop) via flash loan';
      } else if (opportunity.type === 'quadrilateral') {
        resolvedType = 'quadrilateral';
        reason = 'Quadrilateral arbitrage (4-hop) via flash loan';
      }

      return {
        type: resolvedType,
        strategy: this.strategies.flashLoan,
        reason,
      };
    }

    // P0 Fix #1: Priority 2.5: Backrun opportunities (MEV-Share)
    if (opportunity.type === 'backrun') {
      if (!this.strategies.backrun) {
        throw new Error('[ERR_NO_STRATEGY] Backrun opportunity but no backrun strategy registered');
      }
      return {
        type: 'backrun',
        strategy: this.strategies.backrun,
        reason: 'MEV-Share backrun opportunity',
      };
    }

    // P0 Fix #1: Priority 2.6: UniswapX fill opportunities
    if (opportunity.type === 'uniswapx') {
      if (!this.strategies.uniswapx) {
        throw new Error('[ERR_NO_STRATEGY] UniswapX opportunity but no UniswapX strategy registered');
      }
      return {
        type: 'uniswapx',
        strategy: this.strategies.uniswapx,
        reason: 'UniswapX Dutch auction fill opportunity',
      };
    }

    // Phase 3 #29: Solana-native execution (by type or chain)
    if (opportunity.type === 'solana' || opportunity.chain === 'solana') {
      if (!this.strategies.solana) {
        throw new Error('[ERR_NO_STRATEGY] Solana opportunity but no Solana strategy registered');
      }
      return {
        type: 'solana',
        strategy: this.strategies.solana,
        reason: opportunity.type === 'solana'
          ? 'Solana-typed opportunity'
          : 'Opportunity on Solana chain',
      };
    }

    // Phase 3 #31: Statistical arbitrage
    if (opportunity.type === 'statistical') {
      // H4: Statistical arb on Solana routes to EVM flash loan which doesn't exist on Solana
      if (opportunity.chain === 'solana') {
        throw new Error('[ERR_UNSUPPORTED] Statistical arbitrage on Solana is not supported — requires EVM flash loan infrastructure');
      }
      if (!this.strategies.statistical) {
        throw new Error('[ERR_NO_STRATEGY] Statistical opportunity but no statistical strategy registered');
      }
      return {
        type: 'statistical',
        strategy: this.strategies.statistical,
        reason: 'Statistical arbitrage opportunity',
      };
    }

    // Priority 3: Cross-chain opportunities
    // Fix 1.3: Detect cross-chain implicitly from buyChain/sellChain mismatch
    const isExplicitCrossChain = opportunity.type === 'cross-chain';
    const isImplicitCrossChain =
      opportunity.buyChain &&
      opportunity.sellChain &&
      opportunity.buyChain !== opportunity.sellChain;

    if (isExplicitCrossChain || isImplicitCrossChain) {
      if (!this.strategies.crossChain) {
        throw new Error('[ERR_NO_STRATEGY] Cross-chain opportunity but no cross-chain strategy registered');
      }
      return {
        type: 'cross-chain',
        strategy: this.strategies.crossChain,
        reason: isExplicitCrossChain
          ? 'Opportunity type is cross-chain'
          : `Implicit cross-chain detected: buyChain (${opportunity.buyChain}) !== sellChain (${opportunity.sellChain})`,
      };
    }

    // Priority 4: Default to intra-chain
    if (!this.strategies.intraChain) {
      throw new Error('[ERR_NO_STRATEGY] No intra-chain strategy registered');
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
   *
   * Fix 2.1 & 2.2: 'triangular' and 'quadrilateral' check flashLoan strategy
   * since they both use the flash-loan strategy for execution.
   */
  hasStrategy(type: StrategyType): boolean {
    switch (type) {
      case 'simulation':
        return !!this.strategies.simulation;
      case 'cross-chain':
        return !!this.strategies.crossChain;
      case 'intra-chain':
        return !!this.strategies.intraChain;
      case 'flash-loan':
      case 'triangular':
      case 'quadrilateral':
        // Fix 2.1 & 2.2: Multi-hop strategies use flash-loan strategy
        return !!this.strategies.flashLoan;
      // P0 Fix #1: New strategy types
      case 'backrun':
        return !!this.strategies.backrun;
      case 'uniswapx':
        return !!this.strategies.uniswapx;
      // Phase 3: New strategy types
      case 'solana':
        return !!this.strategies.solana;
      case 'statistical':
        return !!this.strategies.statistical;
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
    if (this.strategies.flashLoan) types.push('flash-loan');
    // P0 Fix #1: Include new strategy types
    if (this.strategies.backrun) types.push('backrun');
    if (this.strategies.uniswapx) types.push('uniswapx');
    // Phase 3: Include new strategy types
    if (this.strategies.solana) types.push('solana');
    if (this.strategies.statistical) types.push('statistical');
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

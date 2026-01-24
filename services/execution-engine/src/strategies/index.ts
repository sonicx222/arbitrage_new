/**
 * Execution Strategies Module
 *
 * Re-exports all execution strategies and the strategy factory.
 *
 * @see engine.ts (parent service)
 */

export { BaseExecutionStrategy } from './base.strategy';
export { IntraChainStrategy } from './intra-chain.strategy';
export { CrossChainStrategy } from './cross-chain.strategy';
export { SimulationStrategy } from './simulation.strategy';
export {
  FlashLoanStrategy,
  createFlashLoanStrategy,
} from './flash-loan.strategy';
export type {
  FlashLoanStrategyConfig,
  SwapStep,
  SwapStepsParams,
  ExecuteArbitrageParams,
  ProfitabilityParams,
  ProfitabilityAnalysis,
} from './flash-loan.strategy';

// Strategy Factory Pattern
export {
  ExecutionStrategyFactory,
  createStrategyFactory,
} from './strategy-factory';
export type {
  StrategyType,
  StrategyResolution,
  StrategyFactoryConfig,
  RegisteredStrategies,
} from './strategy-factory';

// Flash Loan Provider Abstraction (Fix 1.1)
export {
  FlashLoanProviderFactory,
  createFlashLoanProviderFactory,
  AaveV3FlashLoanProvider,
  UnsupportedFlashLoanProvider,
} from './flash-loan-providers';
export type {
  FlashLoanProtocol,
  ProtocolSupportStatus,
  FlashLoanRequest,
  FlashLoanSwapStep,
  FlashLoanResult,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
  IFlashLoanProvider,
  FlashLoanProviderConfig,
} from './flash-loan-providers';

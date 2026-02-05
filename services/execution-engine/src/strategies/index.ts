/**
 * Execution Strategies Module
 *
 * Re-exports all execution strategies and the strategy factory.
 *
 * ## Strategy Architecture Overview
 *
 * All strategies extend `BaseExecutionStrategy` which provides:
 * - Gas price management with spike detection
 * - MEV protection integration
 * - Per-chain nonce locking (Fix 3.1)
 * - Transaction submission with health checks
 * - Price verification
 *
 * ## Error Handling Pattern (Doc 4.1)
 *
 * Strategies follow a consistent error handling pattern:
 *
 * 1. **execute() method NEVER throws** to its caller
 *    - Always returns `ExecutionResult` (success or error)
 *    - All errors are caught and wrapped in `createErrorResult()`
 *
 * 2. **Internal methods CAN throw**
 *    - `buildSwapSteps()`, `prepareFlashLoanContractTransaction()`, etc.
 *    - These are caught by execute()'s outer try/catch
 *
 * 3. **Error codes from ExecutionErrorCode enum**
 *    - Provides consistent, type-safe error identification
 *    - Enables error categorization for monitoring/alerting
 *
 * Example pattern:
 * ```typescript
 * async execute(opportunity, ctx): Promise<ExecutionResult> {
 *   try {
 *     // Internal methods may throw
 *     const result = await this.internalMethod();
 *     return createSuccessResult(...);
 *   } catch (error) {
 *     // All errors converted to ExecutionResult
 *     return createErrorResult(..., ExecutionErrorCode.FLASH_LOAN_ERROR, ...);
 *   }
 * }
 * ```
 *
 * @see engine.ts (parent service)
 * @see types.ts ExecutionErrorCode (error codes enum)
 */

export {
  BaseExecutionStrategy,
  validateGasPriceConfiguration,
} from './base.strategy';
export type { GasConfigValidationResult } from './base.strategy';
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

// P2-8: Flash Loan Fee Calculator (extracted for testability)
export {
  FlashLoanFeeCalculator,
  createFlashLoanFeeCalculator,
} from './flash-loan-fee-calculator';
export type { FlashLoanFeeCalculatorConfig } from './flash-loan-fee-calculator';

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

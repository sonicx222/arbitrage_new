/**
 * Shared Test Helpers Index
 *
 * ## Extraction Boundaries (M-07)
 *
 * **Shared** (extracted here):
 * - common-setup: Token/router deployment, funding (used by all 6+ test files)
 * - exchange-rates: Named rate constants, rate setup functions
 * - swap-paths: Path builder utilities
 * - shared-admin-tests: Admin function tests (router, pause, withdraw, ownership)
 * - shared-base-tests: Deployment defaults, input validation, profit validation, reentrancy
 * - commit-reveal: CommitReveal-specific deployment and helpers
 * - balancer-v2: Balancer-specific fixture
 *
 * **Protocol-specific** (NOT extracted — intentionally):
 * - Flash loan callback tests are protocol-dependent (Aave executeOperation,
 *   Balancer receiveFlashLoan, PancakeSwap pancakeV3FlashCallback, SyncSwap
 *   onFlashLoan, DAI onFlashLoan). Each has unique callback parameters, fee
 *   structures, and repayment mechanics that don't share enough structure to
 *   warrant extraction without tight coupling.
 */
export {
  deployTokens,
  deployRouters,
  fundRouters,
  fundProvider,
  deployBaseFixture,
  type DeployedTokens,
  type DeployedRouters,
  type FundingAmounts,
  type BaseFixture,
} from './common-setup';

export {
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  RATE_USDC_TO_DAI,
  RATE_DAI_TO_WETH_PROFIT,
  setupProfitableWethUsdcRates,
  setupTriangularRates,
} from './exchange-rates';

export {
  build2HopPath,
  build2HopCrossRouterPath,
  build3HopPath,
  getDeadline,
  type SwapStep,
} from './swap-paths';

export {
  deployCommitRevealFixture,
  createCommitmentHash,
  mineBlocks,
} from './commit-reveal';

export {
  deployBalancerV2Fixture,
  BALANCER_AMOUNTS,
  type BalancerV2Fixture,
} from './balancer-v2';

export {
  testRouterManagement,
  testMinimumProfitConfig,
  testSwapDeadlineConfig,
  testPauseUnpause,
  testWithdrawToken,
  testWithdrawETH,
  testWithdrawGasLimitConfig,
  testOwnable2Step,
  testZeroAmountEdgeCases,
  testAllAdminFunctions,
  type AdminTestFixture,
  type AdminTestConfig,
} from './shared-admin-tests';

export {
  testDeploymentDefaults,
  testInputValidation,
  testProfitValidation,
  testCalculateExpectedProfit,
  testReentrancyProtection,
  type DeploymentTestConfig,
  type DeploymentTestFixture,
  type ValidationTestConfig,
  type ValidationTestFixture,
  type ProfitValidationTestConfig,
  type CalculateProfitTestConfig,
  type CalculateProfitTestFixture,
  type CalculateProfitResult,
  type ReentrancyTestConfig,
  type ReentrancyTestFixture,
} from './shared-base-tests';

/**
 * Flash Loan Constants and ABI Definitions
 *
 * Centralized flash loan fee constants and contract ABIs.
 *
 * @see P1-4: Flash loan provider configuration
 */

import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from './addresses';

// =============================================================================
// FLASH LOAN CONSTANTS (Fix 1.1: Centralized constants)
// =============================================================================

/**
 * Aave V3 flash loan fee in basis points (0.09% = 9 bps)
 * Used by both FlashLoanStrategy and AaveV3FlashLoanProvider
 *
 * @see https://docs.aave.com/developers/guides/flash-loans
 */
export const AAVE_V3_FEE_BPS = 9;

/**
 * Basis points denominator (10000 = 100%)
 * Used for fee calculations: feeAmount = amount * feeBps / BPS_DENOMINATOR
 */
export const BPS_DENOMINATOR = 10000;

/**
 * Pre-computed BigInt versions for hot-path optimization
 * Avoids repeated BigInt conversion in performance-critical code
 *
 * FIX: Converted to lazy-loaded functions to avoid Jest BigInt serialization errors.
 * Jest workers serialize modules for communication, and JSON.stringify cannot serialize BigInt.
 * Functions are not serialized by Jest, so this avoids the "Do not know how to serialize a BigInt" error.
 */
export const getAaveV3FeeBpsBigInt = (): bigint => BigInt(AAVE_V3_FEE_BPS);
export const getBpsDenominatorBigInt = (): bigint => BigInt(BPS_DENOMINATOR);

/**
 * FlashLoanArbitrage contract ABI (minimal for execution)
 * Fix 9.2: Consolidated to single location for reuse
 *
 * ## Function Documentation
 *
 * ### executeArbitrage
 * Executes flash loan arbitrage with provided swap path.
 * Reverts if profit < minProfit or if any swap fails.
 *
 * ### calculateExpectedProfit (Fix 2.1: Enhanced documentation)
 * Returns `(uint256 expectedProfit, uint256 flashLoanFee)`:
 * - `expectedProfit`: Expected profit in asset units (0 if unprofitable or invalid path)
 * - `flashLoanFee`: Flash loan fee (0.09% of loan amount)
 *
 * **When `expectedProfit` returns 0, check these common causes:**
 * 1. Invalid swap path (tokenIn/tokenOut mismatch between steps)
 * 2. Router's getAmountsOut() call failed (pair doesn't exist, low liquidity)
 * 3. Final token doesn't match the starting asset (path doesn't loop back)
 * 4. Expected output is less than loan repayment amount (unprofitable)
 *
 * **Important distinction:**
 * - The function returns 0 for BOTH invalid paths AND valid-but-unprofitable paths
 * - To distinguish: a valid path with 0 profit means the swap would succeed but not be profitable
 * - An invalid path means the swap would revert on-chain
 *
 * @see contracts/src/FlashLoanArbitrage.sol
 */
/**
 * Shared ABI function signatures common to all flash arbitrage contracts.
 * Extracted to avoid duplication across provider-specific ABIs.
 */
const SHARED_ARBITRAGE_ABI_FUNCTIONS: string[] = [
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
];

export const FLASH_LOAN_ARBITRAGE_ABI: string[] = [
  ...SHARED_ARBITRAGE_ABI_FUNCTIONS,
  'function POOL() external view returns (address)',
];

/**
 * ABI for BalancerV2FlashArbitrage contract.
 * Minimal ABI containing only the functions needed for flash loan execution.
 *
 * **Function signatures:**
 * - `executeArbitrage(asset, amount, swapPath, minProfit, deadline)`: Execute flash loan arbitrage
 * - `calculateExpectedProfit(asset, amount, swapPath)`: Simulate arbitrage and calculate profit
 * - `isApprovedRouter(router)`: Check if router is approved for swaps
 * - `VAULT()`: Get the Balancer V2 Vault address
 *
 * **Key differences from Aave V3:**
 * - Uses VAULT() instead of POOL()
 * - Flash loan fee is always 0 (Balancer V2 doesn't charge flash loan fees)
 * - Same swap execution logic and validation
 *
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
export const BALANCER_V2_FLASH_ARBITRAGE_ABI: string[] = [
  ...SHARED_ARBITRAGE_ABI_FUNCTIONS,
  'function VAULT() external view returns (address)',
];

/**
 * Balancer V2 flash loan fee (0 basis points = 0%)
 * Balancer V2 charges no fees for flash loans, unlike Aave V3's 0.09%.
 */
export const BALANCER_V2_FEE_BPS = 0;

/**
 * SyncSwap flash loan fee in basis points (0.3% = 30 bps)
 * Used by SyncSwapFlashLoanProvider for fee calculations.
 *
 * SyncSwap charges 0.3% flash loan fee (higher than Balancer's 0%, lower than Aave's 0.09%).
 * Fee is applied to surplus balance after flash loan repayment.
 *
 * @see https://syncswap.xyz/
 * @see docs/syncswap_api_dpcu.md
 */
export const SYNCSWAP_FEE_BPS = 30;

/**
 * Pre-computed BigInt version for hot-path optimization.
 *
 * FIX: Converted to lazy-loaded function to avoid Jest BigInt serialization errors.
 * Jest workers serialize modules for communication, and JSON.stringify cannot serialize BigInt.
 * Functions are not serialized by Jest, so this avoids the "Do not know how to serialize a BigInt" error.
 */
export const getSyncSwapFeeBpsBigInt = (): bigint => BigInt(SYNCSWAP_FEE_BPS);

/**
 * SyncSwapFlashArbitrage contract ABI (minimal for execution).
 * Supports EIP-3156 compliant flash loans with 0.3% fee.
 *
 * ## Function Documentation
 *
 * ### executeArbitrage
 * Executes flash loan arbitrage using EIP-3156 interface.
 * Initiates flash loan from SyncSwap Vault and executes multi-hop swaps.
 *
 * ### calculateExpectedProfit
 * Returns `(uint256 expectedProfit, uint256 flashLoanFee)`:
 * - `expectedProfit`: Expected profit in asset units (0 if unprofitable or invalid path)
 * - `flashLoanFee`: Flash loan fee (0.3% of loan amount)
 *
 * **When `expectedProfit` returns 0:**
 * 1. Invalid swap path (tokenIn/tokenOut mismatch)
 * 2. Router's getAmountsOut() call failed
 * 3. Final token doesn't match starting asset
 * 4. Expected output < loan repayment (unprofitable)
 *
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 * @see contracts/src/interfaces/ISyncSwapVault.sol
 */
export const SYNCSWAP_FLASH_ARBITRAGE_ABI: string[] = [
  ...SHARED_ARBITRAGE_ABI_FUNCTIONS,
  'function VAULT() external view returns (address)',
];

/**
 * PancakeSwapFlashArbitrage contract ABI.
 *
 * PancakeSwap V3 has a different `executeArbitrage` signature than the shared base:
 * it takes an extra `pool` parameter (first arg) to specify which PancakeSwap V3 pool
 * to flash-borrow from. It also has pool whitelisting management functions.
 *
 * **Cannot use SHARED_ARBITRAGE_ABI_FUNCTIONS** because the function signatures differ.
 *
 * @see contracts/src/PancakeSwapFlashArbitrage.sol
 */
export const PANCAKESWAP_FLASH_ARBITRAGE_ABI: string[] = [
  'function executeArbitrage(address pool, address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address pool, address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function whitelistPool(address pool) external',
  'function isPoolWhitelisted(address pool) external view returns (bool)',
  'function addApprovedRouter(address router) external',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function getWhitelistedPools() external view returns (address[])',
  'function getApprovedRouters() external view returns (address[])',
];

// Re-export address constants needed by flash loan provider config
export { AAVE_V3_POOLS, BALANCER_V2_VAULTS, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS };

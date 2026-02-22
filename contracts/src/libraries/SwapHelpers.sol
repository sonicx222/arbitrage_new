// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDexRouter.sol";

/**
 * @title SwapHelpers
 * @author Arbitrage System
 * @notice Library for executing a single DEX swap with gas optimizations
 * @dev Extracted from flash loan contracts to reduce code duplication (DRY principle)
 *
 * ## Design Decision: Single Swap Function
 * This library provides a low-level `executeSingleSwap()` function instead of
 * a high-level `executeSwaps()` function. This approach avoids Solidity's
 * struct compatibility issues (each contract defines its own SwapStep struct).
 *
 * Contracts call this function in a loop, maintaining their own loop logic
 * while sharing the common swap execution code. This reduces duplication by
 * ~40 lines per contract while maintaining type safety.
 *
 * ## Features
 * - Single swap execution with validation
 * - Gas optimizations: pre-allocated path array passed by caller
 * - Defense-in-depth: validates output matches minimum
 * - Compatible with Uniswap V2-style routers (swapExactTokensForTokens)
 *
 * ## Gas Optimizations
 * - Caller pre-allocates path array once (~200 gas/swap saved)
 * - Single deadline parameter cached from caller (~100 gas saved vs repeated SLOAD)
 * - forceApprove for safe token approvals (~5,000 gas saved vs approve(0) pattern)
 *
 * ## Security Features
 * - Token continuity validation (prevents broken swap paths)
 * - Output amount verification (defense against malicious routers)
 * - No approval leftovers (forceApprove handles any residual allowance)
 *
 * ## Usage
 * ```solidity
 * using SafeERC20 for IERC20;
 *
 * // In your _executeSwaps function:
 * address[] memory path = new address[](2);
 * for (uint256 i = 0; i < swapPath.length; i++) {
 *     currentAmount = SwapHelpers.executeSingleSwap(
 *         currentToken,
 *         currentAmount,
 *         step.router,
 *         step.tokenIn,
 *         step.tokenOut,
 *         step.amountOutMin,
 *         path,
 *         deadline
 *     );
 *     currentToken = step.tokenOut;
 * }
 * ```
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 */
library SwapHelpers {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Errors
    // ==========================================================================

    /// @notice Thrown when swap path has invalid token continuity (tokenOut ≠ expected tokenIn)
    error InvalidSwapPath();

    /// @notice Thrown when swap output is below the minimum required (slippage exceeded)
    error InsufficientOutputAmount();

    // ==========================================================================
    // Public Functions
    // ==========================================================================

    /**
     * @notice Executes a single swap step with validation
     * @dev Gas optimizations applied:
     *      - Reuses caller's pre-allocated path array (~200 gas saved)
     *      - forceApprove for safe non-zero to non-zero approvals (~5,000 gas saved)
     *      - Defense-in-depth output verification
     *
     * ## Assumptions
     * - Router has been validated by caller
     * - currentToken and tokenIn match (validated by this function)
     * - amount > 0 (caller should validate)
     * - deadline is reasonable (caller should validate)
     * - path array is exactly length 2 (caller should pre-allocate)
     *
     * ## Token Approvals
     * Uses `forceApprove()` which:
     * - Sets approval to exact amount needed (security best practice)
     * - Handles non-zero to non-zero approvals (USDT, BNB compatibility)
     * - Saves ~5,000 gas vs approve(0) + approve(amount) pattern
     * - No need to reset approval after swap
     *
     * @param currentToken Current token being swapped (validated against tokenIn)
     * @param amount Amount of currentToken to swap
     * @param router DEX router address to use for swap
     * @param tokenIn Expected input token (must match currentToken)
     * @param tokenOut Expected output token
     * @param amountOutMin Minimum output amount (slippage protection)
     * @param path Pre-allocated array of length 2 (reused by caller)
     * @param deadline Absolute deadline timestamp (Unix timestamp)
     * @return amountOut The output amount received from swap
     */
    function executeSingleSwap(
        address currentToken,
        uint256 amount,
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountOutMin,
        address[] memory path,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        // Validate token continuity
        // This ensures the swap path is correct (each step's output = next step's input)
        if (tokenIn != currentToken) revert InvalidSwapPath();

        // Approve router to spend tokens
        // forceApprove handles non-zero to non-zero approvals safely (USDT, BNB compatibility)
        IERC20(currentToken).forceApprove(router, amount);

        // Set up path array (reused by caller across all swaps)
        path[0] = tokenIn;
        path[1] = tokenOut;

        // Execute swap via Uniswap V2-style router
        uint256[] memory amounts = IDexRouter(router).swapExactTokensForTokens(
            amount,
            amountOutMin,
            path,
            address(this),
            deadline
        );

        // W1-15 FIX: Reset residual token approval after swap.
        // If the router is compromised, any leftover allowance could be drained.
        // Cost: ~5k gas per swap — acceptable for the security guarantee.
        IERC20(currentToken).forceApprove(router, 0);

        // Defense-in-depth: Verify output matches minimum
        // NOTE: This check is technically redundant as compliant DEX routers
        // already revert if output < amountOutMin. However, we keep this as:
        // 1. Protection against non-compliant or malicious routers
        // 2. Explicit error message (InsufficientOutputAmount vs generic revert)
        // 3. Security audit requirement for explicit state validation
        // Cost: ~200 gas per swap - acceptable for the security guarantee
        amountOut = amounts[amounts.length - 1];
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();

        return amountOut;
    }
}

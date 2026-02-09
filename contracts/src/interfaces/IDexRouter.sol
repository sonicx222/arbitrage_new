// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IDexRouter
 * @notice Standard interface for DEX routers (Uniswap V2 compatible)
 * @dev This interface is used across all flash loan arbitrage contracts to ensure consistency.
 *
 * ## Centralized Interface Pattern
 *
 * This interface is defined once and imported by all contracts that interact with DEX routers.
 * This prevents interface drift and ensures ABI compatibility across the system.
 *
 * ## Used By
 * - FlashLoanArbitrage.sol
 * - BalancerV2FlashArbitrage.sol
 * - PancakeSwapFlashArbitrage.sol
 * - SyncSwapFlashArbitrage.sol
 * - CommitRevealArbitrage.sol
 * - IFlashLoanReceiver.sol (for testing/mocking)
 *
 * ## Compatibility
 *
 * Compatible with:
 * - Uniswap V2 Router
 * - SushiSwap Router
 * - PancakeSwap V2 Router
 * - Most Uniswap V2 forks
 *
 * @custom:security This interface assumes trusted router implementations.
 *                   All routers must be whitelisted before use.
 */
interface IDexRouter {
    /**
     * @notice Swap exact tokens for tokens
     * @dev Executes a swap through a liquidity pool path
     *
     * @param amountIn The amount of input tokens to send
     * @param amountOutMin The minimum amount of output tokens that must be received
     * @param path An array of token addresses representing the swap path
     *             path[0] = input token, path[path.length-1] = output token
     * @param to Recipient of the output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amounts The amounts of tokens received at each step of the path
     *                 amounts[0] = amountIn, amounts[amounts.length-1] = final output
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Get amounts out for a swap
     * @dev Performs a read-only calculation of swap amounts (does not execute swap)
     *      Used for profitability calculations and trade simulation
     *
     * @param amountIn The amount of input tokens
     * @param path An array of token addresses representing the swap path
     * @return amounts The amounts of tokens that would be received at each step
     *                 amounts[0] = amountIn, amounts[amounts.length-1] = expected output
     */
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

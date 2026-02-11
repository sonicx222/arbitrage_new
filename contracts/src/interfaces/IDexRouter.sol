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
 * - FlashLoanArbitrage.sol (Aave V3)
 * - BalancerV2FlashArbitrage.sol (Balancer V2)
 * - PancakeSwapFlashArbitrage.sol (PancakeSwap V3)
 * - SyncSwapFlashArbitrage.sol (SyncSwap/zkSync)
 * - CommitRevealArbitrage.sol (MEV protection)
 * - MultiPathQuoter.sol (batched quote optimization)
 * - SwapHelpers.sol (shared swap execution library)
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
     * @notice Swap tokens for exact tokens (reverse of swapExactTokensForTokens)
     * @dev Useful for exact-output swaps when you know how much you want to receive
     *
     * @param amountOut The exact amount of output tokens desired
     * @param amountInMax The maximum amount of input tokens to spend
     * @param path An array of token addresses representing the swap path
     * @param to Recipient of the output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amounts The amounts of tokens spent at each step
     *                 amounts[0] = actual input spent, amounts[amounts.length-1] = amountOut
     *
     * @custom:use-case When you need exactly X tokens out (e.g., repaying a flash loan)
     */
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
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

    /**
     * @notice Get amounts in for a desired output (reverse of getAmountsOut)
     * @dev Calculates how much input is needed to get exact output amount
     *
     * @param amountOut The desired output amount
     * @param path An array of token addresses representing the swap path
     * @return amounts The amounts of tokens required at each step
     *                 amounts[0] = required input, amounts[amounts.length-1] = amountOut
     *
     * @custom:use-case Calculate input needed for exact output (e.g., flash loan repayment)
     */
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /**
     * @notice Get the factory address that deployed this router
     * @dev Useful for verifying pool addresses and checking pool existence
     * @return factory The factory contract address
     *
     * @custom:use-case Verify a pool address: factory.getPair(tokenA, tokenB)
     */
    function factory() external view returns (address);

    /**
     * @notice Get the WETH (Wrapped ETH) address for this router
     * @dev Used for ETH↔Token swaps and identifying native token in paths
     * @return weth The WETH contract address
     *
     * @custom:note On different chains this may be:
     *              - Ethereum: WETH
     *              - Polygon: WMATIC
     *              - BSC: WBNB
     *              - Avalanche: WAVAX
     */
    function WETH() external view returns (address);
}

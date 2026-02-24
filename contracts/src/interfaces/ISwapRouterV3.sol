// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ISwapRouterV3
 * @notice Interface for Uniswap V3 SwapRouter's exactInputSingle function
 * @dev Minimal interface covering only the functions needed by UniswapV3Adapter.
 *      Full Uniswap V3 SwapRouter has additional functions (exactInput, exactOutput, etc.)
 *      that are not needed for the V2-compatible adapter pattern.
 *
 * ## Compatibility
 *
 * Compatible with:
 * - Uniswap V3 SwapRouter (all chains)
 * - SushiSwap V3 Router
 * - PancakeSwap V3 SmartRouter (uses same exactInputSingle signature)
 * - Any router implementing the same exactInputSingle interface
 *
 * @custom:security This interface is used by UniswapV3Adapter to wrap V3 behind IDexRouter.
 * @custom:version 1.0.0
 */
interface ISwapRouterV3 {
    /**
     * @notice Parameters for single-hop exact input swap
     * @param tokenIn The input token address
     * @param tokenOut The output token address
     * @param fee The pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
     * @param recipient The address that receives the output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @param amountIn The exact amount of input tokens to swap
     * @param amountOutMinimum The minimum output amount (slippage protection)
     * @param sqrtPriceLimitX96 Price limit for the swap (0 for no limit)
     */
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Swaps `amountIn` of one token for as much as possible of another token
     * @param params The parameters necessary for the swap, encoded as `ExactInputSingleParams`
     * @return amountOut The amount of the received token
     */
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/**
 * @title IQuoterV2
 * @notice Interface for Uniswap V3 QuoterV2's quoteExactInputSingle function
 * @dev Used by UniswapV3Adapter to implement getAmountsOut/getAmountsIn from IDexRouter.
 *
 *      NOTE: The real Uniswap V3 QuoterV2 is non-view (it uses state-modifying calls
 *      internally and reverts to simulate). This interface declares the function as `view`
 *      because UniswapV3Adapter.getAmountsOut() must satisfy IDexRouter's `view` constraint.
 *      The mock quoter (MockQuoterV2) is naturally view-compatible since it only reads
 *      from storage. For production integration with the real QuoterV2, use off-chain
 *      staticcall simulation or a dedicated quoting wrapper.
 *
 * @custom:version 1.0.0
 */
interface IQuoterV2 {
    /**
     * @notice Parameters for quoting a single-hop exact input swap
     * @param tokenIn The input token address
     * @param tokenOut The output token address
     * @param amountIn The desired input amount
     * @param fee The pool fee tier
     * @param sqrtPriceLimitX96 Price limit for the quote (0 for no limit)
     */
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Returns the amount out received for a given exact input but for a single pool swap
     * @param params The params for the quote, encoded as `QuoteExactInputSingleParams`
     * @return amountOut The amount of `tokenOut` that would be received
     * @return sqrtPriceX96After The sqrt price of the pool after the swap
     * @return initializedTicksCrossed The number of initialized ticks crossed during the swap
     * @return gasEstimate The estimate of the gas that the swap consumes
     */
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        view
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

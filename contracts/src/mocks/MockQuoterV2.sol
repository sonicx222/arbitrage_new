// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/ISwapRouterV3.sol";

/**
 * @title MockQuoterV2
 * @dev Mock Uniswap V3 QuoterV2 for testing UniswapV3Adapter
 * @notice Simulates V3 quoteExactInputSingle with configurable exchange rates
 *
 * ## Exchange Rate Calculation
 *
 * amountOut = (amountIn * rate) / 1e18
 *
 * Same formula as MockDexRouter and MockUniswapV3Router for consistency.
 *
 * ## Note on quoteExactInputSingle
 *
 * The real QuoterV2 is NOT a view function (it uses state-modifying calls internally
 * and reverts to return results). Our interface declares it as `view` to satisfy
 * IDexRouter's view constraint on getAmountsOut/getAmountsIn. The mock is naturally
 * view-compatible since it only reads from storage mappings.
 */
contract MockQuoterV2 is IQuoterV2 {
    // Exchange rates: tokenIn => tokenOut => rate (output per 1e18 input)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    /**
     * @dev Set the exchange rate for a token pair
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param rate Exchange rate (output amount per 1e18 input)
     */
    function setExchangeRate(
        address tokenIn,
        address tokenOut,
        uint256 rate
    ) external {
        exchangeRates[tokenIn][tokenOut] = rate;
    }

    /**
     * @dev Simulates Uniswap V3 quoteExactInputSingle
     * @param params QuoteExactInputSingleParams struct
     * @return amountOut The estimated output amount
     * @return sqrtPriceX96After Always returns 0 in mock
     * @return initializedTicksCrossed Always returns 0 in mock
     * @return gasEstimate Always returns 150000 in mock (typical V3 swap gas)
     */
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        view
        override
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        )
    {
        require(params.tokenIn != address(0), "Invalid tokenIn");
        require(params.tokenOut != address(0), "Invalid tokenOut");

        uint256 rate = exchangeRates[params.tokenIn][params.tokenOut];
        require(rate > 0, "Exchange rate not set");

        amountOut = (params.amountIn * rate) / 1e18;

        return (amountOut, 0, 0, 150000);
    }
}

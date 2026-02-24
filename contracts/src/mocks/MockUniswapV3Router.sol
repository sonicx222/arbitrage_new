// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISwapRouterV3.sol";

/**
 * @title MockUniswapV3Router
 * @dev Mock Uniswap V3 SwapRouter for testing UniswapV3Adapter
 * @notice Simulates V3 exactInputSingle with configurable exchange rates
 *
 * ## Exchange Rate Calculation
 *
 * amountOut = (amountIn * rate) / 1e18
 *
 * Same formula as MockDexRouter for consistency across test mocks.
 *
 * ## Test Assertions
 *
 * Tracks `lastFee` so tests can verify the adapter passes the correct fee tier.
 */
contract MockUniswapV3Router is ISwapRouterV3 {
    using SafeERC20 for IERC20;

    // Exchange rates: tokenIn => tokenOut => rate (output per 1e18 input)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    /// @notice Last fee tier used in a swap (for test assertions)
    uint24 public lastFee;

    /// @notice Last deadline passed (for test assertions)
    uint256 public lastDeadline;

    /// @notice Last sqrtPriceLimitX96 passed (for test assertions)
    uint160 public lastSqrtPriceLimit;

    event SwapV3(
        address indexed tokenIn,
        address indexed tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOut
    );

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
     * @dev Simulates Uniswap V3 exactInputSingle
     * @param params ExactInputSingleParams struct
     * @return amountOut The amount of output tokens
     */
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        require(params.tokenIn != address(0), "Invalid tokenIn");
        require(params.tokenOut != address(0), "Invalid tokenOut");
        require(params.amountIn > 0, "Amount must be > 0");
        require(params.deadline >= block.timestamp, "Deadline expired");

        uint256 rate = exchangeRates[params.tokenIn][params.tokenOut];
        require(rate > 0, "Exchange rate not set");

        amountOut = (params.amountIn * rate) / 1e18;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        // Track params for test assertions
        lastFee = params.fee;
        lastDeadline = params.deadline;
        lastSqrtPriceLimit = params.sqrtPriceLimitX96;

        // Transfer input tokens from sender
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Transfer output tokens to recipient
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);

        emit SwapV3(params.tokenIn, params.tokenOut, params.fee, params.amountIn, amountOut);

        return amountOut;
    }

    /**
     * @dev Allows the router to receive ETH (for WETH wrapping scenarios)
     */
    receive() external payable {}
}

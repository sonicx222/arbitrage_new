// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockDexRouter
 * @dev Mock DEX router for testing swaps
 * @notice Simulates Uniswap V2 style router with configurable exchange rates
 */
contract MockDexRouter {
    using SafeERC20 for IERC20;

    string public name;

    // Exchange rates: tokenIn => tokenOut => rate (output per 1e18 input)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    event Swap(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(string memory _name) {
        name = _name;
    }

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
     * @dev Simulates swapExactTokensForTokens from Uniswap V2 Router
     * @param amountIn Amount of input tokens
     * @param amountOutMin Minimum output amount (reverts if not met)
     * @param path Token swap path [tokenIn, tokenOut]
     * @param to Recipient address
     * @param deadline Transaction deadline (unused in mock)
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        // Silence unused variable warning
        deadline;

        require(path.length >= 2, "Invalid path");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        // Process each hop in the path
        uint256 currentAmount = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];

            uint256 rate = exchangeRates[tokenIn][tokenOut];
            require(rate > 0, "Exchange rate not set");

            // Calculate output: amountIn * rate / 1e18
            // Handle different decimal tokens properly
            uint256 amountOut = (currentAmount * rate) / 1e18;

            amounts[i + 1] = amountOut;
            currentAmount = amountOut;
        }

        uint256 finalAmount = amounts[amounts.length - 1];
        require(finalAmount >= amountOutMin, "Insufficient output amount");

        // Transfer input tokens from sender
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        // Transfer output tokens to recipient
        IERC20(path[path.length - 1]).safeTransfer(to, finalAmount);

        emit Swap(path[0], path[path.length - 1], amountIn, finalAmount);

        return amounts;
    }

    /**
     * @dev Get expected output amounts for a swap path
     * @param amountIn Input amount
     * @param path Token swap path
     */
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "Invalid path");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 currentAmount = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint256 rate = exchangeRates[path[i]][path[i + 1]];
            require(rate > 0, "Exchange rate not set");

            uint256 amountOut = (currentAmount * rate) / 1e18;
            amounts[i + 1] = amountOut;
            currentAmount = amountOut;
        }

        return amounts;
    }

    /**
     * @dev Allows the router to receive tokens
     */
    receive() external payable {}
}

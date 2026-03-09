// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDexRouter.sol";

/**
 * @title MockDexRouter
 * @dev Mock DEX router for testing swaps
 * @notice Simulates Uniswap V2 style router with configurable exchange rates
 * @dev Implements IDexRouter for full interface compliance
 *
 * ## Exchange Rate Calculation (Fix 4.2 Documentation)
 *
 * amountOut = (amountIn * rate) / 1e18
 *
 * IMPORTANT: For very small amounts or small rates, this can truncate to 0.
 * Example: amountIn=1, rate=1e17 (0.1) → amountOut = (1 * 1e17) / 1e18 = 0
 *
 * To prevent zero-output issues in tests:
 * - Use amounts >= 1e18 for 18-decimal tokens
 * - Set rates that ensure non-zero output for your test amounts
 * - The contract now emits a warning event when output truncates to zero
 *
 * ## Fee Simulation (M-05)
 *
 * When feeBps > 0, output is reduced by the fee percentage:
 *   amountOut = (rawAmountOut * (10000 - feeBps)) / 10000
 *
 * Real DEXes charge 0.3% (V2, 30 bps) or variable (V3: 1-100 bps).
 * Set via setFeeBps(). Default: 0 (no fee, backward compatible).
 *
 * ## AMM Curve Simulation (H-03)
 *
 * When ammMode is enabled, output follows constant-product curve:
 *   amountOut = (reserveOut * amountIn) / (reserveIn + amountIn)
 *
 * This simulates price impact for large trades. Enable with setAmmMode()
 * and configure reserves with setReserves(). Default: off (static rates).
 *
 * @custom:version 1.1.0
 */
contract MockDexRouter is IDexRouter {
    using SafeERC20 for IERC20;

    string public name;

    // Exchange rates: tokenIn => tokenOut => rate (output per 1e18 input)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    /// @notice When true, allows zero-output swaps instead of reverting
    bool public allowZeroOutput = false;

    /// @dev M-05: Fee in basis points deducted from output (0 = no fee, 30 = 0.3%)
    uint256 public feeBps;

    /// @dev H-03: AMM constant-product curve mode
    bool public ammMode;

    /// @dev H-03: AMM reserves for constant-product simulation
    /// tokenA => tokenB => reserveIn (amount of tokenA in pool)
    mapping(address => mapping(address => uint256)) public reserveIn;
    /// tokenA => tokenB => reserveOut (amount of tokenB in pool)
    mapping(address => mapping(address => uint256)) public reserveOut;

    function setAllowZeroOutput(bool _allow) external {
        allowZeroOutput = _allow;
    }

    /// @notice M-05: Set fee in basis points (e.g., 30 = 0.3%)
    function setFeeBps(uint256 _feeBps) external {
        require(_feeBps < 10000, "Fee must be < 100%");
        feeBps = _feeBps;
    }

    /// @notice H-03: Enable/disable AMM constant-product curve mode
    function setAmmMode(bool _enabled) external {
        ammMode = _enabled;
    }

    /// @notice H-03: Set pool reserves for AMM curve simulation
    function setReserves(
        address tokenIn,
        address tokenOut,
        uint256 _reserveIn,
        uint256 _reserveOut
    ) external {
        require(_reserveIn > 0 && _reserveOut > 0, "Reserves must be > 0");
        reserveIn[tokenIn][tokenOut] = _reserveIn;
        reserveOut[tokenIn][tokenOut] = _reserveOut;
    }

    event Swap(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @notice Emitted when calculation truncates to zero (Fix 4.2)
    event ZeroOutputWarning(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 rate
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
    ) external override returns (uint256[] memory amounts) {
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

            uint256 amountOut;

            // H-03: AMM curve mode uses constant-product formula
            if (ammMode && reserveIn[tokenIn][tokenOut] > 0) {
                uint256 rIn = reserveIn[tokenIn][tokenOut];
                uint256 rOut = reserveOut[tokenIn][tokenOut];
                // x * y = k → amountOut = (rOut * amountIn) / (rIn + amountIn)
                amountOut = (rOut * currentAmount) / (rIn + currentAmount);
            } else {
                uint256 rate = exchangeRates[tokenIn][tokenOut];
                require(rate > 0, "Exchange rate not set");
                // Calculate output: amountIn * rate / 1e18
                amountOut = (currentAmount * rate) / 1e18;
            }

            // M-05: Apply fee deduction
            if (feeBps > 0) {
                amountOut = (amountOut * (10000 - feeBps)) / 10000;
            }

            // Fix 4.2: Check for zero output due to truncation
            if (amountOut == 0 && currentAmount > 0) {
                emit ZeroOutputWarning(tokenIn, tokenOut, currentAmount,
                    exchangeRates[tokenIn][tokenOut]);
                require(allowZeroOutput, "Zero output from truncation");
            }

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
        override
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "Invalid path");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 currentAmount = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address tIn = path[i];
            address tOut = path[i + 1];
            uint256 amountOut;

            // H-03: AMM curve mode
            if (ammMode && reserveIn[tIn][tOut] > 0) {
                uint256 rIn = reserveIn[tIn][tOut];
                uint256 rOut = reserveOut[tIn][tOut];
                amountOut = (rOut * currentAmount) / (rIn + currentAmount);
            } else {
                uint256 rate = exchangeRates[tIn][tOut];
                require(rate > 0, "Exchange rate not set");
                amountOut = (currentAmount * rate) / 1e18;
            }

            // M-05: Apply fee deduction
            if (feeBps > 0) {
                amountOut = (amountOut * (10000 - feeBps)) / 10000;
            }

            if (amountOut == 0 && currentAmount > 0) {
                require(allowZeroOutput, "Zero output from truncation");
            }
            amounts[i + 1] = amountOut;
            currentAmount = amountOut;
        }

        return amounts;
    }

    /**
     * @dev Simulates swapTokensForExactTokens from Uniswap V2 Router
     * @notice Stub implementation — uses forward rates. For precise reverse routing,
     *         set exchange rates accordingly in your test setup.
     */
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        // Silence unused variable warning
        deadline;

        require(path.length >= 2, "Invalid path");

        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;

        // Calculate required input using reverse rates
        uint256 currentAmount = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            uint256 rate = exchangeRates[path[i - 1]][path[i]];
            require(rate > 0, "Exchange rate not set");

            // Reverse: amountIn = (amountOut * 1e18) / rate (round up)
            uint256 amountIn = (currentAmount * 1e18 + rate - 1) / rate;
            amounts[i - 1] = amountIn;
            currentAmount = amountIn;
        }

        uint256 requiredInput = amounts[0];
        require(requiredInput <= amountInMax, "Excessive input amount");

        // Transfer input tokens from sender
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), requiredInput);

        // Transfer output tokens to recipient
        IERC20(path[path.length - 1]).safeTransfer(to, amountOut);

        emit Swap(path[0], path[path.length - 1], requiredInput, amountOut);

        return amounts;
    }

    /**
     * @dev Get required input amounts for a desired output
     * @param amountOut Desired output amount
     * @param path Token swap path
     */
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        override
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "Invalid path");

        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;

        uint256 currentAmount = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            uint256 rate = exchangeRates[path[i - 1]][path[i]];
            require(rate > 0, "Exchange rate not set");

            // Reverse: amountIn = (amountOut * 1e18) / rate (round up)
            uint256 amountIn = (currentAmount * 1e18 + rate - 1) / rate;
            amounts[i - 1] = amountIn;
            currentAmount = amountIn;
        }

        return amounts;
    }

    /**
     * @dev Returns a mock factory address (zero address — no real factory in mock)
     */
    function factory() external pure override returns (address) {
        return address(0);
    }

    /**
     * @dev Returns a mock WETH address (zero address — no real WETH in mock)
     */
    function WETH() external pure override returns (address) {
        return address(0);
    }

    /**
     * @dev Allows the router to receive tokens
     */
    receive() external payable {}
}

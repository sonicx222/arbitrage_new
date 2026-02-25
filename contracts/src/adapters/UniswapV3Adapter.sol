// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "../interfaces/IDexRouter.sol";
import "../interfaces/ISwapRouterV3.sol";

/**
 * @title UniswapV3Adapter
 * @author Arbitrage System
 * @notice Adapter contract that wraps Uniswap V3 SwapRouter behind the V2-compatible IDexRouter interface
 * @dev Enables BaseFlashArbitrage and all derived contracts to use V3 liquidity without any modifications
 *      to existing contracts. Simply approve this adapter as a router and pass it in SwapStep.router.
 *
 * ## Architecture
 *
 * ```
 * BaseFlashArbitrage -> SwapHelpers.executeSingleSwap()
 *     -> IDexRouter(adapter).swapExactTokensForTokens()
 *         -> ISwapRouterV3(v3Router).exactInputSingle()
 * ```
 *
 * ## Fee Tier Configuration
 *
 * V3 pools use discrete fee tiers (500, 3000, 10000). The adapter supports:
 * - Per-pair fee overrides via `setPairFee(tokenA, tokenB, fee)` (owner-only)
 * - Configurable default fee via `setDefaultFee(fee)` (owner-only, default: 3000 = 0.3%)
 *
 * Fee lookup is order-independent: setPairFee(A, B, 500) also sets fee for B->A swaps.
 *
 * ## Multi-hop Support
 *
 * For paths with more than 2 tokens (e.g., [A, B, C]), the adapter executes sequential
 * single hops: A->B then B->C. Each hop uses the output of the previous hop as input.
 *
 * ## Gas Overhead
 *
 * ~5-10k gas per hop for the proxy indirection (delegating to V3 router).
 * Acceptable for arbitrage operations where profit margins exceed gas costs.
 *
 * ## Quoting
 *
 * If a QuoterV2 address is configured, `getAmountsOut` and `getAmountsIn` will use it
 * for accurate on-chain quotes. Without a quoter, these functions revert.
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 */
contract UniswapV3Adapter is IDexRouter, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Custom Errors
    // ==========================================================================

    /// @notice Thrown when path has fewer than 2 elements
    error PathTooShort();

    /// @notice Thrown when a zero address is provided for a required parameter
    error ZeroAddress();

    /// @notice Thrown when an invalid fee tier is provided (must be > 0)
    error InvalidFeeTier();

    /// @notice Thrown when the quoter is not configured but getAmountsOut/getAmountsIn is called
    error QuoterNotConfigured();

    /// @notice Thrown when final output amount is below minimum
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);

    // ==========================================================================
    // Events
    // ==========================================================================

    /// @notice Emitted when a per-pair fee tier is set
    event PairFeeSet(address indexed tokenA, address indexed tokenB, uint24 fee);

    /// @notice Emitted when the default fee tier is changed
    event DefaultFeeSet(uint24 fee);

    /// @notice Emitted when the quoter address is updated
    event QuoterSet(address indexed quoter);

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The Uniswap V3 SwapRouter address (immutable after deployment)
    ISwapRouterV3 public immutable v3Router;

    /// @notice Optional QuoterV2 for getAmountsOut/getAmountsIn
    IQuoterV2 public quoter;

    /// @notice Default fee tier for pairs without explicit override (3000 = 0.3%)
    uint24 public defaultFee;

    /// @notice Per-pair fee tier overrides (sorted key: lower address first)
    /// @dev Key is keccak256(abi.encodePacked(min(tokenA, tokenB), max(tokenA, tokenB)))
    mapping(bytes32 => uint24) public pairFees;

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the UniswapV3Adapter
     * @param _v3Router The Uniswap V3 SwapRouter address
     * @param _quoter The QuoterV2 address (address(0) to skip quoting support)
     * @param _owner The contract owner address
     * @param _defaultFee The default fee tier (e.g., 3000 for 0.3%)
     */
    constructor(
        address _v3Router,
        address _quoter,
        address _owner,
        uint24 _defaultFee
    ) {
        if (_v3Router == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();
        if (_defaultFee == 0) revert InvalidFeeTier();

        v3Router = ISwapRouterV3(_v3Router);
        defaultFee = _defaultFee;

        if (_quoter != address(0)) {
            quoter = IQuoterV2(_quoter);
        }

        // Transfer ownership to specified owner (Ownable2Step: pending until accepted)
        _transferOwnership(_owner);
    }

    // ==========================================================================
    // Admin Functions (Owner-only)
    // ==========================================================================

    /**
     * @notice Set fee tier for a specific token pair
     * @dev Order-independent: setPairFee(A, B, fee) also applies to B->A
     * @param tokenA First token in the pair
     * @param tokenB Second token in the pair
     * @param fee The fee tier (500, 3000, 10000, etc.)
     */
    function setPairFee(address tokenA, address tokenB, uint24 fee) external onlyOwner {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (fee == 0) revert InvalidFeeTier();

        bytes32 key = _pairKey(tokenA, tokenB);
        pairFees[key] = fee;

        emit PairFeeSet(tokenA, tokenB, fee);
    }

    /**
     * @notice Set the default fee tier for pairs without explicit overrides
     * @param fee The new default fee tier
     */
    function setDefaultFee(uint24 fee) external onlyOwner {
        if (fee == 0) revert InvalidFeeTier();

        defaultFee = fee;

        emit DefaultFeeSet(fee);
    }

    /**
     * @notice Set or update the QuoterV2 address
     * @param _quoter The new quoter address (address(0) to disable quoting)
     */
    function setQuoter(address _quoter) external onlyOwner {
        quoter = IQuoterV2(_quoter);

        emit QuoterSet(_quoter);
    }

    /**
     * @notice Pause the adapter, preventing all swaps
     * @dev Only callable by the contract owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the adapter, re-enabling swaps
     * @dev Only callable by the contract owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ==========================================================================
    // IDexRouter Implementation
    // ==========================================================================

    /**
     * @notice Swap exact tokens for tokens through Uniswap V3
     * @dev Translates V2-style multi-hop path to sequential V3 exactInputSingle calls.
     *      Each hop uses the output of the previous hop as input for the next.
     *
     * @param amountIn The amount of input tokens to send
     * @param amountOutMin The minimum amount of output tokens that must be received
     * @param path An array of token addresses representing the swap path
     * @param to Recipient of the output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amounts The amounts of tokens at each step of the path
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (path.length < 2) revert PathTooShort();

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        // Pull input tokens from caller
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 currentAmount = amountIn;

        // Execute each hop sequentially
        for (uint256 i = 0; i < path.length - 1;) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            uint24 fee = _getFee(tokenIn, tokenOut);

            // For intermediate hops, tokens stay in the adapter
            // For the final hop, tokens go directly to the recipient
            address recipient = (i == path.length - 2) ? to : address(this);

            // Approve V3 router to spend input tokens
            IERC20(tokenIn).forceApprove(address(v3Router), currentAmount);

            // Execute V3 swap
            uint256 amountOut = v3Router.exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    deadline: deadline,
                    amountIn: currentAmount,
                    // Known trade-off: intermediate hops use 0 slippage protection.
                    // MEV could sandwich individual hops, but final output is validated
                    // against amountOutMin in the calling contract. Per-hop minimums would
                    // need off-chain quote simulation with marginal benefit since the
                    // overall arbitrage profit check catches net losses.
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0  // No price limit
                })
            );

            // Reset approval after swap (security: no residual allowance)
            IERC20(tokenIn).forceApprove(address(v3Router), 0);

            amounts[i + 1] = amountOut;
            currentAmount = amountOut;

            unchecked { ++i; }
        }

        // Verify final output meets minimum
        uint256 finalAmount = amounts[amounts.length - 1];
        if (finalAmount < amountOutMin) {
            revert InsufficientOutputAmount(finalAmount, amountOutMin);
        }

        return amounts;
    }

    /**
     * @notice WARNING: This simplified implementation always consumes the full amountInMax.
     * @dev Unlike standard V2 routers which return excess input, this adapter uses V3's
     * exactInputSingle (forward swap) rather than exactOutputSingle, so it cannot determine
     * the minimum input required. Callers should set amountInMax close to the expected input.
     * The amounts[0] value reflects the full amountInMax consumed, not the theoretical minimum.
     *
     * @param amountOut The exact amount of output tokens desired
     * @param amountInMax The maximum amount of input tokens to spend
     * @param path An array of token addresses representing the swap path
     * @param to Recipient of the output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amounts The amounts at each step
     */
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (path.length < 2) revert PathTooShort();

        // For simplicity, execute a forward swap with amountInMax and verify output
        // Pull max input tokens from caller
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountInMax);

        amounts = new uint256[](path.length);
        amounts[0] = amountInMax;

        uint256 currentAmount = amountInMax;

        for (uint256 i = 0; i < path.length - 1;) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            uint24 fee = _getFee(tokenIn, tokenOut);

            address recipient = (i == path.length - 2) ? to : address(this);

            IERC20(tokenIn).forceApprove(address(v3Router), currentAmount);

            uint256 swapOut = v3Router.exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    deadline: deadline,
                    amountIn: currentAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );

            IERC20(tokenIn).forceApprove(address(v3Router), 0);

            amounts[i + 1] = swapOut;
            currentAmount = swapOut;

            unchecked { ++i; }
        }

        uint256 finalAmount = amounts[amounts.length - 1];
        if (finalAmount < amountOut) {
            revert InsufficientOutputAmount(finalAmount, amountOut);
        }

        return amounts;
    }

    /**
     * @notice Get expected output amounts for a swap path using QuoterV2
     * @dev Requires quoter to be configured. Reverts with QuoterNotConfigured if not set.
     *
     * @param amountIn The input amount
     * @param path Token swap path
     * @return amounts Expected amounts at each step
     */
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        override
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert PathTooShort();
        if (address(quoter) == address(0)) revert QuoterNotConfigured();

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 currentAmount = amountIn;

        for (uint256 i = 0; i < path.length - 1;) {
            uint24 fee = _getFee(path[i], path[i + 1]);

            (uint256 amountOut,,,) = quoter.quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: path[i],
                    tokenOut: path[i + 1],
                    amountIn: currentAmount,
                    fee: fee,
                    sqrtPriceLimitX96: 0
                })
            );

            amounts[i + 1] = amountOut;
            currentAmount = amountOut;

            unchecked { ++i; }
        }

        return amounts;
    }

    /**
     * @notice Get required input amounts for a desired output using QuoterV2
     *
     * @dev WARNING: APPROXIMATION ONLY — NOT SUITABLE FOR TIGHT-MARGIN DECISIONS.
     *
     * This implementation uses `quoteExactInputSingle` (forward quote) in the reverse
     * direction as an approximation for `quoteExactOutputSingle`. Due to AMM curve
     * non-linearity, a forward quote from tokenB → tokenA does NOT equal the required
     * input from tokenA → tokenB for a given output. The error grows with:
     * - Larger trade sizes relative to pool liquidity
     * - Higher fee tiers
     * - Concentrated liquidity positions (V3-specific)
     *
     * Callers MUST NOT use these results for:
     * - Profit threshold decisions in tight-margin arbitrage
     * - Exact input calculations for `swapTokensForExactTokens`
     * - Any scenario where over/under-estimation causes financial loss
     *
     * For production precision, either:
     * 1. Implement `quoteExactOutputSingle` (requires IQuoterV2 support)
     * 2. Use off-chain simulation with full pool state
     *
     * @param amountOut The desired output amount
     * @param path Token swap path
     * @return amounts Estimated (not exact) required amounts at each step
     */
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        override
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert PathTooShort();
        if (address(quoter) == address(0)) revert QuoterNotConfigured();

        // For V3 adapter, provide a reasonable estimate using forward quote
        // This is an approximation; for precise amounts, use off-chain simulation
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;

        // Simple reverse estimation: for each hop, estimate input needed
        // This uses the same quoter but in reverse direction
        uint256 currentAmount = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            uint24 fee = _getFee(path[i - 1], path[i]);

            // Use forward quote as approximation for reverse
            // In production, use quoteExactOutputSingle for precise reverse amounts
            (uint256 reverseAmount,,,) = quoter.quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: path[i],
                    tokenOut: path[i - 1],
                    amountIn: currentAmount,
                    fee: fee,
                    sqrtPriceLimitX96: 0
                })
            );

            amounts[i - 1] = reverseAmount;
            currentAmount = reverseAmount;
        }

        return amounts;
    }

    /**
     * @notice Returns address(0) since this adapter is not backed by a V2 factory
     * @return Always returns address(0)
     */
    function factory() external pure override returns (address) {
        return address(0);
    }

    /**
     * @notice Returns address(0) since WETH is not tracked by the adapter
     * @return Always returns address(0)
     */
    function WETH() external pure override returns (address) {
        return address(0);
    }

    // ==========================================================================
    // Public View Functions
    // ==========================================================================

    /**
     * @notice Get the fee tier for a specific token pair
     * @param tokenA First token in the pair
     * @param tokenB Second token in the pair
     * @return fee The fee tier (per-pair override or default)
     */
    function getFee(address tokenA, address tokenB) external view returns (uint24) {
        return _getFee(tokenA, tokenB);
    }

    // ==========================================================================
    // Internal Functions
    // ==========================================================================

    /**
     * @dev Get fee tier for a token pair, falling back to default
     * @param tokenA First token
     * @param tokenB Second token
     * @return fee The applicable fee tier
     */
    function _getFee(address tokenA, address tokenB) internal view returns (uint24) {
        bytes32 key = _pairKey(tokenA, tokenB);
        uint24 pairFee = pairFees[key];
        return pairFee > 0 ? pairFee : defaultFee;
    }

    /**
     * @dev Generate a canonical pair key (order-independent)
     * @param tokenA First token
     * @param tokenB Second token
     * @return Canonical hash key for the pair
     */
    function _pairKey(address tokenA, address tokenB) internal pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        return keccak256(abi.encodePacked(token0, token1));
    }
}

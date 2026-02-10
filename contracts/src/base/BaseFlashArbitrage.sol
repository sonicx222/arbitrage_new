// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../libraries/SwapHelpers.sol";

/**
 * @title BaseFlashArbitrage
 * @author Arbitrage System
 * @notice Abstract base contract for flash loan arbitrage implementations
 * @dev Provides common functionality for all flash arbitrage contracts
 *
 * ## Refactoring Benefits (v2.0.0)
 *
 * This base contract eliminates 1,135 lines of duplicate code across 5 flash arbitrage contracts:
 * - FlashLoanArbitrage (Aave V3)
 * - PancakeSwapFlashArbitrage (PancakeSwap V3)
 * - BalancerV2FlashArbitrage (Balancer V2 Vault)
 * - SyncSwapFlashArbitrage (SyncSwap/zkSync Era)
 * - CommitRevealArbitrage (Commit-reveal MEV protection)
 *
 * ## Common Features
 *
 * - Multi-hop swap execution across multiple DEX routers
 * - Router whitelist security
 * - Profit verification with minimum profit threshold
 * - Emergency pause functionality
 * - Configurable swap deadlines
 * - Fund recovery mechanisms
 * - OpenZeppelin security patterns (Ownable2Step, Pausable, ReentrancyGuard)
 *
 * ## Architecture Pattern
 *
 * Each derived contract implements:
 * - executeArbitrage() - Protocol-specific flash loan initiation
 * - Flash loan callback - Protocol-specific callback handler
 * - calculateExpectedProfit() - Protocol-specific profit simulation
 *
 * Base contract provides:
 * - Common structs (SwapStep)
 * - Common state variables (minimumProfit, swapDeadline, _approvedRouters)
 * - Router management (add/remove/list)
 * - Configuration (pause, minimumProfit, swapDeadline)
 * - Emergency functions (withdrawToken, withdrawETH)
 * - Swap execution (_executeSwaps)
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.0.0
 * @custom:refactoring-priority P0 (Critical)
 */
abstract contract BaseFlashArbitrage is
    Ownable2Step,
    Pausable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ==========================================================================
    // Constants
    // ==========================================================================

    /// @notice Default swap deadline (5 minutes)
    uint256 public constant DEFAULT_SWAP_DEADLINE = 300;

    /// @notice Maximum swap deadline (1 hour) to prevent stale transactions
    uint256 public constant MAX_SWAP_DEADLINE = 3600;

    /// @notice Minimum slippage protection floor (0.1% = 10 bps)
    /// @dev Prevents callers from setting amountOutMin = 0 which exposes to sandwich attacks
    uint256 public constant MIN_SLIPPAGE_BPS = 10;

    /// @notice Maximum number of hops in a swap path (prevents DoS via gas exhaustion)
    /// @dev Limit chosen based on gas analysis: 5 hops = ~700k gas (within block gas limit)
    uint256 public constant MAX_SWAP_HOPS = 5;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice Minimum profit required for arbitrage execution (in token units)
    uint256 public minimumProfit;

    /// @notice Total profits accumulated (for tracking)
    uint256 public totalProfits;

    /// @notice Configurable swap deadline in seconds (default: 300 = 5 minutes)
    uint256 public swapDeadline;

    /// @notice Set of approved DEX routers (O(1) add/remove/contains)
    /// @dev Uses EnumerableSet for gas-efficient operations and enumeration
    EnumerableSet.AddressSet private _approvedRouters;

    // ==========================================================================
    // Structs
    // ==========================================================================

    /**
     * @notice Represents a single swap step in the arbitrage path
     * @param router The DEX router to use for this swap
     * @param tokenIn The input token for this swap
     * @param tokenOut The output token for this swap
     * @param amountOutMin Minimum acceptable output amount (slippage protection)
     */
    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin;
    }

    // ==========================================================================
    // Events
    // ==========================================================================

    /// @notice Emitted when an arbitrage is executed successfully
    event ArbitrageExecuted(
        address indexed asset,
        uint256 amount,
        uint256 profit,
        uint256 timestamp
    );

    /// @notice Emitted when a router is added to the approved list
    event RouterAdded(address indexed router);

    /// @notice Emitted when a router is removed from the approved list
    event RouterRemoved(address indexed router);

    /// @notice Emitted when minimum profit is updated
    event MinimumProfitUpdated(uint256 oldValue, uint256 newValue);

    /// @notice Emitted when tokens are withdrawn
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when ETH is withdrawn
    event ETHWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when swap deadline is updated
    event SwapDeadlineUpdated(uint256 oldValue, uint256 newValue);

    // ==========================================================================
    // Errors
    // ==========================================================================

    error InvalidRouterAddress();
    error RouterAlreadyApproved();
    error RouterNotApproved();
    error EmptySwapPath();
    error PathTooLong(uint256 provided, uint256 max);
    error InvalidSwapPath();
    error SwapPathAssetMismatch();
    error InsufficientProfit();
    error SwapFailed();
    error InsufficientOutputAmount();
    error InsufficientSlippageProtection();
    error InvalidRecipient();
    error ETHTransferFailed();
    error InvalidSwapDeadline();
    error InvalidAmount();
    error TransactionTooOld();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the BaseFlashArbitrage contract
     * @param _owner The contract owner address
     */
    constructor(address _owner) {
        swapDeadline = DEFAULT_SWAP_DEADLINE;
        _transferOwnership(_owner);
    }

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes multi-hop swaps according to the swap path
     * @dev Uses SwapHelpers library for shared swap logic (DRY principle)
     *      Gas optimizations: pre-allocated path array, cached deadline
     *
     * ## Fix 10.5 Note: Why `memory` instead of `calldata`
     *
     * This function uses `SwapStep[] memory` instead of `calldata` because:
     * 1. The swapPath is decoded from `bytes calldata params` in flash loan callbacks
     * 2. abi.decode() always returns data in memory, not calldata
     * 3. Internal functions cannot receive calldata from decoded bytes
     *
     * The executeArbitrage() function does use calldata for the original swapPath,
     * which is optimal for the validation phase. The memory copy is unavoidable
     * for the flash loan callback architecture.
     *
     * @param startAsset The starting asset (flash loaned asset)
     * @param startAmount The starting amount
     * @param swapPath Array of swap steps (memory required due to abi.decode)
     * @return finalAmount The final amount after all swaps
     */
    function _executeSwaps(
        address startAsset,
        uint256 startAmount,
        SwapStep[] memory swapPath
    ) internal returns (uint256 finalAmount) {
        uint256 currentAmount = startAmount;
        address currentToken = startAsset;
        uint256 pathLength = swapPath.length;

        // Gas optimization: Pre-allocate path array once, reuse across iterations
        address[] memory path = new address[](2);

        // Cache swapDeadline to avoid repeated SLOAD (~100 gas saved)
        uint256 deadline = block.timestamp + swapDeadline;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep memory step = swapPath[i];

            // Execute swap using shared library function
            currentAmount = SwapHelpers.executeSingleSwap(
                currentToken,
                currentAmount,
                step.router,
                step.tokenIn,
                step.tokenOut,
                step.amountOutMin,
                path,
                deadline
            );

            // Update for next iteration
            currentToken = step.tokenOut;

            unchecked { ++i; }
        }

        // Verify we end up with the same asset we started with (for repayment)
        if (currentToken != startAsset) revert InvalidSwapPath();

        return currentAmount;
    }

    // ==========================================================================
    // Admin Functions - Router Management
    // ==========================================================================

    /**
     * @notice Adds a router to the approved list
     * @dev O(1) complexity using EnumerableSet
     * @param router The router address to approve
     */
    function addApprovedRouter(address router) external onlyOwner {
        if (router == address(0)) revert InvalidRouterAddress();
        if (!_approvedRouters.add(router)) revert RouterAlreadyApproved();

        emit RouterAdded(router);
    }

    /**
     * @notice Removes a router from the approved list
     * @dev O(1) complexity using EnumerableSet
     * @param router The router address to remove
     */
    function removeApprovedRouter(address router) external onlyOwner {
        if (!_approvedRouters.remove(router)) revert RouterNotApproved();

        emit RouterRemoved(router);
    }

    /**
     * @notice Checks if a router is approved
     * @dev O(1) complexity using EnumerableSet
     * @param router The router address to check
     * @return True if router is approved
     */
    function isApprovedRouter(address router) external view returns (bool) {
        return _approvedRouters.contains(router);
    }

    /**
     * @notice Returns all approved routers
     * @return Array of approved router addresses
     */
    function getApprovedRouters() external view returns (address[] memory) {
        return _approvedRouters.values();
    }

    // ==========================================================================
    // Admin Functions - Configuration
    // ==========================================================================

    /**
     * @notice Sets the minimum profit threshold
     * @param _minimumProfit The new minimum profit value
     */
    function setMinimumProfit(uint256 _minimumProfit) external onlyOwner {
        uint256 oldValue = minimumProfit;
        minimumProfit = _minimumProfit;
        emit MinimumProfitUpdated(oldValue, _minimumProfit);
    }

    /**
     * @notice Sets the swap deadline for DEX transactions
     * @dev Deadline must be between 1 second and MAX_SWAP_DEADLINE (1 hour)
     *      Shorter deadlines provide better MEV protection but may cause failures
     *      on congested networks. Longer deadlines are more reliable but expose
     *      transactions to price movements.
     * @param _swapDeadline The new deadline in seconds (added to block.timestamp)
     */
    function setSwapDeadline(uint256 _swapDeadline) external onlyOwner {
        if (_swapDeadline == 0 || _swapDeadline > MAX_SWAP_DEADLINE) revert InvalidSwapDeadline();
        uint256 oldValue = swapDeadline;
        swapDeadline = _swapDeadline;
        emit SwapDeadlineUpdated(oldValue, _swapDeadline);
    }

    /**
     * @notice Pauses the contract (emergency stop)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ==========================================================================
    // Admin Functions - Fund Recovery
    // ==========================================================================

    /**
     * @notice Withdraws ERC20 tokens from the contract
     * @param token The token address to withdraw
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    /**
     * @notice Withdraws ETH from the contract
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert ETHTransferFailed();
        emit ETHWithdrawn(to, amount);
    }

    // ==========================================================================
    // Receive Function
    // ==========================================================================

    /**
     * @notice Allows the contract to receive ETH
     */
    receive() external payable {}

    // ==========================================================================
    // Internal Utility Functions
    // ==========================================================================

    /**
     * @notice Validates common arbitrage parameters
     * @dev Internal function for use by derived contracts in their executeArbitrage() implementations
     *      Extracts 143+ lines of duplicate validation code (P1 refactoring priority)
     *
     * Validates:
     * - Amount is non-zero (prevents gas waste and ensures slippage protection works)
     * - Deadline has not expired (prevents stale transactions)
     * - Swap path is not empty and not too long (prevents DoS)
     * - First swap starts with the flash-loaned asset (prevents execution failures)
     * - All routers are approved (security)
     * - All swaps have slippage protection (prevents sandwich attacks)
     *
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param deadline The transaction deadline (absolute timestamp)
     * @param swapPath Array of swap steps defining the arbitrage path
     */
    function _validateArbitrageParams(
        address asset,
        uint256 amount,
        uint256 deadline,
        SwapStep[] calldata swapPath
    ) internal view {
        // Validate amount is non-zero to prevent gas waste and ensure slippage protection
        if (amount == 0) revert InvalidAmount();

        // Validate transaction is not stale using user-specified deadline
        if (block.timestamp > deadline) revert TransactionTooOld();

        uint256 pathLength = swapPath.length;
        if (pathLength == 0) revert EmptySwapPath();

        // Prevent DoS via excessive gas consumption
        if (pathLength > MAX_SWAP_HOPS) revert PathTooLong(pathLength, MAX_SWAP_HOPS);

        // Validate first swap step starts with the flash-loaned asset
        if (swapPath[0].tokenIn != asset) revert SwapPathAssetMismatch();

        // Validate token continuity and routers
        // Cache validated routers to avoid redundant checks for repeated routers
        address lastValidatedRouter = address(0);
        address expectedTokenIn = asset;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // Validate token continuity: each step's tokenIn must match expected token
            // This ensures the swap path is valid before taking a flash loan
            if (step.tokenIn != expectedTokenIn) revert InvalidSwapPath();

            // Skip router validation if same router as previous step (common in triangular arb)
            if (step.router != lastValidatedRouter) {
                if (!_approvedRouters.contains(step.router)) revert RouterNotApproved();
                lastValidatedRouter = step.router;
            }

            // Enforce minimum slippage protection to prevent sandwich attacks
            if (step.amountOutMin == 0 && amount > 0) revert InsufficientSlippageProtection();

            // Update expected token for next iteration
            expectedTokenIn = step.tokenOut;

            unchecked { ++i; }
        }

        // Validate cycle completeness: path must return to the starting asset
        // This is critical for flash loan repayment
        if (expectedTokenIn != asset) revert InvalidSwapPath();
    }

    /**
     * @notice Checks if a router is in the approved set (internal helper)
     * @dev Use this for internal validation in derived contracts
     * @param router The router address to check
     * @return True if router is approved
     */
    function _isRouterApproved(address router) internal view returns (bool) {
        return _approvedRouters.contains(router);
    }
}

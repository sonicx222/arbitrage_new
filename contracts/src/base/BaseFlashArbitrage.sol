// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../libraries/SwapHelpers.sol";
import "../interfaces/IDexRouter.sol";

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
 * ## Access Control Design Decision
 *
 * executeArbitrage() access control varies by protocol:
 * - onlyOwner: FlashLoanArbitrage (Aave), PancakeSwapFlashArbitrage — restricts who can trigger trades
 * - open access: BalancerV2FlashArbitrage, SyncSwapFlashArbitrage — safe because flash loans are
 *   atomic (caller can't extract funds; unprofitable trades revert via InsufficientProfit)
 * - CommitRevealArbitrage: open access with commit-reveal pattern for MEV protection
 *
 * This is intentional: open-access contracts allow keeper bots to execute without owner keys,
 * reducing operational risk. The profit check ensures only profitable trades succeed.
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
 * @custom:version 2.1.0
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

    /// @notice Default swap deadline (60 seconds)
    /// @dev Tuned for competitive arbitrage on L2 chains (2-12s block times).
    ///      Shorter deadlines reduce MEV exposure. Increase for congested L1.
    uint256 public constant DEFAULT_SWAP_DEADLINE = 60;

    /// @notice Maximum swap deadline (10 minutes) to prevent stale transactions
    /// @dev Arbitrage opportunities vanish within seconds; 10 minutes is generous.
    uint256 public constant MAX_SWAP_DEADLINE = 600;

    /// @notice Recommended minimum slippage protection floor (0.1% = 10 bps)
    /// @dev Informational constant for off-chain integrations. On-chain validation
    ///      enforces amountOutMin > 0 (see _validateArbitrageParams). Off-chain callers
    ///      SHOULD use at least MIN_SLIPPAGE_BPS to calculate amountOutMin for MEV protection.
    uint256 public constant MIN_SLIPPAGE_BPS = 10;

    /// @notice Maximum number of hops in a swap path (prevents DoS via gas exhaustion)
    /// @dev Limit chosen based on gas analysis: 5 hops = ~700k gas (within block gas limit)
    uint256 public constant MAX_SWAP_HOPS = 5;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice Minimum profit required for arbitrage execution (in token units)
    uint256 public minimumProfit;

    /// @notice Total profits accumulated (aggregate counter, may mix denominations)
    /// @dev Kept for backward compatibility. Use tokenProfits(asset) for accurate per-token tracking.
    uint256 public totalProfits;

    /// @notice Per-token profit tracking (token address => accumulated profit in token units)
    /// @dev Provides accurate per-token profit tracking without mixing denominations
    mapping(address => uint256) public tokenProfits;

    /// @notice Configurable swap deadline in seconds (default: DEFAULT_SWAP_DEADLINE)
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
     * @param deadline Absolute deadline timestamp for swaps (block.timestamp + swapDeadline for flash loans,
     *                 or user-specified deadline for commit-reveal)
     * @return finalAmount The final amount after all swaps
     */
    function _executeSwaps(
        address startAsset,
        uint256 startAmount,
        SwapStep[] memory swapPath,
        uint256 deadline
    ) internal returns (uint256 finalAmount) {
        uint256 currentAmount = startAmount;
        address currentToken = startAsset;
        uint256 pathLength = swapPath.length;

        // Gas optimization: Pre-allocate path array once, reuse across iterations
        address[] memory path = new address[](2);

        for (uint256 i = 0; i < pathLength;) {
            // Access fields directly to avoid memory-to-memory struct copy (~200 gas/hop)
            currentAmount = SwapHelpers.executeSingleSwap(
                currentToken,
                currentAmount,
                swapPath[i].router,
                swapPath[i].tokenIn,
                swapPath[i].tokenOut,
                swapPath[i].amountOutMin,
                path,
                deadline
            );

            // Update for next iteration
            currentToken = swapPath[i].tokenOut;

            unchecked { ++i; }
        }

        // Verify we end up with the same asset we started with (for repayment)
        if (currentToken != startAsset) revert InvalidSwapPath();

        return currentAmount;
    }

    // ==========================================================================
    // Internal Functions - Swap Simulation (View)
    // ==========================================================================

    /**
     * @notice Simulates multi-hop swaps to estimate final output amount
     * @dev Shared logic for calculateExpectedProfit() across all protocol contracts.
     *      Uses DEX router getAmountsOut() to simulate each hop without executing.
     *
     *      Returns 0 on any failure (invalid path, cycle, router error) so callers
     *      can return (0, flashLoanFee) as appropriate.
     *
     *      Includes cycle detection: if an intermediate token appears twice before
     *      the final step, the path is rejected as inefficient. O(n^2) but bounded
     *      by MAX_SWAP_HOPS=5 (max 15 comparisons).
     *
     * @param asset The starting/ending asset (must form a cycle)
     * @param amount The starting amount
     * @param swapPath Array of swap steps defining the path
     * @return finalAmount The simulated output amount, or 0 if path is invalid
     */
    function _simulateSwapPath(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) internal view returns (uint256 finalAmount) {
        uint256 pathLength = swapPath.length;

        // Early validation
        if (pathLength == 0 || swapPath[0].tokenIn != asset) {
            return 0;
        }

        uint256 currentAmount = amount;
        address currentToken = asset;

        // Gas optimization: Pre-allocate path array once, reuse across iterations
        address[] memory path = new address[](2);

        // Track visited tokens to detect inefficient cycles
        address[] memory visitedTokens = new address[](pathLength + 1);
        visitedTokens[0] = asset;
        uint256 visitedCount = 1;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // Validate token continuity
            if (step.tokenIn != currentToken) {
                return 0;
            }

            // Cycle detection: reject if token seen before (except final step
            // returning to start asset, which is the desired behavior)
            if (i < pathLength - 1) {
                for (uint256 j = 0; j < visitedCount;) {
                    if (visitedTokens[j] == step.tokenOut) {
                        return 0;
                    }
                    unchecked { ++j; }
                }
            }

            visitedTokens[visitedCount] = step.tokenOut;
            unchecked { ++visitedCount; }

            // Simulate swap via router's view function
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            try IDexRouter(step.router).getAmountsOut(currentAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
                currentToken = step.tokenOut;
            } catch {
                return 0;
            }

            unchecked { ++i; }
        }

        // Verify cycle completed (must end with start asset for flash loan repayment)
        if (currentToken != asset) {
            return 0;
        }

        return currentAmount;
    }

    /**
     * @notice Calculates profit from simulated output and flash loan fee
     * @dev Common profit calculation used by all protocol-specific calculateExpectedProfit()
     *
     * @param amount Original flash loan amount
     * @param simulatedOutput Output from _simulateSwapPath()
     * @param flashLoanFee Protocol-specific flash loan fee
     * @return expectedProfit Net profit after repayment + fees, or 0 if unprofitable
     */
    function _calculateProfit(
        uint256 amount,
        uint256 simulatedOutput,
        uint256 flashLoanFee
    ) internal pure returns (uint256 expectedProfit) {
        uint256 amountOwed = amount + flashLoanFee;
        if (simulatedOutput > amountOwed) {
            return simulatedOutput - amountOwed;
        }
        return 0;
    }

    /**
     * @notice Verifies profit meets minimum thresholds and updates tracking
     * @dev Consolidates profit verification logic used across all protocol callbacks.
     *      Uses max(minProfit, minimumProfit) to enforce both per-trade and contract-wide thresholds.
     *
     * @param profit The actual profit earned from the arbitrage
     * @param minProfit The per-trade minimum profit specified by the caller
     * @param asset The token address used for per-token profit tracking
     */
    function _verifyAndTrackProfit(uint256 profit, uint256 minProfit, address asset) internal {
        // Zero-profit flash loans are never desirable — always revert
        if (profit == 0) revert InsufficientProfit();

        // Cache storage read to save ~100 gas on SLOAD
        uint256 _minimumProfit = minimumProfit;
        uint256 effectiveMinProfit = minProfit > _minimumProfit ? minProfit : _minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Track profits per-token (avoids mixing denominations)
        tokenProfits[asset] += profit;
        // Maintain legacy aggregate counter for backward compatibility
        totalProfits += profit;
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
     * @dev Deadline must be between 1 second and MAX_SWAP_DEADLINE (10 minutes)
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
        // Gas-limited call prevents recipient from executing arbitrary logic
        (bool success, ) = to.call{value: amount, gas: 10000}("");
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
     * @notice Returns absolute swap deadline (block.timestamp + swapDeadline)
     * @dev Used by flash loan callbacks to compute the deadline for DEX swaps.
     *      Centralizes the computation to avoid repeated inline calculation across children.
     * @return Absolute deadline timestamp
     */
    function _getSwapDeadline() internal view returns (uint256) {
        return block.timestamp + swapDeadline;
    }

    /**
     * @notice Validates common arbitrage parameters
     * @dev Internal function for use by derived contracts in their executeArbitrage() implementations
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
            // Note: amount > 0 is guaranteed by InvalidAmount check above
            if (step.amountOutMin == 0) revert InsufficientSlippageProtection();

            // Update expected token for next iteration
            expectedTokenIn = step.tokenOut;

            unchecked { ++i; }
        }

        // Validate cycle completeness: path must return to the starting asset
        // This is critical for flash loan repayment
        if (expectedTokenIn != asset) revert InvalidSwapPath();
    }

}

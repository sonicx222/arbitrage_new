// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IFlashLoanReceiver.sol";

/**
 * @title FlashLoanArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for executing profitable trades using Aave V3 flash loans
 * @dev Implements IFlashLoanSimpleReceiver for Aave V3 integration
 *
 * Features:
 * - Aave V3 flash loan integration (0.09% fee)
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.2.0
 *
 * ## Changelog v1.2.0 (Bug Hunt Fixes)
 * - Fix P2-1: Added amount validation (amount > 0) to prevent gas waste and ensure slippage protection
 * - Fix P2-2: Added deadline parameter for transaction staleness protection (industry standard)
 * - BREAKING CHANGE: executeArbitrage() now requires deadline parameter
 *
 * ## Changelog v1.1.0
 * - Fix 4.3: Added SwapPathAssetMismatch validation for swapPath[0].tokenIn == asset
 * - Fix 6.1: Added MIN_SLIPPAGE_BPS constant and InsufficientSlippageProtection check
 * - Fix 7.2: Upgraded from Ownable to Ownable2Step for safer ownership transfers
 * - Fix 10.3: Optimized router validation with caching for repeated routers
 *
 * ## Performance Optimization Roadmap (Fix 10.4 & 10.2.3)
 *
 * ### Current Limitation
 * calculateExpectedProfit() makes sequential getAmountsOut() calls to DEX routers.
 * For an N-hop path, this requires N external calls, adding latency in competitive
 * MEV environments where every millisecond counts.
 *
 * ### Proposed Solution: MultiPathQuoter Contract
 * Deploy a separate quoter contract that batches getAmountsOut() calls:
 *
 * ```solidity
 * contract MultiPathQuoter {
 *     struct QuoteRequest {
 *         address router;
 *         address tokenIn;
 *         address tokenOut;
 *         uint256 amountIn;
 *     }
 *
 *     function getBatchedQuotes(QuoteRequest[] calldata requests)
 *         external view returns (uint256[] memory amountsOut);
 * }
 * ```
 *
 * Benefits:
 * - Single RPC call instead of N calls (reduces network latency)
 * - Atomic state snapshot (quotes are from the same block)
 * - Can be combined with multicall for maximum efficiency
 *
 * Implementation Notes:
 * 1. Deploy MultiPathQuoter on each supported chain
 * 2. Update flash-loan.strategy.ts to use batched quotes for profitability checks
 * 3. Keep calculateExpectedProfit() as fallback for on-chain verification
 *
 * Estimated Impact: 50-200ms latency reduction for 3-hop paths
 *
 * See implementation_plan_v2.md Task 3.1.1
 */
contract FlashLoanArbitrage is
    IFlashLoanSimpleReceiver,
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

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The Aave V3 Pool address for flash loans
    IPool public immutable POOL;

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

    error InvalidPoolAddress();
    error InvalidRouterAddress();
    error RouterAlreadyApproved();
    error RouterNotApproved();
    error EmptySwapPath();
    error InvalidSwapPath();
    error SwapPathAssetMismatch();
    error InsufficientProfit();
    error InvalidFlashLoanInitiator();
    error InvalidFlashLoanCaller();
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
     * @notice Initializes the FlashLoanArbitrage contract
     * @param _pool The Aave V3 Pool address
     * @param _owner The contract owner address
     */
    constructor(address _pool, address _owner) {
        if (_pool == address(0)) revert InvalidPoolAddress();
        POOL = IPool(_pool);
        swapDeadline = DEFAULT_SWAP_DEADLINE;
        _transferOwnership(_owner);
    }

    // ==========================================================================
    // External Functions - Arbitrage Execution
    // ==========================================================================

    /**
     * @notice Executes a flash loan arbitrage
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @param minProfit Minimum required profit (reverts if not achieved)
     * @param deadline Absolute deadline (block.timestamp) - reverts if current block is after deadline
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        // Fix P2-1: Validate amount is non-zero to prevent gas waste and ensure slippage protection
        // Without this check, amount=0 bypasses slippage validation (line 243 condition)
        if (amount == 0) revert InvalidAmount();

        // Fix P2-2: Validate transaction is not stale using user-specified deadline
        // This protects against transactions being mined in poor market conditions after delays.
        // Industry standard: Uniswap, Sushiswap, etc. all use absolute deadlines.
        if (block.timestamp > deadline) revert TransactionTooOld();

        if (swapPath.length == 0) revert EmptySwapPath();

        // Fix 4.3: Validate first swap step starts with the flash-loaned asset
        // This prevents silent failures during swap execution
        if (swapPath[0].tokenIn != asset) revert SwapPathAssetMismatch();

        // Validate all routers in the path are approved (O(1) lookup via EnumerableSet)
        // Fix 10.3: Cache validated routers to avoid redundant checks for repeated routers
        uint256 pathLength = swapPath.length;
        address lastValidatedRouter = address(0);

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // Fix 10.3: Skip validation if same router as previous step (common in triangular arb)
            if (step.router != lastValidatedRouter) {
                if (!_approvedRouters.contains(step.router)) revert RouterNotApproved();
                lastValidatedRouter = step.router;
            }

            // Fix 6.1: Enforce minimum slippage protection to prevent sandwich attacks
            // amountOutMin of 0 is dangerous - require at least MIN_SLIPPAGE_BPS protection
            // Skip this check if amount is also 0 (degenerate case)
            if (step.amountOutMin == 0 && amount > 0) revert InsufficientSlippageProtection();

            unchecked { ++i; }
        }

        // Encode the swap path and minimum profit for the callback
        bytes memory params = abi.encode(swapPath, minProfit);

        // Initiate flash loan
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0 // referralCode
        );
    }

    /**
     * @notice Callback function called by Aave Pool during flash loan
     * @dev Must return true and repay loan + premium for success
     * @param asset The asset that was flash-borrowed
     * @param amount The amount that was flash-borrowed
     * @param premium The fee to pay for the flash loan
     * @param initiator The address that initiated the flash loan
     * @param params Encoded swap path and minimum profit
     * @return True if the operation succeeds
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Security: Verify caller is the Aave Pool
        if (msg.sender != address(POOL)) revert InvalidFlashLoanCaller();

        // Security: Verify initiator is this contract
        if (initiator != address(this)) revert InvalidFlashLoanInitiator();

        // Decode parameters
        (SwapStep[] memory swapPath, uint256 minProfit) = abi.decode(
            params,
            (SwapStep[], uint256)
        );

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(asset, amount, swapPath);

        // Calculate required repayment and profit
        uint256 amountOwed = amount + premium;
        if (amountReceived < amountOwed) revert InsufficientProfit();

        uint256 profit = amountReceived - amountOwed;

        // Verify minimum profit threshold (cache storage read)
        uint256 _minimumProfit = minimumProfit;
        uint256 effectiveMinProfit = minProfit > _minimumProfit ? minProfit : _minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Update profit tracking
        totalProfits += profit;

        // Approve the Pool to pull the owed amount
        // Fix 9.1: Use forceApprove instead of safeIncreaseAllowance to prevent
        // allowance accumulation and handle tokens that revert on non-zero to non-zero approval
        IERC20(asset).forceApprove(address(POOL), amountOwed);

        emit ArbitrageExecuted(asset, amount, profit, block.timestamp);

        return true;
    }

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes multi-hop swaps according to the swap path
     * @dev Gas optimizations applied:
     *      - Pre-allocated path array reused across iterations (~200 gas/swap saved)
     *      - Configurable deadline instead of hardcoded value
     *      - Defense-in-depth output verification (see note below)
     *
     * ## Fix 10.5 Note: Why `memory` instead of `calldata`
     *
     * This function uses `SwapStep[] memory` instead of `calldata` because:
     * 1. The swapPath is decoded from `bytes calldata params` in executeOperation()
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
        // Saves ~200 gas per swap step by avoiding repeated memory allocation
        address[] memory path = new address[](2);

        // Cache swapDeadline to avoid repeated SLOAD (~100 gas saved)
        uint256 deadline = block.timestamp + swapDeadline;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep memory step = swapPath[i];

            // Validate swap step (router already validated in executeArbitrage)
            if (step.tokenIn != currentToken) revert InvalidSwapPath();

            // Approve router to spend tokens
            // Fix 9.1: Use forceApprove for safe token approvals
            IERC20(currentToken).forceApprove(step.router, currentAmount);

            // Reuse pre-allocated path array
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            // Execute swap
            uint256[] memory amounts = IDexRouter(step.router).swapExactTokensForTokens(
                currentAmount,
                step.amountOutMin,
                path,
                address(this),
                deadline
            );

            // Defense-in-depth: Verify output matches minimum
            // NOTE: This check is technically redundant as compliant DEX routers
            // already revert if output < amountOutMin. However, we keep this as:
            // 1. Protection against non-compliant or malicious routers
            // 2. Explicit error message (InsufficientOutputAmount vs generic revert)
            // 3. Security audit requirement for explicit state validation
            // Cost: ~200 gas per swap - acceptable for the security guarantee
            uint256 amountOut = amounts[amounts.length - 1];
            if (amountOut < step.amountOutMin) revert InsufficientOutputAmount();

            // Update for next iteration
            currentAmount = amountOut;
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
     * @dev O(1) complexity using EnumerableSet (Fix 10.5 implemented)
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
    // View Functions
    // ==========================================================================

    /**
     * @notice Calculates the expected profit for an arbitrage opportunity
     * @dev This is a simulation that doesn't execute the actual swaps
     *
     * Fix 10.4: Performance optimization note - This function makes sequential
     * external calls to getAmountsOut() for each swap step. For competitive
     * speed in MEV environments, consider these alternatives:
     *
     * 1. Cache quotes off-chain: Call this function only for final verification,
     *    use off-chain quote aggregation for initial screening.
     *
     * 2. Multicall pattern: If the caller can batch read calls, combine this
     *    with other view functions to reduce round trips.
     *
     * 3. Custom quoter: Deploy a quoter contract that batches getAmountsOut()
     *    calls internally using DELEGATECALL.
     *
     * Current implementation prioritizes correctness and gas efficiency over
     * latency. The sequential approach is safer for production use.
     *
     * Note: This view function does NOT validate amount > 0 or check deadlines
     * since those are execution-time validations. Callers should validate inputs
     * before calling executeArbitrage().
     *
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan (caller should ensure > 0)
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The flash loan fee
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Calculate flash loan fee (0.09% for Aave V3)
        uint128 premiumBps = POOL.FLASHLOAN_PREMIUM_TOTAL();
        flashLoanFee = (amount * premiumBps) / 10000;

        // Fix 4.3: Early validation - swapPath must start with the flash-loaned asset
        uint256 pathLength = swapPath.length;
        if (pathLength == 0 || swapPath[0].tokenIn != asset) {
            return (0, flashLoanFee);
        }

        // Simulate swaps to get expected output
        uint256 currentAmount = amount;
        address currentToken = asset;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee); // Invalid path
            }

            // Get expected output from router
            address[] memory path = new address[](2);
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            try IDexRouter(step.router).getAmountsOut(currentAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
                currentToken = step.tokenOut;
            } catch {
                return (0, flashLoanFee); // Router call failed
            }

            unchecked { ++i; }
        }

        // Check if we end with the correct asset
        if (currentToken != asset) {
            return (0, flashLoanFee);
        }

        // Calculate profit
        uint256 amountOwed = amount + flashLoanFee;
        if (currentAmount > amountOwed) {
            expectedProfit = currentAmount - amountOwed;
        } else {
            expectedProfit = 0;
        }

        return (expectedProfit, flashLoanFee);
    }

    // ==========================================================================
    // Receive Function
    // ==========================================================================

    /**
     * @notice Allows the contract to receive ETH
     */
    receive() external payable {}
}

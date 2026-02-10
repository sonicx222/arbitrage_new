// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
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
 * @custom:version 2.0.0
 *
 * @custom:warning UNSUPPORTED TOKEN TYPES
 * This contract does NOT support:
 * - Fee-on-transfer tokens: Tokens that deduct fees during transfer will cause
 *   InsufficientProfit errors because received amounts don't match expected amounts.
 * - Rebasing tokens: Tokens that change balance over time may cause repayment failures
 *   if balance decreases mid-transaction.
 * Using these token types will result in failed transactions and wasted gas.
 *
 * ## Changelog v2.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage (eliminates 300+ lines of duplicate code)
 * - Moved common functionality to base contract (router management, config, emergency functions)
 * - No behavioral changes, pure refactoring for maintainability
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
 * ## Performance Optimization for Competitive MEV
 *
 * For batched quote operations (reducing RPC latency), use MultiPathQuoter.sol
 * instead of calling calculateExpectedProfit() for each opportunity.
 *
 * Benefits:
 * - Single RPC call for multiple paths (50-200ms latency reduction)
 * - Atomic price snapshot (all quotes from same block)
 * - Better suited for MEV-competitive environments
 *
 * See: contracts/src/MultiPathQuoter.sol
 */
contract FlashLoanArbitrage is
    BaseFlashArbitrage,
    IFlashLoanSimpleReceiver
{
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants
    // ==========================================================================

    /// @notice Denominator for basis points calculations (10000 bps = 100%)
    uint256 private constant BPS_DENOMINATOR = 10000;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The Aave V3 Pool address for flash loans
    IPool public immutable POOL;

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    error InvalidPoolAddress();
    error InvalidFlashLoanInitiator();
    error InvalidFlashLoanCaller();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the FlashLoanArbitrage contract
     * @param _pool The Aave V3 Pool address
     * @param _owner The contract owner address
     */
    constructor(address _pool, address _owner) BaseFlashArbitrage(_owner) {
        if (_pool == address(0)) revert InvalidPoolAddress();

        // Verify pool is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_pool.code.length == 0) revert InvalidPoolAddress();

        POOL = IPool(_pool);
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
        // P1: Use base contract validation (eliminates duplicate code)
        _validateArbitrageParams(asset, amount, deadline, swapPath);

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

    // Note: _executeSwaps, router management, config, and emergency functions
    // are now inherited from BaseFlashArbitrage

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
        flashLoanFee = (amount * premiumBps) / BPS_DENOMINATOR;

        // Fix 4.3: Early validation - swapPath must start with the flash-loaned asset
        uint256 pathLength = swapPath.length;
        if (pathLength == 0 || swapPath[0].tokenIn != asset) {
            return (0, flashLoanFee);
        }

        // Simulate swaps to get expected output
        uint256 currentAmount = amount;
        address currentToken = asset;

        // Gas optimization: Pre-allocate path array once, reuse across iterations
        // Saves ~200 gas per swap step by avoiding repeated memory allocation
        // (Same pattern as _executeSwaps)
        address[] memory path = new address[](2);

        // Track visited tokens to detect cycles (Fix 4.4: P2 resilience improvement)
        // Pre-allocate array for visited tokens (max size = pathLength + 1 for start asset)
        address[] memory visitedTokens = new address[](pathLength + 1);
        visitedTokens[0] = asset; // Start asset
        uint256 visitedCount = 1;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee); // Invalid path
            }

            // Check for cycle: token appears twice before final step
            // Allow final step to return to start asset (that's the goal)
            // Cycle detection: O(n²) complexity for path validation
            // Acceptable for MAX_SWAP_HOPS=5 (max 15 comparisons)
            // Alternative would be mapping (not possible in view functions)
            if (i < pathLength - 1) {
                for (uint256 j = 0; j < visitedCount; j++) {
                    if (visitedTokens[j] == step.tokenOut) {
                        return (0, flashLoanFee); // Cycle detected - inefficient path
                    }
                }
            }

            // Track this token as visited
            visitedTokens[visitedCount] = step.tokenOut;
            unchecked { ++visitedCount; }

            // Reuse pre-allocated path array
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
}

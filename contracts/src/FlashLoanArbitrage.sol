// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/IFlashLoanReceiver.sol";
import "./interfaces/IFlashLoanErrors.sol";
import "./interfaces/IDexRouter.sol"; // Used by calculateExpectedProfit() for getAmountsOut()

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
    IFlashLoanSimpleReceiver,
    IFlashLoanErrors
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

    // Errors: InvalidProtocolAddress, InvalidFlashLoanCaller, InvalidFlashLoanInitiator
    // inherited from IFlashLoanErrors

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the FlashLoanArbitrage contract
     * @param _pool The Aave V3 Pool address
     * @param _owner The contract owner address
     */
    constructor(address _pool, address _owner) BaseFlashArbitrage(_owner) {
        if (_pool == address(0)) revert InvalidProtocolAddress();

        // Verify pool is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_pool.code.length == 0) revert InvalidProtocolAddress();

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

        // Repayment: PULL pattern - Aave Pool pulls tokens via transferFrom after callback
        // Use forceApprove (not safeIncreaseAllowance) to prevent allowance accumulation
        // and handle tokens that revert on non-zero to non-zero approval
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
     * @dev Simulates swaps via DEX router getAmountsOut() without executing.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage for path
     *      validation, cycle detection, and swap simulation.
     *
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan (caller should ensure > 0)
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The Aave V3 flash loan fee (0.09%)
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Aave V3 fee: (amount * premiumBps) / 10000
        uint128 premiumBps = POOL.FLASHLOAN_PREMIUM_TOTAL();
        flashLoanFee = (amount * premiumBps) / BPS_DENOMINATOR;

        uint256 simulatedOutput = _simulateSwapPath(asset, amount, swapPath);
        if (simulatedOutput == 0) {
            return (0, flashLoanFee);
        }

        expectedProfit = _calculateProfit(amount, simulatedOutput, flashLoanFee);
        return (expectedProfit, flashLoanFee);
    }
}

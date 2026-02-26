// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/IBalancerV2Vault.sol";
import "./interfaces/IDexRouter.sol"; // Used by calculateExpectedProfit() for getAmountsOut()

/**
 * @title BalancerV2FlashArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for executing profitable trades using Balancer V2 flash loans
 * @dev Implements IFlashLoanRecipient for Balancer V2 Vault integration
 *
 * Features:
 * - Balancer V2 flash loan integration (0% fee permanently - see below)
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * ## Balancer V2 Flash Loan Fees
 *
 * Balancer V2 flash loans are **permanently fee-free** (0%) per governance decision.
 * This is a competitive advantage over other flash loan providers:
 * - Aave V3: 0.09% (9 basis points)
 * - PancakeSwap V3: 0.01-1% (pool-dependent)
 * - SyncSwap: ~0.3% (configurable)
 *
 * Fee-free status is hardcoded in Balancer V2 Vault and cannot be changed without
 * a full protocol upgrade, making it a reliable long-term advantage.
 *
 * Reference: https://docs.balancer.fi/reference/contracts/flash-loans.html
 *
 * Balancer V2 Flash Loan Advantages:
 * - Zero flash loan fees (unlike Aave V3's 0.09%)
 * - Single Vault contract per chain (no pool discovery needed)
 * - Massive liquidity across all Balancer pools
 * - Simple callback interface with array-based parameters
 *
 * Security Model:
 * - Only Balancer Vault can call receiveFlashLoan() callback
 * - No pool whitelist needed (Vault address is trusted)
 * - Approved router system prevents malicious DEX interactions
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.1.0
 * @custom:implementation-plan Task 2.2 - Balancer V2 Flash Loan Provider
 *
 * ## Changelog v2.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage (eliminates 300+ lines of duplicate code)
 * - No behavioral changes, pure refactoring for maintainability
 *
 * @custom:warning UNSUPPORTED TOKEN TYPES
 * This contract does NOT support:
 * - Fee-on-transfer tokens: Tokens that deduct fees during transfer will cause
 *   InsufficientProfit errors because received amounts don't match expected amounts.
 * - Rebasing tokens: Tokens that change balance over time may cause repayment failures
 *   if balance decreases mid-transaction.
 * Using these token types will result in failed transactions and wasted gas.
 */
contract BalancerV2FlashArbitrage is
    BaseFlashArbitrage,
    IFlashLoanRecipient
{
    using SafeERC20 for IERC20;

    // ==========================================================================
    // State Variables (Protocol-Specific)
    // ==========================================================================

    /// @notice The Balancer V2 Vault address for flash loans
    IBalancerV2Vault public immutable VAULT;

    // ==========================================================================
    // State Variables (Flash Loan Security)
    // ==========================================================================

    /// @notice Guard flag to prevent direct callback invocation (defense in depth)
    /// @dev Set in executeArbitrage(), checked in receiveFlashLoan(), cleared after callback
    bool private _flashLoanActive;

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    // InvalidProtocolAddress, InvalidFlashLoanCaller inherited from IFlashLoanErrors
    error MultiAssetNotSupported();
    error FlashLoanNotActive();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the BalancerV2FlashArbitrage contract
     * @param _vault The Balancer V2 Vault address
     * @param _owner The contract owner address
     */
    constructor(address _vault, address _owner) BaseFlashArbitrage(_owner) {
        _validateContractAddress(_vault);

        VAULT = IBalancerV2Vault(_vault);
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
        bytes memory userData = abi.encode(swapPath, minProfit);

        // Prepare flash loan parameters
        address[] memory tokens = new address[](1);
        tokens[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        // Set flash loan active guard (defense in depth — prevents direct callback calls)
        _flashLoanActive = true;

        // Initiate flash loan
        VAULT.flashLoan(
            IFlashLoanRecipient(this),
            tokens,
            amounts,
            userData
        );

        // Clear flash loan guard after successful execution
        _flashLoanActive = false;
    }

    /**
     * @notice Callback function called by Balancer Vault during flash loan
     * @dev Must repay borrowed tokens (+ fees, though Balancer V2 fees are 0) before returning
     * @param tokens Array of tokens that were flash loaned
     * @param amounts Array of amounts that were flash loaned
     * @param feeAmounts Array of fee amounts (always 0 for Balancer V2)
     * @param userData Encoded swap path and minimum profit
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Security: Verify caller is the Balancer Vault
        if (msg.sender != address(VAULT)) revert InvalidFlashLoanCaller();

        // Security: Verify flash loan was initiated by this contract (defense in depth)
        if (!_flashLoanActive) revert FlashLoanNotActive();

        // Balancer V2 supports multi-asset flash loans, but we only use single-asset for MVP
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert MultiAssetNotSupported();
        }

        address asset = tokens[0];
        uint256 amount = amounts[0];
        uint256 feeAmount = feeAmounts[0]; // Always 0 for Balancer V2

        // Decode parameters
        (SwapStep[] memory swapPath, uint256 minProfit) = abi.decode(
            userData,
            (SwapStep[], uint256)
        );

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(asset, amount, swapPath, _getSwapDeadline());

        // Calculate required repayment and profit
        uint256 amountOwed = amount + feeAmount; // feeAmount is 0, but kept for clarity
        if (amountReceived < amountOwed) revert InsufficientProfit();

        uint256 profit = amountReceived - amountOwed;

        // Verify profit meets thresholds and update tracking (base contract)
        _verifyAndTrackProfit(profit, minProfit, asset);

        // Repayment: PUSH pattern - we transfer tokens directly to Vault
        // Balancer V2 checks its balance after callback returns to verify repayment
        IERC20(asset).safeTransfer(address(VAULT), amountOwed);

        emit ArbitrageExecuted(asset, amount, profit, block.timestamp, tx.origin);
    }

    // Note: Common functions inherited from BaseFlashArbitrage

    // ==========================================================================
    // View Functions
    // ==========================================================================

    /**
     * @notice Calculates the expected profit for an arbitrage opportunity
     * @dev Simulates swaps via DEX router getAmountsOut() without executing.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage.
     *      Balancer V2 charges 0% flash loan fees -- only DEX swap fees apply.
     *
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan (caller should ensure > 0)
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The flash loan fee (always 0 for Balancer V2)
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Balancer V2: 0% flash loan fee
        flashLoanFee = 0;

        uint256 simulatedOutput = _simulateSwapPath(asset, amount, swapPath);
        if (simulatedOutput == 0) {
            return (0, flashLoanFee);
        }

        expectedProfit = _calculateProfit(amount, simulatedOutput, flashLoanFee);
        return (expectedProfit, flashLoanFee);
    }
}

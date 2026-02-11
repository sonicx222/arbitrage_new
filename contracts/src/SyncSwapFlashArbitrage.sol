// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/ISyncSwapVault.sol";
import "./interfaces/IFlashLoanErrors.sol";
import "./interfaces/IDexRouter.sol";

/**
 * @title SyncSwapFlashArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for zkSync Era using SyncSwap's EIP-3156 flash loans
 * @dev Implements IERC3156FlashBorrower for EIP-3156 compliant flash loan integration
 *
 * Features:
 * - SyncSwap flash loan integration (dynamic fee query via EIP-3156)
 * - EIP-3156 standard compliance for interoperability
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * SyncSwap Flash Loan Characteristics:
 * - Dynamic flash loan fee (~0.3% typical, queried via VAULT.flashFee())
 * - EIP-3156 compliant callback interface
 * - Single Vault contract per chain (no pool discovery needed)
 * - Supports native ETH via address(0)
 * - Fee calculated on the loan amount (not surplus balance)
 * - Fee is configurable by governance and may vary over time
 *
 * Security Model:
 * - Only SyncSwap Vault can call onFlashLoan() callback
 * - Approved router system prevents malicious DEX interactions
 * - Initiator verification ensures callback initiated by this contract
 * - Returns correct EIP-3156 success hash
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.0.0
 * @custom:implementation-plan Task 3.4 - SyncSwap Flash Loan Provider (zkSync Era)
 * @custom:standard EIP-3156 Flash Loans
 *
 * ## Changelog v2.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage
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
contract SyncSwapFlashArbitrage is
    BaseFlashArbitrage,
    IERC3156FlashBorrower,
    IFlashLoanErrors
{
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants (Protocol-Specific)
    // ==========================================================================

    /// @notice EIP-3156 success return value
    /// @dev Must return this exact value from onFlashLoan() to signal success
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    // ==========================================================================
    // State Variables (Protocol-Specific)
    // ==========================================================================

    /// @notice The SyncSwap Vault address for flash loans
    ISyncSwapVault public immutable VAULT;

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    // InvalidProtocolAddress, InvalidFlashLoanCaller, InvalidFlashLoanInitiator
    // inherited from IFlashLoanErrors
    error FlashLoanFailed();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the SyncSwapFlashArbitrage contract
     * @param _vault The SyncSwap Vault address
     * @param _owner The contract owner address
     */
    constructor(address _vault, address _owner) BaseFlashArbitrage(_owner) {
        if (_vault == address(0)) revert InvalidProtocolAddress();

        // Verify vault is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_vault.code.length == 0) revert InvalidProtocolAddress();

        VAULT = ISyncSwapVault(_vault);
    }

    // ==========================================================================
    // External Functions - Arbitrage Execution
    // ==========================================================================

    /**
     * @notice Executes a flash loan arbitrage using EIP-3156 interface
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @param minProfit Minimum required profit (reverts if not achieved)
     * @param deadline Absolute deadline (block.timestamp) - reverts if current block is after deadline
     *
     * @dev Initiates flash loan from SyncSwap Vault, executes swaps, verifies profit.
     *      The Vault will call onFlashLoan() callback during execution.
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

        // Initiate EIP-3156 flash loan
        // SyncSwap will transfer tokens to this contract, call onFlashLoan(), then verify repayment
        bool success = VAULT.flashLoan(
            IERC3156FlashBorrower(this),
            asset,
            amount,
            userData
        );

        if (!success) revert FlashLoanFailed();
    }

    /**
     * @notice EIP-3156 callback function called by SyncSwap Vault during flash loan
     * @dev Must repay borrowed tokens + fee before returning. Returns ERC3156_CALLBACK_SUCCESS on success.
     * @param initiator The address that initiated the flash loan (should be this contract)
     * @param token The token that was flash loaned
     * @param amount The amount that was flash loaned
     * @param fee The flash loan fee (0.3% = 30 bps)
     * @param data Encoded swap path and minimum profit
     * @return ERC3156_CALLBACK_SUCCESS if successful
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        // Security: Only SyncSwap Vault can call this function
        if (msg.sender != address(VAULT)) revert InvalidFlashLoanCaller();

        // Security: Verify the flash loan was initiated by this contract
        // Prevents external actors from triggering callbacks
        if (initiator != address(this)) revert InvalidFlashLoanInitiator();

        // Decode user data
        (SwapStep[] memory swapPath, uint256 minProfit) = abi.decode(
            data,
            (SwapStep[], uint256)
        );

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(token, amount, swapPath);

        // Calculate amount owed (principal + fee)
        uint256 amountOwed = amount + fee;

        // Verify we received enough to repay loan + fee
        if (amountReceived < amountOwed) revert InsufficientProfit();

        // Calculate actual profit
        uint256 profit = amountReceived - amountOwed;

        // Check profit meets minimum threshold (cache storage read to save ~100 gas)
        uint256 _minimumProfit = minimumProfit;
        uint256 effectiveMinProfit = minProfit > _minimumProfit ? minProfit : _minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Update total profits tracking
        totalProfits += profit;

        // Repayment: PULL pattern - SyncSwap Vault pulls tokens via transferFrom
        // after callback returns (EIP-3156 standard behavior).
        // Use forceApprove for safe non-zero to non-zero approval handling.
        IERC20(token).forceApprove(address(VAULT), amountOwed);

        // Emit success event
        emit ArbitrageExecuted(token, amount, profit, block.timestamp);

        // Return EIP-3156 success code
        return ERC3156_CALLBACK_SUCCESS;
    }

    // Note: _executeSwaps function inherited from BaseFlashArbitrage

    // ==========================================================================
    // External Functions - View
    // ==========================================================================

    /**
     * @notice Calculate expected profit for an arbitrage opportunity
     * @dev Simulates swaps via DEX router getAmountsOut() without executing.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage.
     *
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @return expectedProfit Expected profit after fees (0 if unprofitable or invalid)
     * @return flashLoanFee Flash loan fee amount (~0.3%, queried from Vault)
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // SyncSwap EIP-3156: query exact fee from Vault
        flashLoanFee = VAULT.flashFee(asset, amount);

        uint256 simulatedOutput = _simulateSwapPath(asset, amount, swapPath);
        if (simulatedOutput == 0) {
            return (0, flashLoanFee);
        }

        expectedProfit = _calculateProfit(amount, simulatedOutput, flashLoanFee);
        return (expectedProfit, flashLoanFee);
    }

    // Note: Router management, config, and emergency functions inherited from BaseFlashArbitrage
}

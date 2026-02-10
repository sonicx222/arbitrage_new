// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/ISyncSwapVault.sol";
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
 * - Fee calculated on surplus balance after repayment
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
    IERC3156FlashBorrower
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

    error InvalidVaultAddress();
    error InvalidFlashLoanCaller();
    error InvalidInitiator();
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
        if (_vault == address(0)) revert InvalidVaultAddress();

        // Verify vault is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_vault.code.length == 0) revert InvalidVaultAddress();

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
        if (initiator != address(this)) revert InvalidInitiator();

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

        // Check profit meets minimum threshold
        // Use max of per-trade minProfit and global minimumProfit
        uint256 effectiveMinProfit = minProfit > minimumProfit ? minProfit : minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Update total profits tracking
        totalProfits += profit;

        // Approve Vault to pull repayment (EIP-3156 standard behavior)
        // Vault will pull amountOwed from this contract after callback returns
        // Use forceApprove for safe non-zero to non-zero approval handling
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
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @return expectedProfit Expected profit after fees (0 if unprofitable or invalid)
     * @return flashLoanFee Flash loan fee amount (0.3% of amount)
     *
     * @dev Simulates swaps using DEX router's getAmountsOut() without executing on-chain.
     *      Returns 0 for expectedProfit if path is invalid or unprofitable.
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // P3 Optimization: Query fee rate once per calculation
        // Query fee for 1e18 tokens to get the per-token fee rate, then scale for actual amount
        // This approach assumes linear fee structure (standard for EIP-3156 implementations)
        // and allows for consistent scaling across any amount size.
        // Typical SyncSwap fee: 0.3% (30 bps), but we always query to ensure accuracy
        //
        // Bug Fix (P1): Round up division to prevent underestimating fees for small amounts
        // Formula: (a * b + c - 1) / c rounds up instead of down
        // This ensures we never underestimate the fee required for repayment
        //
        // Note: Potential overflow for amounts near type(uint256).max / feeRate is prevented
        // by Solidity 0.8.19's built-in overflow protection (will revert if overflow occurs)
        uint256 feeRate = VAULT.flashFee(asset, 1e18);
        flashLoanFee = (amount * feeRate + 1e18 - 1) / 1e18;

        // Validate basic path requirements
        if (swapPath.length == 0 || swapPath[0].tokenIn != asset) {
            return (0, flashLoanFee);
        }

        uint256 currentAmount = amount;
        address currentToken = asset;
        address[] memory path = new address[](2);

        // Track visited tokens to detect cycles (Fix 4.4: P2 resilience improvement)
        address[] memory visitedTokens = new address[](swapPath.length + 1);
        visitedTokens[0] = asset;
        uint256 visitedCount = 1;

        // Simulate each swap
        for (uint256 i = 0; i < swapPath.length;) {
            SwapStep calldata step = swapPath[i];

            // Validate path continuity
            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee);
            }

            // Check for cycle: token appears twice before final step
            if (i < swapPath.length - 1) {
                for (uint256 j = 0; j < visitedCount; j++) {
                    if (visitedTokens[j] == step.tokenOut) {
                        return (0, flashLoanFee); // Cycle detected
                    }
                }
            }

            // Track visited token
            visitedTokens[visitedCount] = step.tokenOut;
            unchecked { ++visitedCount; }

            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            // Try to get amounts out (catches reverts from invalid pairs)
            try IDexRouter(step.router).getAmountsOut(currentAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
                currentToken = step.tokenOut;
            } catch {
                return (0, flashLoanFee);
            }

            unchecked { ++i; }
        }

        // Validate cycle completed (ends with start asset)
        if (currentToken != asset) {
            return (0, flashLoanFee);
        }

        // Calculate profit (if positive)
        uint256 amountOwed = amount + flashLoanFee;
        if (currentAmount > amountOwed) {
            expectedProfit = currentAmount - amountOwed;
        } else {
            expectedProfit = 0;
        }

        return (expectedProfit, flashLoanFee);
    }

    // Note: Router management, config, and emergency functions inherited from BaseFlashArbitrage
}

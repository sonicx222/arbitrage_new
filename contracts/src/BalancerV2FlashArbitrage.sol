// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IBalancerV2Vault.sol";
import "./interfaces/IFlashLoanReceiver.sol";

/**
 * @title BalancerV2FlashArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for executing profitable trades using Balancer V2 flash loans
 * @dev Implements IFlashLoanRecipient for Balancer V2 Vault integration
 *
 * Features:
 * - Balancer V2 flash loan integration (0% fee - no flash loan fees!)
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
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
 * @custom:version 1.0.0
 * @custom:implementation-plan Task 2.2 - Balancer V2 Flash Loan Provider
 */
contract BalancerV2FlashArbitrage is
    IFlashLoanRecipient,
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

    /// @notice The Balancer V2 Vault address for flash loans
    IBalancerV2Vault public immutable VAULT;

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

    error InvalidVaultAddress();
    error InvalidRouterAddress();
    error RouterAlreadyApproved();
    error RouterNotApproved();
    error EmptySwapPath();
    error InvalidSwapPath();
    error SwapPathAssetMismatch();
    error InsufficientProfit();
    error InvalidFlashLoanCaller();
    error SwapFailed();
    error InsufficientOutputAmount();
    error InsufficientSlippageProtection();
    error InvalidRecipient();
    error ETHTransferFailed();
    error InvalidSwapDeadline();
    error InvalidAmount();
    error TransactionTooOld();
    error MultiAssetNotSupported();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the BalancerV2FlashArbitrage contract
     * @param _vault The Balancer V2 Vault address
     * @param _owner The contract owner address
     */
    constructor(address _vault, address _owner) {
        if (_vault == address(0)) revert InvalidVaultAddress();

        // Verify vault is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_vault.code.length == 0) revert InvalidVaultAddress();

        VAULT = IBalancerV2Vault(_vault);
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
        // Validate amount is non-zero to prevent gas waste and ensure slippage protection
        if (amount == 0) revert InvalidAmount();

        // Validate transaction is not stale using user-specified deadline
        if (block.timestamp > deadline) revert TransactionTooOld();

        if (swapPath.length == 0) revert EmptySwapPath();

        // Validate first swap step starts with the flash-loaned asset
        if (swapPath[0].tokenIn != asset) revert SwapPathAssetMismatch();

        // Validate all routers in the path are approved
        // Cache validated routers to avoid redundant checks for repeated routers
        uint256 pathLength = swapPath.length;
        address lastValidatedRouter = address(0);

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // Skip validation if same router as previous step (common in triangular arb)
            if (step.router != lastValidatedRouter) {
                if (!_approvedRouters.contains(step.router)) revert RouterNotApproved();
                lastValidatedRouter = step.router;
            }

            // Enforce minimum slippage protection to prevent sandwich attacks
            if (step.amountOutMin == 0 && amount > 0) revert InsufficientSlippageProtection();

            unchecked { ++i; }
        }

        // Encode the swap path and minimum profit for the callback
        bytes memory userData = abi.encode(swapPath, minProfit);

        // Prepare flash loan parameters
        address[] memory tokens = new address[](1);
        tokens[0] = asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        // Initiate flash loan
        VAULT.flashLoan(
            IFlashLoanRecipient(this),
            tokens,
            amounts,
            userData
        );
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
        uint256 amountReceived = _executeSwaps(asset, amount, swapPath);

        // Calculate required repayment and profit
        uint256 amountOwed = amount + feeAmount; // feeAmount is 0, but kept for clarity
        if (amountReceived < amountOwed) revert InsufficientProfit();

        uint256 profit = amountReceived - amountOwed;

        // Verify minimum profit threshold
        uint256 _minimumProfit = minimumProfit;
        uint256 effectiveMinProfit = minProfit > _minimumProfit ? minProfit : _minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Update profit tracking
        totalProfits += profit;

        // Repay the flash loan by transferring tokens back to Vault
        // Balancer V2 checks its balance after the callback returns to verify repayment
        IERC20(asset).safeTransfer(address(VAULT), amountOwed);

        emit ArbitrageExecuted(asset, amount, profit, block.timestamp);
    }

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes multi-hop swaps according to the swap path
     * @dev Gas optimizations applied:
     *      - Pre-allocated path array reused across iterations (~200 gas/swap saved)
     *      - Configurable deadline instead of hardcoded value
     *      - Defense-in-depth output verification
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

            // Validate swap step (router already validated in executeArbitrage)
            if (step.tokenIn != currentToken) revert InvalidSwapPath();

            // Approve router to spend tokens
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
     * Note: Balancer V2 charges 0% flash loan fees, so the only costs are DEX swap fees
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
        // Balancer V2 has 0% flash loan fee
        flashLoanFee = 0;

        // Early validation - swapPath must start with the flash-loaned asset
        uint256 pathLength = swapPath.length;
        if (pathLength == 0 || swapPath[0].tokenIn != asset) {
            return (0, flashLoanFee);
        }

        // Simulate swaps to get expected output
        uint256 currentAmount = amount;
        address currentToken = asset;

        // Gas optimization: Pre-allocate path array once
        address[] memory path = new address[](2);

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee); // Invalid path
            }

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

        // Calculate profit (no flash loan fee for Balancer V2!)
        uint256 amountOwed = amount; // No fees!
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

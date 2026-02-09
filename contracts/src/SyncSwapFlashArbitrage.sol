// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/ISyncSwapVault.sol";
import "./interfaces/IDexRouter.sol";
import "./libraries/SwapHelpers.sol";

/**
 * @title SyncSwapFlashArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for zkSync Era using SyncSwap's EIP-3156 flash loans
 * @dev Implements IERC3156FlashBorrower for EIP-3156 compliant flash loan integration
 *
 * Features:
 * - SyncSwap flash loan integration (0.3% fee - competitive on zkSync Era)
 * - EIP-3156 standard compliance for interoperability
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * SyncSwap Flash Loan Characteristics:
 * - 0.3% (30 bps) flash loan fee
 * - EIP-3156 compliant callback interface
 * - Single Vault contract per chain (no pool discovery needed)
 * - Supports native ETH via address(0)
 * - Fee calculated on surplus balance after repayment
 *
 * Security Model:
 * - Only SyncSwap Vault can call onFlashLoan() callback
 * - Approved router system prevents malicious DEX interactions
 * - Initiator verification ensures callback initiated by this contract
 * - Returns correct EIP-3156 success hash
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 * @custom:implementation-plan Task 3.4 - SyncSwap Flash Loan Provider (zkSync Era)
 * @custom:standard EIP-3156 Flash Loans
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
    IERC3156FlashBorrower,
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

    /// @notice SyncSwap flash loan fee rate in basis points (0.3% = 30 bps)
    /// @dev SyncSwap charges 0.3% (30 bps) for flash loans on zkSync Era
    uint256 private constant SYNCSWAP_FEE_BPS = 30;

    /// @notice Denominator for basis points calculations (10000 bps = 100%)
    uint256 private constant BPS_DENOMINATOR = 10000;

    /// @notice EIP-3156 success return value
    /// @dev Must return this exact value from onFlashLoan() to signal success
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The SyncSwap Vault address for flash loans
    ISyncSwapVault public immutable VAULT;

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
    error PathTooLong(uint256 provided, uint256 max);
    error InvalidSwapPath();
    error SwapPathAssetMismatch();
    error InsufficientProfit();
    error InvalidFlashLoanCaller();
    error InvalidInitiator();
    error SwapFailed();
    error InsufficientOutputAmount();
    error InsufficientSlippageProtection();
    error InvalidRecipient();
    error ETHTransferFailed();
    error InvalidSwapDeadline();
    error InvalidAmount();
    error TransactionTooOld();
    error FlashLoanFailed();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the SyncSwapFlashArbitrage contract
     * @param _vault The SyncSwap Vault address
     * @param _owner The contract owner address
     */
    constructor(address _vault, address _owner) {
        if (_vault == address(0)) revert InvalidVaultAddress();

        // Verify vault is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_vault.code.length == 0) revert InvalidVaultAddress();

        VAULT = ISyncSwapVault(_vault);
        swapDeadline = DEFAULT_SWAP_DEADLINE;
        _transferOwnership(_owner);
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

        // Validate all routers in the path are approved
        // Cache validated routers to avoid redundant checks for repeated routers
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

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes a multi-hop swap path
     * @dev Uses SwapHelpers library for shared swap logic (DRY principle)
     *      Gas optimizations: pre-allocated path array, cached deadline
     * @param startAsset The initial asset (flash loan asset)
     * @param startAmount The initial amount (flash loan amount)
     * @param swapPath Array of swap steps to execute
     * @return finalAmount The final amount received after all swaps
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
        // Calculate flash loan fee (0.3% = 30 bps)
        flashLoanFee = (amount * SYNCSWAP_FEE_BPS) / BPS_DENOMINATOR;

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

    /**
     * @notice Check if a router is approved
     * @param router The router address to check
     * @return True if router is approved
     */
    function isApprovedRouter(address router) external view returns (bool) {
        return _approvedRouters.contains(router);
    }

    /**
     * @notice Get all approved routers
     * @return Array of approved router addresses
     * @dev Uses EnumerableSet.values() for gas efficiency (avoids manual loop)
     */
    function getApprovedRouters() external view returns (address[] memory) {
        return _approvedRouters.values();
    }

    /**
     * @notice Get count of approved routers
     * @return Number of approved routers
     */
    function approvedRouterCount() external view returns (uint256) {
        return _approvedRouters.length();
    }

    // ==========================================================================
    // External Functions - Admin (OnlyOwner)
    // ==========================================================================

    /**
     * @notice Add a router to the approved list
     * @param router The router address to approve
     */
    function addApprovedRouter(address router) external onlyOwner {
        if (router == address(0)) revert InvalidRouterAddress();

        // EnumerableSet.add() returns false if element already exists
        // More gas-efficient than separate contains() call (~2,100 gas saved)
        if (!_approvedRouters.add(router)) revert RouterAlreadyApproved();

        emit RouterAdded(router);
    }

    /**
     * @notice Remove a router from the approved list
     * @param router The router address to remove
     */
    function removeApprovedRouter(address router) external onlyOwner {
        if (!_approvedRouters.contains(router)) revert RouterNotApproved();

        _approvedRouters.remove(router);
        emit RouterRemoved(router);
    }

    /**
     * @notice Set minimum profit threshold
     * @param _minimumProfit New minimum profit value (in token units)
     */
    function setMinimumProfit(uint256 _minimumProfit) external onlyOwner {
        uint256 oldValue = minimumProfit;
        minimumProfit = _minimumProfit;
        emit MinimumProfitUpdated(oldValue, _minimumProfit);
    }

    /**
     * @notice Set swap deadline
     * @param _swapDeadline New swap deadline in seconds
     */
    function setSwapDeadline(uint256 _swapDeadline) external onlyOwner {
        if (_swapDeadline == 0 || _swapDeadline > MAX_SWAP_DEADLINE) {
            revert InvalidSwapDeadline();
        }

        uint256 oldValue = swapDeadline;
        swapDeadline = _swapDeadline;
        emit SwapDeadlineUpdated(oldValue, _swapDeadline);
    }

    /**
     * @notice Pause contract (emergency)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Withdraw ERC20 tokens from contract
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to withdraw
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
     * @notice Withdraw ETH from contract
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();

        (bool success, ) = to.call{value: amount}("");
        if (!success) revert ETHTransferFailed();

        emit ETHWithdrawn(to, amount);
    }

    // ==========================================================================
    // Receive ETH
    // ==========================================================================

    /// @notice Allow contract to receive ETH (for native token arbitrage)
    receive() external payable {}
}

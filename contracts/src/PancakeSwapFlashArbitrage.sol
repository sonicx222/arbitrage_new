// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IPancakeV3FlashCallback.sol";
import "./interfaces/IFlashLoanReceiver.sol"; // For IDexRouter
import "./libraries/SwapHelpers.sol";

/**
 * @title PancakeSwapFlashArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for executing profitable trades using PancakeSwap V3 flash swaps
 * @dev Implements IPancakeV3FlashCallback for PancakeSwap V3 integration
 *
 * Features:
 * - PancakeSwap V3 flash swap integration (pool-specific fees: 0.01%, 0.05%, 0.25%, 1%)
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 * - Pool whitelist security (prevents malicious pool callbacks)
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 *
 * @custom:warning UNSUPPORTED TOKEN TYPES
 * This contract does NOT support:
 * - Fee-on-transfer tokens: Tokens that deduct fees during transfer will cause
 *   InsufficientProfit errors because received amounts don't match expected amounts.
 * - Rebasing tokens: Tokens that change balance over time may cause repayment failures
 *   if balance decreases mid-transaction.
 * Using these token types will result in failed transactions and wasted gas.
 *
 * ## Supported Chains
 * - BSC (Binance Smart Chain)
 * - Ethereum
 * - Arbitrum
 * - zkSync Era
 * - Base
 * - opBNB
 * - Linea
 *
 * ## Architecture Notes
 * PancakeSwap V3 uses a different flash loan mechanism than Aave V3:
 * - Callback: pancakeV3FlashCallback(fee0, fee1, data) instead of executeOperation()
 * - Pool-specific fees: 100, 500, 2500, 10000 bps (vs Aave's fixed 9 bps)
 * - Security: Must verify callback caller is a whitelisted PancakeSwap V3 pool
 * - Fees paid at end of transaction, not pulled by pool
 *
 * @custom:audit-status Pending
 */
contract PancakeSwapFlashArbitrage is
    IPancakeV3FlashCallback,
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

    /// @notice Denominator for basis points calculations (10000 bps = 100%)
    uint256 private constant BPS_DENOMINATOR = 10000;

    /// @notice Maximum number of pools that can be whitelisted in a single batch operation
    /// @dev I2 Fix: Prevents potential DoS from extremely large batch operations
    /// @dev Practical limit: 100 pools ~ 5M gas, well within block limit (~30M gas)
    uint256 public constant MAX_BATCH_WHITELIST = 100;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The PancakeSwap V3 Factory address for pool verification
    IPancakeV3Factory public immutable FACTORY;

    /// @notice Minimum profit required for arbitrage execution (in token units)
    uint256 public minimumProfit;

    /// @notice Total profits accumulated (for tracking)
    uint256 public totalProfits;

    /// @notice Configurable swap deadline in seconds (default: 300 = 5 minutes)
    uint256 public swapDeadline;

    /// @notice Set of approved DEX routers (O(1) add/remove/contains)
    /// @dev Uses EnumerableSet for gas-efficient operations and enumeration
    EnumerableSet.AddressSet private _approvedRouters;

    /// @notice Set of whitelisted PancakeSwap V3 pools (O(1) add/remove/contains)
    /// @dev Critical security: Only whitelisted pools can call pancakeV3FlashCallback
    EnumerableSet.AddressSet private _whitelistedPools;

    /// @notice Temporary storage for flash loan context (cleared after callback)
    /// @dev Used to pass context from executeArbitrage to pancakeV3FlashCallback
    FlashLoanContext private _flashContext;

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

    /**
     * @notice Flash loan context passed from executeArbitrage to callback
     * @dev Stored temporarily in contract storage, cleared after callback
     */
    struct FlashLoanContext {
        address asset;           // The flash-loaned asset
        uint256 amount;          // The flash-loaned amount
        uint256 minProfit;       // Minimum required profit
        bool active;             // Whether a flash loan is active (reentrancy check)
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

    /// @notice Emitted when a pool is whitelisted
    event PoolWhitelisted(address indexed pool);

    /// @notice Emitted when a pool is removed from whitelist
    event PoolRemovedFromWhitelist(address indexed pool);

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

    error InvalidFactoryAddress();
    error InvalidRouterAddress();
    error InvalidPoolAddress();
    error RouterAlreadyApproved();
    error RouterNotApproved();
    error PoolAlreadyWhitelisted();
    error PoolNotWhitelisted();
    error EmptySwapPath();
    error EmptyPoolsArray();
    error PathTooLong(uint256 provided, uint256 max);
    error InvalidSwapPath();
    error SwapPathAssetMismatch();
    error InsufficientProfit();
    error InvalidFlashLoanCaller();
    error FlashLoanNotActive();
    error FlashLoanAlreadyActive();
    error SwapFailed();
    error InsufficientOutputAmount();
    error InsufficientSlippageProtection();
    error InvalidRecipient();
    error ETHTransferFailed();
    error InvalidSwapDeadline();
    error InvalidAmount();
    error TransactionTooOld();
    error PoolNotFound();
    error PoolNotFromFactory();
    error InsufficientPoolLiquidity();
    error BatchTooLarge(uint256 requested, uint256 maximum);

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the PancakeSwapFlashArbitrage contract
     * @param _factory The PancakeSwap V3 Factory address for pool verification
     * @param _owner The contract owner address
     */
    constructor(address _factory, address _owner) {
        if (_factory == address(0)) revert InvalidFactoryAddress();

        // Verify factory is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_factory.code.length == 0) revert InvalidFactoryAddress();

        FACTORY = IPancakeV3Factory(_factory);
        swapDeadline = DEFAULT_SWAP_DEADLINE;
        _transferOwnership(_owner);
    }

    // ==========================================================================
    // External Functions - Arbitrage Execution
    // ==========================================================================

    /**
     * @notice Executes a flash loan arbitrage using PancakeSwap V3 flash swaps
     * @dev This function initiates the flash loan on the PancakeSwap V3 pool
     * @param pool The PancakeSwap V3 pool address to use for flash loan
     * @param asset The asset to flash loan (must be token0 or token1 of the pool)
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @param minProfit Minimum required profit (reverts if not achieved)
     * @param deadline Absolute deadline (block.timestamp) - reverts if current block is after deadline
     */
    function executeArbitrage(
        address pool,
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        // Validate amount is non-zero to prevent gas waste
        if (amount == 0) revert InvalidAmount();

        // Validate transaction is not stale using user-specified deadline
        if (block.timestamp > deadline) revert TransactionTooOld();

        // C4 Fix: Validate pool is not zero address (clearer error, gas optimization)
        if (pool == address(0)) revert InvalidPoolAddress();

        // Validate pool is whitelisted (security critical)
        if (!_whitelistedPools.contains(pool)) revert PoolNotWhitelisted();

        uint256 pathLength = swapPath.length;
        if (pathLength == 0) revert EmptySwapPath();

        // Prevent DoS via excessive gas consumption
        if (pathLength > MAX_SWAP_HOPS) revert PathTooLong(pathLength, MAX_SWAP_HOPS);

        // Validate first swap step starts with the flash-loaned asset
        if (swapPath[0].tokenIn != asset) revert SwapPathAssetMismatch();

        // Validate all routers in the path are approved (O(1) lookup via EnumerableSet)
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

        // Verify flash loan is not already active (reentrancy protection)
        if (_flashContext.active) revert FlashLoanAlreadyActive();

        // Store flash loan context for callback
        _flashContext = FlashLoanContext({
            asset: asset,
            amount: amount,
            minProfit: minProfit,
            active: true
        });

        // Encode the swap path for the callback
        bytes memory data = abi.encode(swapPath);

        // Determine which token is token0 and which is token1 in the pool
        IPancakeV3Pool poolContract = IPancakeV3Pool(pool);
        address token0 = poolContract.token0();
        address token1 = poolContract.token1();

        // SECURITY FIX: Verify pool is legitimate PancakeSwap V3 pool (defense in depth)
        // Whitelist provides first layer of security, factory verification provides second layer
        // Protects against whitelisting malicious contracts that implement IPancakeV3Pool interface
        uint24 fee = poolContract.fee();
        address verifiedPool = FACTORY.getPool(token0, token1, fee);
        if (verifiedPool != pool) revert PoolNotFromFactory();

        // Check pool has active liquidity (fail-fast optimization)
        // Zero liquidity indicates inactive/newly created pool
        // Flash loan would revert anyway, but this provides clearer error
        uint128 poolLiquidity = poolContract.liquidity();
        if (poolLiquidity == 0) revert InsufficientPoolLiquidity();

        uint256 amount0;
        uint256 amount1;

        if (asset == token0) {
            amount0 = amount;
            amount1 = 0;
        } else if (asset == token1) {
            amount0 = 0;
            amount1 = amount;
        } else {
            revert InvalidSwapPath(); // Asset must be token0 or token1
        }

        // Initiate flash loan
        poolContract.flash(address(this), amount0, amount1, data);

        // Clear flash loan context after successful execution
        delete _flashContext;
    }

    /**
     * @notice Callback function called by PancakeSwap V3 Pool during flash loan
     * @dev Must repay loan + fee to the pool for success
     * @param fee0 The fee amount in token0 due to the pool
     * @param fee1 The fee amount in token1 due to the pool
     * @param data Encoded swap path
     */
    function pancakeV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // Security: Verify caller is a whitelisted PancakeSwap V3 pool
        if (!_whitelistedPools.contains(msg.sender)) revert InvalidFlashLoanCaller();

        // Security: Verify flash loan is active (prevents direct calls)
        if (!_flashContext.active) revert FlashLoanNotActive();

        // Load flash context from storage
        FlashLoanContext memory context = _flashContext;

        // Decode swap path
        SwapStep[] memory swapPath = abi.decode(data, (SwapStep[]));

        // Determine the fee amount based on which asset was borrowed
        IPancakeV3Pool pool = IPancakeV3Pool(msg.sender);
        address token0 = pool.token0();
        uint256 feeAmount = (context.asset == token0) ? fee0 : fee1;

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(context.asset, context.amount, swapPath);

        // Calculate required repayment and profit
        uint256 amountOwed = context.amount + feeAmount;
        if (amountReceived < amountOwed) revert InsufficientProfit();

        uint256 profit = amountReceived - amountOwed;

        // Verify minimum profit threshold (cache storage read)
        uint256 _minimumProfit = minimumProfit;
        uint256 effectiveMinProfit = context.minProfit > _minimumProfit ? context.minProfit : _minimumProfit;
        if (profit < effectiveMinProfit) revert InsufficientProfit();

        // Update profit tracking
        totalProfits += profit;

        // Repay the pool (transfer back the borrowed amount + fee)
        IERC20(context.asset).safeTransfer(msg.sender, amountOwed);

        emit ArbitrageExecuted(context.asset, context.amount, profit, block.timestamp);
    }

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes multi-hop swaps according to the swap path
     * @dev Uses SwapHelpers library for shared swap logic (DRY principle)
     *      Gas optimizations: pre-allocated path array, cached deadline
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
    // Admin Functions - Pool Management
    // ==========================================================================

    /**
     * @notice Whitelists a PancakeSwap V3 pool
     * @dev Only whitelisted pools can call pancakeV3FlashCallback (security critical)
     * @param pool The pool address to whitelist
     */
    function whitelistPool(address pool) external onlyOwner {
        if (pool == address(0)) revert InvalidPoolAddress();
        if (!_whitelistedPools.add(pool)) revert PoolAlreadyWhitelisted();

        emit PoolWhitelisted(pool);
    }

    /**
     * @notice Batch whitelists multiple PancakeSwap V3 pools
     * @dev Gas-efficient alternative to calling whitelistPool() multiple times
     * @dev Skips pools that are already whitelisted (no revert on duplicates)
     * @dev Critical for deployment: whitelist common pools atomically with contract deployment
     * @param pools Array of pool addresses to whitelist
     * @return successCount Number of pools successfully added (excludes duplicates)
     *
     * Security: Owner-only, validates each address is non-zero
     * Gas optimization: Single transaction for multiple pools
     *
     * Task 2.1 (C4): Batch whitelist management for efficient deployment
     */
    function whitelistMultiplePools(address[] calldata pools)
        external
        onlyOwner
        returns (uint256 successCount)
    {
        uint256 length = pools.length;
        if (length == 0) revert EmptyPoolsArray();

        // I2 Fix: Enforce maximum batch size to prevent potential DoS
        // Defense in depth: Owner is trusted, but explicit limits improve auditability
        if (length > MAX_BATCH_WHITELIST) {
            revert BatchTooLarge(length, MAX_BATCH_WHITELIST);
        }

        for (uint256 i = 0; i < length; ) {
            address pool = pools[i];

            // Validate address (skip zero addresses instead of reverting entire batch)
            if (pool != address(0)) {
                // Try to add pool (returns false if already exists)
                bool added = _whitelistedPools.add(pool);
                if (added) {
                    emit PoolWhitelisted(pool);
                    unchecked {
                        ++successCount;
                    }
                }
                // Note: Silently skip duplicates for idempotent batch operations
            }

            unchecked {
                ++i;
            }
        }

        // Return success count for caller verification
        return successCount;
    }

    /**
     * @notice Removes a pool from the whitelist
     * @dev O(1) complexity using EnumerableSet
     * @param pool The pool address to remove
     */
    function removePoolFromWhitelist(address pool) external onlyOwner {
        if (!_whitelistedPools.remove(pool)) revert PoolNotWhitelisted();

        emit PoolRemovedFromWhitelist(pool);
    }

    /**
     * @notice Checks if a pool is whitelisted
     * @dev O(1) complexity using EnumerableSet
     * @param pool The pool address to check
     * @return True if pool is whitelisted
     */
    function isPoolWhitelisted(address pool) external view returns (bool) {
        return _whitelistedPools.contains(pool);
    }

    /**
     * @notice Returns all whitelisted pools
     * @return Array of whitelisted pool addresses
     */
    function getWhitelistedPools() external view returns (address[] memory) {
        return _whitelistedPools.values();
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
     * @param pool The PancakeSwap V3 pool address
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The flash loan fee
     */
    function calculateExpectedProfit(
        address pool,
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Get pool fee
        IPancakeV3Pool poolContract = IPancakeV3Pool(pool);
        uint24 feeTier = poolContract.fee();

        // Calculate flash loan fee
        // Fee is calculated as: amount * feeTier / 1e6
        // feeTier is in hundredths of a bip (e.g., 2500 = 0.25% = 2500/1e6)
        flashLoanFee = (amount * feeTier) / 1e6;

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

        // Track visited tokens to detect cycles (Fix 4.4: P2 resilience improvement)
        address[] memory visitedTokens = new address[](pathLength + 1);
        visitedTokens[0] = asset;
        uint256 visitedCount = 1;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee); // Invalid path
            }

            // Check for cycle: token appears twice before final step
            if (i < pathLength - 1) {
                for (uint256 j = 0; j < visitedCount; j++) {
                    if (visitedTokens[j] == step.tokenOut) {
                        return (0, flashLoanFee); // Cycle detected
                    }
                }
            }

            // Track visited token
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

    // ==========================================================================
    // Receive Function
    // ==========================================================================

    /**
     * @notice Allows the contract to receive ETH
     */
    receive() external payable {}
}

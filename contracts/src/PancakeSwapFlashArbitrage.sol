// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IPancakeV3FlashCallback.sol";
import "./interfaces/IFlashLoanErrors.sol";
import "./interfaces/IDexRouter.sol"; // Used by calculateExpectedProfit() for getAmountsOut()

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
 * - Calldata-based context passing (gas-optimized, no storage for flash context)
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.1.0
 *
 * ## Changelog v2.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage (eliminates 350+ lines of duplicate code)
 * - Moved common functionality to base contract
 * - No behavioral changes, pure refactoring for maintainability
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
 * - Pool-specific fees: 100, 500, 2500, 10000 (hundredths of a bip, i.e., 1e-6)
 *   → 0.01%, 0.05%, 0.25%, 1.00% respectively (vs Aave's fixed 0.09%)
 * - Security: Must verify callback caller is a whitelisted PancakeSwap V3 pool
 * - Fees paid at end of transaction, not pulled by pool
 *
 * @custom:audit-status Pending
 */
contract PancakeSwapFlashArbitrage is
    BaseFlashArbitrage,
    IPancakeV3FlashCallback,
    IFlashLoanErrors
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ==========================================================================
    // Constants (Protocol-Specific)
    // ==========================================================================

    /// @notice Maximum number of pools that can be whitelisted in a single batch operation
    /// @dev I2 Fix: Prevents potential DoS from extremely large batch operations
    /// @dev Practical limit: 100 pools ~ 5M gas, well within block limit (~30M gas)
    uint256 public constant MAX_BATCH_WHITELIST = 100;

    // ==========================================================================
    // State Variables (Protocol-Specific)
    // ==========================================================================

    /// @notice The PancakeSwap V3 Factory address for pool verification
    IPancakeV3Factory public immutable FACTORY;

    /// @notice Set of whitelisted PancakeSwap V3 pools (O(1) add/remove/contains)
    /// @dev Critical security: Only whitelisted pools can call pancakeV3FlashCallback
    EnumerableSet.AddressSet private _whitelistedPools;

    // ==========================================================================
    // Events (Protocol-Specific)
    // ==========================================================================

    /// @notice Emitted when a pool is whitelisted
    event PoolWhitelisted(address indexed pool);

    /// @notice Emitted when a pool is removed from whitelist
    event PoolRemovedFromWhitelist(address indexed pool);

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    // InvalidProtocolAddress, InvalidFlashLoanCaller inherited from IFlashLoanErrors
    error PoolAlreadyWhitelisted();
    error PoolNotWhitelisted();
    error EmptyPoolsArray();
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
    constructor(address _factory, address _owner) BaseFlashArbitrage(_owner) {
        if (_factory == address(0)) revert InvalidProtocolAddress();

        // Verify factory is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_factory.code.length == 0) revert InvalidProtocolAddress();

        FACTORY = IPancakeV3Factory(_factory);
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
        // P1: Use base contract validation (eliminates duplicate code)
        _validateArbitrageParams(asset, amount, deadline, swapPath);

        // Protocol-specific validations
        // C4 Fix: Validate pool is not zero address (clearer error, gas optimization)
        if (pool == address(0)) revert InvalidProtocolAddress();

        // Validate pool is whitelisted (security critical)
        if (!_whitelistedPools.contains(pool)) revert PoolNotWhitelisted();

        // Encode the full flash loan context in calldata (gas optimization)
        // Context is passed via the data parameter instead of using storage slots,
        // saving ~20k gas per execution (avoids SSTORE/SLOAD/SSTORE-zero).
        // This matches the pattern used by FlashLoanArbitrage and BalancerV2FlashArbitrage.
        bytes memory data = abi.encode(swapPath, asset, amount, minProfit);

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
    }

    /**
     * @notice Callback function called by PancakeSwap V3 Pool during flash loan
     * @dev Must repay loan + fee to the pool for success
     * @param fee0 The fee amount in token0 due to the pool
     * @param fee1 The fee amount in token1 due to the pool
     * @param data Encoded swap path, asset, amount, and minProfit
     */
    function pancakeV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // Security: Verify caller is a whitelisted PancakeSwap V3 pool
        if (!_whitelistedPools.contains(msg.sender)) revert InvalidFlashLoanCaller();

        // Decode flash loan context from calldata (gas optimization over storage)
        (SwapStep[] memory swapPath, address asset, uint256 amount, uint256 minProfit) =
            abi.decode(data, (SwapStep[], address, uint256, uint256));

        // Determine the fee amount based on which asset was borrowed
        IPancakeV3Pool pool = IPancakeV3Pool(msg.sender);
        address token0 = pool.token0();
        uint256 feeAmount = (asset == token0) ? fee0 : fee1;

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(asset, amount, swapPath, _getSwapDeadline());

        // Calculate required repayment and profit
        uint256 amountOwed = amount + feeAmount;
        if (amountReceived < amountOwed) revert InsufficientProfit();

        uint256 profit = amountReceived - amountOwed;

        // Verify profit meets thresholds and update tracking (base contract)
        _verifyAndTrackProfit(profit, minProfit, asset);

        // Repayment: PUSH pattern - we transfer tokens directly to pool
        // PancakeSwap V3 checks pool balance after callback to verify repayment
        IERC20(asset).safeTransfer(msg.sender, amountOwed);

        emit ArbitrageExecuted(asset, amount, profit, block.timestamp, tx.origin);
    }

    // Note: _executeSwaps and router management functions inherited from BaseFlashArbitrage

    // ==========================================================================
    // Admin Functions - Pool Management
    // ==========================================================================

    /**
     * @notice Whitelists a PancakeSwap V3 pool
     * @dev Only whitelisted pools can call pancakeV3FlashCallback (security critical)
     * @param pool The pool address to whitelist
     */
    function whitelistPool(address pool) external onlyOwner {
        if (pool == address(0)) revert InvalidProtocolAddress();
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

    // Note: Config and emergency functions inherited from BaseFlashArbitrage

    // ==========================================================================
    // View Functions
    // ==========================================================================

    /**
     * @notice Calculates the expected profit for an arbitrage opportunity
     * @dev Simulates swaps via DEX router getAmountsOut() without executing.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage.
     *
     * @param pool The PancakeSwap V3 pool address (for fee tier query)
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The PancakeSwap V3 flash loan fee (pool fee tier dependent)
     */
    function calculateExpectedProfit(
        address pool,
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // PancakeSwap V3 fee: (amount * feeTier) / 1e6
        // feeTier is in hundredths of a bip (e.g., 2500 = 0.25%)
        uint24 feeTier = IPancakeV3Pool(pool).fee();
        flashLoanFee = (amount * feeTier) / 1e6;

        uint256 simulatedOutput = _simulateSwapPath(asset, amount, swapPath);
        if (simulatedOutput == 0) {
            return (0, flashLoanFee);
        }

        expectedProfit = _calculateProfit(amount, simulatedOutput, flashLoanFee);
        return (expectedProfit, flashLoanFee);
    }
}

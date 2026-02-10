// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ArbitrageConstants
 * @author Arbitrage System
 * @notice Shared constants used across flash loan arbitrage contracts
 * @dev Extracted from individual contracts to reduce duplication (DRY principle)
 *
 * ## Usage
 * Import this library in your contract and reference constants:
 * ```solidity
 * import "./libraries/ArbitrageConstants.sol";
 *
 * contract MyArbitrage {
 *     function execute() external {
 *         uint256 deadline = block.timestamp + ArbitrageConstants.DEFAULT_SWAP_DEADLINE;
 *         // ...
 *     }
 * }
 * ```
 *
 * ## Rationale
 * These constants were duplicated across:
 * - FlashLoanArbitrage.sol
 * - PancakeSwapFlashArbitrage.sol
 * - BalancerV2FlashArbitrage.sol
 * - SyncSwapFlashArbitrage.sol
 * - CommitRevealArbitrage.sol
 *
 * Total reduction: ~50 lines of duplicate code
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 */
library ArbitrageConstants {
    // ==========================================================================
    // Timing Constants
    // ==========================================================================

    /// @notice Default swap deadline in seconds (5 minutes)
    /// @dev Used when no deadline is specified or as reasonable default
    uint256 internal constant DEFAULT_SWAP_DEADLINE = 300;

    /// @notice Maximum swap deadline in seconds (1 hour)
    /// @dev Prevents stale transactions from being executed far in the future
    /// @dev Configurable deadline must be <= now + MAX_SWAP_DEADLINE
    uint256 internal constant MAX_SWAP_DEADLINE = 3600;

    // ==========================================================================
    // Slippage Constants
    // ==========================================================================

    /// @notice Minimum slippage protection in basis points (0.1%)
    /// @dev Ensures amountOutMin is at least 99.9% of expected output
    /// @dev Lower values increase risk of sandwich attacks
    uint256 internal constant MIN_SLIPPAGE_BPS = 10;

    /// @notice Maximum slippage tolerance in basis points (5%)
    /// @dev Prevents excessive slippage that could indicate misconfiguration
    uint256 internal constant MAX_SLIPPAGE_BPS = 500;

    // ==========================================================================
    // Path Validation Constants
    // ==========================================================================

    /// @notice Maximum number of hops in a swap path
    /// @dev Prevents DoS via gas exhaustion
    /// @dev 5 hops = ~700k gas (within block gas limit for most chains)
    /// @dev Each additional hop adds ~140k gas
    uint256 internal constant MAX_SWAP_HOPS = 5;

    /// @notice Minimum number of hops in a swap path
    /// @dev Arbitrage requires at least 2 swaps (buy + sell)
    uint256 internal constant MIN_SWAP_HOPS = 2;

    // ==========================================================================
    // Basis Points Constants
    // ==========================================================================

    /// @notice Denominator for basis points calculations (10000 bps = 100%)
    /// @dev Used for fee calculations, slippage, and percentage operations
    /// @dev Example: 30 bps = 30/10000 = 0.003 = 0.3%
    uint256 internal constant BPS_DENOMINATOR = 10000;

    /// @notice Maximum basis points value (100%)
    /// @dev Used for validation to ensure percentages don't exceed 100%
    uint256 internal constant MAX_BPS = 10000;

    // ==========================================================================
    // Gas Optimization Constants
    // ==========================================================================

    /// @notice Typical gas cost for ERC20 transfer
    /// @dev Used for gas estimation and profitability calculations
    uint256 internal constant GAS_TRANSFER = 65000;

    /// @notice Typical gas cost for ERC20 approval
    /// @dev Used for gas estimation
    uint256 internal constant GAS_APPROVAL = 46000;

    /// @notice Typical gas cost for Uniswap V2 swap
    /// @dev Used for gas estimation
    uint256 internal constant GAS_SWAP_V2 = 140000;

    /// @notice Typical gas cost for Uniswap V3 swap
    /// @dev Used for gas estimation
    uint256 internal constant GAS_SWAP_V3 = 180000;
}

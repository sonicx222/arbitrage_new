// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Constants
 * @author Arbitrage System
 * @notice Shared constants for flash loan arbitrage contracts
 * @dev Fix 9.1: Extracted constants to a separate file for reuse
 *
 * This library provides centralized constants that can be imported by
 * FlashLoanArbitrage and any future contracts in the system.
 */
library Constants {
    // ==========================================================================
    // Swap Configuration
    // ==========================================================================

    /// @notice Default swap deadline (5 minutes)
    /// @dev Added to block.timestamp for DEX swap deadline parameter
    uint256 internal constant DEFAULT_SWAP_DEADLINE = 300;

    /// @notice Maximum swap deadline (1 hour)
    /// @dev Prevents stale transactions that could be exploited
    uint256 internal constant MAX_SWAP_DEADLINE = 3600;

    /// @notice Minimum slippage protection (0.1% = 10 basis points)
    /// @dev Prevents callers from setting amountOutMin = 0 (sandwich attack vector)
    uint256 internal constant MIN_SLIPPAGE_BPS = 10;

    // ==========================================================================
    // Flash Loan Configuration
    // ==========================================================================

    /// @notice Aave V3 flash loan fee in basis points (0.09% = 9 bps)
    /// @dev Used for fee calculations: feeAmount = amount * FEE_BPS / BPS_DENOMINATOR
    uint256 internal constant AAVE_V3_FEE_BPS = 9;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 internal constant BPS_DENOMINATOR = 10000;

    // ==========================================================================
    // Gas Limits
    // ==========================================================================

    /// @notice Maximum expected gas for 2-hop arbitrage
    /// @dev Used for gas estimation and profitability calculations
    uint256 internal constant MAX_2HOP_GAS = 500000;

    /// @notice Maximum expected gas for 3-hop arbitrage
    uint256 internal constant MAX_3HOP_GAS = 700000;

    // ==========================================================================
    // Path Limits
    // ==========================================================================

    /// @notice Maximum number of hops in a swap path
    /// @dev Prevents excessive gas consumption from very long paths
    uint256 internal constant MAX_SWAP_HOPS = 5;
}

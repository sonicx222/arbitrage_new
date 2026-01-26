// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title SwapPathValidator
 * @author Arbitrage System
 * @notice Library for validating swap paths in flash loan arbitrage
 * @dev Fix 9.4: Extracted validation logic for reusability and clarity
 *
 * Provides validation functions that can be used by FlashLoanArbitrage
 * and any future arbitrage contracts.
 */
library SwapPathValidator {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ==========================================================================
    // Structs (must match FlashLoanArbitrage.SwapStep)
    // ==========================================================================

    /**
     * @notice Represents a single swap step in the arbitrage path
     * @dev Matches the struct defined in FlashLoanArbitrage for compatibility
     */
    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin;
    }

    // ==========================================================================
    // Errors
    // ==========================================================================

    error EmptySwapPath();
    error SwapPathAssetMismatch(address expected, address actual);
    error RouterNotApproved(address router);
    error InsufficientSlippageProtection(uint256 hopIndex);
    error InvalidTokenContinuity(uint256 hopIndex, address expected, address actual);
    error PathDoesNotReturnToAsset(address expected, address actual);
    error PathTooLong(uint256 length, uint256 maxLength);

    // ==========================================================================
    // Validation Functions
    // ==========================================================================

    /**
     * @notice Validates that a swap path is valid for flash loan arbitrage
     * @dev Performs all pre-execution validations in a single call
     *
     * Validations performed:
     * 1. Path is not empty
     * 2. Path doesn't exceed maximum length
     * 3. First hop starts with the flash-loaned asset
     * 4. All routers in the path are approved
     * 5. Token continuity (each hop's tokenIn matches previous hop's tokenOut)
     * 6. Slippage protection is set (amountOutMin > 0)
     * 7. Path ends with the original asset (for repayment)
     *
     * @param swapPath Array of swap steps
     * @param asset The flash-loaned asset address
     * @param approvedRouters EnumerableSet of approved router addresses
     * @param maxHops Maximum allowed hops (use 0 for no limit)
     */
    function validateSwapPath(
        SwapStep[] calldata swapPath,
        address asset,
        EnumerableSet.AddressSet storage approvedRouters,
        uint256 maxHops
    ) internal view {
        uint256 pathLength = swapPath.length;

        // 1. Check path is not empty
        if (pathLength == 0) revert EmptySwapPath();

        // 2. Check path length limit
        if (maxHops > 0 && pathLength > maxHops) {
            revert PathTooLong(pathLength, maxHops);
        }

        // 3. Check first hop starts with asset
        if (swapPath[0].tokenIn != asset) {
            revert SwapPathAssetMismatch(asset, swapPath[0].tokenIn);
        }

        // Cache for router validation optimization
        address lastValidatedRouter = address(0);
        address expectedTokenIn = asset;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // 4. Validate router is approved (skip if same as last)
            if (step.router != lastValidatedRouter) {
                if (!approvedRouters.contains(step.router)) {
                    revert RouterNotApproved(step.router);
                }
                lastValidatedRouter = step.router;
            }

            // 5. Validate token continuity
            if (step.tokenIn != expectedTokenIn) {
                revert InvalidTokenContinuity(i, expectedTokenIn, step.tokenIn);
            }

            // 6. Validate slippage protection
            if (step.amountOutMin == 0) {
                revert InsufficientSlippageProtection(i);
            }

            // Update expected tokenIn for next hop
            expectedTokenIn = step.tokenOut;

            unchecked { ++i; }
        }

        // 7. Validate path returns to original asset
        if (expectedTokenIn != asset) {
            revert PathDoesNotReturnToAsset(asset, expectedTokenIn);
        }
    }

    /**
     * @notice Validates only router approval for a swap path
     * @dev Lighter weight validation for gas estimation scenarios
     *
     * @param swapPath Array of swap steps
     * @param approvedRouters EnumerableSet of approved router addresses
     */
    function validateRouters(
        SwapStep[] calldata swapPath,
        EnumerableSet.AddressSet storage approvedRouters
    ) internal view {
        uint256 pathLength = swapPath.length;
        address lastValidatedRouter = address(0);

        for (uint256 i = 0; i < pathLength;) {
            address router = swapPath[i].router;

            if (router != lastValidatedRouter) {
                if (!approvedRouters.contains(router)) {
                    revert RouterNotApproved(router);
                }
                lastValidatedRouter = router;
            }

            unchecked { ++i; }
        }
    }
}

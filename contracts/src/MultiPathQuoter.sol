// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IFlashLoanReceiver.sol";

/**
 * @title MultiPathQuoter
 * @author Arbitrage System
 * @notice Batches getAmountsOut() calls for multiple swap paths in a single RPC call
 * @dev Reduces latency for MEV-competitive environments by eliminating sequential RPC calls
 *
 * ## Performance Impact
 * - Before: N sequential RPC calls for N-hop paths (50-200ms per call)
 * - After: 1 RPC call for all quotes (~50ms total)
 * - Estimated latency reduction: 50-200ms for 3-hop paths
 *
 * ## Usage
 * Instead of calling getAmountsOut() N times sequentially:
 * ```
 * const quote1 = await router1.getAmountsOut(amount, [tokenA, tokenB]);
 * const quote2 = await router2.getAmountsOut(quote1, [tokenB, tokenC]);
 * const quote3 = await router1.getAmountsOut(quote2, [tokenC, tokenA]);
 * ```
 *
 * Call this contract once:
 * ```
 * const [quotes, success] = await quoter.getBatchedQuotes([
 *   { router: router1, tokenIn: tokenA, tokenOut: tokenB, amountIn: amount },
 *   { router: router2, tokenIn: tokenB, tokenOut: tokenC, amountIn: 0 }, // 0 = use previous output
 *   { router: router1, tokenIn: tokenC, tokenOut: tokenA, amountIn: 0 },
 * ]);
 * ```
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 */
contract MultiPathQuoter {
    // ==========================================================================
    // Structs
    // ==========================================================================

    /**
     * @notice Single quote request for a 2-token swap path
     * @param router The DEX router to query
     * @param tokenIn The input token address
     * @param tokenOut The output token address
     * @param amountIn The input amount (use 0 for chained quotes to use previous output)
     */
    struct QuoteRequest {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
    }

    /**
     * @notice Result for a single quote request
     * @param amountOut The quoted output amount
     * @param success Whether the quote call succeeded
     */
    struct QuoteResult {
        uint256 amountOut;
        bool success;
    }

    // ==========================================================================
    // Errors
    // ==========================================================================

    error EmptyQuoteRequests();
    error InvalidRouterAddress();
    error InvalidTokenAddress();
    error ChainedQuoteWithZeroAmount();
    /// @dev P2 Fix: Thrown when pathRequests.length != flashLoanAmounts.length
    error ArrayLengthMismatch();
    /// @dev P3 Fix: Thrown when an individual path within pathRequests is empty
    error EmptyPathInArray(uint256 pathIndex);

    // ==========================================================================
    // View Functions - Batched Quotes
    // ==========================================================================

    /**
     * @notice Get batched quotes for multiple swap paths in a single call
     * @dev Each quote is independent. Use amountIn=0 to chain quotes (use previous output).
     *
     * Gas optimization: Pre-allocates path array once and reuses across iterations.
     *
     * @param requests Array of quote requests
     * @return results Array of quote results with amountOut and success flag
     */
    function getBatchedQuotes(QuoteRequest[] calldata requests)
        external
        view
        returns (QuoteResult[] memory results)
    {
        uint256 length = requests.length;
        if (length == 0) revert EmptyQuoteRequests();

        results = new QuoteResult[](length);

        // Gas optimization: Pre-allocate path array once
        address[] memory path = new address[](2);
        uint256 previousOutput = 0;

        for (uint256 i = 0; i < length;) {
            QuoteRequest calldata req = requests[i];

            // Determine input amount (use previous output if amountIn is 0)
            uint256 inputAmount = req.amountIn;
            if (inputAmount == 0) {
                if (i == 0) revert ChainedQuoteWithZeroAmount();
                inputAmount = previousOutput;
            }

            // Reuse pre-allocated path array
            path[0] = req.tokenIn;
            path[1] = req.tokenOut;

            // Try to get quote from router
            try IDexRouter(req.router).getAmountsOut(inputAmount, path) returns (
                uint256[] memory amounts
            ) {
                uint256 amountOut = amounts[amounts.length - 1];
                results[i] = QuoteResult({
                    amountOut: amountOut,
                    success: true
                });
                previousOutput = amountOut;
            } catch {
                results[i] = QuoteResult({
                    amountOut: 0,
                    success: false
                });
                previousOutput = 0;
            }

            unchecked { ++i; }
        }

        return results;
    }

    /**
     * @notice Get independent batched quotes (no chaining)
     * @dev Each quote is completely independent. Faster for parallel quote scenarios.
     *
     * @param requests Array of quote requests (amountIn must be > 0 for all)
     * @return amountsOut Array of output amounts (0 if quote failed)
     * @return successFlags Array of success flags for each quote
     */
    function getIndependentQuotes(QuoteRequest[] calldata requests)
        external
        view
        returns (uint256[] memory amountsOut, bool[] memory successFlags)
    {
        uint256 length = requests.length;
        if (length == 0) revert EmptyQuoteRequests();

        amountsOut = new uint256[](length);
        successFlags = new bool[](length);

        // Gas optimization: Pre-allocate path array once
        address[] memory path = new address[](2);

        for (uint256 i = 0; i < length;) {
            QuoteRequest calldata req = requests[i];

            // Reuse pre-allocated path array
            path[0] = req.tokenIn;
            path[1] = req.tokenOut;

            // Try to get quote from router
            try IDexRouter(req.router).getAmountsOut(req.amountIn, path) returns (
                uint256[] memory amounts
            ) {
                amountsOut[i] = amounts[amounts.length - 1];
                successFlags[i] = true;
            } catch {
                amountsOut[i] = 0;
                successFlags[i] = false;
            }

            unchecked { ++i; }
        }

        return (amountsOut, successFlags);
    }

    /**
     * @notice Simulate a complete arbitrage path and return expected profit
     * @dev Convenience function for flash loan arbitrage profitability checks.
     *      Chains all quotes sequentially and calculates net profit.
     *
     * @param requests Array of quote requests for the arbitrage path
     * @param flashLoanAmount The amount to flash loan
     * @param flashLoanFeeBps Flash loan fee in basis points (9 for Aave V3 = 0.09%)
     * @return expectedProfit Net profit after flash loan fee (0 if any quote fails)
     * @return finalAmount Final amount after all swaps
     * @return allSuccess Whether all quotes succeeded
     */
    function simulateArbitragePath(
        QuoteRequest[] calldata requests,
        uint256 flashLoanAmount,
        uint256 flashLoanFeeBps
    )
        external
        view
        returns (uint256 expectedProfit, uint256 finalAmount, bool allSuccess)
    {
        uint256 length = requests.length;
        if (length == 0) revert EmptyQuoteRequests();

        // Gas optimization: Pre-allocate path array once
        address[] memory path = new address[](2);
        uint256 currentAmount = flashLoanAmount;
        allSuccess = true;

        for (uint256 i = 0; i < length;) {
            QuoteRequest calldata req = requests[i];

            // Use amountIn if specified, otherwise use current amount
            uint256 inputAmount = req.amountIn > 0 ? req.amountIn : currentAmount;

            // Reuse pre-allocated path array
            path[0] = req.tokenIn;
            path[1] = req.tokenOut;

            // Try to get quote from router
            try IDexRouter(req.router).getAmountsOut(inputAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
            } catch {
                return (0, 0, false);
            }

            unchecked { ++i; }
        }

        finalAmount = currentAmount;

        // Calculate flash loan fee and net profit
        uint256 flashLoanFee = (flashLoanAmount * flashLoanFeeBps) / 10000;
        uint256 amountOwed = flashLoanAmount + flashLoanFee;

        if (finalAmount > amountOwed) {
            expectedProfit = finalAmount - amountOwed;
        } else {
            expectedProfit = 0;
        }

        return (expectedProfit, finalAmount, allSuccess);
    }

    /**
     * @notice Get quotes for multiple independent arbitrage paths
     * @dev Useful for comparing multiple arbitrage opportunities in a single call
     *
     * @param pathRequests 2D array - each inner array is a complete arbitrage path
     * @param flashLoanAmounts Array of flash loan amounts for each path
     * @param flashLoanFeeBps Flash loan fee in basis points
     * @return profits Array of expected profits for each path
     * @return successFlags Array of success flags for each path
     */
    function compareArbitragePaths(
        QuoteRequest[][] calldata pathRequests,
        uint256[] calldata flashLoanAmounts,
        uint256 flashLoanFeeBps
    )
        external
        view
        returns (uint256[] memory profits, bool[] memory successFlags)
    {
        uint256 numPaths = pathRequests.length;

        // P2 Fix: Validate array lengths match
        if (numPaths == 0) revert EmptyQuoteRequests();
        if (flashLoanAmounts.length != numPaths) revert ArrayLengthMismatch();

        profits = new uint256[](numPaths);
        successFlags = new bool[](numPaths);

        // Gas optimization: Pre-allocate path array once (reused across all paths)
        address[] memory path = new address[](2);

        for (uint256 p = 0; p < numPaths;) {
            QuoteRequest[] calldata requests = pathRequests[p];
            uint256 pathLength = requests.length;

            // P3 Fix: Handle empty inner paths gracefully
            if (pathLength == 0) {
                successFlags[p] = false;
                unchecked { ++p; }
                continue;
            }

            uint256 flashLoanAmount = flashLoanAmounts[p];
            uint256 currentAmount = flashLoanAmount;
            bool pathSuccess = true;

            for (uint256 i = 0; i < pathLength;) {
                QuoteRequest calldata req = requests[i];
                uint256 inputAmount = req.amountIn > 0 ? req.amountIn : currentAmount;

                path[0] = req.tokenIn;
                path[1] = req.tokenOut;

                try IDexRouter(req.router).getAmountsOut(inputAmount, path) returns (
                    uint256[] memory amounts
                ) {
                    currentAmount = amounts[amounts.length - 1];
                } catch {
                    pathSuccess = false;
                    break;
                }

                unchecked { ++i; }
            }

            if (pathSuccess) {
                uint256 flashLoanFee = (flashLoanAmount * flashLoanFeeBps) / 10000;
                uint256 amountOwed = flashLoanAmount + flashLoanFee;
                if (currentAmount > amountOwed) {
                    profits[p] = currentAmount - amountOwed;
                }
            }

            successFlags[p] = pathSuccess;

            unchecked { ++p; }
        }

        return (profits, successFlags);
    }
}

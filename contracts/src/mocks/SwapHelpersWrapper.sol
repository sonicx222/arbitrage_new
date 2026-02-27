// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/SwapHelpers.sol";

/**
 * @title SwapHelpersWrapper
 * @notice Thin wrapper to expose SwapHelpers library functions as external calls for testing.
 * @dev Libraries cannot be called directly in tests — this contract delegates to the library.
 *
 * @custom:test-only This contract is only used in tests.
 */
contract SwapHelpersWrapper {
    using SafeERC20 for IERC20;

    /**
     * @notice Execute a single swap via SwapHelpers.executeSingleSwap()
     * @dev Pre-allocates the path array and delegates to the library.
     */
    function executeSingleSwap(
        address currentToken,
        uint256 amount,
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountOutMin,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        return SwapHelpers.executeSingleSwap(
            currentToken,
            amount,
            router,
            tokenIn,
            tokenOut,
            amountOutMin,
            path,
            deadline
        );
    }
}

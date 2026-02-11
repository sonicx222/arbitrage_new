// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockMaliciousRouter
 * @dev Malicious router that attempts reentrancy attack during swap execution
 * @notice Used for testing ReentrancyGuard protection in flash arbitrage contracts
 *
 * ## Attack Mechanism
 *
 * When a flash arbitrage contract calls swapExactTokensForTokens() on this router,
 * the router re-enters the arbitrage contract by calling executeArbitrage() again.
 * This triggers the ReentrancyGuard modifier, which reverts with "ReentrancyGuard:
 * reentrant call". The attack attempt is recorded via attackCount for test assertions.
 *
 * Attack is ENABLED BY DEFAULT. Use disableAttack() for normal swap behavior.
 *
 * ## Why abi.encodeWithSelector instead of abi.encodeWithSignature
 *
 * We use abi.encodeWithSelector with a pre-computed selector to ensure the calldata
 * is well-formed. Using abi.encodeWithSignature with tuple types can produce malformed
 * calldata if the signature string doesn't exactly match Solidity's ABI encoding rules.
 * A well-formed call ensures the revert comes from ReentrancyGuard, not from ABI
 * decoding failure.
 */
contract MockMaliciousRouter {
    using SafeERC20 for IERC20;

    /// @dev Local struct matching BaseFlashArbitrage.SwapStep for proper ABI encoding
    /// Must match exactly: (address router, address tokenIn, address tokenOut, uint256 amountOutMin)
    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin;
    }

    address public attackTarget;
    bool public attackEnabled;
    uint256 public attackCount;

    /// @dev Records whether the reentrancy attack was attempted (for test assertions)
    bool public attackAttempted;

    /// @dev Records whether the reentrancy call succeeded (should always be false)
    bool public attackSucceeded;

    constructor(address _attackTarget) {
        attackTarget = _attackTarget;
        attackEnabled = true;
    }

    /// @notice Enable reentrancy attack (enabled by default)
    function enableAttack() external {
        attackEnabled = true;
    }

    /// @notice Disable reentrancy attack for normal swap testing
    function disableAttack() external {
        attackEnabled = false;
    }

    /**
     * @dev Malicious swap that attempts reentrancy via executeArbitrage()
     *
     * The attack constructs a valid executeArbitrage() call with an empty SwapStep[]
     * array. This ensures the revert is caused by ReentrancyGuard (not by calldata
     * decoding errors). The empty swap path would fail validation anyway, but the
     * ReentrancyGuard check runs first.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        // Silence unused variable warnings
        amountOutMin;
        deadline;

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[1] = amountIn; // Return same amount for simplicity

        // Transfer input tokens
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        if (attackEnabled && attackCount == 0) {
            attackCount++;
            attackAttempted = true;

            // Build a properly ABI-encoded call to executeArbitrage().
            // selector: executeArbitrage(address,uint256,(address,address,address,uint256)[],uint256,uint256)
            // We use abi.encodeWithSelector to guarantee well-formed calldata.
            // The empty SwapStep[] is valid ABI encoding — the revert MUST come from ReentrancyGuard.
            bytes4 selector = bytes4(keccak256("executeArbitrage(address,uint256,(address,address,address,uint256)[],uint256,uint256)"));

            // Properly typed empty SwapStep array for correct ABI encoding.
            // This would fail EmptySwapPath validation if ReentrancyGuard didn't catch it first.
            SwapStep[] memory emptyPath = new SwapStep[](0);

            bytes memory attackData = abi.encodeWithSelector(
                selector,
                path[0],                    // asset
                amountIn,                   // amount
                emptyPath,                  // empty swap path (properly typed)
                uint256(0),                 // minProfit
                block.timestamp + 300       // deadline
            );

            // Attempt reentrancy — this MUST fail due to ReentrancyGuard
            (bool success, ) = attackTarget.call(attackData);
            attackSucceeded = success;

            // Don't require(!success) here — let the test assert the outcome
            // This allows the test to verify both the attack attempt and the result
        }

        // Transfer output tokens
        IERC20(path[1]).safeTransfer(to, amountIn);

        return amounts;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            amounts[i] = amountIn;
        }
        return amounts;
    }

    receive() external payable {}
}

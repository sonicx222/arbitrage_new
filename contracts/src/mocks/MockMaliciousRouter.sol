// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDexRouter.sol";

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
 *
 * ## Custom Attack Calldata (H-02)
 *
 * By default, the attack uses the 5-param executeArbitrage selector matching
 * FlashLoanArbitrage/BalancerV2/SyncSwap/DaiFlashMint. For contracts with
 * different entry points (PancakeSwap's 6-param executeArbitrage or
 * CommitReveal's reveal()), use setCustomAttackCalldata() to provide
 * protocol-specific calldata. This ensures the revert is caused by
 * ReentrancyGuard — not by a selector mismatch.
 *
 * @custom:version 1.1.0
 */
contract MockMaliciousRouter is IDexRouter {
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

    /// @dev Custom attack calldata for protocol-specific reentrancy testing (H-02)
    bytes private _customAttackCalldata;

    constructor(address _attackTarget) {
        attackTarget = _attackTarget;
        attackEnabled = true;
    }

    /// @notice Set custom attack calldata for protocol-specific reentrancy testing
    /// @dev When set (non-empty), this calldata is used instead of the default
    /// executeArbitrage(address,uint256,...) call. This allows testing reentrancy
    /// against PancakeSwap (6-param executeArbitrage) and CommitReveal (reveal()).
    function setCustomAttackCalldata(bytes calldata data) external {
        _customAttackCalldata = data;
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
     * The attack constructs a valid executeArbitrage() call with a non-empty SwapStep[]
     * array that passes all input validation (token continuity, approved router, etc.).
     * This proves the revert is caused ONLY by ReentrancyGuard — not by EmptySwapPath
     * or other validation checks.
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

            bytes memory attackData;

            if (_customAttackCalldata.length > 0) {
                // H-02: Use protocol-specific calldata set by the test.
                // This ensures the attack targets the correct function selector
                // (e.g., PancakeSwap's 6-param executeArbitrage or CommitReveal's reveal).
                attackData = _customAttackCalldata;
            } else {
                // Default: 5-param executeArbitrage used by FlashLoanArbitrage,
                // BalancerV2, SyncSwap, and DaiFlashMint.
                bytes4 selector = bytes4(keccak256("executeArbitrage(address,uint256,(address,address,address,uint256)[],uint256,uint256)"));

                // Non-empty swap path that passes validation: uses this router (approved)
                // with valid token continuity (asset→path[1]→asset). If ReentrancyGuard
                // were removed, this would reach _executeSwaps — proving the guard is the
                // only defense, not EmptySwapPath or other validation.
                SwapStep[] memory attackPath = new SwapStep[](2);
                attackPath[0] = SwapStep({
                    router: address(this),
                    tokenIn: path[0],
                    tokenOut: path[1],
                    amountOutMin: 0
                });
                attackPath[1] = SwapStep({
                    router: address(this),
                    tokenIn: path[1],
                    tokenOut: path[0],
                    amountOutMin: 0
                });

                attackData = abi.encodeWithSelector(
                    selector,
                    path[0],                    // asset
                    amountIn,                   // amount
                    attackPath,                 // non-empty valid swap path (M-05)
                    uint256(0),                 // minProfit
                    block.timestamp + 300       // deadline
                );
            }

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

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        amountInMax;
        deadline;
        amounts = new uint256[](path.length);
        amounts[0] = amountOut;
        amounts[path.length - 1] = amountOut;

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountOut);
        IERC20(path[path.length - 1]).safeTransfer(to, amountOut);

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

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountOut;
        }
        return amounts;
    }

    function factory() external pure returns (address) {
        return address(0);
    }

    function WETH() external pure returns (address) {
        return address(0);
    }

    receive() external payable {}
}

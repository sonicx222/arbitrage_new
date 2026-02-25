// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockCommitAttackRouter
 * @dev Attempts cross-function reentrancy via commit() during swap execution
 * @notice Tests that nonReentrant on commit() blocks entry when reveal() holds the lock.
 *
 * When a CommitRevealArbitrage contract calls swapExactTokensForTokens() on this router
 * during reveal(), the router attempts to re-enter via commit(). Since reveal() holds
 * the nonReentrant lock and commit() also requires it, the call is blocked.
 *
 * @custom:version 1.0.0
 */
contract MockCommitAttackRouter {
    using SafeERC20 for IERC20;

    address public attackTarget;
    bool public attackAttempted;
    bool public attackSucceeded;

    constructor(address _attackTarget) {
        attackTarget = _attackTarget;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[1] = amountIn;

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        // Attempt cross-function reentrancy: call commit() while reveal() holds the lock
        attackAttempted = true;
        bytes memory attackData = abi.encodeWithSignature(
            "commit(bytes32)",
            keccak256("reentrancy-attack")
        );
        (bool success, ) = attackTarget.call(attackData);
        attackSucceeded = success;

        IERC20(path[1]).safeTransfer(to, amountIn);
        return amounts;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    receive() external payable {}
}

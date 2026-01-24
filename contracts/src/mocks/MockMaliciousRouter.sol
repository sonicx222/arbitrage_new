// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockMaliciousRouter
 * @dev Malicious router that attempts reentrancy attack
 * @notice Used for testing reentrancy protection in FlashLoanArbitrage
 */
contract MockMaliciousRouter {
    using SafeERC20 for IERC20;

    address public target;
    bool public attackEnabled;
    uint256 public attackCount;

    constructor(address _target) {
        target = _target;
    }

    function enableAttack() external {
        attackEnabled = true;
    }

    function disableAttack() external {
        attackEnabled = false;
    }

    /**
     * @dev Malicious swap that attempts reentrancy
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

            // Attempt reentrancy attack by calling executeArbitrage again
            bytes memory attackData = abi.encodeWithSignature(
                "executeArbitrage(address,uint256,(address,address,address,uint256)[],uint256)",
                path[0],
                amountIn,
                new bytes(0), // Empty swap path
                0
            );

            // This should fail due to reentrancy guard
            (bool success, ) = target.call(attackData);
            require(!success, "Reentrancy attack should have failed");
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

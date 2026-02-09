// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBalancerV2Vault.sol";

/**
 * @title MockBalancerVault
 * @dev Mock Balancer V2 Vault for testing flash loans
 * @notice Simulates Balancer V2 Vault flash loan functionality with 0% fees
 */
contract MockBalancerVault is IBalancerV2Vault {
    using SafeERC20 for IERC20;

    event FlashLoanExecuted(
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    /**
     * @notice Executes a flash loan
     * @dev Balancer V2 charges 0% flash loan fees
     * @param recipient Contract receiving the flash loan
     * @param tokens Array of token addresses to flash loan
     * @param amounts Array of amounts to flash loan
     * @param userData Arbitrary data to pass to the recipient
     */
    function flashLoan(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external override {
        require(tokens.length == amounts.length, "Array length mismatch");
        require(tokens.length > 0, "Empty arrays");

        // Create fee amounts array (all zeros for Balancer V2)
        uint256[] memory feeAmounts = new uint256[](tokens.length);

        // Record balances before
        uint256[] memory balancesBefore = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(amounts[i] > 0, "Zero amount");
            balancesBefore[i] = IERC20(tokens[i]).balanceOf(address(this));
            IERC20(tokens[i]).safeTransfer(address(recipient), amounts[i]);
            emit FlashLoanExecuted(address(recipient), tokens[i], amounts[i]);
        }

        // Call recipient callback
        recipient.receiveFlashLoan(tokens, amounts, feeAmounts, userData);

        // Verify repayment - check balance increased by loaned amount
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balanceAfter = IERC20(tokens[i]).balanceOf(address(this));
            require(
                balanceAfter >= balancesBefore[i],
                "Flash loan not repaid"
            );
        }
    }

    /**
     * @dev Allows the vault to receive tokens for liquidity
     */
    receive() external payable {}
}

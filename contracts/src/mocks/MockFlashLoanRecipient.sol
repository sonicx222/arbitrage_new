// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBalancerV2Vault.sol";

/**
 * @title MockFlashLoanRecipient
 * @dev Mock recipient contract for testing Balancer V2 flash loans
 * @notice Simple recipient that approves and returns tokens to the vault
 */
contract MockFlashLoanRecipient is IFlashLoanRecipient {
    using SafeERC20 for IERC20;

    /// @dev Address of the Balancer V2 Vault
    address public vault;

    /// @dev Flag to control whether to repay the loan (for testing failure scenarios)
    bool public shouldRepay = true;

    /**
     * @notice Called by the Balancer vault during a flash loan
     * @dev Implements IFlashLoanRecipient interface
     * @param tokens Array of tokens that were flash loaned
     * @param amounts Array of amounts that were flash loaned
     * @param feeAmounts Array of fee amounts owed (0 for Balancer V2)
     * @param userData Arbitrary data passed from flashLoan() call
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Record the vault address for first call
        if (vault == address(0)) {
            vault = msg.sender;
        }

        // Verify caller is the vault
        require(msg.sender == vault, "Caller is not vault");

        // If configured to repay, transfer tokens back to vault
        if (shouldRepay) {
            for (uint256 i = 0; i < tokens.length; i++) {
                uint256 totalOwed = amounts[i] + feeAmounts[i];
                IERC20(tokens[i]).safeTransfer(vault, totalOwed);
            }
        }
        // If shouldRepay is false, don't transfer back (to test failure scenario)
    }

    /**
     * @notice Configure whether the recipient should repay the loan
     * @param _shouldRepay True to repay, false to simulate failure
     */
    function setShouldRepay(bool _shouldRepay) external {
        shouldRepay = _shouldRepay;
    }
}

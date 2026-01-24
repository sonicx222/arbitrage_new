// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockAavePool
 * @dev Mock Aave V3 Pool for testing flash loans
 * @notice Implements IPool.flashLoanSimple() interface
 */
contract MockAavePool {
    using SafeERC20 for IERC20;

    // Aave V3 flash loan premium: 0.09% = 9 basis points
    uint256 public constant FLASH_LOAN_PREMIUM = 9;
    uint256 public constant PREMIUM_DENOMINATOR = 10000;

    event FlashLoan(
        address indexed target,
        address indexed asset,
        uint256 amount,
        uint256 premium
    );

    /**
     * @dev Simulates Aave V3 flashLoanSimple
     * @param receiverAddress The address receiving the flash loan
     * @param asset The address of the asset to flash loan
     * @param amount The amount to flash loan
     * @param params Arbitrary bytes to pass to the receiver
     * @param referralCode Unused in mock
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external {
        // Silence unused variable warning
        referralCode;

        require(amount > 0, "Amount must be greater than 0");

        uint256 premium = (amount * FLASH_LOAN_PREMIUM) / PREMIUM_DENOMINATOR;

        // Transfer the flash loan amount to receiver
        IERC20(asset).safeTransfer(receiverAddress, amount);

        // Call the receiver's executeOperation function
        (bool success, bytes memory result) = receiverAddress.call(
            abi.encodeWithSignature(
                "executeOperation(address,uint256,uint256,address,bytes)",
                asset,
                amount,
                premium,
                msg.sender, // initiator is the original caller
                params
            )
        );

        if (!success) {
            // Bubble up the revert reason
            if (result.length > 0) {
                assembly {
                    let resultSize := mload(result)
                    revert(add(32, result), resultSize)
                }
            } else {
                revert("Flash loan execution failed");
            }
        }

        // Verify that the amount + premium was returned
        uint256 amountOwed = amount + premium;

        // Transfer the repayment from receiver back to pool
        IERC20(asset).safeTransferFrom(receiverAddress, address(this), amountOwed);

        emit FlashLoan(receiverAddress, asset, amount, premium);
    }

    /**
     * @dev Returns the flash loan premium
     */
    function FLASHLOAN_PREMIUM_TOTAL() external pure returns (uint128) {
        return uint128(FLASH_LOAN_PREMIUM);
    }

    /**
     * @dev Allows the pool to receive tokens for flash loan liquidity
     */
    receive() external payable {}
}

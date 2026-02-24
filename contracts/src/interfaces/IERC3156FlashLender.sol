// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ISyncSwapVault.sol";

/**
 * @title IERC3156FlashLender
 * @notice Minimal EIP-3156 flash lender interface
 * @dev Used by DaiFlashMintArbitrage to interact with MakerDAO's DssFlash module.
 *      IERC3156FlashBorrower is imported from ISyncSwapVault.sol (shared definition).
 *      Reference: https://eips.ethereum.org/EIPS/eip-3156
 */
interface IERC3156FlashLender {
    /**
     * @notice Get the maximum flash loan amount for a token
     * @param token The token address
     * @return The maximum flash loan amount available
     */
    function maxFlashLoan(address token) external view returns (uint256);

    /**
     * @notice Get the flash loan fee for a given amount
     * @param token The token address
     * @param amount The loan amount
     * @return The fee amount
     */
    function flashFee(address token, uint256 amount) external view returns (uint256);

    /**
     * @notice Initiate a flash loan (EIP-3156 standard)
     * @param receiver The contract that will receive the flash loan
     * @param token The token to borrow
     * @param amount The amount to borrow
     * @param data Arbitrary data passed to the receiver
     * @return success True if flash loan succeeded
     */
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes memory data
    ) external returns (bool);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IERC3156FlashLender.sol";

/**
 * @title MockDssFlash
 * @dev Mock MakerDAO DssFlash module for testing EIP-3156 DAI flash minting
 * @notice Simulates DssFlash behavior with configurable flash loan fee
 *
 * In production, DssFlash mints DAI directly (no liquidity pool needed).
 * This mock simulates the same EIP-3156 interface using pre-funded token balances.
 *
 * @custom:version 1.0.0
 */
contract MockDssFlash is IERC3156FlashLender {
    using SafeERC20 for IERC20;

    /// @notice Fee in basis points (1 bps = 0.01%)
    uint256 public immutable feeBps;

    /// @notice BPS denominator
    uint256 private constant BPS_DENOMINATOR = 10000;

    /// @notice EIP-3156 success return value
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @notice Flag to simulate flash loan failure
    bool public shouldFailFlashLoan;

    event FlashLoanExecuted(
        address indexed receiver,
        address indexed token,
        uint256 amount,
        uint256 fee
    );

    /**
     * @notice Initialize with configurable fee
     * @param _feeBps Fee in basis points (e.g., 1 = 0.01%)
     */
    constructor(uint256 _feeBps) {
        feeBps = _feeBps;
    }

    /**
     * @notice Get the maximum flash loan amount for a token
     * @param token The token address
     * @return Maximum flash loan amount (mock returns token balance)
     */
    function maxFlashLoan(address token) external view override returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @notice Calculate flash loan fee
     * @param token The token address (unused, included for EIP-3156 compliance)
     * @param amount The loan amount
     * @return The fee amount
     */
    function flashFee(address token, uint256 amount) external view override returns (uint256) {
        // Silence unused variable warning
        token;
        return (amount * feeBps) / BPS_DENOMINATOR;
    }

    /**
     * @notice Execute EIP-3156 flash loan
     * @param receiver The flash loan borrower contract
     * @param token The token to lend
     * @param amount The amount to lend
     * @param data Arbitrary data passed to the borrower
     * @return success True if flash loan succeeded
     */
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes memory data
    ) external override returns (bool) {
        // Simulate failure if flag is set
        if (shouldFailFlashLoan) {
            return false;
        }

        // Calculate fee
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;

        // Check balance
        require(
            IERC20(token).balanceOf(address(this)) >= amount,
            "Insufficient vault balance"
        );

        // Record balance before
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        // Transfer tokens to receiver
        IERC20(token).safeTransfer(address(receiver), amount);

        // Call receiver's callback
        // Note on `initiator` parameter (msg.sender):
        // In this mock, msg.sender is the arbitrage contract (which calls flashLoan on DssFlash).
        // In production MakerDAO DssFlash, the initiator is also msg.sender per EIP-3156 spec.
        // The arbitrage contract validates initiator == address(this) to prevent unauthorized callbacks.
        // This mock accurately simulates production DssFlash behavior for this parameter.
        bytes32 result = receiver.onFlashLoan(
            msg.sender,
            token,
            amount,
            fee,
            data
        );

        // Verify callback returned success
        require(result == ERC3156_CALLBACK_SUCCESS, "Callback failed");

        // Pull repayment from receiver (amount + fee)
        uint256 repayment = amount + fee;
        IERC20(token).safeTransferFrom(address(receiver), address(this), repayment);

        // Verify balance increased by at least fee
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        require(
            balanceAfter >= balanceBefore + fee,
            "Insufficient repayment"
        );

        emit FlashLoanExecuted(address(receiver), token, amount, fee);

        return true;
    }

    // =========================================================================
    // Test Helpers
    // =========================================================================

    /**
     * @notice Set flag to simulate flash loan failure
     */
    function setShouldFailFlashLoan(bool _shouldFail) external {
        shouldFailFlashLoan = _shouldFail;
    }

    /**
     * @notice Withdraw tokens from vault (for test cleanup)
     */
    function withdrawToken(address token, address to, uint256 amount) external {
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Allow vault to receive ETH
     */
    receive() external payable {}
}

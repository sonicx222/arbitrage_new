// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISyncSwapVault.sol";

/**
 * @title MockSyncSwapVault
 * @dev Mock SyncSwap Vault for testing EIP-3156 flash loans
 * @notice Simulates SyncSwap Vault behavior with 0.3% flash loan fee
 *
 * @custom:version 1.0.0
 */
contract MockSyncSwapVault is ISyncSwapVault {
    using SafeERC20 for IERC20;

    /// @notice Flash loan fee percentage (0.3% = 3e15 in 18 decimals)
    uint256 private constant FLASH_LOAN_FEE_PERCENTAGE = 3e15;

    /// @notice EIP-3156 success return value
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @notice Wrapped ETH address (for zkSync Era)
    address public immutable override wETH;

    /// @notice Flag to simulate flash loan failure
    bool public shouldFailFlashLoan;

    /// @notice Flag to simulate insufficient balance
    bool public shouldSimulateInsufficientBalance;

    event FlashLoanExecuted(
        address indexed receiver,
        address indexed token,
        uint256 amount,
        uint256 fee
    );

    constructor(address _wETH) {
        wETH = _wETH;
    }

    /**
     * @notice Get the maximum flash loan amount for a token
     */
    function maxFlashLoan(address token) external view override returns (uint256) {
        if (shouldSimulateInsufficientBalance) {
            return 0;
        }
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @notice Calculate flash loan fee (0.3% of amount)
     */
    function flashFee(address token, uint256 amount)
        external
        pure
        override
        returns (uint256)
    {
        // Silence unused variable warning
        token;

        return (amount * FLASH_LOAN_FEE_PERCENTAGE) / 1e18;
    }

    /**
     * @notice Get the flash loan fee percentage
     */
    function flashLoanFeePercentage() external pure override returns (uint256) {
        return FLASH_LOAN_FEE_PERCENTAGE;
    }

    /**
     * @notice Execute EIP-3156 flash loan
     */
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes memory userData
    ) external override returns (bool) {
        // Simulate failure if flag is set
        if (shouldFailFlashLoan) {
            return false;
        }

        // Calculate fee (0.3%)
        uint256 fee = (amount * FLASH_LOAN_FEE_PERCENTAGE) / 1e18;

        // Check vault has sufficient balance
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
        // In this mock, msg.sender is the arbitrage contract (which calls flashLoan on the vault).
        // In production SyncSwap, the vault also passes msg.sender as initiator.
        // The arbitrage contract validates initiator == address(this) to prevent unauthorized callbacks.
        // This mock accurately simulates production behavior for this parameter.
        bytes32 result = receiver.onFlashLoan(
            msg.sender,
            token,
            amount,
            fee,
            userData
        );

        // Verify callback returned success
        require(result == ERC3156_CALLBACK_SUCCESS, "Callback failed");

        // Pull repayment from receiver (amount + fee)
        uint256 repayment = amount + fee;
        IERC20(token).safeTransferFrom(address(receiver), address(this), repayment);

        // Verify balance increased by at least amount + fee
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
     * @notice Set flag to simulate insufficient balance
     */
    function setShouldSimulateInsufficientBalance(bool _shouldSimulate) external {
        shouldSimulateInsufficientBalance = _shouldSimulate;
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

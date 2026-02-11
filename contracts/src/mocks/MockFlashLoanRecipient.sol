// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBalancerV2Vault.sol";

/**
 * @title MockFlashLoanRecipient
 * @dev Multi-protocol mock recipient for testing flash loan callbacks
 * @notice Supports Balancer V2, Aave V3, and PancakeSwap V3 flash loan callbacks.
 *
 * Implements:
 * - IFlashLoanRecipient.receiveFlashLoan() for Balancer V2
 * - executeOperation() for Aave V3 (IFlashLoanSimpleReceiver)
 * - pancakeV3FlashCallback() for PancakeSwap V3
 *
 * Test helpers:
 * - setShouldRepay(bool) - Controls Balancer repayment
 * - setShouldSucceed(bool) - Controls Aave executeOperation return value
 * - setShouldRevert(bool) - Forces callback to revert
 * - approveToken(token, spender, amount) - Approve tokens for repayment
 * - Recording fields for asserting callback parameters in tests
 */
contract MockFlashLoanRecipient is IFlashLoanRecipient {
    using SafeERC20 for IERC20;

    // =========================================================================
    // State
    // =========================================================================

    /// @dev Address of the Balancer V2 Vault (set on first receiveFlashLoan call, or via setVault())
    address public vault;

    /// @dev Controls Balancer repayment behavior
    bool public shouldRepay = true;

    /// @dev Controls Aave executeOperation return value (true = success)
    bool public shouldSucceed = true;

    /// @dev Forces any callback to revert
    bool public shouldRevert;

    // =========================================================================
    // Recorded callback parameters (for test assertions)
    // =========================================================================

    /// @dev Last asset address passed to executeOperation (Aave)
    address public lastAsset;

    /// @dev Last amount passed to executeOperation (Aave)
    uint256 public lastAmount;

    /// @dev Last premium passed to executeOperation (Aave)
    uint256 public lastPremium;

    /// @dev Last fee0 passed to pancakeV3FlashCallback
    uint256 public lastFee0;

    /// @dev Last fee1 passed to pancakeV3FlashCallback
    uint256 public lastFee1;

    /// @dev Last userData/data passed to any callback
    bytes public lastUserData;

    // =========================================================================
    // Balancer V2: IFlashLoanRecipient
    // =========================================================================

    /**
     * @notice Called by the Balancer vault during a flash loan
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
        require(!shouldRevert, "Mock forced revert");

        // Record the vault address for first call
        if (vault == address(0)) {
            vault = msg.sender;
        }

        // Verify caller is the vault
        require(msg.sender == vault, "Caller is not vault");

        // Record callback data
        lastUserData = userData;

        // If configured to repay, transfer tokens back to vault
        if (shouldRepay) {
            for (uint256 i = 0; i < tokens.length; i++) {
                uint256 totalOwed = amounts[i] + feeAmounts[i];
                IERC20(tokens[i]).safeTransfer(vault, totalOwed);
            }
        }
    }

    // =========================================================================
    // Aave V3: executeOperation (IFlashLoanSimpleReceiver)
    // =========================================================================

    /**
     * @notice Called by the Aave V3 Pool during a flash loan
     * @param asset The address of the flash-borrowed asset
     * @param amount The amount of the flash-borrowed asset
     * @param premium The fee of the flash-borrowed asset
     * @param initiator The address of the flashLoan initiator
     * @param params The byte-encoded params passed when initiating the flash loan
     * @return True if the execution of the operation succeeds
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(!shouldRevert, "Mock forced revert");

        // Silence unused variable warning
        initiator;

        // Record callback parameters for test assertions
        lastAsset = asset;
        lastAmount = amount;
        lastPremium = premium;
        lastUserData = params;

        return shouldSucceed;
    }

    // =========================================================================
    // PancakeSwap V3: pancakeV3FlashCallback
    // =========================================================================

    /**
     * @notice Called by the PancakeSwap V3 Pool during a flash loan
     * @param fee0 The fee amount in token0 owed to the pool
     * @param fee1 The fee amount in token1 owed to the pool
     * @param data The data passed through by the caller via the flash call
     */
    function pancakeV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        require(!shouldRevert, "Mock forced revert");

        // Record callback parameters for test assertions
        lastFee0 = fee0;
        lastFee1 = fee1;
        lastUserData = data;

        // PancakeSwap push-model repayment: transfer all tokens back to the pool (msg.sender)
        // Get pool's token addresses dynamically via static calls
        (bool s0, bytes memory r0) = msg.sender.staticcall(abi.encodeWithSignature("token0()"));
        (bool s1, bytes memory r1) = msg.sender.staticcall(abi.encodeWithSignature("token1()"));

        if (s0 && s1) {
            address t0 = abi.decode(r0, (address));
            address t1 = abi.decode(r1, (address));

            // Transfer entire balance back to pool (amount received + pre-minted fee)
            uint256 bal0 = IERC20(t0).balanceOf(address(this));
            if (bal0 > 0) IERC20(t0).safeTransfer(msg.sender, bal0);

            uint256 bal1 = IERC20(t1).balanceOf(address(this));
            if (bal1 > 0) IERC20(t1).safeTransfer(msg.sender, bal1);
        }
    }

    // =========================================================================
    // Test Helpers
    // =========================================================================

    /**
     * @notice Configure whether Balancer repayment should occur
     * @param _shouldRepay True to repay, false to simulate failure
     */
    function setShouldRepay(bool _shouldRepay) external {
        shouldRepay = _shouldRepay;
    }

    /**
     * @notice Configure whether Aave executeOperation returns true/false
     * @param _shouldSucceed True = return true (success), false = return false (fail)
     */
    function setShouldSucceed(bool _shouldSucceed) external {
        shouldSucceed = _shouldSucceed;
    }

    /**
     * @notice Configure whether any callback should revert
     * @param _shouldRevert True = revert on callback, false = normal behavior
     */
    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    /**
     * @notice Explicitly set the vault address (for test reuse across different vault instances)
     * @param _vault The vault address to set
     */
    function setVault(address _vault) external {
        vault = _vault;
    }

    /**
     * @notice Approve a spender to transfer tokens from this contract
     * @dev Used in tests to set up token approvals for flash loan repayment
     * @param token The ERC20 token to approve
     * @param spender The address to approve (typically the pool/vault)
     * @param amount The approval amount
     */
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ISyncSwapVault
 * @notice Minimal interface for SyncSwap Vault flash loans (EIP-3156 compliant)
 * @dev SyncSwap Vault provides flash loans via EIP-3156 standard interface
 *
 * ## Addresses
 * - zkSync Era Mainnet: 0x621425a1Ef6abE91058E9712575dcc4258F8d091
 * - zkSync Era Testnet: 0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8 (Staging)
 *
 * ## Flash Loan Fee
 * - 0.3% (30 basis points)
 * - Fee is calculated as: `fee = (amount * flashLoanFeePercentage()) / 1e18`
 *   - Example: 1000 ETH loan → fee = (1000 * 3e15) / 1e18 = 3 ETH
 * - Fee percentage stored with 18 decimals: `flashLoanFeePercentage()` returns 3e15 (0.3%)
 *
 * **Repayment**: Borrower must repay `amount + fee` (e.g., 1003 ETH for 1000 ETH loan)
 *
 * **Vault Verification Process**:
 * 1. Vault records balance before loan: `balanceBefore`
 * 2. Vault transfers `amount` to borrower
 * 3. Borrower executes trades and repays `amount + fee`
 * 4. Vault checks: `balanceAfter - balanceBefore >= fee`
 * 5. The difference (`balanceAfter - balanceBefore`) is the vault's profit
 *
 * **Important**: Fee is calculated ON THE LOAN AMOUNT, not on vault profit.
 * The vault profit happens to equal the fee when borrower repays correctly.
 *
 * ## Callback Interfaces
 * SyncSwap supports two callback interfaces:
 * 1. IERC3156FlashBorrower.onFlashLoan() - EIP-3156 standard (single-asset)
 * 2. IFlashLoanRecipient.receiveFlashLoan() - Balancer-style (multi-asset)
 *
 * This contract implements **EIP-3156** for standards compliance.
 *
 * @see https://eips.ethereum.org/EIPS/eip-3156
 * @see docs/syncswap_api_dpcu.md
 */

// =============================================================================
// EIP-3156 Flash Loan Interfaces
// =============================================================================

/**
 * @title IERC3156FlashBorrower
 * @notice Interface for flash loan borrower callback (EIP-3156 standard)
 * @dev Borrower must implement this interface to receive flash loans
 */
interface IERC3156FlashBorrower {
    /**
     * @notice Receive a flash loan
     * @param initiator The address that initiated the flash loan
     * @param token The token being flash loaned
     * @param amount The amount of tokens loaned
     * @param fee The fee for the flash loan (calculated by lender)
     * @param data Arbitrary data passed from the borrower
     * @return MUST return `keccak256("ERC3156FlashBorrower.onFlashLoan")`
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}

/**
 * @title ISyncSwapVault
 * @notice SyncSwap Vault interface for flash loans
 * @dev Implements EIP-3156 FlashLender interface
 */
interface ISyncSwapVault {
    // =========================================================================
    // EIP-3156 Flash Loan Functions
    // =========================================================================

    /**
     * @notice Get the maximum flash loan amount for a token
     * @param token The token address (use address(0) for native ETH)
     * @return The maximum flash loan amount available
     *
     * **Note**: SyncSwap uses `address(0)` for native ETH, and handles
     * wETH wrapping/unwrapping internally.
     */
    function maxFlashLoan(address token) external view returns (uint256);

    /**
     * @notice Get the flash loan fee for a given amount
     * @param token The token address
     * @param amount The loan amount
     * @return The fee amount (0.3% of amount)
     *
     * **Calculation**:
     * ```solidity
     * fee = (amount * flashLoanFeePercentage()) / 1e18
     * // Example: amount = 1000 ETH, fee = (1000 * 3e15) / 1e18 = 3 ETH (0.3%)
     * ```
     *
     * **Important**: The fee is calculated on the LOAN AMOUNT, not on any surplus.
     * Borrower must repay: `amount + fee`
     *
     * **EIP-3156 Compliance**: This follows the EIP-3156 standard where fee
     * is a function of the loan amount, known upfront before execution.
     */
    function flashFee(address token, uint256 amount) external pure returns (uint256);

    /**
     * @notice Initiate a flash loan (EIP-3156 standard)
     * @param receiver The contract that will receive the flash loan
     * @param token The token to borrow
     * @param amount The amount to borrow
     * @param userData Arbitrary data passed to the receiver
     * @return success True if flash loan succeeded
     *
     * **Flow**:
     * 1. Vault transfers `amount` of `token` to `receiver`
     * 2. Vault calls `receiver.onFlashLoan(initiator, token, amount, fee, userData)`
     * 3. Receiver executes arbitrage and approves Vault to pull repayment
     * 4. Vault pulls `amount + fee` from receiver
     * 5. Vault verifies balance increased by `amount + fee`
     *
     * **Requirements**:
     * - Receiver must implement IERC3156FlashBorrower
     * - Receiver must return correct hash from onFlashLoan()
     * - Receiver must approve Vault to transfer `amount + fee`
     *
     * @custom:gas Typical Gas Costs
     * - Base flash loan overhead: ~55,000 gas (includes EIP-3156 validation)
     * - Fee calculation: ~3,000 gas (calls flashFee())
     * - Callback execution: Variable (depends on arbitrage complexity)
     * - Single-asset flash loan: ~350,000-550,000 gas total
     * - **Recommendation**: Budget 550,000 gas for single-asset arbitrage on zkSync Era
     * - **Note**: zkSync Era has different gas model - these are L2 gas estimates only
     * - **zkSync**: Add L1 gas costs for data availability (~30,000-50,000 gas equivalent)
     */
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes memory userData
    ) external returns (bool);

    // =========================================================================
    // Flash Loan Configuration
    // =========================================================================

    /**
     * @notice Get the flash loan fee percentage
     * @return Fee percentage in 18 decimals (3e15 = 0.3%)
     *
     * **Example**:
     * - flashLoanFeePercentage() = 3000000000000000 (3e15)
     * - Represents 0.3% fee (30 basis points)
     */
    function flashLoanFeePercentage() external view returns (uint256);

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /**
     * @notice Get the wrapped native token address
     * @return The wETH address on zkSync Era
     *
     * **Note**: SyncSwap Vault uses `address(0)` for flash loans involving
     * native ETH, but this function returns the wETH address for reference.
     */
    function wETH() external view returns (address);
}

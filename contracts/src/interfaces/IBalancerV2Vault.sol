// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IBalancerV2Vault
 * @notice Interface for Balancer V2 Vault flash loan functionality
 * @dev See https://docs.balancer.fi/reference/contracts/flash-loans.html
 */
interface IBalancerV2Vault {
    /**
     * @notice Performs a flash loan
     * @param recipient Contract receiving the flash loan (must implement IFlashLoanRecipient)
     * @param tokens Array of token addresses to flash loan
     * @param amounts Array of amounts to flash loan (matching tokens array)
     * @param userData Arbitrary data to pass to the recipient
     *
     * @custom:requirements Array Validation
     * - `tokens.length` MUST equal `amounts.length`
     * - Arrays MUST NOT be empty (minimum 1 token)
     * - All `amounts[i]` MUST be greater than 0
     * - `recipient` MUST be a contract (not EOA)
     * - `recipient` MUST implement IFlashLoanRecipient correctly
     *
     * @custom:validation Recipient Validation Timing
     * - The Vault does NOT pre-validate recipient interface compliance
     * - Validation happens during callback execution
     * - If recipient is not a contract: reverts when calling receiveFlashLoan()
     * - If recipient doesn't implement IFlashLoanRecipient: reverts in callback
     * - Non-compliant recipients waste gas - validate off-chain before calling
     *
     * @custom:reverts
     * - "Array length mismatch" if array lengths don't match
     * - "Empty arrays" if arrays are empty
     * - "Zero amount" if any amount is 0
     * - Reverts if recipient is not a contract (during callback attempt)
     * - Reverts if recipient callback reverts
     * - "Flash loan not repaid" if repayment insufficient
     *
     * @custom:note Maximum Array Length
     * While technically unlimited, practical gas limits restrict multi-asset
     * flash loans to ~100 tokens maximum. Single-asset flash loans are most common.
     *
     * @custom:gas Typical Gas Costs (L1 Estimates)
     * - Base flash loan overhead: ~50,000 gas
     * - Per-token cost: ~20,000 gas additional
     * - Callback execution: Variable (depends on arbitrage complexity)
     * - Single-asset flash loan: ~300,000-500,000 gas total
     * - Multi-asset (2-3 tokens): ~350,000-600,000 gas total
     * - **Recommendation**: Budget 500,000 gas for single-asset arbitrage
     * - **L2 Note**: On Arbitrum/Optimism/Base, L2 gas is cheaper but add L1 calldata
     *   costs (~30,000-50,000 gas equivalent for data availability)
     */
    function flashLoan(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/**
 * @title IFlashLoanRecipient
 * @notice Interface that flash loan recipients must implement
 * @dev Called by the Vault during flash loan execution
 */
interface IFlashLoanRecipient {
    /**
     * @notice Callback function invoked by the Vault during flash loan
     * @dev Must return borrowed tokens + fees to the Vault before returning
     * @param tokens Array of tokens that were flash loaned
     * @param amounts Array of amounts that were flash loaned
     * @param feeAmounts Array of fee amounts owed (currently 0 for Balancer V2)
     * @param userData Arbitrary data passed from flashLoan() call
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

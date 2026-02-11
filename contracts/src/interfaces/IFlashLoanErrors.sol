// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IFlashLoanErrors
 * @notice Standardized error definitions for all flash loan arbitrage contracts
 * @dev Single source of truth for protocol-level errors. Prevents naming drift
 *      across FlashLoanArbitrage, BalancerV2, PancakeSwap, and SyncSwap contracts.
 *
 * ## Error Categories
 *
 * 1. Protocol Address Validation - Constructor-time checks
 * 2. Callback Security - Runtime caller/initiator verification
 *
 * ## Usage
 * ```solidity
 * import {IFlashLoanErrors} from "./interfaces/IFlashLoanErrors.sol";
 *
 * contract MyFlashArbitrage is BaseFlashArbitrage, IFlashLoanErrors {
 *     constructor(address _pool) {
 *         if (_pool == address(0)) revert InvalidProtocolAddress();
 *     }
 * }
 * ```
 *
 * Standardization rationale: contracts/src/interfaces/FLASH_LOAN_ERRORS.md
 */
interface IFlashLoanErrors {
    /// @notice Protocol contract address is invalid (zero address or not a contract)
    /// @dev Use for: Pool (Aave), Vault (Balancer/SyncSwap), Factory (PancakeSwap)
    error InvalidProtocolAddress();

    /// @notice Flash loan callback called by unauthorized contract
    /// @dev Only the protocol contract (Pool/Vault) should call the callback
    error InvalidFlashLoanCaller();

    /// @notice Flash loan initiated by unauthorized address
    /// @dev Only the contract itself should be the initiator (Aave, SyncSwap)
    error InvalidFlashLoanInitiator();
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IFlashLoanSimpleReceiver
 * @dev Interface for Aave V3 flash loan simple receiver
 * @notice Based on Aave V3's IFlashLoanSimpleReceiver interface
 */
interface IFlashLoanSimpleReceiver {
    /**
     * @notice Executes an operation after receiving the flash-borrowed asset
     * @dev Ensure that the contract can return the debt + premium, e.g., has
     *      enough funds to repay and has approved the Pool to pull the total amount
     * @param asset The address of the flash-borrowed asset
     * @param amount The amount of the flash-borrowed asset
     * @param premium The fee of the flash-borrowed asset
     * @param initiator The address of the flashloan initiator
     * @param params The byte-encoded params passed when initiating the flashloan
     * @return True if the execution of the operation succeeds, false otherwise
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title IPool
 * @dev Minimal interface for Aave V3 Pool flash loan functions
 */
interface IPool {
    /**
     * @notice Allows smartcontracts to access the liquidity of the pool within one transaction,
     * as long as the amount taken plus a fee is returned.
     * @param receiverAddress The address of the contract receiving the funds
     * @param asset The address of the asset being flash-borrowed
     * @param amount The amount of the asset being flash-borrowed
     * @param params Variadic packed params to pass to the receiver as extra information
     * @param referralCode Code used to register the integrator
     *
     * @custom:gas Typical Gas Costs
     * - Base flash loan overhead: ~60,000 gas (higher than Balancer due to Aave's accounting)
     * - Fee calculation: ~5,000 gas (queries FLASHLOAN_PREMIUM_TOTAL)
     * - Callback execution: Variable (depends on arbitrage complexity)
     * - Single-asset flash loan: ~350,000-600,000 gas total
     * - **Recommendation**: Budget 600,000 gas for single-asset arbitrage
     * - **Note**: Aave V3's 0.09% fee is relatively low (Balancer V2 is 0%), but base gas cost is slightly higher
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Returns the total fee on flash loans (in basis points)
     */
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

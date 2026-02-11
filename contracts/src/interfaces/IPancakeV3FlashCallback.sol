// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IPancakeV3FlashCallback
 * @dev Interface for PancakeSwap V3 flash loan callback
 * @notice Based on PancakeSwap V3's IPancakeV3FlashCallback interface
 * @custom:see https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
 */
interface IPancakeV3FlashCallback {
    /**
     * @notice Called to `msg.sender` after transferring to the recipient from IPancakeV3Pool#flash
     * @dev In the implementation you must repay the pool the tokens sent by flash plus the computed fee amounts.
     * The caller of this method must be checked to be a PancakeV3Pool deployed by the canonical PancakeV3Factory.
     * @param fee0 The fee amount in token0 due to the pool by the end of the flash
     * @param fee1 The fee amount in token1 due to the pool by the end of the flash
     * @param data Any data passed through by the caller via the IPancakeV3PoolActions#flash call
     */
    function pancakeV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external;
}

/**
 * @title IPancakeV3Pool
 * @dev Minimal interface for PancakeSwap V3 Pool flash loan functions
 */
interface IPancakeV3Pool {
    /**
     * @notice The pool's token0
     */
    function token0() external view returns (address);

    /**
     * @notice The pool's token1
     */
    function token1() external view returns (address);

    /**
     * @notice The pool's fee in hundredths of a bip (i.e., 1e-6)
     * @dev Returns one of: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
     */
    function fee() external view returns (uint24);

    /**
     * @notice The currently in-range liquidity available to the pool
     * @dev This value has no relationship to the total liquidity across all ticks
     * @return The liquidity at the current price of the pool
     */
    function liquidity() external view returns (uint128);

    /**
     * @notice Receive token0 and/or token1 and pay it back, plus a fee, in the callback
     * @dev The caller of this method receives a callback in the form of IPancakeV3FlashCallback#pancakeV3FlashCallback
     * @param recipient The address which will receive the token0 and token1 amounts
     * @param amount0 The amount of token0 to send (can be 0 if only borrowing token1)
     * @param amount1 The amount of token1 to send (can be 0 if only borrowing token0)
     * @param data Any data to be passed through to the callback
     *
     * @custom:requirements Input Validation
     * - At least one of (amount0, amount1) MUST be greater than 0
     * - recipient MUST be a contract that implements IPancakeV3FlashCallback
     * - Pool MUST have sufficient liquidity for requested amounts
     * - Caller must have sufficient gas for callback execution
     *
     * @custom:fees Fee Calculation
     * - fee0 = (amount0 * pool.fee()) / 1e6
     * - fee1 = (amount1 * pool.fee()) / 1e6
     * - Pool fee is one of: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
     *
     * @custom:repayment Repayment Requirements
     * - Recipient must repay: amount0 + fee0 and amount1 + fee1
     * - Repayment verified by checking pool balance after callback
     * - Insufficient repayment causes transaction to revert
     *
     * @custom:reverts
     * - Reverts if both amount0 and amount1 are 0
     * - Reverts if pool has insufficient liquidity
     * - Reverts if recipient callback reverts
     * - Reverts if repayment is insufficient (amount + fee not returned)
     * - Reverts if callback does not return from contract implementing IPancakeV3FlashCallback
     *
     * @custom:security Callback Validation
     * - The pool DOES NOT pre-validate recipient interface
     * - Validation happens when calling pancakeV3FlashCallback()
     * - Non-compliant recipients waste gas - validate off-chain first
     * - IMPORTANT: Verify callback caller is a legitimate PancakeSwap V3 pool
     *   (use factory.getPool() to verify pool address)
     *
     * @custom:gas Typical Gas Costs
     * - Base flash loan overhead: ~40,000 gas (efficient due to minimal state changes)
     * - Single-asset (amount0 or amount1): ~300,000-500,000 gas total
     * - Dual-asset (both amount0 and amount1): ~320,000-550,000 gas total
     * - Pool discovery (factory.getPool()): ~3,000 gas additional (for security validation)
     * - **Recommendation**: Budget 500,000 gas for single-asset, 550,000 for dual-asset
     * - **Note**: PancakeSwap V3 has lowest base overhead but variable fees (0.01%-1%)
     */
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}

/**
 * @title IPancakeV3Factory
 * @dev Minimal interface for PancakeSwap V3 Factory
 */
interface IPancakeV3Factory {
    /**
     * @notice Returns the pool address for a given pair of tokens and a fee, or address 0 if it does not exist
     * @param tokenA The contract address of either token0 or token1
     * @param tokenB The contract address of the other token
     * @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
     * @return pool The pool address
     */
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);
}

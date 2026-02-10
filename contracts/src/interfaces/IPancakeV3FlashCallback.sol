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
     * @param amount0 The amount of token0 to send
     * @param amount1 The amount of token1 to send
     * @param data Any data to be passed through to the callback
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

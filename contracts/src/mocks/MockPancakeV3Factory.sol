// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./MockPancakeV3Pool.sol";
import "../interfaces/IPancakeV3FlashCallback.sol";

/**
 * @title MockPancakeV3Factory
 * @dev Mock PancakeSwap V3 Factory for testing pool verification
 * @notice Implements IPancakeV3Factory.getPool() interface
 *
 * ## Factory Role in Flash Loan Security
 *
 * The factory contract maintains a registry of all legitimate PancakeSwap V3 pools.
 * When receiving a flash loan callback, contracts MUST verify the caller is a
 * real PancakeSwap V3 pool by:
 *
 * 1. Checking factory.getPool(token0, token1, fee) returns the caller address
 * 2. Or maintaining a whitelist of known pool addresses
 *
 * This prevents malicious contracts from:
 * - Calling pancakeV3FlashCallback() directly with fake fee amounts
 * - Draining funds by pretending to be a flash loan
 *
 * @custom:version 1.0.0
 */
contract MockPancakeV3Factory is IPancakeV3Factory {
    // Mapping: tokenA => tokenB => fee => pool
    // Note: Order doesn't matter (tokenA < tokenB normalized internally)
    mapping(address => mapping(address => mapping(uint24 => address))) private pools;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        address pool
    );

    /**
     * @notice Creates a new mock pool (for testing)
     * @param tokenA One of the two tokens in the pool
     * @param tokenB The other token in the pool
     * @param fee The desired fee tier (100, 500, 2500, 10000)
     * @return pool The address of the created pool
     */
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool) {
        require(tokenA != tokenB, "Identical tokens");
        require(tokenA != address(0) && tokenB != address(0), "Zero address");
        require(
            fee == 100 || fee == 500 || fee == 2500 || fee == 10000,
            "Invalid fee tier"
        );

        // Normalize token order (token0 < token1)
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        // Check pool doesn't already exist
        require(pools[token0][token1][fee] == address(0), "Pool already exists");

        // Deploy new pool
        MockPancakeV3Pool newPool = new MockPancakeV3Pool(
            token0,
            token1,
            fee,
            address(this)
        );

        pool = address(newPool);

        // Register pool in both directions for easy lookup
        pools[token0][token1][fee] = pool;
        pools[token1][token0][fee] = pool;

        emit PoolCreated(token0, token1, fee, pool);

        return pool;
    }

    /**
     * @notice Register an externally-deployed pool in the factory registry
     * @dev Test helper for registering pools deployed outside createPool().
     *      Useful when tests need direct control over pool constructor parameters.
     * @param tokenA One of the two tokens
     * @param tokenB The other token
     * @param fee The pool's fee tier
     * @param pool The deployed pool address to register
     */
    function registerPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        address pool
    ) external {
        require(pool != address(0), "Zero pool address");

        // Normalize token order (token0 < token1)
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        // Register pool in both directions for easy lookup
        pools[token0][token1][fee] = pool;
        pools[token1][token0][fee] = pool;

        emit PoolCreated(token0, token1, fee, pool);
    }

    /**
     * @notice Returns the pool address for a given pair of tokens and fee tier
     * @param tokenA One of the two tokens
     * @param tokenB The other token
     * @param fee The fee tier
     * @return pool The pool address, or address(0) if it doesn't exist
     */
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view override returns (address pool) {
        // Normalize token order
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        return pools[token0][token1][fee];
    }
}

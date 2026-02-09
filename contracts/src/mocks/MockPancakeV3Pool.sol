// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPancakeV3Pool
 * @dev Mock PancakeSwap V3 Pool for testing flash loans
 * @notice Implements IPancakeV3Pool.flash() interface
 *
 * ## PancakeSwap V3 Flash Loan Mechanism
 *
 * Unlike Aave V3 which has a central Pool contract, PancakeSwap V3 flash loans
 * are executed directly on individual pool contracts. Each pool can flash
 * token0 and/or token1 with a fee determined by the pool's fee tier.
 *
 * Fee Tiers:
 * - 100 (0.01%) - Lowest fee tier
 * - 500 (0.05%) - Common for stablecoin pairs
 * - 2500 (0.25%) - Standard fee tier (most pairs)
 * - 10000 (1.0%) - High volatility pairs
 *
 * Security Model:
 * - Callback caller must be verified to be a legitimate pool
 * - Factory contract maintains registry of valid pools
 * - Flash loan recipient must repay amount + fee before transaction ends
 */
contract MockPancakeV3Pool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable factory;

    event Flash(
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 paid0,
        uint256 paid1
    );

    /**
     * @param _token0 The first token of the pool
     * @param _token1 The second token of the pool
     * @param _fee The pool's fee in hundredths of a bip (100 = 0.01%, 500 = 0.05%, 2500 = 0.25%, 10000 = 1%)
     * @param _factory The factory contract address
     */
    constructor(
        address _token0,
        address _token1,
        uint24 _fee,
        address _factory
    ) {
        require(_token0 != address(0) && _token1 != address(0), "Invalid token addresses");
        require(_factory != address(0), "Invalid factory address");
        require(
            _fee == 100 || _fee == 500 || _fee == 2500 || _fee == 10000,
            "Invalid fee tier"
        );

        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        factory = _factory;
    }

    /**
     * @dev Simulates PancakeSwap V3 flash loan
     * @param recipient The address receiving the flash loan
     * @param amount0 The amount of token0 to flash
     * @param amount1 The amount of token1 to flash
     * @param data Arbitrary bytes to pass to the callback
     */
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        require(amount0 > 0 || amount1 > 0, "At least one amount must be > 0");

        // Calculate fees (fee is in hundredths of a bip, so divide by 1e6)
        uint256 fee0 = (amount0 * fee) / 1e6;
        uint256 fee1 = (amount1 * fee) / 1e6;

        // Record balances before flash loan
        uint256 balance0Before = IERC20(token0).balanceOf(address(this));
        uint256 balance1Before = IERC20(token1).balanceOf(address(this));

        // Transfer the flash loan amounts to recipient
        if (amount0 > 0) {
            IERC20(token0).safeTransfer(recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(token1).safeTransfer(recipient, amount1);
        }

        // Call the recipient's pancakeV3FlashCallback function
        (bool success, bytes memory result) = recipient.call(
            abi.encodeWithSignature(
                "pancakeV3FlashCallback(uint256,uint256,bytes)",
                fee0,
                fee1,
                data
            )
        );

        if (!success) {
            // Bubble up the revert reason
            if (result.length > 0) {
                assembly {
                    let resultSize := mload(result)
                    revert(add(32, result), resultSize)
                }
            } else {
                revert("Flash loan callback failed");
            }
        }

        // Verify that amount + fee was returned
        uint256 balance0After = IERC20(token0).balanceOf(address(this));
        uint256 balance1After = IERC20(token1).balanceOf(address(this));

        require(
            balance0After >= balance0Before + fee0,
            "Insufficient token0 repayment"
        );
        require(
            balance1After >= balance1Before + fee1,
            "Insufficient token1 repayment"
        );

        emit Flash(
            recipient,
            amount0,
            amount1,
            balance0After - balance0Before,
            balance1After - balance1Before
        );
    }

    /**
     * @dev Allows the pool to receive tokens for flash loan liquidity
     */
    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockGasHeavyReceiver
 * @dev Contract whose receive() requires >2300 gas (does SSTORE).
 * Used to test configurable withdrawGasLimit in BaseFlashArbitrage.
 */
contract MockGasHeavyReceiver {
    uint256 public receiveCount;

    receive() external payable {
        // SSTORE costs ~20000 gas, well above the 2300 stipend
        receiveCount++;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./MockERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @author Arbitrage System
 * @notice Mock ERC20 token that deducts a configurable fee on transfer.
 * @dev Simulates fee-on-transfer tokens (e.g., USDT, SafeMoon) where the
 *      received amount is less than the sent amount. Used for testing that
 *      arbitrage contracts handle the discrepancy correctly.
 *
 *      Fee is expressed in basis points (bps): 100 bps = 1%.
 *      Fee is deducted from the transfer amount and burned (not redirected).
 *
 *      Example: transfer(to, 1000) with feeBps=100 → to receives 990, 10 burned.
 *
 * @custom:version 1.0.0
 */
contract MockFeeOnTransferERC20 is MockERC20 {
    /// @notice Transfer fee in basis points (100 = 1%)
    uint256 public feeBps;

    /// @notice Maximum fee: 50% (5000 bps)
    uint256 public constant MAX_FEE_BPS = 5000;

    /// @notice Emitted when transfer fee is updated
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    /// @notice Thrown when fee exceeds MAX_FEE_BPS
    error FeeTooHigh(uint256 provided, uint256 max);

    /**
     * @notice Initializes the fee-on-transfer token
     * @param name_ Token name
     * @param symbol_ Token symbol
     * @param decimals_ Token decimals
     * @param feeBps_ Transfer fee in basis points (100 = 1%)
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_
    ) MockERC20(name_, symbol_, decimals_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        feeBps = feeBps_;
    }

    /**
     * @notice Update the transfer fee (for testing different fee levels)
     * @param newFeeBps New fee in basis points
     */
    function setFee(uint256 newFeeBps) external {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        uint256 oldFee = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(oldFee, newFeeBps);
    }

    /**
     * @notice Override transfer to deduct fee
     * @dev Fee is burned from the transfer amount. Recipient receives (amount - fee).
     * @param to Recipient address
     * @param amount Gross amount (before fee deduction)
     * @return True on success
     */
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        uint256 fee = (amount * feeBps) / 10000;
        uint256 netAmount = amount - fee;

        // Burn the fee from sender
        if (fee > 0) {
            _burn(msg.sender, fee);
        }

        // Transfer the net amount
        return super.transfer(to, netAmount);
    }

    /**
     * @notice Override transferFrom to deduct fee
     * @dev Fee is burned from the transfer amount. Recipient receives (amount - fee).
     *      Allowance is consumed for the full `amount` (not the net amount).
     * @param from Sender address
     * @param to Recipient address
     * @param amount Gross amount (before fee deduction)
     * @return True on success
     */
    function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool) {
        uint256 fee = (amount * feeBps) / 10000;
        uint256 netAmount = amount - fee;

        // Spend allowance for full amount (standard behavior)
        _spendAllowance(from, msg.sender, amount);

        // Burn the fee from sender
        if (fee > 0) {
            _burn(from, fee);
        }

        // Transfer the net amount
        _transfer(from, to, netAmount);
        return true;
    }
}

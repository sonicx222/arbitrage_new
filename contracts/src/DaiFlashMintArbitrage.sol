// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/IERC3156FlashLender.sol";
import "./interfaces/ISyncSwapVault.sol";
import "./interfaces/IFlashLoanErrors.sol";
import "./interfaces/IDexRouter.sol";

/**
 * @title DaiFlashMintArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract using MakerDAO's DssFlash DAI flash minting (EIP-3156)
 * @dev Implements IERC3156FlashBorrower for EIP-3156 compliant flash loan integration
 *
 * Features:
 * - DAI flash minting via MakerDAO DssFlash module (0.01% fee / 1 bps)
 * - EIP-3156 standard compliance for interoperability
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * DAI Flash Mint Characteristics:
 * - Extremely low fee: 1 bps (0.01%) — lowest of any flash loan source
 * - No liquidity constraint (mints fresh DAI, limited only by debt ceiling)
 * - Ethereum mainnet only (DssFlash is Ethereum-only)
 * - EIP-3156 compliant callback interface
 * - Single asset: DAI only
 *
 * Security Model:
 * - Only DssFlash can call onFlashLoan() callback
 * - Approved router system prevents malicious DEX interactions
 * - Initiator verification ensures callback initiated by this contract
 * - Returns correct EIP-3156 success hash
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.1.0
 * @custom:implementation-plan Task 1A - DAI Flash Mint Provider (Ethereum)
 * @custom:standard EIP-3156 Flash Loans
 *
 * @custom:warning UNSUPPORTED TOKEN TYPES
 * This contract does NOT support:
 * - Fee-on-transfer tokens: Tokens that deduct fees during transfer will cause
 *   InsufficientProfit errors because received amounts don't match expected amounts.
 * - Rebasing tokens: Tokens that change balance over time may cause repayment failures
 *   if balance decreases mid-transaction.
 * Using these token types will result in failed transactions and wasted gas.
 */
contract DaiFlashMintArbitrage is
    BaseFlashArbitrage,
    IERC3156FlashBorrower,
    IFlashLoanErrors
{
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants (Protocol-Specific)
    // ==========================================================================

    /// @notice EIP-3156 success return value
    /// @dev Must return this exact value from onFlashLoan() to signal success
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    // ==========================================================================
    // State Variables (Protocol-Specific)
    // ==========================================================================

    /// @notice The DssFlash contract address for flash minting
    IERC3156FlashLender public immutable DSS_FLASH;

    /// @notice The DAI token address
    address public immutable DAI;

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    // InvalidProtocolAddress, InvalidFlashLoanCaller, InvalidFlashLoanInitiator
    // inherited from IFlashLoanErrors
    error FlashLoanFailed();
    error InvalidDaiAddress();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the DaiFlashMintArbitrage contract
     * @param _dssFlash The DssFlash contract address
     * @param _dai The DAI token address
     * @param _owner The contract owner address
     */
    constructor(
        address _dssFlash,
        address _dai,
        address _owner
    ) BaseFlashArbitrage(_owner) {
        if (_dssFlash == address(0)) revert InvalidProtocolAddress();

        // Verify DssFlash is a contract (has code deployed)
        // Protection against typos or EOA addresses during deployment
        if (_dssFlash.code.length == 0) revert InvalidProtocolAddress();

        if (_dai == address(0)) revert InvalidDaiAddress();

        // Verify DAI is a contract
        if (_dai.code.length == 0) revert InvalidDaiAddress();

        DSS_FLASH = IERC3156FlashLender(_dssFlash);
        DAI = _dai;
    }

    // ==========================================================================
    // External Functions - Arbitrage Execution
    // ==========================================================================

    /**
     * @notice Executes a flash mint arbitrage using EIP-3156 interface
     * @dev Always uses DAI — no asset parameter needed (always DAI)
     * @param amount The amount of DAI to flash mint
     * @param swapPath Array of swap steps defining the arbitrage path
     * @param minProfit Minimum required profit (reverts if not achieved)
     * @param deadline Absolute deadline (block.timestamp) - reverts if current block is after deadline
     *
     * @dev Initiates flash mint from DssFlash, executes swaps, verifies profit.
     *      The DssFlash module will call onFlashLoan() callback during execution.
     */
    function executeArbitrage(
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        // Use base contract validation (DAI is always the asset)
        _validateArbitrageParams(DAI, amount, deadline, swapPath);

        // Encode the swap path and minimum profit for the callback
        bytes memory userData = abi.encode(swapPath, minProfit);

        // Initiate EIP-3156 flash loan (DAI flash mint)
        // DssFlash will mint DAI to this contract, call onFlashLoan(), then verify repayment
        bool success = DSS_FLASH.flashLoan(
            IERC3156FlashBorrower(this),
            DAI,
            amount,
            userData
        );

        if (!success) revert FlashLoanFailed();
    }

    /**
     * @notice EIP-3156 callback function called by DssFlash during flash mint
     * @dev Must repay borrowed DAI + fee before returning. Returns ERC3156_CALLBACK_SUCCESS on success.
     * @param initiator The address that initiated the flash loan (should be this contract)
     * @param token The token that was flash minted (always DAI)
     * @param amount The amount that was flash minted
     * @param fee The flash mint fee (1 bps = 0.01%)
     * @param data Encoded swap path and minimum profit
     * @return ERC3156_CALLBACK_SUCCESS if successful
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        // Security: Only DssFlash can call this function
        if (msg.sender != address(DSS_FLASH)) revert InvalidFlashLoanCaller();

        // Security: Verify the flash loan was initiated by this contract
        // Prevents external actors from triggering callbacks
        if (initiator != address(this)) revert InvalidFlashLoanInitiator();

        // Defense-in-depth: DssFlash should only callback with DAI, but verify
        // in case of future DssFlash upgrades or misconfiguration
        if (token != DAI) revert InvalidDaiAddress();

        // Decode user data
        (SwapStep[] memory swapPath, uint256 minProfit) = abi.decode(
            data,
            (SwapStep[], uint256)
        );

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(token, amount, swapPath, _getSwapDeadline());

        // Calculate amount owed (principal + fee)
        uint256 amountOwed = amount + fee;

        // Verify we received enough to repay loan + fee
        if (amountReceived < amountOwed) revert InsufficientProfit();

        // Calculate actual profit
        uint256 profit = amountReceived - amountOwed;

        // Verify profit meets thresholds and update tracking (base contract)
        _verifyAndTrackProfit(profit, minProfit, token);

        // Repayment: PULL pattern - DssFlash pulls tokens via transferFrom
        // after callback returns (EIP-3156 standard behavior).
        // Use forceApprove for safe non-zero to non-zero approval handling.
        IERC20(token).forceApprove(address(DSS_FLASH), amountOwed);

        // Emit success event
        emit ArbitrageExecuted(token, amount, profit, block.timestamp, tx.origin);

        // Return EIP-3156 success code
        return ERC3156_CALLBACK_SUCCESS;
    }

    // Note: _executeSwaps function inherited from BaseFlashArbitrage

    // ==========================================================================
    // External Functions - View
    // ==========================================================================

    /**
     * @notice Calculate expected profit for an arbitrage opportunity
     * @dev Simulates swaps via DEX router getAmountsOut() without executing.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage.
     *
     * @param amount The amount of DAI to flash mint
     * @param swapPath Array of swap steps defining the arbitrage path
     * @return expectedProfit Expected profit after fees (0 if unprofitable or invalid)
     * @return flashLoanFee Flash loan fee amount (1 bps, queried from DssFlash)
     */
    function calculateExpectedProfit(
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Query exact fee from DssFlash
        flashLoanFee = DSS_FLASH.flashFee(DAI, amount);

        uint256 simulatedOutput = _simulateSwapPath(DAI, amount, swapPath);
        if (simulatedOutput == 0) {
            return (0, flashLoanFee);
        }

        expectedProfit = _calculateProfit(amount, simulatedOutput, flashLoanFee);
        return (expectedProfit, flashLoanFee);
    }

    // Note: Router management, config, and emergency functions inherited from BaseFlashArbitrage
}

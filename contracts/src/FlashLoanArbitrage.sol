// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IFlashLoanReceiver.sol";

/**
 * @title FlashLoanArbitrage
 * @author Arbitrage System
 * @notice Flash loan arbitrage contract for executing profitable trades using Aave V3 flash loans
 * @dev Implements IFlashLoanSimpleReceiver for Aave V3 integration
 *
 * Features:
 * - Aave V3 flash loan integration (0.09% fee)
 * - Multi-hop swap execution across multiple DEX routers
 * - Profit verification with minimum profit threshold
 * - Reentrancy protection
 * - Access control for router approval and fund withdrawal
 * - Emergency pause functionality
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 1.0.0
 *
 * @see implementation_plan_v2.md Task 3.1.1
 */
contract FlashLoanArbitrage is
    IFlashLoanSimpleReceiver,
    Ownable,
    Pausable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The Aave V3 Pool address for flash loans
    IPool public immutable POOL;

    /// @notice Minimum profit required for arbitrage execution (in token units)
    uint256 public minimumProfit;

    /// @notice Total profits accumulated (for tracking)
    uint256 public totalProfits;

    /// @notice Mapping of approved DEX routers
    mapping(address => bool) public isApprovedRouter;

    /// @notice List of all approved routers (for enumeration)
    address[] public approvedRouters;

    // ==========================================================================
    // Structs
    // ==========================================================================

    /**
     * @notice Represents a single swap step in the arbitrage path
     * @param router The DEX router to use for this swap
     * @param tokenIn The input token for this swap
     * @param tokenOut The output token for this swap
     * @param amountOutMin Minimum acceptable output amount (slippage protection)
     */
    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin;
    }

    // ==========================================================================
    // Events
    // ==========================================================================

    /// @notice Emitted when an arbitrage is executed successfully
    event ArbitrageExecuted(
        address indexed asset,
        uint256 amount,
        uint256 profit,
        uint256 timestamp
    );

    /// @notice Emitted when a router is added to the approved list
    event RouterAdded(address indexed router);

    /// @notice Emitted when a router is removed from the approved list
    event RouterRemoved(address indexed router);

    /// @notice Emitted when minimum profit is updated
    event MinimumProfitUpdated(uint256 oldValue, uint256 newValue);

    /// @notice Emitted when tokens are withdrawn
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when ETH is withdrawn
    event ETHWithdrawn(address indexed to, uint256 amount);

    // ==========================================================================
    // Errors
    // ==========================================================================

    error InvalidPoolAddress();
    error InvalidRouterAddress();
    error RouterAlreadyApproved();
    error RouterNotApproved();
    error EmptySwapPath();
    error InvalidSwapPath();
    error InsufficientProfit();
    error InvalidFlashLoanInitiator();
    error InvalidFlashLoanCaller();
    error SwapFailed();
    error InsufficientOutputAmount();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the FlashLoanArbitrage contract
     * @param _pool The Aave V3 Pool address
     * @param _owner The contract owner address
     */
    constructor(address _pool, address _owner) Ownable(_owner) {
        require(_pool != address(0), "Invalid pool address");
        POOL = IPool(_pool);
    }

    // ==========================================================================
    // External Functions - Arbitrage Execution
    // ==========================================================================

    /**
     * @notice Executes a flash loan arbitrage
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps defining the arbitrage path
     * @param minProfit Minimum required profit (reverts if not achieved)
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit
    ) external nonReentrant whenNotPaused {
        require(swapPath.length > 0, "Empty swap path");

        // Validate all routers in the path are approved
        for (uint256 i = 0; i < swapPath.length; i++) {
            require(isApprovedRouter[swapPath[i].router], "Router not approved");
        }

        // Encode the swap path and minimum profit for the callback
        bytes memory params = abi.encode(swapPath, minProfit);

        // Initiate flash loan
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0 // referralCode
        );
    }

    /**
     * @notice Callback function called by Aave Pool during flash loan
     * @dev Must return true and repay loan + premium for success
     * @param asset The asset that was flash-borrowed
     * @param amount The amount that was flash-borrowed
     * @param premium The fee to pay for the flash loan
     * @param initiator The address that initiated the flash loan
     * @param params Encoded swap path and minimum profit
     * @return True if the operation succeeds
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Security: Verify caller is the Aave Pool
        require(msg.sender == address(POOL), "Invalid flash loan caller");

        // Security: Verify initiator is this contract
        require(initiator == address(this), "Invalid flash loan initiator");

        // Decode parameters
        (SwapStep[] memory swapPath, uint256 minProfit) = abi.decode(
            params,
            (SwapStep[], uint256)
        );

        // Execute multi-hop swaps
        uint256 amountReceived = _executeSwaps(asset, amount, swapPath);

        // Calculate required repayment and profit
        uint256 amountOwed = amount + premium;
        require(amountReceived >= amountOwed, "Insufficient funds to repay");

        uint256 profit = amountReceived - amountOwed;

        // Verify minimum profit threshold
        uint256 effectiveMinProfit = minProfit > minimumProfit ? minProfit : minimumProfit;
        require(profit >= effectiveMinProfit, "Profit below minimum");

        // Update profit tracking
        totalProfits += profit;

        // Approve the Pool to pull the owed amount
        IERC20(asset).safeIncreaseAllowance(address(POOL), amountOwed);

        emit ArbitrageExecuted(asset, amount, profit, block.timestamp);

        return true;
    }

    // ==========================================================================
    // Internal Functions - Swap Execution
    // ==========================================================================

    /**
     * @notice Executes multi-hop swaps according to the swap path
     * @param startAsset The starting asset (flash loaned asset)
     * @param startAmount The starting amount
     * @param swapPath Array of swap steps
     * @return finalAmount The final amount after all swaps
     */
    function _executeSwaps(
        address startAsset,
        uint256 startAmount,
        SwapStep[] memory swapPath
    ) internal returns (uint256 finalAmount) {
        uint256 currentAmount = startAmount;
        address currentToken = startAsset;

        for (uint256 i = 0; i < swapPath.length; i++) {
            SwapStep memory step = swapPath[i];

            // Validate swap step
            require(step.tokenIn == currentToken, "Invalid swap path");
            require(isApprovedRouter[step.router], "Router not approved");

            // Approve router to spend tokens
            IERC20(currentToken).safeIncreaseAllowance(step.router, currentAmount);

            // Build path for the swap
            address[] memory path = new address[](2);
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            // Execute swap
            uint256[] memory amounts = IDexRouter(step.router).swapExactTokensForTokens(
                currentAmount,
                step.amountOutMin,
                path,
                address(this),
                block.timestamp + 300 // 5 minute deadline
            );

            // Verify output
            uint256 amountOut = amounts[amounts.length - 1];
            require(amountOut >= step.amountOutMin, "Insufficient output amount");

            // Update for next iteration
            currentAmount = amountOut;
            currentToken = step.tokenOut;
        }

        // Verify we end up with the same asset we started with (for repayment)
        require(currentToken == startAsset, "Must end with flash loan asset");

        return currentAmount;
    }

    // ==========================================================================
    // Admin Functions - Router Management
    // ==========================================================================

    /**
     * @notice Adds a router to the approved list
     * @param router The router address to approve
     */
    function addApprovedRouter(address router) external onlyOwner {
        require(router != address(0), "Invalid router address");
        require(!isApprovedRouter[router], "Router already approved");

        isApprovedRouter[router] = true;
        approvedRouters.push(router);

        emit RouterAdded(router);
    }

    /**
     * @notice Removes a router from the approved list
     * @param router The router address to remove
     */
    function removeApprovedRouter(address router) external onlyOwner {
        require(isApprovedRouter[router], "Router not approved");

        isApprovedRouter[router] = false;

        // Remove from array (find and swap with last element)
        for (uint256 i = 0; i < approvedRouters.length; i++) {
            if (approvedRouters[i] == router) {
                approvedRouters[i] = approvedRouters[approvedRouters.length - 1];
                approvedRouters.pop();
                break;
            }
        }

        emit RouterRemoved(router);
    }

    /**
     * @notice Returns all approved routers
     * @return Array of approved router addresses
     */
    function getApprovedRouters() external view returns (address[] memory) {
        return approvedRouters;
    }

    // ==========================================================================
    // Admin Functions - Configuration
    // ==========================================================================

    /**
     * @notice Sets the minimum profit threshold
     * @param _minimumProfit The new minimum profit value
     */
    function setMinimumProfit(uint256 _minimumProfit) external onlyOwner {
        uint256 oldValue = minimumProfit;
        minimumProfit = _minimumProfit;
        emit MinimumProfitUpdated(oldValue, _minimumProfit);
    }

    /**
     * @notice Pauses the contract (emergency stop)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ==========================================================================
    // Admin Functions - Fund Recovery
    // ==========================================================================

    /**
     * @notice Withdraws ERC20 tokens from the contract
     * @param token The token address to withdraw
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    /**
     * @notice Withdraws ETH from the contract
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
        emit ETHWithdrawn(to, amount);
    }

    // ==========================================================================
    // View Functions
    // ==========================================================================

    /**
     * @notice Calculates the expected profit for an arbitrage opportunity
     * @dev This is a simulation that doesn't execute the actual swaps
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param swapPath Array of swap steps
     * @return expectedProfit The expected profit after all fees
     * @return flashLoanFee The flash loan fee
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit, uint256 flashLoanFee) {
        // Calculate flash loan fee (0.09% for Aave V3)
        uint128 premiumBps = POOL.FLASHLOAN_PREMIUM_TOTAL();
        flashLoanFee = (amount * premiumBps) / 10000;

        // Simulate swaps to get expected output
        uint256 currentAmount = amount;
        address currentToken = asset;

        for (uint256 i = 0; i < swapPath.length; i++) {
            SwapStep calldata step = swapPath[i];

            if (step.tokenIn != currentToken) {
                return (0, flashLoanFee); // Invalid path
            }

            // Get expected output from router
            address[] memory path = new address[](2);
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            try IDexRouter(step.router).getAmountsOut(currentAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
                currentToken = step.tokenOut;
            } catch {
                return (0, flashLoanFee); // Router call failed
            }
        }

        // Check if we end with the correct asset
        if (currentToken != asset) {
            return (0, flashLoanFee);
        }

        // Calculate profit
        uint256 amountOwed = amount + flashLoanFee;
        if (currentAmount > amountOwed) {
            expectedProfit = currentAmount - amountOwed;
        } else {
            expectedProfit = 0;
        }

        return (expectedProfit, flashLoanFee);
    }

    // ==========================================================================
    // Receive Function
    // ==========================================================================

    /**
     * @notice Allows the contract to receive ETH
     */
    receive() external payable {}
}

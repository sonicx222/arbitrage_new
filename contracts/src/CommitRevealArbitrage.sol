// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IDexRouter.sol";
import "./libraries/SwapHelpers.sol";

/**
 * @title CommitRevealArbitrage
 * @author Arbitrage System
 * @notice Two-phase commit-reveal MEV protection for multi-router DEX arbitrage
 * @dev Implements commit-reveal pattern to prevent sandwich attacks on high-risk transactions
 *
 * ## Architecture
 *
 * Flow:
 * 1. COMMIT: Store commitment hash on-chain (hides trade parameters)
 * 2. WAIT: Minimum 1 block delay (prevents same-block MEV)
 * 3. REVEAL: Reveal parameters and execute multi-hop arbitrage atomically
 *
 * ## Multi-Router Support (v2.0.0)
 *
 * Supports arbitrage across multiple DEXes via SwapStep[] array:
 * - Example: WETH → USDC (Uniswap) → WETH (SushiSwap)
 * - Each hop can use a different router
 * - Path must start and end with same asset
 * - Maximum 5 hops (configurable via MAX_SWAP_HOPS)
 *
 * ## Security Features
 *
 * - Ownable2Step: Safe ownership transfer (two-transaction process)
 * - Pausable: Emergency stop mechanism
 * - ReentrancyGuard: Protection against reentrancy attacks
 * - Router whitelist: Only approved DEX routers can execute swaps
 * - Path validation: Validates token continuity and asset matching
 * - Time bounds: Commitments expire after 10 blocks to prevent staleness
 * - Replay protection: Each commitment can only be revealed once
 *
 * ## Use Cases
 *
 * Automatically activated by execution engine when:
 * - MEV risk score >= 70 (HIGH or CRITICAL risk)
 * - Strategy is IntraChainStrategy or CrossChainStrategy
 * - Private mempool (Flashbots/Jito) unavailable or failed
 *
 * ## Gas Optimization
 *
 * - Batch commits: Multiple opportunities in one transaction
 * - Cancel mechanism: Gas refund for abandoned commitments
 * - Minimal storage: Only commitment hash and block number
 * - Router validation caching: Skips repeated router checks
 * - Pre-allocated path array: Reused across all swaps
 *
 * @custom:security-contact security@arbitrage.system
 * @custom:version 2.0.0
 * @custom:implementation-plan Task 3.1: Commit-Reveal Smart Contract (Pragmatic Balance)
 * @custom:breaking-change v2.0.0 - Changed RevealParams to support multi-router arbitrage
 */
contract CommitRevealArbitrage is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants
    // ==========================================================================

    /// @notice Minimum blocks between commit and reveal (prevents same-block reveal)
    uint256 public constant MIN_DELAY_BLOCKS = 1;

    /// @notice Maximum blocks for commitment validity (prevents staleness)
    /// @dev 10 blocks = ~2 minutes on most chains (12s blocks)
    uint256 public constant MAX_COMMIT_AGE_BLOCKS = 10;

    /// @notice Maximum swap deadline from reveal time (prevents stale swaps)
    uint256 public constant MAX_SWAP_DEADLINE = 300; // 5 minutes

    /// @notice Maximum number of hops in a swap path (prevents DoS)
    uint256 public constant MAX_SWAP_HOPS = 5;

    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice Commitment storage: commitmentHash => commit block number
    /// @dev Block number of 0 means commitment doesn't exist
    mapping(bytes32 => uint256) public commitments;

    /// @notice Revealed commitments: commitmentHash => revealed status
    /// @dev Prevents replay attacks (revealing same commitment twice)
    mapping(bytes32 => bool) public revealed;

    /// @notice Commitment committers: commitmentHash => committer address
    /// @dev Prevents griefing attacks where others commit the same hash
    mapping(bytes32 => address) public committers;

    /// @notice Approved DEX routers for swap execution
    /// @dev Only whitelisted routers can execute swaps (security measure)
    mapping(address => bool) public approvedRouters;

    /// @notice Minimum profit threshold (in token units)
    /// @dev Configurable by owner, prevents unprofitable reveals
    uint256 public minimumProfit;

    // ==========================================================================
    // Structs
    // ==========================================================================

    /**
     * @notice Single swap step in arbitrage path
     * @dev Matches SwapStep struct from other flash loan contracts for consistency
     *
     * @param router DEX router address (must be approved)
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param amountOutMin Minimum output amount (slippage protection)
     */
    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin;
    }

    /**
     * @notice Parameters for reveal phase
     * @dev These parameters are committed as a hash, then revealed on execution
     *
     * ## v2.0.0 Breaking Change
     * Changed from single router to SwapStep[] array to support multi-router arbitrage.
     * Previous version only supported single-router arbitrage which is rarely profitable.
     *
     * @param asset Initial asset address (e.g., WETH) - path must start and end with this
     * @param amountIn Amount of initial asset to swap
     * @param swapPath Array of swap steps (e.g., [WETH→USDC on Uniswap, USDC→WETH on SushiSwap])
     * @param minProfit Minimum profit required (in asset units)
     * @param deadline Swap deadline timestamp (must be <= now + MAX_SWAP_DEADLINE)
     * @param salt Random 32-byte salt for commitment hash (prevents preimage attacks)
     */
    struct RevealParams {
        address asset;
        uint256 amountIn;
        SwapStep[] swapPath;
        uint256 minProfit;
        uint256 deadline;
        bytes32 salt;
    }

    // ==========================================================================
    // Events
    // ==========================================================================

    /// @notice Emitted when a commitment is stored on-chain
    event Committed(bytes32 indexed commitmentHash, uint256 blockNumber, address indexed committer);

    /// @notice Emitted when a commitment is revealed and executed
    event Revealed(
        bytes32 indexed commitmentHash,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 profit
    );

    /// @notice Emitted when a commitment is cancelled (gas refund)
    event CommitCancelled(bytes32 indexed commitmentHash, address indexed canceller);

    /// @notice Emitted when a router is approved
    event RouterApproved(address indexed router);

    /// @notice Emitted when a router is revoked
    event RouterRevoked(address indexed router);

    /// @notice Emitted when minimum profit is updated
    event MinimumProfitUpdated(uint256 oldValue, uint256 newValue);

    // ==========================================================================
    // Errors
    // ==========================================================================

    error CommitmentAlreadyExists();
    error CommitmentNotFound();
    error CommitmentAlreadyRevealed();
    error CommitmentTooRecent();
    error CommitmentExpired();
    error InvalidCommitmentHash();
    error UnauthorizedRevealer();
    error RouterNotApproved();
    error InsufficientProfit();
    error BelowMinimumProfit();
    error InvalidDeadline();
    error SwapFailed();
    error InvalidRouterAddress();
    error InvalidOwnerAddress();
    error InvalidAmount();
    error EmptySwapPath();
    error PathTooLong(uint256 length, uint256 maxLength);
    error InvalidSwapPath();
    error SwapPathAssetMismatch();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the CommitRevealArbitrage contract
     * @param _owner The contract owner address
     */
    constructor(address _owner) {
        if (_owner == address(0)) revert InvalidOwnerAddress();
        _transferOwnership(_owner);
        // Set minimumProfit to 0 by default - MUST be configured by owner before use
        // Prevents accidental deployment with insufficient profit threshold
        // Note: Commit+reveal gas cost ~315k gas (~$10 @ 20 gwei, $2500 ETH)
        // Recommend: 0.01 ETH (~$25) for mainnet, 0.005 ETH for L2s
        minimumProfit = 0;
    }

    // ==========================================================================
    // Commit Phase
    // ==========================================================================

    /**
     * @notice Commit to an arbitrage opportunity
     * @dev Stores commitment hash to prevent frontrunning. Actual parameters hidden until reveal.
     *
     * Gas cost: ~65,000 (2x SSTORE + event emission)
     *
     * Requirements:
     * - Contract not paused
     * - Commitment doesn't already exist
     *
     * Security: Only the committer can reveal their commitment (prevents griefing)
     *
     * @param commitmentHash Keccak256 hash of RevealParams
     */
    function commit(bytes32 commitmentHash) external whenNotPaused {
        if (commitments[commitmentHash] != 0) revert CommitmentAlreadyExists();

        commitments[commitmentHash] = block.number;
        committers[commitmentHash] = msg.sender;
        emit Committed(commitmentHash, block.number, msg.sender);
    }

    /**
     * @notice Batch commit multiple opportunities in one transaction
     * @dev More gas-efficient than individual commits for multiple opportunities
     *
     * Gas cost: ~60,000 per commitment (saves ~5k gas vs individual commits)
     *
     * Requirements:
     * - Contract not paused
     * - No commitments already exist
     *
     * @param commitmentHashes Array of commitment hashes
     * @return successCount Number of successfully committed hashes
     */
    function batchCommit(bytes32[] calldata commitmentHashes) external whenNotPaused returns (uint256 successCount) {
        uint256 len = commitmentHashes.length;
        uint256 currentBlock = block.number;

        for (uint256 i = 0; i < len;) {
            bytes32 hash = commitmentHashes[i];

            // Skip if commitment already exists (don't revert entire batch)
            if (commitments[hash] == 0) {
                commitments[hash] = currentBlock;
                committers[hash] = msg.sender;
                emit Committed(hash, currentBlock, msg.sender);
                successCount++;
            }

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Cancel a commitment before reveal (gas refund mechanism)
     * @dev Deletes commitment storage to provide partial gas refund
     *
     * Use case: Opportunity no longer profitable, cancel to recover gas
     *
     * Requirements:
     * - Commitment must exist
     * - Commitment not already revealed
     *
     * @param commitmentHash Hash to cancel
     */
    function cancelCommit(bytes32 commitmentHash) external {
        if (commitments[commitmentHash] == 0) revert CommitmentNotFound();
        if (revealed[commitmentHash]) revert CommitmentAlreadyRevealed();

        delete commitments[commitmentHash];
        emit CommitCancelled(commitmentHash, msg.sender);
    }

    // ==========================================================================
    // Reveal Phase
    // ==========================================================================

    /**
     * @notice Reveal commitment and execute multi-hop arbitrage swap
     * @dev Validates commitment hash, timing, path, and routers, then executes swaps atomically
     *
     * Gas cost: ~150,000-500,000 depending on path length and complexity
     *
     * Security validations:
     * 1. Commitment hash matches revealed parameters
     * 2. At least 1 block has passed since commit
     * 3. Commitment not expired (< 10 blocks old)
     * 4. Swap deadline is reasonable (< 5 minutes)
     * 5. Swap path not empty and not too long (<= MAX_SWAP_HOPS)
     * 6. Path starts with asset and ends with asset
     * 7. All routers in path are approved
     * 8. Token continuity validated (each hop's tokenOut = next hop's tokenIn)
     * 9. Commitment not already revealed (replay protection)
     *
     * Execution flow:
     * 1. Validate commitment and timing
     * 2. Validate swap path structure
     * 3. Execute each swap in the path sequentially
     * 4. Verify profit >= minProfit and >= minimumProfit
     * 5. Emit Revealed event with actual profit
     *
     * Requirements:
     * - Contract not paused
     * - All validations pass
     * - All swaps succeed with sufficient profit
     *
     * @param params Reveal parameters (must match committed hash)
     */
    function reveal(RevealParams calldata params)
        external
        nonReentrant
        whenNotPaused
    {
        // 1. Validate commitment hash
        bytes32 commitmentHash = keccak256(abi.encode(params));
        uint256 commitBlock = commitments[commitmentHash];

        if (commitBlock == 0) revert CommitmentNotFound();
        if (revealed[commitmentHash]) revert CommitmentAlreadyRevealed();

        // 2. Validate committer (prevents griefing attacks)
        if (committers[commitmentHash] != msg.sender) revert UnauthorizedRevealer();

        // 3. Validate timing
        if (block.number < commitBlock + MIN_DELAY_BLOCKS) revert CommitmentTooRecent();
        if (block.number > commitBlock + MAX_COMMIT_AGE_BLOCKS) revert CommitmentExpired();

        // 4. Validate deadline
        if (block.timestamp > params.deadline) revert InvalidDeadline();
        if (params.deadline > block.timestamp + MAX_SWAP_DEADLINE) revert InvalidDeadline();

        // 5. Validate amount and swap path
        if (params.amountIn == 0) revert InvalidAmount();

        uint256 pathLength = params.swapPath.length;
        if (pathLength == 0) revert EmptySwapPath();
        if (pathLength > MAX_SWAP_HOPS) revert PathTooLong(pathLength, MAX_SWAP_HOPS);

        // 6. Validate swap path structure
        // First hop must start with the flash-loaned asset
        if (params.swapPath[0].tokenIn != params.asset) revert SwapPathAssetMismatch();

        // Validate each hop: router approval, token continuity, slippage protection
        address lastValidatedRouter = address(0);
        address expectedTokenIn = params.asset;

        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = params.swapPath[i];

            // Validate router approval (cache to skip repeated validations)
            if (step.router != lastValidatedRouter) {
                if (!approvedRouters[step.router]) revert RouterNotApproved();
                lastValidatedRouter = step.router;
            }

            // Validate token continuity
            if (step.tokenIn != expectedTokenIn) revert InvalidSwapPath();

            // Update expected token for next hop
            expectedTokenIn = step.tokenOut;

            unchecked { ++i; }
        }

        // Last hop must end with the original asset (for profit calculation)
        if (expectedTokenIn != params.asset) revert InvalidSwapPath();

        // 6. Mark as revealed and cleanup storage (reentrancy protection + gas refund)
        revealed[commitmentHash] = true;
        delete commitments[commitmentHash];
        delete committers[commitmentHash];

        // 7. Execute arbitrage swap
        uint256 profit = _executeArbitrageSwap(params);

        // 8. Verify profit meets minimum thresholds
        // Check user-specified minimum first (per-commitment threshold)
        if (profit < params.minProfit) revert InsufficientProfit();

        // Check contract-wide minimum (owner-controlled floor)
        if (profit < minimumProfit) revert BelowMinimumProfit();

        // Emit event with first and last tokens in the path for tracking
        emit Revealed(
            commitmentHash,
            params.swapPath[0].tokenIn,  // First token in path
            params.swapPath[pathLength - 1].tokenOut, // Last token in path
            profit
        );
    }

    // ==========================================================================
    // Internal Functions
    // ==========================================================================

    /**
     * @notice Execute multi-hop arbitrage swap path
     * @dev Uses SwapHelpers library for shared swap logic (DRY principle)
     *
     * ## v2.1.0 Update - Fixed Profit Calculation (BUG FIX)
     * Changed from balance-based to amount-based profit tracking.
     * Previous version used balanceOf() which could be affected by residual
     * token balances from previous operations. New version tracks amounts
     * through the swap path directly, matching the pattern used in all
     * flash loan contracts for consistency.
     *
     * ## v2.0.0 Update
     * Refactored to support multi-hop paths (e.g., WETH → USDC → DAI → WETH)
     * Previously only supported single-router round trips.
     *
     * Flow:
     * 1. Start with params.amountIn
     * 2. Execute each swap in the path sequentially
     * 3. Calculate profit (final amount - initial amount)
     *
     * @param params Reveal parameters with swap path
     * @return profit Profit amount in asset units
     */
    function _executeArbitrageSwap(RevealParams calldata params)
        internal
        returns (uint256 profit)
    {
        uint256 currentAmount = params.amountIn;
        address currentToken = params.asset;
        uint256 pathLength = params.swapPath.length;

        // Gas optimization: Pre-allocate path array once, reuse across iterations
        address[] memory path = new address[](2);

        // Execute each swap in the path
        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = params.swapPath[i];

            // Execute swap using shared library function
            currentAmount = SwapHelpers.executeSingleSwap(
                currentToken,
                currentAmount,
                step.router,
                step.tokenIn,
                step.tokenOut,
                step.amountOutMin,
                path,
                params.deadline
            );

            // Update for next iteration
            currentToken = step.tokenOut;

            unchecked { ++i; }
        }

        // Verify we end up with the same asset we started with (for profit calculation)
        if (currentToken != params.asset) revert InvalidSwapPath();

        // Calculate profit: final amount - initial amount
        // Safety check: final amount must exceed initial investment
        if (currentAmount <= params.amountIn) revert InsufficientProfit();

        profit = currentAmount - params.amountIn;
    }

    // ==========================================================================
    // View Functions
    // ==========================================================================

    /**
     * @notice Calculate expected profit for commit-reveal arbitrage
     * @dev Simulates the arbitrage path without executing on-chain
     *      No flash loan fees for commit-reveal (user provides upfront capital)
     *
     * @param asset The asset to swap (must start and end with this)
     * @param amountIn The amount to swap
     * @param swapPath Array of swap steps defining the arbitrage path
     * @return expectedProfit The expected profit (0 if unprofitable or invalid path)
     *
     * ## Usage
     * This function allows off-chain profit simulation before committing.
     * Returns 0 for any invalid path or unprofitable opportunity.
     *
     * ## Gas Cost
     * View function - free to call (no gas cost)
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amountIn,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit) {
        uint256 pathLength = swapPath.length;

        // Validate basic requirements
        if (pathLength == 0 || amountIn == 0) return 0;
        if (pathLength > MAX_SWAP_HOPS) return 0;
        if (swapPath[0].tokenIn != asset) return 0;

        uint256 currentAmount = amountIn;
        address currentToken = asset;

        // Pre-allocate path array (gas optimization)
        address[] memory path = new address[](2);

        // Simulate each swap
        for (uint256 i = 0; i < pathLength;) {
            SwapStep calldata step = swapPath[i];

            // Validate token continuity
            if (step.tokenIn != currentToken) return 0;

            path[0] = step.tokenIn;
            path[1] = step.tokenOut;

            // Try to get quote from router
            try IDexRouter(step.router).getAmountsOut(currentAmount, path) returns (
                uint256[] memory amounts
            ) {
                currentAmount = amounts[amounts.length - 1];
                currentToken = step.tokenOut;
            } catch {
                return 0; // Router call failed
            }

            unchecked { ++i; }
        }

        // Verify path ends with original asset
        if (currentToken != asset) return 0;

        // Calculate profit (no flash loan fees for commit-reveal)
        if (currentAmount > amountIn) {
            expectedProfit = currentAmount - amountIn;
        } else {
            expectedProfit = 0;
        }

        return expectedProfit;
    }

    // ==========================================================================
    // Admin Functions
    // ==========================================================================

    /**
     * @notice Approve a DEX router for swap execution
     * @dev Only owner can approve routers (security measure)
     *
     * @param router Router address to approve
     */
    function approveRouter(address router) external onlyOwner {
        if (router == address(0)) revert InvalidRouterAddress();
        approvedRouters[router] = true;
        emit RouterApproved(router);
    }

    /**
     * @notice Revoke a DEX router's approval
     * @dev Only owner can revoke routers
     *
     * @param router Router address to revoke
     */
    function revokeRouter(address router) external onlyOwner {
        approvedRouters[router] = false;
        emit RouterRevoked(router);
    }

    /**
     * @notice Update minimum profit threshold
     * @dev Only owner can update minimum profit
     *
     * @param _minimumProfit New minimum profit in token units
     */
    function setMinimumProfit(uint256 _minimumProfit) external onlyOwner {
        uint256 oldValue = minimumProfit;
        minimumProfit = _minimumProfit;
        emit MinimumProfitUpdated(oldValue, _minimumProfit);
    }

    /**
     * @notice Pause the contract (emergency stop)
     * @dev Only owner can pause
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract
     * @dev Only owner can unpause
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Withdraw tokens (emergency recovery)
     * @dev Only owner can withdraw
     *
     * @param token Token address to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Withdraw ETH (emergency recovery)
     * @dev Only owner can withdraw
     *
     * @param to Recipient address
     * @param amount Amount to withdraw in wei
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert SwapFailed();
    }

    /**
     * @notice Receive ETH (for WETH unwrapping scenarios)
     */
    receive() external payable {}
}

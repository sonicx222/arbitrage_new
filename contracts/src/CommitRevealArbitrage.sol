// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";
import "./interfaces/IDexRouter.sol";

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
 * @custom:version 3.0.0
 * @custom:implementation-plan Task 3.1: Commit-Reveal Smart Contract (Pragmatic Balance)
 *
 * ## Changelog v3.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage
 * - Migrated from mapping-based to EnumerableSet-based router management
 * - Eliminated ~250 lines of duplicate code
 * - No functional changes beyond router management API
 *
 * ## Changelog v2.0.0
 * - Changed RevealParams to support multi-router arbitrage
 *
 * @custom:warning UNSUPPORTED TOKEN TYPES
 * This contract does NOT support:
 * - Fee-on-transfer tokens: Tokens that deduct fees during transfer will cause
 *   InsufficientProfit errors because received amounts don't match expected amounts.
 * - Rebasing tokens: Tokens that change balance over time may cause profit calculation
 *   errors or insufficient funds for repayment.
 * Using these token types will result in failed transactions and wasted gas.
 *
 * ## Known Limitations
 *
 * **Front-Running Griefing**: An attacker can observe a commit transaction in the
 * mempool and front-run it with the same commitment hash. This causes the original
 * committer's transaction to revert. However, the attacker cannot steal profits
 * because only the original committer (tracked in `committers` mapping) can reveal.
 *
 * **Mitigation**: This is a griefing attack (DoS) not a theft attack. Consider using
 * private mempools (Flashbots, Eden, etc.) for high-value commits to avoid front-running.
 *
 * **Why Not Fixed**: Including msg.sender in the commitment hash would prevent this,
 * but adds complexity and gas cost. Current design prioritizes simplicity for the
 * common case (no attackers), with private mempool as escape hatch.
 */
contract CommitRevealArbitrage is BaseFlashArbitrage {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants (Protocol-Specific)
    // ==========================================================================

    /// @notice Minimum blocks between commit and reveal (prevents same-block reveal)
    uint256 public constant MIN_DELAY_BLOCKS = 1;

    /// @notice Maximum blocks for commitment validity (prevents staleness)
    /// @dev 10 blocks = ~2 minutes on most chains (12s blocks)
    uint256 public constant MAX_COMMIT_AGE_BLOCKS = 10;

    // Note: MAX_SWAP_DEADLINE and MAX_SWAP_HOPS inherited from BaseFlashArbitrage

    // ==========================================================================
    // State Variables (Protocol-Specific)
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

    // Note: minimumProfit, approvedRouters (_approvedRouters EnumerableSet), SwapStep struct inherited from BaseFlashArbitrage

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
    // Events (Protocol-Specific)
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

    // Note: RouterAdded, RouterRemoved, MinimumProfitUpdated, etc. inherited from BaseFlashArbitrage

    // ==========================================================================
    // Errors (Protocol-Specific)
    // ==========================================================================

    error CommitmentAlreadyExists();
    error CommitmentNotFound();
    error CommitmentAlreadyRevealed();
    error CommitmentTooRecent();
    error CommitmentExpired();
    error InvalidCommitmentHash();
    error UnauthorizedRevealer();
    error BelowMinimumProfit();
    error InvalidDeadline();
    error InvalidOwnerAddress();

    // Note: Common errors (RouterNotApproved, InsufficientProfit, SwapFailed, InvalidRouterAddress,
    // InvalidAmount, EmptySwapPath, PathTooLong, InvalidSwapPath, SwapPathAssetMismatch) inherited from BaseFlashArbitrage

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the CommitRevealArbitrage contract
     * @param _owner The contract owner address
     */
    constructor(address _owner) BaseFlashArbitrage(_owner) {
        // minimumProfit inherited from BaseFlashArbitrage (defaults to 0)
        // MUST be configured by owner before use
        // Note: Commit+reveal gas cost ~315k gas (~$10 @ 20 gwei, $2500 ETH)
        // Recommend: 0.01 ETH (~$25) for mainnet, 0.005 ETH for L2s
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
    // Reveal Phase - Internal Validation Helpers (P2 Refactoring)
    // ==========================================================================

    /**
     * @notice Validates commitment exists and caller is authorized
     * @dev Internal helper extracted for testability (P2 refactoring)
     *      Reverts if validation fails, otherwise returns normally
     * @param commitmentHash Hash of the commitment to validate
     * @param commitBlock Block number when commitment was made
     */
    function _validateCommitment(
        bytes32 commitmentHash,
        uint256 commitBlock
    ) internal view {
        if (commitBlock == 0) revert CommitmentNotFound();
        if (revealed[commitmentHash]) revert CommitmentAlreadyRevealed();
        if (committers[commitmentHash] != msg.sender) revert UnauthorizedRevealer();
    }

    /**
     * @notice Validates timing constraints and deadline
     * @dev Internal helper extracted for testability (P2 refactoring)
     *      Reverts if validation fails, otherwise returns normally
     * @param commitBlock Block number when commitment was made
     * @param deadline User-specified deadline for the transaction
     */
    function _validateTimingAndDeadline(
        uint256 commitBlock,
        uint256 deadline
    ) internal view {
        // Validate timing (must wait MIN_DELAY_BLOCKS, cannot exceed MAX_COMMIT_AGE_BLOCKS)
        if (block.number < commitBlock + MIN_DELAY_BLOCKS) revert CommitmentTooRecent();
        if (block.number > commitBlock + MAX_COMMIT_AGE_BLOCKS) revert CommitmentExpired();

        // Validate deadline is not expired and not too far in future
        if (block.timestamp > deadline) revert InvalidDeadline();
        if (deadline > block.timestamp + MAX_SWAP_DEADLINE) revert InvalidDeadline();
    }


    /**
     * @notice Executes arbitrage and verifies profit meets thresholds
     * @dev Internal helper extracted for testability (P2 refactoring)
     * @param commitmentHash Hash of the commitment being revealed
     * @param params Reveal parameters containing swap details
     * @return profit The actual profit earned from the arbitrage
     */
    function _executeAndVerifyProfit(
        bytes32 commitmentHash,
        RevealParams calldata params
    ) internal returns (uint256 profit) {
        // Mark as revealed and cleanup storage (reentrancy protection + gas refund)
        revealed[commitmentHash] = true;
        delete commitments[commitmentHash];
        delete committers[commitmentHash];

        // Execute arbitrage swap
        profit = _executeArbitrageSwap(params);

        // Verify profit meets minimum thresholds
        // Check user-specified minimum first (per-commitment threshold)
        if (profit < params.minProfit) revert InsufficientProfit();

        // Check contract-wide minimum (owner-controlled floor)
        if (profit < minimumProfit) revert BelowMinimumProfit();

        return profit;
    }

    // ==========================================================================
    // Reveal Phase
    // ==========================================================================

    /**
     * @notice Reveal commitment and execute multi-hop arbitrage swap
     * @dev Validates commitment hash, timing, path, and routers, then executes swaps atomically
     *
     * ## P2 Refactoring (v3.1.0)
     * Refactored 150-line function into smaller, testable helper methods:
     * - _validateCommitment() - Commitment existence and authorization
     * - _validateTimingAndDeadline() - Timing constraints and deadline checks
     * - _validateArbitrageParams() - Common swap validation including token continuity (P1 extraction)
     * - _executeAndVerifyProfit() - Execution and profit verification
     *
     * This improves:
     * - Testability: Each helper can be tested independently
     * - Readability: Clear separation of concerns
     * - Maintainability: Easier to modify individual validation steps
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
        // 1. Calculate commitment hash and retrieve commit block
        bytes32 commitmentHash = keccak256(abi.encode(params));
        uint256 commitBlock = commitments[commitmentHash];

        // 2. Validate commitment exists, not revealed, caller authorized
        _validateCommitment(commitmentHash, commitBlock);

        // 3. Validate timing constraints and deadline
        _validateTimingAndDeadline(commitBlock, params.deadline);

        // 4. Validate common arbitrage parameters (P1: base contract validation)
        // Note: This now includes token continuity validation (moved to base in bug fix)
        _validateArbitrageParams(params.asset, params.amountIn, params.deadline, params.swapPath);

        // 5. Execute arbitrage and verify profit meets thresholds
        uint256 profit = _executeAndVerifyProfit(commitmentHash, params);

        // 6. Emit success event
        uint256 pathLength = params.swapPath.length;
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
     * @dev Simulates the arbitrage path without executing on-chain.
     *      Uses shared _simulateSwapPath() from BaseFlashArbitrage.
     *      No flash loan fees for commit-reveal (user provides upfront capital).
     *
     * @param asset The asset to swap (must start and end with this)
     * @param amountIn The amount to swap
     * @param swapPath Array of swap steps defining the arbitrage path
     * @return expectedProfit The expected profit (0 if unprofitable or invalid path)
     */
    function calculateExpectedProfit(
        address asset,
        uint256 amountIn,
        SwapStep[] calldata swapPath
    ) external view returns (uint256 expectedProfit) {
        if (amountIn == 0 || swapPath.length > MAX_SWAP_HOPS) return 0;

        uint256 simulatedOutput = _simulateSwapPath(asset, amountIn, swapPath);
        if (simulatedOutput == 0) return 0;

        // No flash loan fees for commit-reveal (user provides upfront capital)
        return _calculateProfit(amountIn, simulatedOutput, 0);
    }

    // Note: Router management (addApprovedRouter, removeApprovedRouter, etc.),
    // config (setMinimumProfit, pause, unpause), and emergency functions
    // (withdrawToken, withdrawETH, receive) inherited from BaseFlashArbitrage
    //
    // BREAKING CHANGE v3.0.0: Router management API changed from approveRouter/revokeRouter
    // to addApprovedRouter/removeApprovedRouter (EnumerableSet-based)
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./base/BaseFlashArbitrage.sol";

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
 * ## Capital Model (SEC-003)
 *
 * Unlike flash loan siblings (FlashLoanArbitrage, BalancerV2FlashArbitrage, etc.),
 * CommitRevealArbitrage uses UPFRONT CAPITAL, not flash loans. The caller must
 * transfer tokens to this contract before calling reveal(). This has important
 * security implications:
 *
 * - OPEN ACCESS: reveal() has no onlyOwner restriction (same as flash loan siblings).
 *   Anyone can call reveal() if they have a valid commitment and sufficient capital.
 * - CAPITAL AT RISK: Unlike flash loans (which are atomic and riskless), the caller's
 *   capital is held by the contract during execution. If the trade reverts, the tokens
 *   remain in the contract (recoverable via owner's withdrawToken).
 * - PROFIT ENFORCEMENT: The contract enforces minimumProfit > 0, preventing grief
 *   attacks via break-even paths. All profit stays in the contract for owner withdrawal.
 * - WHY OPEN ACCESS IS SAFE: A non-owner caller must (1) provide their own capital,
 *   (2) have a valid unexpired commitment, and (3) generate profit above minimumProfit.
 *   Any profit goes to the contract (owner benefit), not the caller. An attacker
 *   spending their own capital to generate profit for the contract owner is not
 *   a viable attack vector.
 * - COMMITMENT BINDING: Parameters are hash-locked at commit time. An attacker cannot
 *   alter trade parameters between commit and reveal.
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
 * @custom:version 3.1.0
 * @custom:implementation-plan Task 3.1: Commit-Reveal Smart Contract (Pragmatic Balance)
 *
 * ## Changelog v3.0.0 (Refactoring)
 * - Refactored to inherit from BaseFlashArbitrage
 * - Migrated from mapping-based to EnumerableSet-based router management
 * - Eliminated ~250 lines of duplicate code
 * - BREAKING: Router management API changed (approveRouter→addApprovedRouter, revokeRouter→removeApprovedRouter)
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
 * ## Griefing Protection
 *
 * Commitment hashes include msg.sender to prevent front-running griefing attacks.
 * An attacker observing a commit tx in the mempool cannot replicate the same hash
 * because each sender produces a unique hash for the same parameters (+2000 gas per commit).
 * The reveal() function recomputes the hash with msg.sender for validation.
 */
contract CommitRevealArbitrage is BaseFlashArbitrage {
    using SafeERC20 for IERC20;

    // ==========================================================================
    // Constants (Protocol-Specific)
    // ==========================================================================

    /// @notice Minimum blocks between commit and reveal (prevents same-block reveal)
    uint256 public constant MIN_DELAY_BLOCKS = 1;

    /// @notice Default maximum blocks for commitment validity
    uint256 public constant DEFAULT_MAX_COMMIT_AGE = 10;

    /// @notice Minimum allowed value for maxCommitAgeBlocks (prevents too-short windows)
    uint256 public constant MIN_COMMIT_AGE = 5;

    /// @notice Maximum allowed value for maxCommitAgeBlocks (prevents stale commitments)
    uint256 public constant MAX_COMMIT_AGE = 100;

    /// @notice Maximum blocks for commitment validity (configurable per chain)
    /// @dev 10 blocks = ~2 minutes on Ethereum (12s), ~2.5s on Arbitrum (0.25s).
    ///      Owner should increase for fast L2 chains where 10 blocks is too short.
    uint256 public maxCommitAgeBlocks;

    /// @notice Maximum number of commitments in a single batchCommit call
    /// @dev Prevents gas-limit DoS; consistent with MAX_BATCH_WHITELIST in PancakeSwapFlashArbitrage
    uint256 public constant MAX_BATCH_COMMITS = 50;

    // Note: MAX_SWAP_DEADLINE and MAX_SWAP_HOPS inherited from BaseFlashArbitrage

    // ==========================================================================
    // State Variables (Protocol-Specific)
    // ==========================================================================

    /// @notice Packed commitment data: hash, block number, committer, revealed status
    /// @dev Packed into a single storage slot (29 bytes): uint64 + address + bool
    ///      Saves ~40k gas per commit vs 3 separate mappings (1 SSTORE vs 3).
    ///      Use view functions commitments(), committers(), revealed() for external access.
    struct CommitmentInfo {
        uint64 blockNumber;   // 8 bytes — block when committed (0 = doesn't exist)
        address committer;    // 20 bytes — who committed (prevents griefing)
        bool revealed;        // 1 byte — replay protection
    }

    /// @dev Internal mapping — use commitments(), committers(), revealed() view functions
    mapping(bytes32 => CommitmentInfo) internal _commitments;

    // Note: minimumProfit, approvedRouters (_approvedRouters EnumerableSet), SwapStep struct inherited from BaseFlashArbitrage

    // ==========================================================================
    // Backward-Compatible View Functions
    // ==========================================================================

    /// @notice Get commitment block number (backward-compatible with previous mapping getter)
    function commitments(bytes32 hash) external view returns (uint256) {
        return uint256(_commitments[hash].blockNumber);
    }

    /// @notice Get commitment committer address (backward-compatible with previous mapping getter)
    function committers(bytes32 hash) external view returns (address) {
        return _commitments[hash].committer;
    }

    /// @notice Get commitment revealed status (backward-compatible with previous mapping getter)
    function revealed(bytes32 hash) external view returns (bool) {
        return _commitments[hash].revealed;
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

    /// @notice Emitted when maxCommitAgeBlocks is updated
    event MaxCommitAgeBlocksUpdated(uint256 oldValue, uint256 newValue);

    /// @notice Emitted when expired commitments are cleaned up
    event CommitmentsCleanedUp(uint256 count);

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
    error BatchTooLarge(uint256 provided, uint256 max);
    error BelowMinimumProfit();
    error InvalidDeadline();
    error InvalidCommitAge();
    // Note: Common errors (RouterNotApproved, InsufficientProfit, InvalidRouterAddress,
    // InvalidAmount, EmptySwapPath, PathTooLong, InvalidSwapPath, SwapPathAssetMismatch,
    // InvalidOwnerAddress) inherited from BaseFlashArbitrage

    // ==========================================================================
    // Constructor
    // ==========================================================================

    /**
     * @notice Initializes the CommitRevealArbitrage contract
     * @param _owner The contract owner address
     */
    constructor(address _owner) BaseFlashArbitrage(_owner) {
        // Zero-address validation handled by BaseFlashArbitrage constructor
        // minimumProfit inherited from BaseFlashArbitrage (defaults to 0)
        // MUST be configured by owner before use
        // Note: Commit+reveal gas cost ~315k gas (~$10 @ 20 gwei, $2500 ETH)
        // Recommend: 0.01 ETH (~$25) for mainnet, 0.005 ETH for L2s
        maxCommitAgeBlocks = DEFAULT_MAX_COMMIT_AGE;
    }

    // ==========================================================================
    // Commit Phase
    // ==========================================================================

    /**
     * @notice Commit to an arbitrage opportunity
     * @dev Stores commitment hash to prevent frontrunning. Actual parameters hidden until reveal.
     *
     * Gas cost: ~68,000 (2x SSTORE + event emission + nonReentrant overhead)
     *
     * Requirements:
     * - Contract not paused
     * - Commitment doesn't already exist
     *
     * Security: Only the committer can reveal their commitment (prevents griefing)
     *
     * @param commitmentHash Keccak256 hash of RevealParams
     */
    function commit(bytes32 commitmentHash) external nonReentrant whenNotPaused {
        if (_commitments[commitmentHash].blockNumber != 0) revert CommitmentAlreadyExists();

        _commitments[commitmentHash] = CommitmentInfo({
            blockNumber: uint64(block.number),
            committer: msg.sender,
            revealed: false
        });
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
    function batchCommit(bytes32[] calldata commitmentHashes) external nonReentrant whenNotPaused returns (uint256 successCount) {
        uint256 len = commitmentHashes.length;
        if (len > MAX_BATCH_COMMITS) revert BatchTooLarge(len, MAX_BATCH_COMMITS);
        uint256 currentBlock = block.number;

        for (uint256 i = 0; i < len;) {
            bytes32 hash = commitmentHashes[i];

            // Skip if commitment already exists (don't revert entire batch)
            if (_commitments[hash].blockNumber == 0) {
                _commitments[hash] = CommitmentInfo({
                    blockNumber: uint64(currentBlock),
                    committer: msg.sender,
                    revealed: false
                });
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
     * - Caller must be the original committer (prevents griefing)
     *
     * @param commitmentHash Hash to cancel
     */
    function cancelCommit(bytes32 commitmentHash) external {
        CommitmentInfo storage info = _commitments[commitmentHash];
        if (info.blockNumber == 0) revert CommitmentNotFound();
        if (info.revealed) revert CommitmentAlreadyRevealed();
        if (info.committer != msg.sender) revert UnauthorizedRevealer();

        delete _commitments[commitmentHash];
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
        CommitmentInfo storage info = _commitments[commitmentHash];
        if (info.revealed) revert CommitmentAlreadyRevealed();
        if (info.committer != msg.sender) revert UnauthorizedRevealer();
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
        // Validate timing (must wait MIN_DELAY_BLOCKS, cannot exceed maxCommitAgeBlocks)
        if (block.number < commitBlock + MIN_DELAY_BLOCKS) revert CommitmentTooRecent();
        if (block.number > commitBlock + maxCommitAgeBlocks) revert CommitmentExpired();

        // Validate deadline is not expired and not too far in future
        if (block.timestamp > deadline) revert InvalidDeadline();
        if (deadline > block.timestamp + MAX_SWAP_DEADLINE) revert InvalidDeadline();
    }


    /**
     * @notice Executes arbitrage and verifies profit meets thresholds
     * @dev Internal helper extracted for testability (P2 refactoring)
     *      Uses base contract's _executeSwaps and _verifyAndTrackProfit for DRY consistency.
     * @param commitmentHash Hash of the commitment being revealed
     * @param params Reveal parameters containing swap details
     * @return profit The actual profit earned from the arbitrage
     */
    function _executeAndVerifyProfit(
        bytes32 commitmentHash,
        RevealParams calldata params
    ) internal returns (uint256 profit) {
        // Mark as revealed and cleanup storage (reentrancy protection + gas refund)
        // Preserve revealed=true for external queries; zero blockNumber/committer for gas refund
        CommitmentInfo storage info = _commitments[commitmentHash];
        info.revealed = true;
        info.blockNumber = 0;
        info.committer = address(0);

        // Execute multi-hop swaps using base contract's _executeSwaps (DRY)
        // Note: calldata SwapStep[] is implicitly copied to memory by Solidity compiler
        uint256 amountReceived = _executeSwaps(params.asset, params.amountIn, params.swapPath, params.deadline);

        // Calculate profit: final amount must exceed initial investment
        if (amountReceived <= params.amountIn) revert InsufficientProfit();
        profit = amountReceived - params.amountIn;

        // Verify profit meets thresholds and update tracking (base contract)
        _verifyAndTrackProfit(profit, params.minProfit, params.asset);

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
     * 4. Swap deadline is reasonable (<= MAX_SWAP_DEADLINE from current block)
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
        // 1. Calculate commitment hash (includes msg.sender to prevent griefing)
        bytes32 commitmentHash = keccak256(abi.encodePacked(msg.sender, abi.encode(params)));
        uint256 commitBlock = uint256(_commitments[commitmentHash].blockNumber);

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

    // Note: _executeArbitrageSwap removed in v3.1.0 — now uses base contract's _executeSwaps (DRY)

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

    // ==========================================================================
    // Capital Recovery (W1-14)
    // ==========================================================================

    /// @notice Emitted when capital is recovered from an expired commitment
    event CommitmentRecovered(
        bytes32 indexed commitmentHash,
        address indexed recipient,
        address indexed asset,
        uint256 amount
    );

    /// @notice Thrown when attempting to recover a commitment that hasn't expired yet
    error CommitmentNotExpired();

    /// @notice Thrown when recipient address is zero
    error ZeroAddress();

    /**
     * @notice Recover capital from an expired commitment
     * @dev Allows the contract owner to recover tokens from an expired commitment.
     *      Restricted to onlyOwner because the contract only stores the commitment
     *      hash and block number — not the deposited asset/amount. Without deposit
     *      tracking, an open-access version would allow an attacker with any expired
     *      commitment to specify arbitrary asset/amount and drain contract funds.
     *
     * Security:
     * - onlyOwner prevents arbitrary token drain (SEC-003)
     * - Commitment must exist and not be revealed
     * - Commitment must be expired (past maxCommitAgeBlocks)
     * - nonReentrant prevents reentrancy via token transfer callbacks
     * - Contract must not be paused
     * - Commitment state is cleared before transfer (CEI pattern)
     *
     * @param commitmentHash The hash of the expired commitment
     * @param asset The token address to recover
     * @param amount The amount of tokens to recover
     * @param recipient The address to send recovered tokens to
     */
    function recoverCommitment(
        bytes32 commitmentHash,
        address asset,
        uint256 amount,
        address recipient
    ) external onlyOwner nonReentrant whenNotPaused {
        CommitmentInfo storage info = _commitments[commitmentHash];
        uint256 commitBlock = uint256(info.blockNumber);

        // Validate commitment exists
        if (commitBlock == 0) revert CommitmentNotFound();

        // Validate not already revealed
        if (info.revealed) revert CommitmentAlreadyRevealed();

        // Validate commitment is expired (past maxCommitAgeBlocks)
        if (block.number <= commitBlock + maxCommitAgeBlocks) revert CommitmentNotExpired();

        // Validate recipient
        if (recipient == address(0)) revert ZeroAddress();

        // Clear commitment state before transfer (CEI pattern)
        delete _commitments[commitmentHash];

        // Transfer capital to specified recipient (typically the original committer)
        IERC20(asset).safeTransfer(recipient, amount);

        emit CommitmentRecovered(commitmentHash, recipient, asset, amount);
    }

    // ==========================================================================
    // Admin Functions (Protocol-Specific)
    // ==========================================================================

    /**
     * @notice Cleanup expired commitments to reclaim storage
     * @dev Allows owner to delete commitments that are past maxCommitAgeBlocks.
     *      This is a storage hygiene function — expired commitments can never be revealed
     *      but still occupy storage slots. Deleting them provides gas refunds.
     *
     * Requirements:
     * - Caller must be owner
     * - Contract must not be paused
     * - Each hash must correspond to an existing, expired commitment
     *
     * @param hashes Array of commitment hashes to clean up
     * @return cleaned Number of commitments successfully cleaned up
     */
    function cleanupExpiredCommitments(bytes32[] calldata hashes)
        external
        onlyOwner
        whenNotPaused
        returns (uint256 cleaned)
    {
        uint256 len = hashes.length;
        for (uint256 i = 0; i < len;) {
            bytes32 hash = hashes[i];
            CommitmentInfo storage info = _commitments[hash];
            uint256 commitBlock = uint256(info.blockNumber);

            // Skip non-existent or already-revealed commitments
            if (commitBlock != 0 && !info.revealed) {
                // Only clean up if truly expired
                if (block.number > commitBlock + maxCommitAgeBlocks) {
                    delete _commitments[hash];
                    cleaned++;
                }
            }

            unchecked {
                ++i;
            }
        }

        if (cleaned > 0) {
            emit CommitmentsCleanedUp(cleaned);
        }
    }

    /**
     * @notice Set the maximum commit age in blocks
     * @dev Allows owner to tune for different chains:
     *      - Ethereum (12s blocks): 10 blocks = ~2 min (default)
     *      - Arbitrum (0.25s blocks): 50+ blocks recommended (~12s)
     *      - Base/Optimism (2s blocks): 20+ blocks recommended (~40s)
     * @param _maxCommitAgeBlocks New maximum age in blocks [MIN_COMMIT_AGE..MAX_COMMIT_AGE]
     */
    function setMaxCommitAgeBlocks(uint256 _maxCommitAgeBlocks) external onlyOwner {
        if (_maxCommitAgeBlocks < MIN_COMMIT_AGE || _maxCommitAgeBlocks > MAX_COMMIT_AGE) {
            revert InvalidCommitAge();
        }
        uint256 oldValue = maxCommitAgeBlocks;
        maxCommitAgeBlocks = _maxCommitAgeBlocks;
        emit MaxCommitAgeBlocksUpdated(oldValue, _maxCommitAgeBlocks);
    }

    // Note: Router management (addApprovedRouter, removeApprovedRouter, etc.),
    // config (setMinimumProfit, pause, unpause), and emergency functions
    // (withdrawToken, withdrawETH, receive) inherited from BaseFlashArbitrage
    //
    // BREAKING CHANGE v3.0.0: Router management API changed from approveRouter/revokeRouter
    // to addApprovedRouter/removeApprovedRouter (EnumerableSet-based)
}

/**
 * Feature Flags and Configuration Validation
 *
 * Feature flags for opt-in functionality and validation logic.
 *
 * @see ADR-029: Batched Quote Fetching
 */

import { COMMIT_REVEAL_CONTRACTS, hasCommitRevealContract } from './addresses';
import { MULTI_PATH_QUOTER_ADDRESSES, hasMultiPathQuoter, isProduction } from './service-config';

// =============================================================================
// FEATURE FLAGS (Task 1.2: Batched Quoting)
// =============================================================================

/**
 * Feature flags for opt-in functionality.
 *
 * These flags allow safe incremental rollout of new features:
 * - Start with flag OFF (default behavior maintained)
 * - Enable for specific services/chains to test
 * - Gradually roll out to 100% if metrics show improvement
 * - Instant rollback by setting flag to false
 *
 * @see ADR-029: Batched Quote Fetching
 */
export const FEATURE_FLAGS = {
  /**
   * Enable batched quote fetching via MultiPathQuoter contract.
   *
   * When enabled and contract is deployed:
   * - Uses single RPC call for N-hop arbitrage paths (latency: ~50ms)
   * - Falls back to sequential quotes if contract unavailable
   *
   * When disabled (default):
   * - Uses existing sequential quote fetching (latency: ~150ms)
   *
   * Impact: 75-83% latency reduction for profit calculation
   *
   * @default false (safe rollout - explicitly opt-in)
   */
  useBatchedQuoter: process.env.FEATURE_BATCHED_QUOTER === 'true',

  /**
   * Enable flash loan protocol aggregator (Task 2.3).
   *
   * When enabled (default):
   * - Dynamically selects best flash loan provider via weighted ranking
   * - Validates liquidity with on-chain checks (5-min cache)
   * - Tracks provider metrics (success rate, latency)
   * - Supports automatic fallback on provider failures
   *
   * When disabled:
   * - Uses hardcoded Aave V3 provider (backward compatible)
   * - Set FEATURE_FLASH_LOAN_AGGREGATOR=false to disable
   *
   * Impact:
   * - Better fee optimization (select lowest-fee provider)
   * - Prevents insufficient liquidity failures
   * - Improves reliability via fallback mechanisms
   *
   * @default true (production-ready - opt-out to disable)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
   */
  useFlashLoanAggregator: process.env.FEATURE_FLASH_LOAN_AGGREGATOR !== 'false',

  /**
   * Enable commit-reveal MEV protection (Task 3.1).
   *
   * When enabled (default):
   * - Automatically activates for high-risk transactions (sandwichRiskScore >= 70)
   * - Two-phase execution: commit hash → wait 1 block → reveal and execute
   * - Prevents sandwich attacks by hiding transaction parameters
   * - Fallback to standard execution if commit-reveal fails
   *
   * When disabled:
   * - Uses only private mempool (Flashbots/Jito) for MEV protection
   * - Set FEATURE_COMMIT_REVEAL=false to disable
   *
   * Impact:
   * - Additional MEV protection layer when private mempools unavailable
   * - +1 block latency for high-risk transactions (acceptable trade-off)
   * - Reduces sandwich attack risk from ~80% to ~5%
   *
   * Activates for:
   * - IntraChainStrategy with HIGH/CRITICAL MEV risk
   * - CrossChainStrategy with HIGH/CRITICAL MEV risk
   * - NOT used for FlashLoanStrategy (incompatible with flash loans)
   *
   * @default true (production-ready - opt-out to disable)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
   */
  useCommitReveal: process.env.FEATURE_COMMIT_REVEAL !== 'false',

  /**
   * Enable Redis storage for commit-reveal parameters.
   *
   * When enabled:
   * - Stores reveal parameters in Redis for persistence
   * - Enables multi-process coordination (shared state)
   * - Survives service restarts (commitment data preserved)
   * - Requires Redis connection (REDIS_URL env var)
   *
   * When disabled (default):
   * - Uses in-memory storage only (single-process)
   * - Lost on service restart (commitments abandoned)
   * - No Redis dependency (simpler deployment)
   * - Set FEATURE_COMMIT_REVEAL_REDIS=true to enable
   *
   * Impact:
   * - Redis enabled: Better reliability, multi-process support
   * - In-memory only: Simpler deployment, single-process only
   *
   * @default false (safe rollout - explicitly opt-in for Redis)
   * @see services/execution-engine/src/services/commit-reveal.service.ts
   */
  useCommitRevealRedis: process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true',
};

/**
 * Flash Loan Aggregator Configuration (Task 2.3)
 *
 * Configuration for intelligent flash loan provider selection.
 * Read from environment variables with safe defaults.
 */
export const FLASH_LOAN_AGGREGATOR_CONFIG = {
  /**
   * Weighted scoring weights (must sum to 1.0)
   * Controls how providers are ranked
   */
  weights: {
    fees: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_FEES ?? '0.5'),
    liquidity: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LIQUIDITY ?? '0.3'),
    reliability: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_RELIABILITY ?? '0.15'),
    latency: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LATENCY ?? '0.05'),
  },

  /**
   * Maximum providers to rank per selection
   * Higher = more options but slower selection
   * @default 3
   */
  maxProvidersToRank: parseInt(process.env.FLASH_LOAN_AGGREGATOR_MAX_PROVIDERS ?? '3', 10),

  /**
   * Enable on-chain liquidity validation
   * When true, validates pool liquidity before execution
   * @default true (if aggregator enabled)
   */
  enableLiquidityValidation: process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_VALIDATION !== 'false',

  /**
   * Liquidity check threshold in USD
   * Only check liquidity for opportunities above this value
   * @default 100000 ($100K)
   */
  liquidityCheckThresholdUsd: parseInt(process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_THRESHOLD_USD ?? '100000', 10),
};

/**
 * Validation state to ensure validation runs only once per process.
 * Prevents duplicate warnings in test environments or when module is
 * imported multiple times.
 */
let _featureFlagValidationRun = false;

/**
 * Validate feature flag configuration and log warnings/info.
 *
 * FIX (Issue 2.3): This function now auto-runs on module load (deferred via setTimeout)
 * to catch misconfigurations early. Services can still call it explicitly with a custom
 * logger for better integration.
 *
 * Auto-run behavior:
 * - Runs automatically after module load (unless DISABLE_CONFIG_VALIDATION=true)
 * - Falls back to console logging if not called explicitly
 * - Validation guard prevents duplicate runs
 * - In production, exits process on critical errors
 *
 * Manual call benefits:
 * - Use proper logger instead of console
 * - Better integration with service logging
 * - Control timing of validation
 *
 * @param logger - Logger instance (optional - falls back to console if not provided)
 *
 * @example
 * ```typescript
 * // In service startup (e.g., execution-engine/src/index.ts)
 * import { validateFeatureFlags } from '@arbitrage/config';
 *
 * async function startService() {
 *   const logger = createLogger('execution-engine');
 *   validateFeatureFlags(logger); // Validate once at startup with custom logger
 *   // ... start service ...
 * }
 * ```
 */
export function validateFeatureFlags(logger?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void; error?: (msg: string, meta?: unknown) => void }): void {
  // Run validation once per process
  if (_featureFlagValidationRun) {
    return;
  }
  _featureFlagValidationRun = true;

  // Validate batched quoter feature
  if (FEATURE_FLAGS.useBatchedQuoter) {
    const deployedChains = Object.keys(MULTI_PATH_QUOTER_ADDRESSES).filter((chain) =>
      hasMultiPathQuoter(chain)
    );

    if (deployedChains.length === 0) {
      const message =
        'FEATURE_BATCHED_QUOTER is enabled but no MultiPathQuoter contracts are deployed. ' +
        'Batched quoting will fall back to sequential quotes on all chains.';

      const details = {
        deployScript: 'npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>',
        envVarsNeeded: 'MULTI_PATH_QUOTER_ETHEREUM, MULTI_PATH_QUOTER_ARBITRUM, etc.',
      };

      if (logger) {
        logger.warn(message, details);
      } else {
        console.warn(`⚠️  WARNING: ${message}`, details);
      }
    } else {
      const message = `Batched quoting enabled for chains: ${deployedChains.join(', ')}`;
      if (logger) {
        logger.info(message, { chains: deployedChains });
      } else {
        console.info(`✅ ${message}`);
      }
    }
  }

  // Validate flash loan aggregator feature (C3 fix)
  if (FEATURE_FLAGS.useFlashLoanAggregator) {
    // FIX #11: Validate that aggregator weights sum to 1.0 (within tolerance)
    const { fees, liquidity, reliability, latency } = FLASH_LOAN_AGGREGATOR_CONFIG.weights;
    const weightSum = fees + liquidity + reliability + latency;
    const WEIGHT_TOLERANCE = 0.001;
    if (Math.abs(weightSum - 1.0) > WEIGHT_TOLERANCE) {
      const weightMsg =
        `Flash Loan Aggregator weights do not sum to 1.0 (got ${weightSum.toFixed(4)}). ` +
        `Weights: fees=${fees}, liquidity=${liquidity}, reliability=${reliability}, latency=${latency}. ` +
        'Provider ranking may produce unexpected results.';
      if (logger) {
        logger.warn(weightMsg, { weightSum, weights: FLASH_LOAN_AGGREGATOR_CONFIG.weights });
      } else {
        console.warn(`⚠️  WARNING: ${weightMsg}`);
      }
    }

    const message = 'Flash Loan Protocol Aggregator enabled - will dynamically select optimal provider';
    if (logger) {
      logger.info(message, {
        weights: FLASH_LOAN_AGGREGATOR_CONFIG.weights,
        liquidityThreshold: FLASH_LOAN_AGGREGATOR_CONFIG.liquidityCheckThresholdUsd,
      });
    } else {
      console.info(`✅ ${message}`);
    }
  } else {
    const message =
      'Flash Loan Protocol Aggregator DISABLED - using hardcoded Aave V3 provider only. ' +
      'Set FEATURE_FLASH_LOAN_AGGREGATOR=true to enable dynamic provider selection.';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }

  // Validate commit-reveal feature (Task 3.1)
  if (FEATURE_FLAGS.useCommitReveal) {
    const deployedChains = Object.keys(COMMIT_REVEAL_CONTRACTS).filter((chain) =>
      hasCommitRevealContract(chain)
    );

    if (deployedChains.length === 0) {
      const message =
        'FEATURE_COMMIT_REVEAL is enabled but no CommitRevealArbitrage contracts are deployed. ' +
        'Commit-reveal protection will be unavailable for high-risk transactions.';

      const details = {
        deployScript: 'npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>',
        envVarsNeeded: 'COMMIT_REVEAL_CONTRACT_ETHEREUM, COMMIT_REVEAL_CONTRACT_ARBITRUM, etc.',
      };

      if (logger) {
        logger.warn(message, details);
      } else {
        console.warn(`⚠️  WARNING: ${message}`, details);
      }
    } else {
      const storageMode = FEATURE_FLAGS.useCommitRevealRedis ? 'Redis (persistent)' : 'In-memory (ephemeral)';
      const message = `Commit-reveal MEV protection enabled for chains: ${deployedChains.join(', ')} [Storage: ${storageMode}]`;
      if (logger) {
        logger.info(message, {
          chains: deployedChains,
          storageMode,
          redisEnabled: FEATURE_FLAGS.useCommitRevealRedis
        });
      } else {
        console.info(`✅ ${message}`);
      }
    }

    // Validate Redis configuration if Redis storage is enabled
    if (FEATURE_FLAGS.useCommitRevealRedis) {
      if (!process.env.REDIS_URL) {
        const message =
          'FEATURE_COMMIT_REVEAL_REDIS is enabled but REDIS_URL is not set. ' +
          'Commit-reveal will fall back to in-memory storage.';

        // In production, this is a critical error (multi-process coordination requires Redis)
        if (isProduction) {
          const error = new Error(
            `${message}\n\n` +
            `CRITICAL: In production with multi-process deployment, Redis is required for commit-reveal.\n` +
            `Either set REDIS_URL or disable Redis storage with FEATURE_COMMIT_REVEAL_REDIS=false.`
          );
          if (logger?.error) {
            logger.error(message, { fallbackMode: 'in-memory', severity: 'CRITICAL' });
          }
          throw error;
        }

        // In development, warn only
        if (logger) {
          logger.warn(message, { fallbackMode: 'in-memory' });
        } else {
          console.warn(`⚠️  WARNING: ${message}`);
        }
      }
    }
  } else {
    const message =
      'Commit-Reveal MEV Protection DISABLED - high-risk transactions will use only private mempools. ' +
      'Set FEATURE_COMMIT_REVEAL=true to enable commit-reveal protection as fallback.';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }
}

// =============================================================================
// AUTO-VALIDATION ON MODULE LOAD (FIX: Issue 2.3)
// =============================================================================

/**
 * Auto-run validation on module load with opt-out.
 *
 * FIX (Issue 2.3): Automatically validate configuration on module load to catch
 * misconfigurations early. Services can still call validateFeatureFlags() explicitly
 * with a logger for better integration, but this ensures validation runs even if forgotten.
 *
 * Design:
 * - Uses setTimeout(0) to defer execution after module load completes
 * - Can be disabled via DISABLE_CONFIG_VALIDATION=true (for tests)
 * - Validation guard prevents duplicate runs
 * - Falls back to console logging if no explicit logger provided
 * - In production with critical errors, exits process to fail fast
 *
 * Why deferred (setTimeout):
 * - Avoids blocking module load
 * - Allows services to call validateFeatureFlags() first if they want
 * - Still catches forgotten calls before service actually starts
 *
 * @see validateFeatureFlags() for manual validation with custom logger
 */
if (process.env.DISABLE_CONFIG_VALIDATION !== 'true' && !process.env.JEST_WORKER_ID) {
  // Defer validation to allow services to call validateFeatureFlags() first
  setTimeout(() => {
    // If validation hasn't run yet, run it now with console fallback
    if (!_featureFlagValidationRun) {
      try {
        validateFeatureFlags(); // Will use console.log/warn
      } catch (error) {
        // Log critical validation errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('❌ CRITICAL CONFIGURATION ERROR:', errorMessage);

        // In production, fail fast to prevent running with invalid config
        if (process.env.NODE_ENV === 'production') {
          console.error('Exiting process due to configuration error in production mode');
          process.exit(1);
        }
      }
    }
  }, 0);
}

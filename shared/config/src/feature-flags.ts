/**
 * Feature Flags and Configuration Validation
 *
 * Feature flags for opt-in functionality and validation logic.
 *
 * @see ADR-029: Batched Quote Fetching
 */

import { COMMIT_REVEAL_CONTRACTS, hasCommitRevealContract } from './addresses';
import { MULTI_PATH_QUOTER_ADDRESSES, hasMultiPathQuoter, isProduction } from './service-config';
import { safeParseFloat, safeParseInt } from './utils/env-parsing';

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
 * P2-16 NOTE: Two env var patterns are used in this codebase:
 *
 * 1. **Opt-in** (`=== 'true'`): For experimental features. Flag is OFF unless
 *    explicitly set to 'true'. Unset env var = feature disabled.
 *    Used for: all FEATURE_* flags in this object (except useDynamicL1Fees).
 *
 * 2. **Opt-out** (`!== 'false'`): For safety-critical features. Flag is ON unless
 *    explicitly set to 'false'. Unset env var = feature enabled.
 *    Used for: useDynamicL1Fees (here), RISK_* flags (risk-config.ts).
 *    Rationale: disabling these causes silent degradation (e.g., 2-10x gas
 *    underestimation on L2s), so they must be on by default.
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
   * When enabled:
   * - Dynamically selects best flash loan provider via weighted ranking
   * - Validates liquidity with on-chain checks (5-min cache)
   * - Tracks provider metrics (success rate, latency)
   * - Supports automatic fallback on provider failures
   *
   * When disabled (default):
   * - Uses hardcoded Aave V3 provider (backward compatible)
   * - Set FEATURE_FLASH_LOAN_AGGREGATOR=true to enable
   *
   * Impact:
   * - Better fee optimization (select lowest-fee provider)
   * - Prevents insufficient liquidity failures
   * - Improves reliability via fallback mechanisms
   *
   * @default false (safe rollout - explicitly opt-in via FEATURE_FLASH_LOAN_AGGREGATOR=true)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
   */
  useFlashLoanAggregator: process.env.FEATURE_FLASH_LOAN_AGGREGATOR === 'true',

  /**
   * Enable commit-reveal MEV protection (Task 3.1).
   *
   * When enabled:
   * - Automatically activates for high-risk transactions (sandwichRiskScore >= 70)
   * - Two-phase execution: commit hash → wait 1 block → reveal and execute
   * - Prevents sandwich attacks by hiding transaction parameters
   * - Fallback to standard execution if commit-reveal fails
   *
   * When disabled (default):
   * - Uses only private mempool (Flashbots/Jito) for MEV protection
   * - Set FEATURE_COMMIT_REVEAL=true to enable
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
   * @default false (safe rollout - explicitly opt-in via FEATURE_COMMIT_REVEAL=true)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
   */
  useCommitReveal: process.env.FEATURE_COMMIT_REVEAL === 'true',

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

  /**
   * Enable flash loans on destination chain for cross-chain arbitrage (FE-001).
   *
   * When enabled:
   * - Cross-chain strategy checks if dest chain supports flash loans
   * - If supported, executes sell via FlashLoanStrategy for atomic execution
   * - Falls back to direct DEX swap if flash loan fails or isn't supported
   * - Requires FlashLoanStrategy and FlashLoanProviderFactory to be initialized
   *
   * When disabled (default):
   * - Cross-chain strategy always uses direct DEX swap on destination chain
   * - Set FEATURE_DEST_CHAIN_FLASH_LOAN=true to enable
   *
   * Benefits:
   * - Atomic execution on dest chain (reverts if unprofitable after bridge)
   * - Larger positions without holding capital on dest chain
   * - Protection against price movement during bridge delay
   *
   * Trade-offs:
   * - Flash loan fee: ~0.09% on Aave V3, ~0.25-0.30% on other protocols
   * - Requires FlashLoanArbitrage contract deployed on dest chain
   * - Increased error handling complexity (bridge succeeded but flash loan failed)
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see docs/research/FUTURE_ENHANCEMENTS.md#FE-001
   * @see services/execution-engine/src/strategies/cross-chain.strategy.ts
   */
  useDestChainFlashLoan: process.env.FEATURE_DEST_CHAIN_FLASH_LOAN === 'true',

  /**
   * Enable momentum data recording in the detection pipeline.
   * When enabled, PriceMomentumTracker records price updates from Sync events.
   * This feeds data for ML signal scoring (FEATURE_ML_SIGNAL_SCORING).
   * @default false
   */
  useMomentumTracking: process.env.FEATURE_MOMENTUM_TRACKING === 'true',

  /**
   * Enable background ML signal pre-computation.
   * When enabled, a background interval (500ms) pre-computes ML-enhanced
   * confidence scores for active trading pairs using MLOpportunityScorer.
   * Scores are cached for O(1) hot-path reads (FEATURE_SIGNAL_CACHE_READ).
   * @default false
   */
  useMLSignalScoring: process.env.FEATURE_ML_SIGNAL_SCORING === 'true',

  /**
   * Enable hot-path reading of cached ML signal scores.
   * When enabled, arbitrage opportunities are filtered by pre-computed
   * ML confidence scores. Low-confidence opportunities are suppressed.
   * Requires FEATURE_ML_SIGNAL_SCORING to be enabled for fresh data.
   * @default false
   */
  useSignalCacheRead: process.env.FEATURE_SIGNAL_CACHE_READ === 'true',

  /**
   * Enable liquidity-depth-based optimal trade sizing.
   * When enabled, LiquidityDepthAnalyzer feeds pool data from Sync events
   * and overrides opportunity.amount with the slippage-knee optimal size.
   * The execution engine can use this for refined trade sizing.
   * @default false
   */
  useLiquidityDepthSizing: process.env.FEATURE_LIQUIDITY_DEPTH_SIZING === 'true',

  /**
   * Enable dynamic L1 fee estimation via on-chain oracle queries.
   *
   * When enabled:
   * - Background task periodically queries L1 fee oracles (ArbGasInfo, OP GasPriceOracle)
   * - Cached oracle values replace static L1_DATA_FEE_USD estimates
   * - Falls back to static estimates if oracle query fails or cache is stale
   *
   * When disabled:
   * - Uses static L1_DATA_FEE_USD fallback values (conservative estimates)
   * - Set FEATURE_DYNAMIC_L1_FEES=false to disable
   *
   * Impact:
   * - More accurate gas cost estimation on L2 rollups
   * - Reduces false-positive opportunities caused by stale L1 fee assumptions
   * - Cached values only — no hot-path latency impact
   *
   * @default true (safety-on-by-default — L1 data fees are 50-90% of total gas
   *   cost on L2 rollups; without dynamic fees, gas is underestimated 2-10x,
   *   causing unprofitable trade execution on Arbitrum/Optimism/Base/zkSync/Linea)
   * @note INTENTIONAL OPT-OUT (`!== 'false'`): This is a safety-critical flag.
   *   Disabling it causes 2-10x gas underestimation on L2s. Unlike experimental
   *   features that use `=== 'true'` (opt-in), this must be on by default.
   * @see shared/core/src/caching/gas-price-cache.ts - L1 oracle integration
   * @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P0-1
   */
  useDynamicL1Fees: process.env.FEATURE_DYNAMIC_L1_FEES !== 'false',

  /**
   * Enable orderflow prediction pipeline consumer.
   *
   * When enabled:
   * - Subscribes to stream:pending-opportunities Redis Stream
   * - Converts pending swap intents to orderflow features
   * - Runs ML predictions via OrderflowPredictor
   * - Caches predictions for O(1) hot-path reads
   *
   * When disabled (default):
   * - No orderflow prediction pipeline running
   * - Set FEATURE_ORDERFLOW_PIPELINE=true to enable
   *
   * Impact:
   * - Enables proactive orderflow-based opportunity filtering
   * - Requires mempool-detector service for pending tx data
   * - Background processing only — no hot-path latency impact
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see shared/core/src/analytics/orderflow-pipeline-consumer.ts
   */
  useOrderflowPipeline: process.env.FEATURE_ORDERFLOW_PIPELINE === 'true',

  /**
   * Enable KMS-based transaction signing (Phase 2 Item 27).
   *
   * When enabled:
   * - Transactions are signed via AWS KMS (key never leaves HSM)
   * - Per-chain KMS keys supported: KMS_KEY_ID_{CHAIN} env vars
   * - Falls back to KMS_KEY_ID for chains without per-chain config
   * - Private key env vars still override KMS for that chain
   *
   * When disabled (default):
   * - Uses local private keys (PRIVATE_KEY or per-chain *_PRIVATE_KEY)
   * - Set FEATURE_KMS_SIGNING=true to enable
   *
   * Prerequisites:
   * - npm install @aws-sdk/client-kms
   * - AWS credentials configured (env vars, instance profile, etc.)
   * - KMS key created with ECC_SECG_P256K1 key spec
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see services/execution-engine/src/services/kms-signer.ts
   * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 7.1.1
   */
  useKmsSigning: process.env.FEATURE_KMS_SIGNING === 'true',

  /**
   * Fix #51: Enable backrun strategy for MEV-Share backrunning.
   *
   * When enabled:
   * - BackrunStrategy is registered in the strategy factory
   * - MEV-Share event listener opportunities are routed to backrun execution
   *
   * When disabled (default):
   * - BackrunStrategy is not registered; backrun opportunities are ignored
   * - Set FEATURE_BACKRUN_STRATEGY=true to enable
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see services/execution-engine/src/strategies/backrun.strategy.ts
   */
  /**
   * Enable fast lane for high-confidence opportunities (Item 12).
   *
   * When enabled:
   * - High-confidence, high-profit opportunities are published to {@link RedisStreams.FAST_LANE}
   *   in parallel with the normal {@link RedisStreams.OPPORTUNITIES} path
   * - Execution engine consumes fast lane directly, bypassing coordinator routing
   * - Normal coordinator path still processes the opportunity for metrics/dedup
   *
   * When disabled (default):
   * - All opportunities go through the normal coordinator path only
   * - Set FEATURE_FAST_LANE=true to enable
   *
   * Impact:
   * - Reduces latency for qualifying opportunities by ~20-50ms (skip coordinator)
   * - Execution engine deduplicates against normal path using opportunity ID
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see services/execution-engine/src/consumers/fast-lane.consumer.ts
   */
  useFastLane: process.env.FEATURE_FAST_LANE === 'true',

  useBackrunStrategy: process.env.FEATURE_BACKRUN_STRATEGY === 'true',

  /**
   * Fix #51: Enable UniswapX filler strategy.
   *
   * When enabled:
   * - UniswapXFillerStrategy is registered in the strategy factory
   * - UniswapX Dutch auction orders are evaluated and filled
   *
   * When disabled (default):
   * - UniswapX orders are ignored
   * - Set FEATURE_UNISWAPX_FILLER=true to enable
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see services/execution-engine/src/strategies/uniswapx-filler.strategy.ts
   */
  useUniswapxFiller: process.env.FEATURE_UNISWAPX_FILLER === 'true',

  /**
   * Fix #51: Enable MEV-Share backrun event processing.
   *
   * When enabled:
   * - MEV-Share SSE event listener is started
   * - Pending transactions from MEV-Share are evaluated as backrun opportunities
   *
   * When disabled (default):
   * - No MEV-Share event stream connection
   * - Set FEATURE_MEV_SHARE_BACKRUN=true to enable
   *
   * @default false (safe rollout - explicitly opt-in)
   * @see shared/core/src/mev-protection/mev-share-event-listener.ts
   */
  useMevShareBackrun: process.env.FEATURE_MEV_SHARE_BACKRUN === 'true',

  // =========================================================================
  // Feature flags previously scattered across individual service/core files.
  // Centralized here for single-source-of-truth (SA-011).
  // =========================================================================

  /** Enable Solana execution strategy (requires SOLANA_RPC_URL). @default false */
  useSolanaExecution: process.env.FEATURE_SOLANA_EXECUTION === 'true',

  /** Enable statistical arbitrage strategy. @default false */
  useStatisticalArb: process.env.FEATURE_STATISTICAL_ARB === 'true',

  /** Enable MEV-Share rebate mode. @default false @see shared/config/src/mev-config.ts */
  useMevShare: process.env.FEATURE_MEV_SHARE === 'true',

  /** Enable adaptive risk scoring thresholds. @default false @see shared/config/src/mev-config.ts */
  useAdaptiveRiskScoring: process.env.FEATURE_ADAPTIVE_RISK_SCORING === 'true',

  /** Enable Timeboost MEV protection (Arbitrum). @default false @see shared/core/src/mev-protection/timeboost-provider.ts */
  useTimeboost: process.env.FEATURE_TIMEBOOST === 'true',

  /** Enable Flashbots Protect L2 provider. @default false @see shared/core/src/mev-protection/flashbots-protect-l2.provider.ts */
  useFlashbotsProtectL2: process.env.FEATURE_FLASHBOTS_PROTECT_L2 === 'true',

  /** Enable CoW Protocol backrun strategy. @default false */
  useCowBackrun: process.env.FEATURE_COW_BACKRUN === 'true',
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
    fees: safeParseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_FEES, 0.5),
    liquidity: safeParseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LIQUIDITY, 0.3),
    reliability: safeParseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_RELIABILITY, 0.15),
    latency: safeParseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LATENCY, 0.05),
  },

  /**
   * Maximum providers to rank per selection
   * Higher = more options but slower selection
   * @default 3
   */
  maxProvidersToRank: safeParseInt(process.env.FLASH_LOAN_AGGREGATOR_MAX_PROVIDERS, 3),

  /**
   * Enable on-chain liquidity validation
   * When true, validates pool liquidity before execution
   * @default false (opt-in sub-feature of already opt-in aggregator)
   */
  enableLiquidityValidation: process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_VALIDATION === 'true',

  /**
   * Liquidity check threshold in USD
   * Only check liquidity for opportunities above this value
   * @default 100000 ($100K)
   */
  liquidityCheckThresholdUsd: safeParseInt(process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_THRESHOLD_USD, 100000),

  /**
   * Ranking cache TTL in milliseconds
   * How long cached provider rankings remain valid before re-ranking
   * @default 30000 (30 seconds)
   */
  rankingCacheTtlMs: safeParseInt(process.env.FLASH_LOAN_AGGREGATOR_RANKING_CACHE_TTL_MS, 30000),

  /**
   * Liquidity cache TTL in milliseconds
   * How long cached on-chain liquidity checks remain valid
   * @default 300000 (5 minutes)
   */
  liquidityCacheTtlMs: safeParseInt(process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_CACHE_TTL_MS, 300000),
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
    const WEIGHT_TOLERANCE = 0.01; // F8: Aligned with domain model tolerance (AggregatorConfig)
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
    // H3 FIX: Only warn about disabled commit-reveal on execution-engine.
    // Other services (coordinator, partitions, cross-chain) don't use commit-reveal
    // and were generating 7 identical noisy warnings at every startup.
    const isExecutionEngine = process.env.SERVICE_ROLE === 'execution-engine'
      || process.env.SERVICE_NAME === 'execution-engine';
    if (isExecutionEngine) {
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

  // Validate destination chain flash loan feature (FE-001)
  if (FEATURE_FLAGS.useDestChainFlashLoan) {
    // Check if any flash loan contract addresses are configured
    const configuredChains: string[] = [];
    for (const chain of ['ethereum', 'arbitrum', 'base', 'polygon', 'optimism', 'avalanche', 'bsc', 'fantom', 'zksync', 'linea']) {
      if (process.env[`FLASH_LOAN_CONTRACT_${chain.toUpperCase()}`]) {
        configuredChains.push(chain);
      }
    }

    if (configuredChains.length === 0) {
      const message =
        'FEATURE_DEST_CHAIN_FLASH_LOAN is enabled but no flash loan contract addresses are configured. ' +
        'Destination chain flash loans will be unavailable (cross-chain strategy will use direct DEX swaps).';

      const details = {
        envVarsNeeded: 'FLASH_LOAN_CONTRACT_ETHEREUM, FLASH_LOAN_CONTRACT_ARBITRUM, etc.',
      };

      if (logger) {
        logger.warn(message, details);
      } else {
        console.warn(`⚠️  WARNING: ${message}`, details);
      }
    } else {
      const message = `Destination chain flash loans enabled for chains: ${configuredChains.join(', ')}`;
      if (logger) {
        logger.info(message, { chains: configuredChains });
      } else {
        console.info(`✅ ${message}`);
      }
    }
  }

  // Validate ML signal scoring pipeline
  if (FEATURE_FLAGS.useSignalCacheRead && !FEATURE_FLAGS.useMLSignalScoring) {
    const message =
      'FEATURE_SIGNAL_CACHE_READ is enabled but FEATURE_ML_SIGNAL_SCORING is not. ' +
      'Signal cache will have no data. Enable FEATURE_ML_SIGNAL_SCORING=true for fresh scores.';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }

  if (FEATURE_FLAGS.useMLSignalScoring && !FEATURE_FLAGS.useMomentumTracking) {
    const message =
      'FEATURE_ML_SIGNAL_SCORING is enabled but FEATURE_MOMENTUM_TRACKING is not. ' +
      'ML scoring will operate without momentum data (reduced signal quality).';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }

  if (FEATURE_FLAGS.useMLSignalScoring) {
    const message = 'ML Signal Scoring enabled - background pre-computation active for hot pairs';
    if (logger) {
      logger.info(message);
    } else {
      console.info(`✅ ${message}`);
    }
  }

  // Validate liquidity depth sizing feature
  if (FEATURE_FLAGS.useLiquidityDepthSizing) {
    const message = 'Liquidity Depth Sizing enabled - optimal trade sizes will be computed from pool depth analysis';
    if (logger) {
      logger.info(message);
    } else {
      console.info(`✅ ${message}`);
    }
  }

  // Validate dynamic L1 fees feature
  if (FEATURE_FLAGS.useDynamicL1Fees) {
    const message = 'Dynamic L1 Fee Estimation enabled - L1 fee oracles will be queried in background for accurate rollup gas costs';
    if (logger) {
      logger.info(message);
    } else {
      console.info(`✅ ${message}`);
    }
  }

  // Validate orderflow pipeline feature
  if (FEATURE_FLAGS.useOrderflowPipeline) {
    if (!process.env.BLOXROUTE_AUTH_HEADER) {
      const message =
        'FEATURE_ORDERFLOW_PIPELINE is enabled but BLOXROUTE_AUTH_HEADER is not set. ' +
        'Mempool detector may not be running, so pending opportunity stream may have no data.';
      if (logger) {
        logger.warn(message);
      } else {
        console.warn(`⚠️  WARNING: ${message}`);
      }
    } else {
      const message = 'Orderflow Pipeline enabled - pending opportunities will be scored via ML prediction';
      if (logger) {
        logger.info(message);
      } else {
        console.info(`✅ ${message}`);
      }
    }
  }

  // Fix #53: Validate KMS signing configuration
  if (FEATURE_FLAGS.useKmsSigning) {
    if (!process.env.KMS_KEY_ID) {
      // P2-15 FIX: Use imported isProduction from service-config (was shadowed local)
      const msg = 'FEATURE_KMS_SIGNING is enabled but KMS_KEY_ID is not set. ' +
        'createKmsSigner() will return null for chains without per-chain KMS_KEY_ID_{CHAIN} env vars.';
      if (isProduction) {
        // In production, KMS without keys means no signing capability — fail fast
        throw new Error(`CRITICAL: ${msg} Set KMS_KEY_ID or disable FEATURE_KMS_SIGNING in production.`);
      }
      if (logger) {
        logger.warn(msg);
      } else {
        console.warn(`WARNING: ${msg}`);
      }
    }
  }

  // RT-012: Validate Solana execution requires RPC URL
  if (FEATURE_FLAGS.useSolanaExecution) {
    if (!process.env.SOLANA_RPC_URL) {
      const message =
        'FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set. ' +
        'Solana execution strategy will be unavailable at runtime.';
      if (logger) {
        logger.warn(message);
      } else {
        console.warn(`⚠️  WARNING: ${message}`);
      }
    } else {
      const message = 'Solana Execution enabled - Solana arbitrage opportunities will be executed';
      if (logger) { logger.info(message); } else { console.info(`✅ ${message}`); }
    }
  }

  // Fix #51: Validate backrun/UniswapX/MEV-Share feature flags
  if (FEATURE_FLAGS.useBackrunStrategy) {
    const msg = 'Backrun Strategy enabled - MEV-Share backrun opportunities will be executed';
    if (logger) { logger.info(msg); } else { console.info(msg); }
  }
  if (FEATURE_FLAGS.useUniswapxFiller) {
    const msg = 'UniswapX Filler Strategy enabled - Dutch auction orders will be filled';
    if (logger) { logger.info(msg); } else { console.info(msg); }
  }
  if (FEATURE_FLAGS.useMevShareBackrun) {
    const msg = 'MEV-Share Backrun event processing enabled - SSE event stream will be consumed';
    if (logger) { logger.info(msg); } else { console.info(msg); }
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
// P2-9 FIX: Never allow disabling config validation in production
const configValidationDisabled = process.env.DISABLE_CONFIG_VALIDATION === 'true'
  && process.env.NODE_ENV !== 'production';
if (!configValidationDisabled && !process.env.JEST_WORKER_ID) {
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

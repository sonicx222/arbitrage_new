/**
 * P4 Solana-Native Partition Service Entry Point
 *
 * Deploys the unified detector for the Solana-Native partition:
 * - Chain: Solana (non-EVM)
 * - Region: Fly.io US-West (us-west1)
 * - Resource Profile: Heavy (high-throughput chain)
 *
 * Architecture Note:
 * Uses the shared createPartitionEntry factory for consistent startup,
 * shutdown, and health server behavior across all partition services.
 * Solana-specific logic (arbitrage detection, RPC selection, Redis Streams)
 * is injected via lifecycle hooks.
 *
 * Solana-Native partition characteristics:
 * - Non-EVM chain requiring different connection handling
 * - Fast health checks (10s) for ~400ms block times
 * - Shorter failover timeout (45s) for quick recovery
 * - US-West deployment for proximity to Solana validators
 * - Uses program account subscriptions instead of event logs
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'solana-native' by default
 * - REDIS_URL: Redis connection URL (required)
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3004)
 * - INSTANCE_ID: Unique instance identifier (auto-generated if not set)
 * - REGION_ID: Region identifier (default: us-west1)
 * - ENABLE_CROSS_REGION_HEALTH: Enable cross-region health reporting (default: true)
 * - PARTITION_CHAINS: Override default chains (comma-separated)
 *
 * RPC Provider Priority (Issue 2.1 - S3.3.7):
 * 1. Explicit URL (SOLANA_RPC_URL or SOLANA_DEVNET_RPC_URL)
 * 2. Helius (if HELIUS_API_KEY set) - 100K free credits/day
 * 3. Triton (if TRITON_API_KEY set) - 50K free credits/day
 * 4. PublicNode - Unlimited, rate-limited
 * 5. Solana Public - Unlimited, rate-limited
 *
 * Devnet Support (Issue 2.2 - S3.3.7):
 * Set PARTITION_CHAINS=solana-devnet to use devnet endpoints
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.6: Create P4 detector service
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */

import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import {
  createPartitionEntry,
  createLogger,
  getRedisStreamsClient,
  getErrorMessage,
} from '@arbitrage/core';
import type { PartitionEnvironmentConfig, PartitionDetectorInterface } from '@arbitrage/core';
import { PARTITION_IDS } from '@arbitrage/config';
import { SolanaArbitrageDetector } from './arbitrage-detector';
import { validateEnvironment } from './env-validation';
import { P4_PARTITION_ID, P4_DEFAULT_PORT, assembleSolanaConfig } from './service-config';
import { selectSolanaRpcUrl, isDevnetMode, SOLANA_RPC_PROVIDERS } from './rpc-config';

// =============================================================================
// Pre-validation: Solana-specific environment checks
// CRITICAL-FIX: Validate required environment variables early to fail fast
// =============================================================================

const preValidationLogger = createLogger('partition-solana:main');
validateEnvironment(P4_PARTITION_ID, preValidationLogger);

// =============================================================================
// Solana-specific configuration (arbitrageConfig + RPC selection)
// Standard partition config is handled by createPartitionEntry below
// =============================================================================

const { arbitrageConfig, rpcSelection } = assembleSolanaConfig(preValidationLogger);

// =============================================================================
// Solana Arbitrage Detector (S3.3.6)
// Created before createPartitionEntry so it can be wired to the detector
// =============================================================================

const solanaArbitrageLogger = createLogger('partition-solana:arbitrage');
const solanaArbitrageDetector = new SolanaArbitrageDetector(arbitrageConfig, {
  logger: solanaArbitrageLogger,
});

// =============================================================================
// P4 Partition Entry (Data-driven via createPartitionEntry factory)
// =============================================================================

const entry = createPartitionEntry(
  PARTITION_IDS.SOLANA_NATIVE,
  (cfg) => new UnifiedChainDetector(cfg),
  {
    // Post-startup hook: initialize Redis Streams and start Solana arbitrage detector
    onStarted: async (detector: PartitionDetectorInterface) => {
      // Initialize Redis Streams client for opportunity publishing
      try {
        const streamsClient = await getRedisStreamsClient();
        solanaArbitrageDetector.setStreamsClient(streamsClient);
        entry.logger.info('Redis Streams client attached to SolanaArbitrageDetector');
      } catch (streamsError) {
        // Non-fatal: continue without Redis Streams publishing
        entry.logger.warn('Failed to initialize Redis Streams client, opportunity publishing disabled', {
          error: streamsError,
        });
      }

      // Start Solana arbitrage detector
      await solanaArbitrageDetector.start();

      entry.logger.info('P4 Solana-Native Partition Service fully initialized', {
        arbitrageDetectorRunning: solanaArbitrageDetector.isRunning(),
        crossChainEnabled: arbitrageConfig.crossChainEnabled,
        triangularEnabled: arbitrageConfig.triangularEnabled,
        solanaRpcProvider: rpcSelection.provider,
        solanaNetwork: isDevnetMode() ? 'devnet' : 'mainnet',
        minProfitThreshold: arbitrageConfig.minProfitThreshold,
      });
    },

    // Startup error hook: clean up Solana arbitrage detector
    onStartupError: async (error: Error) => {
      try {
        await solanaArbitrageDetector.stop();
      } catch (stopError) {
        entry.logger.warn('Failed to stop arbitrage detector during cleanup', { stopError });
      }
    },

    // Additional cleanup: stop arbitrage detector and remove detector listeners
    additionalCleanup: () => {
      detector.off('stopped', detectorStoppedHandler);
      // Stop the arbitrage detector to clean up its internal detector listeners
      // This is safe to call even if already stopped (stop() is idempotent)
      solanaArbitrageDetector.stop().catch((error) => {
        entry.logger.warn('Failed to stop solanaArbitrageDetector during cleanup', { error });
      });
    },
  }
);

// =============================================================================
// Solana-Specific Event Wiring (post-factory)
// =============================================================================

// Connect SolanaArbitrageDetector to receive price updates from UnifiedChainDetector
// The UnifiedChainDetector emits 'priceUpdate' events that we forward to the arbitrage detector
const detector = entry.detector as UnifiedChainDetector;
solanaArbitrageDetector.connectToSolanaDetector(detector);

// Forward arbitrage opportunities to the main event stream and auto-publish to Redis
// BUG-FIX: Added try-catch to prevent unhandled promise rejections from crashing the process
solanaArbitrageDetector.on('opportunity', async (opportunity) => {
  entry.logger.info('Solana arbitrage opportunity detected', {
    id: opportunity.id,
    type: opportunity.type,
    buyDex: opportunity.buyDex,
    sellDex: opportunity.sellDex,
    profitPercentage: opportunity.profitPercentage.toFixed(4) + '%',
    confidence: opportunity.confidence,
  });

  // Publish to Redis Streams if client is configured
  // BUG-FIX: Wrap in try-catch to prevent unhandled rejection if Redis fails
  try {
    await solanaArbitrageDetector.publishOpportunity(opportunity);
  } catch (error) {
    // Log error but don't crash - opportunity was already detected and logged
    // Redis publishing failure shouldn't stop the detection service
    const errorMessage = getErrorMessage(error);
    entry.logger.error('Failed to publish opportunity to Redis Streams', {
      opportunityId: opportunity.id,
      error: errorMessage,
    });
    // P3-FIX: Emit event for monitoring systems to track Redis publish failures
    solanaArbitrageDetector.emit('redis-publish-error', {
      opportunityId: opportunity.id,
      error: errorMessage,
      timestamp: Date.now(),
    });
    // Don't re-throw - allow the service to continue processing other opportunities
  }
});

// Ensure arbitrage detector is stopped when main detector stops
const detectorStoppedHandler = async (): Promise<void> => {
  try {
    await solanaArbitrageDetector.stop();
    entry.logger.info('SolanaArbitrageDetector stopped on main detector shutdown');
  } catch (error) {
    entry.logger.warn('Failed to stop SolanaArbitrageDetector during shutdown', { error });
  }
};
detector.on('stopped', detectorStoppedHandler);

// =============================================================================
// Exports (Backward-compatible)
// =============================================================================

const config: UnifiedDetectorConfig = entry.config;
const P4_CHAINS = entry.chains;
const P4_REGION = entry.region;
const cleanupProcessHandlers = entry.cleanupProcessHandlers;

export {
  detector,
  solanaArbitrageDetector,
  config,
  arbitrageConfig,
  P4_PARTITION_ID,
  P4_DEFAULT_PORT,
  P4_CHAINS,
  P4_REGION,
  // P2-FIX: Export comprehensive cleanup function (includes additionalCleanup)
  cleanupProcessHandlers,
  // Issue 2.1/2.2: Export RPC selection utilities for testing
  selectSolanaRpcUrl,
  isDevnetMode,
  rpcSelection,
  SOLANA_RPC_PROVIDERS,
};

export type { PartitionEnvironmentConfig };

// S3.3.6: Re-export Solana arbitrage detector for external use
export {
  SolanaArbitrageDetector,
  type SolanaArbitrageConfig,
  type SolanaArbitrageDeps,
  type SolanaArbitrageOpportunity,
  type SolanaArbitrageStreamsClient,
  type SolanaPoolInfo,
  type SolanaTokenInfo,
  type EvmPriceUpdate,
  type TriangularPath,
  type TriangularPathStep,
  type CrossChainPriceComparison,
  type PriorityFeeEstimate,
  type PriorityFeeRequest,
  type SolanaArbitrageStats,
} from './arbitrage-detector';

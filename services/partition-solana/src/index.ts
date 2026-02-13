/**
 * P4 Solana-Native Partition Service Entry Point
 *
 * Deploys the unified detector for the Solana-Native partition:
 * - Chain: Solana (non-EVM)
 * - Region: Fly.io US-West (us-west1)
 * - Resource Profile: Heavy (high-throughput chain)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P4 partition.
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
 * - REDIS_URL: Redis connection URL
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3004)
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
 */

import { Server } from 'http';
import { UnifiedChainDetector } from '@arbitrage/unified-detector';
import {
  createLogger,
  createPartitionHealthServer,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  getRedisStreamsClient,
} from '@arbitrage/core';
import { SolanaArbitrageDetector } from './arbitrage-detector';
import { validateEnvironment } from './env-validation';
import { P4_PARTITION_ID, P4_DEFAULT_PORT, assembleConfig } from './service-config';
import { selectSolanaRpcUrl, isDevnetMode, SOLANA_RPC_PROVIDERS } from './rpc-config';

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-solana:main');

// =============================================================================
// Critical Environment Validation
// CRITICAL-FIX: Validate required environment variables early to fail fast
// P2-FIX: Using shared exitWithConfigError from @arbitrage/core
// =============================================================================

validateEnvironment(P4_PARTITION_ID, logger);

// =============================================================================
// Assemble Configuration (service config, detector config, arbitrage config)
// =============================================================================

const {
  P4_CHAINS,
  P4_REGION,
  serviceConfig,
  config,
  arbitrageConfig,
  rpcSelection,
} = assembleConfig(logger);

// =============================================================================
// Service Instance
// =============================================================================

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

const detector = new UnifiedChainDetector(config);

// Solana-specific arbitrage detector (S3.3.6)
const solanaArbitrageLogger = createLogger('partition-solana:arbitrage');
const solanaArbitrageDetector = new SolanaArbitrageDetector(arbitrageConfig, {
  logger: solanaArbitrageLogger,
});

// =============================================================================
// Event Handlers (P16 refactor - Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P4_PARTITION_ID);

// Connect SolanaArbitrageDetector to receive price updates from UnifiedChainDetector
// The UnifiedChainDetector emits 'priceUpdate' events that we can forward to the arbitrage detector
solanaArbitrageDetector.connectToSolanaDetector(detector);

// Forward arbitrage opportunities to the main event stream and auto-publish to Redis
// BUG-FIX: Added try-catch to prevent unhandled promise rejections from crashing the process
solanaArbitrageDetector.on('opportunity', async (opportunity) => {
  logger.info('Solana arbitrage opportunity detected', {
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to publish opportunity to Redis Streams', {
      opportunityId: opportunity.id,
      error: errorMessage,
    });
    // P3-FIX: Emit event for monitoring systems to track Redis publish failures
    // This allows external monitoring (Prometheus, alerts, etc.) to react to Redis issues
    solanaArbitrageDetector.emit('redis-publish-error', {
      opportunityId: opportunity.id,
      error: errorMessage,
      timestamp: Date.now(),
    });
    // Don't re-throw - allow the service to continue processing other opportunities
  }
});

// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================

// S3.2.3-FIX: Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// P2-FIX: Store handler reference for cleanup
const detectorStoppedHandler = async (): Promise<void> => {
  try {
    await solanaArbitrageDetector.stop();
    logger.info('SolanaArbitrageDetector stopped on main detector shutdown');
  } catch (error) {
    logger.warn('Failed to stop SolanaArbitrageDetector during shutdown', { error });
  }
};

// Ensure arbitrage detector is stopped when main detector stops
detector.on('stopped', detectorStoppedHandler);

// P2-FIX: Export cleanup function that includes detector listener cleanup
// BUG-FIX: Also stop solanaArbitrageDetector to clean up its internal detector listeners
// This prevents memory leaks when cleanupAllHandlers is called directly (not via 'stopped' event)
const cleanupAllHandlers = (): void => {
  detector.off('stopped', detectorStoppedHandler);
  // P2-FIX: Stop the arbitrage detector to clean up its detector connection listeners
  // This is safe to call even if already stopped (stop() is idempotent)
  solanaArbitrageDetector.stop().catch((error) => {
    logger.warn('Failed to stop solanaArbitrageDetector during cleanup', { error });
  });
  cleanupProcessHandlers();
};

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // Note: serviceConfig captures all partition config values at module init time,
  // after validation by exitWithConfigError(), so it's safe to use here

  logger.info('Starting P4 Solana-Native Partition Service', {
    partitionId: P4_PARTITION_ID,
    chains: config.chains,
    region: P4_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid,
    nonEvm: true, // P4 is the only non-EVM partition
    arbitrageEnabled: true,
    crossChainEnabled: arbitrageConfig.crossChainEnabled,
    triangularEnabled: arbitrageConfig.triangularEnabled,
    // Issue 2.1/2.2: Log RPC provider selection
    solanaRpcProvider: rpcSelection.provider,
    solanaNetwork: isDevnetMode() ? 'devnet' : 'mainnet',
    minProfitThreshold: arbitrageConfig.minProfitThreshold,
  });

  try {
    // Initialize Redis Streams client for opportunity publishing
    try {
      const streamsClient = await getRedisStreamsClient();
      solanaArbitrageDetector.setStreamsClient(streamsClient);
      logger.info('Redis Streams client attached to SolanaArbitrageDetector');
    } catch (streamsError) {
      // Non-fatal: continue without Redis Streams publishing
      logger.warn('Failed to initialize Redis Streams client, opportunity publishing disabled', {
        error: streamsError,
      });
    }

    // Start health check server first (P12-P14 refactor - Using shared utilities)
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort ?? P4_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

    // Start unified detector (handles chain connections)
    await detector.start();

    // Start Solana arbitrage detector
    await solanaArbitrageDetector.start();

    logger.info('P4 Solana-Native Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains(),
      arbitrageDetectorRunning: solanaArbitrageDetector.isRunning(),
    });

  } catch (error) {
    logger.error('Failed to start P4 Solana-Native Partition Service', { error });

    // CRITICAL-FIX: Clean up resources if startup failed
    try {
      await solanaArbitrageDetector.stop();
    } catch (stopError) {
      logger.warn('Failed to stop arbitrage detector during cleanup', { stopError });
    }

    // BUG-4.2-FIX: Await health server close before exiting to ensure port is released
    if (healthServerRef.current) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Health server close timed out after 1000ms');
          resolve();
        }, 1000);

        healthServerRef.current!.close((err) => {
          clearTimeout(timeout);
          if (err) {
            logger.warn('Failed to close health server during cleanup', { error: err });
          } else {
            logger.info('Health server closed after startup failure');
          }
          resolve();
        });
      });
    }

    // BUG-4.1-FIX: Clean up process handlers before exit to prevent listener leaks
    // P2-FIX: Use cleanupAllHandlers to also clean up detector 'stopped' listener
    cleanupAllHandlers();

    process.exit(1);
  }
}

// Run - only when this is the main entry point (not when imported by tests)
// Check for Jest worker to prevent auto-start during test imports
if (!process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    if (logger) {
      logger.error('Fatal error in P4 Solana-Native partition main', { error });
    } else {
      console.error('Fatal error in P4 Solana-Native partition main (logger unavailable):', error);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

// Runtime exports
export {
  detector,
  solanaArbitrageDetector,
  config,
  arbitrageConfig,
  P4_PARTITION_ID,
  P4_DEFAULT_PORT,
  P4_CHAINS,
  P4_REGION,
  // P2-FIX: Export comprehensive cleanup function
  cleanupAllHandlers as cleanupProcessHandlers,
  // Issue 2.1/2.2: Export RPC selection utilities for testing
  selectSolanaRpcUrl,
  isDevnetMode,
  rpcSelection,
  SOLANA_RPC_PROVIDERS,
};

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

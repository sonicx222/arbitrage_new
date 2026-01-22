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
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import {
  createLogger,
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  PartitionServiceConfig,
  getRedisStreamsClient
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';
import { SolanaArbitrageDetector, SolanaArbitrageConfig, SolanaPoolInfo } from './arbitrage-detector';

// =============================================================================
// P4 Partition Constants
// =============================================================================

const P4_PARTITION_ID = PARTITION_IDS.SOLANA_NATIVE;
const P4_DEFAULT_PORT = 3004; // Different port from P1 (3001), P2 (3002), P3 (3003)

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-solana:main');

// =============================================================================
// Critical Environment Validation
// CRITICAL-FIX: Validate required environment variables early to fail fast
// =============================================================================

/**
 * Validates critical environment variables and exits with clear error if missing.
 * Returns never to help TypeScript understand this terminates the process.
 */
function exitWithConfigError(message: string, context: Record<string, unknown>): never {
  logger.error(message, context);
  process.exit(1);
}

// Validate REDIS_URL - required for all partition services
if (!process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  exitWithConfigError('REDIS_URL environment variable is required', {
    partitionId: P4_PARTITION_ID,
    hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
  });
}

// Single partition config retrieval (P5-FIX pattern)
const partitionConfig = getPartition(P4_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P4 partition configuration not found', { partitionId: P4_PARTITION_ID });
}

// Derive chains and region from partition config (P3-FIX pattern)
const P4_CHAINS: readonly string[] = partitionConfig.chains;
const P4_REGION = partitionConfig.region;

// Service configuration for shared utilities (P12-P16 refactor)
const serviceConfig: PartitionServiceConfig = {
  partitionId: P4_PARTITION_ID,
  serviceName: 'partition-solana',
  defaultChains: P4_CHAINS,
  defaultPort: P4_DEFAULT_PORT,
  region: P4_REGION,
  provider: partitionConfig.provider
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration
const config: UnifiedDetectorConfig = {
  partitionId: P4_PARTITION_ID,
  chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P4_CHAINS, logger),
  instanceId: process.env.INSTANCE_ID || `p4-solana-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
  regionId: process.env.REGION_ID || P4_REGION,
  enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P4_DEFAULT_PORT, logger)
};

// =============================================================================
// Solana RPC Provider Selection (Issue 2.1, 2.2, 3.3 - S3.3.7)
// =============================================================================

/**
 * RPC endpoint providers for Solana mainnet and devnet.
 * Provider selection implements the documented priority in README.md.
 */
const SOLANA_RPC_PROVIDERS = {
  mainnet: {
    helius: (apiKey: string) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    triton: (apiKey: string) => `https://solana-mainnet.rpc.extrnode.com/${apiKey}`,
    publicNode: 'https://solana-mainnet.rpc.publicnode.com',
    solanaPublic: 'https://api.mainnet-beta.solana.com',
  },
  devnet: {
    helius: (apiKey: string) => `https://devnet.helius-rpc.com/?api-key=${apiKey}`,
    triton: (apiKey: string) => `https://solana-devnet.rpc.extrnode.com/${apiKey}`,
    publicNode: 'https://solana-devnet.rpc.publicnode.com',
    solanaPublic: 'https://api.devnet.solana.com',
  },
} as const;

/**
 * Determines if we're running in devnet mode based on PARTITION_CHAINS.
 * Issue 2.2: Devnet support via PARTITION_CHAINS=solana-devnet
 */
function isDevnetMode(): boolean {
  const chains = process.env.PARTITION_CHAINS?.split(',').map(c => c.trim().toLowerCase()) ?? [];
  return chains.includes('solana-devnet');
}

/**
 * Selects the appropriate Solana RPC URL based on documented priority.
 * Issue 2.1: RPC Provider Priority as documented in README.md S3.3.7
 * Issue 3.3: Production warning for public RPC endpoint
 *
 * Priority:
 * 1. Explicit URL (SOLANA_RPC_URL or SOLANA_DEVNET_RPC_URL)
 * 2. Helius (if HELIUS_API_KEY set) - Recommended for production
 * 3. Triton (if TRITON_API_KEY set) - Good alternative
 * 4. PublicNode - Unlimited but rate-limited
 * 5. Solana Public - Last resort, heavily rate-limited
 *
 * @returns Object with selected RPC URL, provider name, and whether it's a public endpoint
 */
function selectSolanaRpcUrl(): { url: string; provider: string; isPublicEndpoint: boolean } {
  const devnet = isDevnetMode();
  const network = devnet ? 'devnet' : 'mainnet';
  const providers = SOLANA_RPC_PROVIDERS[network];

  // Priority 1: Explicit URL override
  const explicitUrl = devnet
    ? process.env.SOLANA_DEVNET_RPC_URL
    : process.env.SOLANA_RPC_URL;
  if (explicitUrl) {
    return { url: explicitUrl, provider: 'explicit', isPublicEndpoint: false };
  }

  // Priority 2: Helius (recommended)
  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) {
    return { url: providers.helius(heliusKey), provider: 'helius', isPublicEndpoint: false };
  }

  // Priority 3: Triton
  const tritonKey = process.env.TRITON_API_KEY;
  if (tritonKey) {
    return { url: providers.triton(tritonKey), provider: 'triton', isPublicEndpoint: false };
  }

  // Priority 4: PublicNode (free, unlimited, rate-limited)
  // Prefer over Solana public as it's generally more reliable
  // Fall through to Solana public for compatibility

  // Priority 5: Solana Public (last resort)
  return { url: providers.solanaPublic, provider: 'solana-public', isPublicEndpoint: true };
}

// Select RPC URL with priority
const rpcSelection = selectSolanaRpcUrl();
const SOLANA_RPC_URL = rpcSelection.url;

// Issue 3.3: Warn about public RPC in production
if (rpcSelection.isPublicEndpoint && process.env.NODE_ENV === 'production') {
  logger.warn('Using public Solana RPC endpoint in production - this is NOT recommended', {
    provider: rpcSelection.provider,
    network: isDevnetMode() ? 'devnet' : 'mainnet',
    recommendation: 'Set HELIUS_API_KEY or TRITON_API_KEY for better rate limits',
    docs: 'See README.md "Solana RPC Configuration" section',
  });
}

// =============================================================================
// Solana Arbitrage Detector Configuration
// =============================================================================

// Issue 3.1: Get profit threshold from partition config or environment
// Default aligns with IMPLEMENTATION_PLAN.md profit threshold guidance
const DEFAULT_MIN_PROFIT_THRESHOLD = 0.3; // 0.3% minimum profit

const arbitrageConfig: SolanaArbitrageConfig = {
  // rpcUrl is optional in updated arbitrage-detector.ts (Issue 7.1)
  // Include for backward compatibility with monitoring/logging
  rpcUrl: SOLANA_RPC_URL,
  minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || String(DEFAULT_MIN_PROFIT_THRESHOLD)),
  crossChainEnabled: process.env.CROSS_CHAIN_ENABLED !== 'false',
  triangularEnabled: process.env.TRIANGULAR_ENABLED !== 'false',
  maxTriangularDepth: parseInt(process.env.MAX_TRIANGULAR_DEPTH || '3', 10),
  opportunityExpiryMs: parseInt(process.env.OPPORTUNITY_EXPIRY_MS || '1000', 10),
  // Issue 1.3: Chain identifier for Solana
  chainId: isDevnetMode() ? 'solana-devnet' : 'solana',
};

// =============================================================================
// Service Instance
// =============================================================================

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
  await solanaArbitrageDetector.publishOpportunity(opportunity);
});

// =============================================================================
// Process Handlers (P15/P19 refactor - Using shared utilities with shutdown guard)
// =============================================================================

// S3.2.3-FIX: Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// Ensure arbitrage detector is stopped when main detector stops
detector.on('stopped', async () => {
  try {
    await solanaArbitrageDetector.stop();
    logger.info('SolanaArbitrageDetector stopped on main detector shutdown');
  } catch (error) {
    logger.warn('Failed to stop SolanaArbitrageDetector during shutdown', { error });
  }
});

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
      port: config.healthCheckPort || P4_DEFAULT_PORT,
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

    if (healthServerRef.current) {
      try {
        healthServerRef.current.close();
        logger.info('Health server closed after startup failure');
      } catch (closeError) {
        logger.warn('Failed to close health server during cleanup', { closeError });
      }
    }

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
  P4_CHAINS,
  P4_REGION,
  cleanupProcessHandlers,
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

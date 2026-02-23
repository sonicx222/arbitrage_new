/**
 * P4 Solana-Native Partition Service Configuration
 *
 * Assembles partition configuration constants, service config,
 * unified detector config, and arbitrage config from environment
 * variables and the partition registry.
 *
 * Standard partition config (serviceConfig, detectorConfig, chains, region)
 * is now also handled by createPartitionEntry() from @arbitrage/core.
 * The assembleSolanaConfig() function builds only the Solana-specific parts.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see IMPLEMENTATION_PLAN.md S3.1.6: Create P4 detector service
 */

import {
  createLogger,
  parsePort,
  validateAndFilterChains,
  exitWithConfigError,
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES,
  generateInstanceId,
} from '@arbitrage/core';
import type { PartitionServiceConfig } from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';
import type { UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import type { SolanaArbitrageConfig } from './arbitrage-detector';
import { selectSolanaRpcUrl, isDevnetMode, redactRpcUrl } from './rpc-config';
import type { RpcSelection } from './rpc-config';

// =============================================================================
// P4 Partition Constants
// =============================================================================

export const P4_PARTITION_ID = PARTITION_IDS.SOLANA_NATIVE;
// Use centralized port constant (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
export const P4_DEFAULT_PORT = PARTITION_PORTS[P4_PARTITION_ID] ?? 3004;

// =============================================================================
// Solana-Specific Configuration Assembly
// =============================================================================

/**
 * Assembles Solana-specific configuration objects for the P4 partition service.
 *
 * Standard partition configuration (serviceConfig, detectorConfig, chains, region)
 * is handled by createPartitionEntry() from @arbitrage/core. This function
 * only builds the Solana-specific parts: arbitrageConfig and rpcSelection.
 *
 * @param logger - Logger instance for validation/warning output
 * @returns Solana-specific configuration objects
 */
export function assembleSolanaConfig(logger: ReturnType<typeof createLogger>): {
  arbitrageConfig: SolanaArbitrageConfig;
  rpcSelection: RpcSelection;
} {
  // Select RPC URL with priority
  const rpcSelection = selectSolanaRpcUrl();
  const SOLANA_RPC_URL = rpcSelection.url;

  // Issue 3.3: FAIL startup if public RPC in production (P0-CRITICAL)
  // Public RPC endpoints have aggressive rate limits that will cause detection failures.
  // Using public RPC in production is a configuration error that must be fixed.
  if (rpcSelection.isPublicEndpoint && process.env.NODE_ENV === 'production') {
    exitWithConfigError('Public Solana RPC endpoint cannot be used in production', {
      partitionId: P4_PARTITION_ID,
      provider: rpcSelection.provider,
      network: isDevnetMode() ? 'devnet' : 'mainnet',
      hint: 'Set HELIUS_API_KEY or TRITON_API_KEY for production deployment. See README.md "Solana RPC Configuration" section.',
    }, logger);
  }

  // Issue 3.1: Get profit threshold from partition config or environment
  // Default aligns with IMPLEMENTATION_PLAN.md profit threshold guidance
  const DEFAULT_MIN_PROFIT_THRESHOLD = 0.3; // 0.3% minimum profit

  const arbitrageConfig: SolanaArbitrageConfig = {
    // rpcUrl is optional in updated arbitrage-detector.ts (Issue 7.1)
    // Include for backward compatibility with monitoring/logging
    // P2-FIX #19: Store redacted URL to prevent API key leakage in logs/monitoring
    rpcUrl: redactRpcUrl(SOLANA_RPC_URL),
    minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD ?? String(DEFAULT_MIN_PROFIT_THRESHOLD)),
    crossChainEnabled: process.env.CROSS_CHAIN_ENABLED !== 'false',
    triangularEnabled: process.env.TRIANGULAR_ENABLED !== 'false',
    maxTriangularDepth: parseInt(process.env.MAX_TRIANGULAR_DEPTH ?? '3', 10),
    opportunityExpiryMs: parseInt(process.env.OPPORTUNITY_EXPIRY_MS ?? '1000', 10),
    // P3-25: Make defaultTradeValueUsd configurable to align with EVM partition thresholds.
    // Used for gas cost estimation in cross-chain and intra-Solana detection.
    defaultTradeValueUsd: parseFloat(process.env.SOLANA_DEFAULT_TRADE_VALUE_USD ?? '1000'),
    // Issue 1.3: Chain identifier for Solana
    chainId: isDevnetMode() ? 'solana-devnet' : 'solana',
  };

  return {
    arbitrageConfig,
    rpcSelection,
  };
}

// =============================================================================
// Full Configuration Assembly (legacy + test compatibility)
// =============================================================================

/**
 * Assembles all configuration objects for the P4 partition service.
 *
 * NOTE: In the refactored index.ts, standard partition config is handled by
 * createPartitionEntry(). This function is preserved for backward compatibility
 * with existing service-config tests.
 *
 * @param logger - Logger instance for validation/warning output
 * @returns All configuration objects needed by the service orchestrator
 */
export function assembleConfig(logger: ReturnType<typeof createLogger>): {
  P4_CHAINS: readonly string[];
  P4_REGION: string;
  serviceConfig: PartitionServiceConfig;
  config: UnifiedDetectorConfig;
  arbitrageConfig: SolanaArbitrageConfig;
  rpcSelection: RpcSelection;
} {
  // Single partition config retrieval (P5-FIX pattern)
  const partitionConfig = getPartition(P4_PARTITION_ID);
  if (!partitionConfig) {
    exitWithConfigError('P4 partition configuration not found', { partitionId: P4_PARTITION_ID }, logger);
  }

  // BUG-FIX: Add defensive null-safety checks for test compatibility
  // During test imports, mocks may not be fully initialized, so we use optional chaining
  // and provide safe defaults to prevent "Cannot read properties of undefined" errors
  const P4_CHAINS: readonly string[] = partitionConfig?.chains ?? ['solana'];
  const P4_REGION = partitionConfig?.region ?? 'us-west1';

  // Service configuration for shared utilities (P12-P16 refactor)
  const serviceConfig: PartitionServiceConfig = {
    partitionId: P4_PARTITION_ID,
    serviceName: PARTITION_SERVICE_NAMES[P4_PARTITION_ID] ?? 'partition-solana',
    defaultChains: P4_CHAINS,
    defaultPort: P4_DEFAULT_PORT,
    region: P4_REGION,
    provider: partitionConfig?.provider ?? 'oracle'
  };

  // Unified detector configuration
  const config: UnifiedDetectorConfig = {
    partitionId: P4_PARTITION_ID,
    chains: validateAndFilterChains(process.env.PARTITION_CHAINS, P4_CHAINS, logger),
    // P1-FIX 2.12: Use shared generateInstanceId for consistency with other partitions
    instanceId: generateInstanceId(P4_PARTITION_ID, process.env.INSTANCE_ID),
    regionId: process.env.REGION_ID ?? P4_REGION,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
    healthCheckPort: parsePort(process.env.HEALTH_CHECK_PORT, P4_DEFAULT_PORT, logger)
  };

  // Solana-specific config (RPC selection + arbitrage config)
  const { arbitrageConfig, rpcSelection } = assembleSolanaConfig(logger);

  return {
    P4_CHAINS,
    P4_REGION,
    serviceConfig,
    config,
    arbitrageConfig,
    rpcSelection,
  };
}

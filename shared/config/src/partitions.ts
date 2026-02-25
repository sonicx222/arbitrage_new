/**
 * Partition Configuration for Distributed Deployment
 *
 * Defines how chains are grouped into partitions for distributed deployment.
 * Implements ADR-003 (Partitioned Chain Detectors) and supports ADR-007 (Failover Strategy).
 *
 * Partition Design Principles:
 * 1. Geographic proximity - chains with validators in similar regions
 * 2. Block time similarity - chains with similar processing rhythms
 * 3. Resource requirements - balanced resource allocation
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-007: Cross-Region Failover Strategy
 */

// Import partition IDs from standalone file FIRST to avoid circular dependency
// This file has no dependencies, so it can be safely imported before index.ts
import { PARTITION_IDS, PartitionId } from './partition-ids';
export { PARTITION_IDS, PartitionId } from './partition-ids';

// Import from split modules to avoid circular dependency with index.ts
import { CHAINS } from './chains';
import { DEXES, getEnabledDexes } from './dexes';
import { CORE_TOKENS, TOKEN_METADATA } from './tokens';
import { DETECTOR_CONFIG } from './detector-config';

// =============================================================================
// Types
// =============================================================================

export type CloudProvider = 'fly' | 'oracle' | 'railway' | 'render' | 'koyeb' | 'gcp';
export type ResourceProfile = 'light' | 'standard' | 'heavy';
export type Region = 'asia-southeast1' | 'us-east1' | 'us-west1' | 'eu-west1';

export interface PartitionConfig {
  /** Unique identifier for the partition */
  readonly partitionId: string;

  /** Human-readable name */
  readonly name: string;

  /** Chains included in this partition - immutable to prevent accidental mutation */
  readonly chains: readonly string[];

  /** Primary deployment region */
  readonly region: Region;

  /** Cloud provider for deployment */
  readonly provider: CloudProvider;

  /** Resource allocation profile */
  readonly resourceProfile: ResourceProfile;

  /** Standby region for failover (optional) */
  readonly standbyRegion?: Region;

  /** Standby provider for failover (optional) */
  readonly standbyProvider?: CloudProvider;

  /** Priority for resource allocation (1 = highest) */
  readonly priority: number;

  /** Maximum memory in MB */
  readonly maxMemoryMB: number;

  /** Whether this partition is enabled */
  readonly enabled: boolean;

  /** Health check interval in ms */
  readonly healthCheckIntervalMs: number;

  /** Failover timeout in ms */
  readonly failoverTimeoutMs: number;
}

export interface ChainInstance {
  /** Chain identifier */
  chainId: string;

  /** Chain numeric ID */
  numericId: number;

  /** WebSocket connection URL */
  wsUrl: string;

  /** RPC URL for fallback */
  rpcUrl: string;

  /** Block time in seconds */
  blockTime: number;

  /** Native token symbol */
  nativeToken: string;

  /** DEXes to monitor on this chain */
  dexes: string[];

  /** Tokens to monitor on this chain */
  tokens: string[];

  /** Connection status */
  status: 'connected' | 'connecting' | 'disconnected' | 'error';

  /** Last successful block received */
  lastBlockNumber: number;

  /** Last block timestamp */
  lastBlockTimestamp: number;

  /** Events processed count */
  eventsProcessed: number;
}

export interface PartitionHealth {
  /** Partition ID */
  partitionId: string;

  /**
   * Overall health status
   * - 'starting': No chains initialized yet (during startup)
   * - 'healthy': All chains are healthy
   * - 'degraded': Some chains are healthy
   * - 'unhealthy': No chains are healthy
   */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting';

  /** Individual chain health */
  chainHealth: Map<string, ChainHealth>;

  /** Total events processed */
  totalEventsProcessed: number;

  /** Average event latency in ms */
  avgEventLatencyMs: number;

  /** Memory usage in bytes */
  memoryUsage: number;

  /** CPU usage percentage */
  cpuUsage: number;

  /** Uptime in seconds */
  uptimeSeconds: number;

  /** Last health check timestamp */
  lastHealthCheck: number;

  /** Active opportunities count */
  activeOpportunities: number;
}

export interface ChainHealth {
  chainId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  blocksBehind: number;
  lastBlockTime: number;
  wsConnected: boolean;
  eventsPerSecond: number;
  errorCount: number;
}

// =============================================================================
// Chain Utilities
// =============================================================================

/**
 * Check if a chain is EVM-compatible.
 * Non-EVM chains (like Solana) require different connection handling.
 *
 * SAFETY FIX: Unknown chains now throw an error instead of defaulting to EVM.
 * This prevents silent failures when misconfigured chains are used.
 *
 * @param chainId - The chain identifier
 * @returns true if EVM-compatible, false for non-EVM chains
 * @throws Error if chainId is not found in CHAINS configuration
 */
export function isEvmChain(chainId: string): boolean {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unknown chain "${chainId}" - not found in CHAINS configuration`);
  }
  return chain.isEVM !== false; // Explicitly check for false (undefined = EVM)
}

/**
 * Check if a chain is EVM-compatible (safe version).
 * Returns false for unknown chains instead of throwing.
 * Use this when you want to silently handle unknown chains.
 *
 * @param chainId - The chain identifier
 * @returns true if EVM-compatible, false for non-EVM or unknown chains
 */
export function isEvmChainSafe(chainId: string): boolean {
  const chain = CHAINS[chainId];
  if (!chain) return false; // Unknown chains are not EVM
  return chain.isEVM !== false;
}

/**
 * Get all non-EVM chain IDs currently configured.
 */
export function getNonEvmChains(): string[] {
  return Object.keys(CHAINS).filter(chainId => !isEvmChain(chainId));
}

// =============================================================================
// Partition Definitions (ADR-003)
// =============================================================================

/**
 * Production partition configurations.
 * Aligned with ARCHITECTURE_V2.md and ADR-003 specifications.
 *
 * S3.1.2: 4-Partition Architecture
 * - P1: Asia-Fast (BSC, Polygon, Avalanche, Fantom) - EVM high-throughput chains
 * - P2: L2-Turbo (Arbitrum, Optimism, Base, Blast, Scroll, Mantle, Mode) - Ethereum L2 rollups
 * - P3: High-Value (Ethereum, zkSync, Linea) - High-value EVM chains
 * - P4: Solana-Native (Solana) - Non-EVM, dedicated partition
 */
// Note: Using string literals for partitionId to avoid circular dependency issues
// during module initialization. Values match those in partition-ids.ts.
export const PARTITIONS: PartitionConfig[] = [
  // P1: Asia-Fast - High-throughput Asian chains
  {
    partitionId: 'asia-fast',
    name: 'Asia Fast Chains',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
    provider: 'fly',
    resourceProfile: 'heavy',
    standbyRegion: 'us-west1',
    standbyProvider: 'render',
    priority: 1,
    maxMemoryMB: 768, // 4 chains need more memory
    enabled: true,
    // Health check interval: 15000ms (moderate frequency)
    // ADR-003 hierarchy: P2 (L2-Turbo) = 10s (fastest), P1 (Asia-Fast) = 15s (moderate), P3 (High-Value) = 30s (slowest)
    // BSC/Polygon/Avalanche/Fantom have 2-5s blocks, 15s allows ~3-7x block time buffer
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000
  },
  // P2: L2-Turbo - Fast Ethereum L2 rollups + emerging L2s
  {
    partitionId: 'l2-turbo',
    name: 'L2 Turbo Chains',
    // Removed blast, scroll, mantle, mode -- all have placeholder DEX addresses (0x000...)
    // Re-add when real factory addresses are configured in dexes/index.ts
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'asia-southeast1',
    provider: 'fly',
    resourceProfile: 'standard', // 3 chains (was 'heavy' for 7)
    standbyRegion: 'us-east1',
    standbyProvider: 'railway',
    priority: 1,
    maxMemoryMB: 512, // 3 chains (was 768 for 7)
    enabled: true,
    healthCheckIntervalMs: 10000, // Faster checks for sub-second blocks
    failoverTimeoutMs: 45000
  },
  // P3: High-Value - Ethereum mainnet and ZK rollups
  {
    partitionId: 'high-value',
    name: 'High Value Chains',
    chains: ['ethereum', 'zksync', 'linea'],
    region: 'us-east1',
    provider: 'fly',
    resourceProfile: 'heavy',
    standbyRegion: 'eu-west1',
    standbyProvider: 'gcp',
    priority: 2,
    maxMemoryMB: 768,
    enabled: true,
    healthCheckIntervalMs: 30000,
    failoverTimeoutMs: 60000
  },
  // P4: Solana-Native - Non-EVM dedicated partition
  {
    partitionId: 'solana-native',
    name: 'Solana Native',
    chains: ['solana'],
    region: 'us-west1', // Solana validator proximity
    provider: 'fly',
    resourceProfile: 'heavy', // High-throughput needs resources
    standbyRegion: 'us-east1',
    standbyProvider: 'railway',
    priority: 2,
    maxMemoryMB: 512,
    enabled: true,
    healthCheckIntervalMs: 10000, // 400ms blocks need fast checks
    failoverTimeoutMs: 45000
  }
];

/**
 * Future partition configurations (Phase 2+).
 *
 * NOTE: These are disabled templates for planned Phase 2 expansion.
 * - All partitions have `enabled: false`
 * - Used in tests to verify disabled partitions are excluded from getEnabledPartitions()
 * - Will be activated when Phase 2 chains are added (e.g., Scroll)
 *
 * @see partitions.test.ts - Tests verify these remain disabled
 */
export const FUTURE_PARTITIONS: PartitionConfig[] = [
  {
    partitionId: 'asia-fast-expanded',
    name: 'Asia Fast Chains (Expanded)',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 1,
    maxMemoryMB: 768,
    enabled: false,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000
  },
  {
    partitionId: 'high-value-expanded',
    name: 'High Value Chains (Expanded)',
    chains: ['ethereum', 'zksync', 'linea', 'scroll'],
    region: 'us-east1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 2,
    maxMemoryMB: 768,
    enabled: false,
    healthCheckIntervalMs: 30000,
    failoverTimeoutMs: 60000
  },
  {
    partitionId: 'non-evm',
    name: 'Non-EVM Chains',
    chains: ['solana'],
    region: 'us-west1',
    provider: 'fly',
    resourceProfile: 'heavy',
    priority: 3,
    maxMemoryMB: 512,
    enabled: false,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000
  }
];

// =============================================================================
// Chain Assignment
// =============================================================================

// Pre-computed partition lookup by ID for O(1) access
const PARTITION_BY_ID = new Map<string, PartitionConfig>(
  PARTITIONS.map(p => [p.partitionId, p])
);

// Pre-computed chain-to-partition assignments for O(1) lookups (hot-path optimization)
// Built at module load time from PARTITIONS chain lists
const CHAIN_TO_PARTITION = new Map<string, PartitionConfig>();
for (const partition of PARTITIONS) {
  for (const chainId of partition.chains) {
    CHAIN_TO_PARTITION.set(chainId, partition);
  }
}

/**
 * Assign a chain to the appropriate partition based on ADR-003 rules.
 * FIX: Uses pre-computed O(1) lookup instead of O(n) iterations.
 *
 * S3.1.2: 4-Partition Assignment Rules (in priority order):
 * 1. Non-EVM chains (Solana) → solana-native partition
 * 2. Ethereum L2 rollups (Arbitrum, Optimism, Base) → l2-turbo partition
 * 3. High-value EVM chains (Ethereum, zkSync, Linea) → high-value partition
 * 4. Fast Asian chains (BSC, Polygon, Avalanche, Fantom) → asia-fast partition
 * 5. Default: high-value partition
 */
export function assignChainToPartition(chainId: string): PartitionConfig | null {
  const chain = CHAINS[chainId];
  if (!chain) {
    return null;
  }

  // Fast path: use pre-computed lookup
  const preComputed = CHAIN_TO_PARTITION.get(chainId);
  if (preComputed) {
    return preComputed;
  }

  // Fallback for chains not explicitly assigned (should not happen with complete config)
  // Default: high-value partition
  return PARTITION_BY_ID.get(PARTITION_IDS.HIGH_VALUE) || null;
}

/**
 * Get partition by ID.
 * FIX: Uses pre-computed O(1) lookup instead of O(n) find.
 */
export function getPartition(partitionId: string): PartitionConfig | undefined {
  return PARTITION_BY_ID.get(partitionId);
}

/**
 * Get all enabled partitions.
 */
export function getEnabledPartitions(): PartitionConfig[] {
  return PARTITIONS.filter(p => p.enabled);
}

/**
 * Get chains for a partition.
 * Returns a copy of the chains array to prevent mutation of the partition config.
 */
export function getChainsForPartition(partitionId: string): string[] {
  const partition = getPartition(partitionId);
  // S3.2.2-FIX: Return array copy to prevent mutation of partition config
  return partition ? [...partition.chains] : [];
}

// =============================================================================
// Chain Instance Factory
// =============================================================================

/**
 * Create a ChainInstance configuration for a chain.
 */
export function createChainInstance(chainId: string): ChainInstance | null {
  const chain = CHAINS[chainId];
  if (!chain) {
    return null;
  }

  const dexes = getEnabledDexes(chainId);
  const tokens = CORE_TOKENS[chainId] || [];

  // FIX: Use wsFallbackUrls if primary wsUrl is missing (rpcUrl won't work for WebSocket)
  const effectiveWsUrl = chain.wsUrl ||
    (chain.wsFallbackUrls && chain.wsFallbackUrls.length > 0 ? chain.wsFallbackUrls[0] : '');

  return {
    chainId,
    numericId: chain.id,
    wsUrl: effectiveWsUrl,
    rpcUrl: chain.rpcUrl,
    blockTime: chain.blockTime,
    nativeToken: chain.nativeToken,
    dexes: dexes.map(d => d.name),
    tokens: tokens.map(t => t.symbol),
    status: 'disconnected',
    lastBlockNumber: 0,
    lastBlockTimestamp: 0,
    eventsProcessed: 0
  };
}

/**
 * Create all chain instances for a partition.
 */
export function createPartitionChainInstances(partitionId: string): ChainInstance[] {
  const chains = getChainsForPartition(partitionId);
  return chains
    .map(chainId => createChainInstance(chainId))
    .filter((c): c is ChainInstance => c !== null);
}

// =============================================================================
// Resource Calculation
// =============================================================================

/**
 * Calculate resource requirements for a partition.
 */
export function calculatePartitionResources(partitionId: string): {
  estimatedMemoryMB: number;
  estimatedCpuCores: number;
  recommendedProfile: ResourceProfile;
} {
  const partition = getPartition(partitionId);
  if (!partition) {
    return { estimatedMemoryMB: 256, estimatedCpuCores: 0.5, recommendedProfile: 'light' };
  }

  // Base memory per chain
  const baseMemoryPerChain = 64; // MB

  // DEX factor (more DEXes = more memory)
  // Use getEnabledDexes to only count DEXs that will actually be monitored
  let totalDexes = 0;
  for (const chainId of partition.chains) {
    const dexes = getEnabledDexes(chainId);
    totalDexes += dexes.length;
  }
  const dexMemory = totalDexes * 8; // 8MB per DEX

  // Token factor
  let totalTokens = 0;
  for (const chainId of partition.chains) {
    const tokens = CORE_TOKENS[chainId] || [];
    totalTokens += tokens.length;
  }
  const tokenMemory = totalTokens * 2; // 2MB per token

  // Block time factor (faster blocks = more CPU needed)
  let avgBlockTime = 10; // Default fallback for empty chains
  if (partition.chains.length > 0) {
    let totalBlockTime = 0;
    for (const chainId of partition.chains) {
      const chain = CHAINS[chainId];
      totalBlockTime += chain?.blockTime || 10;
    }
    avgBlockTime = totalBlockTime / partition.chains.length;
  }

  const estimatedMemoryMB = (partition.chains.length * baseMemoryPerChain) + dexMemory + tokenMemory + 64; // +64 overhead
  const estimatedCpuCores = avgBlockTime < 2 ? 1.0 : avgBlockTime < 5 ? 0.5 : 0.25;

  let recommendedProfile: ResourceProfile;
  if (estimatedMemoryMB > 400) {
    recommendedProfile = 'heavy';
  } else if (estimatedMemoryMB > 256) {
    recommendedProfile = 'standard';
  } else {
    recommendedProfile = 'light';
  }

  return { estimatedMemoryMB, estimatedCpuCores, recommendedProfile };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate partition configuration.
 */
export function validatePartitionConfig(partition: PartitionConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check partition ID
  if (!partition.partitionId || partition.partitionId.length < 3) {
    errors.push('Partition ID must be at least 3 characters');
  }

  // Check chains exist
  for (const chainId of partition.chains) {
    if (!CHAINS[chainId]) {
      errors.push(`Chain ${chainId} not found in CHAINS configuration`);
    }
  }

  // Check for duplicate chains across partitions
  const allChainsInOtherPartitions = PARTITIONS
    .filter(p => p.partitionId !== partition.partitionId && p.enabled)
    .flatMap(p => p.chains);

  for (const chainId of partition.chains) {
    if (allChainsInOtherPartitions.includes(chainId)) {
      warnings.push(`Chain ${chainId} is assigned to multiple partitions`);
    }
  }

  // Check resource profile matches chain requirements
  const resources = calculatePartitionResources(partition.partitionId);
  if (resources.recommendedProfile === 'heavy' && partition.resourceProfile === 'light') {
    warnings.push(`Partition may need more resources than allocated (recommended: ${resources.recommendedProfile})`);
  }

  // Check memory limits
  if (partition.maxMemoryMB < resources.estimatedMemoryMB) {
    warnings.push(`Max memory (${partition.maxMemoryMB}MB) may be insufficient (estimated: ${resources.estimatedMemoryMB}MB)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate all partitions.
 */
export function validateAllPartitions(): {
  valid: boolean;
  results: Map<string, { valid: boolean; errors: string[]; warnings: string[] }>;
} {
  const results = new Map<string, { valid: boolean; errors: string[]; warnings: string[] }>();
  let allValid = true;

  for (const partition of PARTITIONS) {
    const result = validatePartitionConfig(partition);
    results.set(partition.partitionId, result);
    if (!result.valid) {
      allValid = false;
    }
  }

  return { valid: allValid, results };
}

// =============================================================================
// Environment Configuration
// =============================================================================

/**
 * Get partition ID from environment variable.
 * Used by unified-detector to determine which partition to run.
 */
export function getPartitionIdFromEnv(): string {
  return process.env.PARTITION_ID || PARTITION_IDS.ASIA_FAST;
}

/**
 * Get partition configuration from environment.
 */
export function getPartitionFromEnv(): PartitionConfig | null {
  const partitionId = getPartitionIdFromEnv();
  return getPartition(partitionId) || null;
}

/**
 * Get all chain IDs from environment (supports comma-separated override).
 * Returns a copy of the chains array to prevent mutation of partition config.
 *
 * S3.2.3-FIX: Validates that environment-provided chains exist in CHAINS configuration.
 * Invalid chains are silently filtered out to prevent runtime errors.
 */
export function getChainsFromEnv(): string[] {
  const envChains = process.env.PARTITION_CHAINS;
  if (envChains) {
    // S3.2.3-FIX: Validate chains exist in CHAINS configuration
    const requestedChains = envChains.split(',').map(c => c.trim().toLowerCase());
    const validChainIds = Object.keys(CHAINS);
    return requestedChains.filter(chain => validChainIds.includes(chain));
  }

  const partition = getPartitionFromEnv();
  // S3.2.3-FIX: Return array copy to prevent mutation (consistent with getChainsForPartition)
  return partition?.chains ? [...partition.chains] : [];
}

// =============================================================================
// PHASE METRICS (Consolidated from partition-config.ts)
// Track progress against targets from ADR-008
// =============================================================================

/**
 * Phase metrics for tracking implementation progress.
 * Dynamically calculates current counts from actual configuration.
 *
 * S3.1.2: Updated for 4-partition architecture (11 chains, 44 DEXes, 94 tokens)
 * S3.2.2: Updated for Fantom expansion (11 chains, 46 DEXes, 98 tokens)
 * S3.3.3: Updated for Solana token expansion (11 chains, 49 DEXes, 112 tokens)
 * Phase 1 Adapters: Added vault-model DEX adapters (GMX, Platypus, Beethoven X)
 *
 * @see ADR-008: Phase metrics and targets
 */
export const PHASE_METRICS = {
  current: {
    phase: 1,
    chains: Object.keys(CHAINS).length,
    dexes: Object.values(DEXES).flat().length,
    tokens: Object.values(CORE_TOKENS).flat().length,
    targetOpportunities: 500  // Increased with more chains/DEXes
  },
  targets: {
    // Phase 1 with vault-model adapters:
    // - 11 chains (original 6 + avalanche, fantom, zksync, linea, solana)
    // - 49 DEXes (46 + 3 newly enabled: GMX, Platypus, Beethoven X with adapters)
    // - 112 tokens breakdown:
    //   Original 6 chains: 60 (arb:12 + bsc:10 + base:10 + poly:10 + opt:10 + eth:8)
    //   S3.1.2 new chains: 12 (zksync:6 + linea:6)
    //   S3.2.1 Avalanche: 15, S3.2.2 Fantom: 10, S3.3.3 Solana: 15
    phase1: { chains: 11, dexes: 49, tokens: 112, opportunities: 500 },
    phase2: { chains: 15, dexes: 60, tokens: 145, opportunities: 750 },
    phase3: { chains: 20, dexes: 80, tokens: 200, opportunities: 1000 }
  }
};

// =============================================================================
// PARTITION_CONFIG (Backward compatibility - derived from PARTITIONS)
// Use getChainsForPartition() for runtime access instead
// =============================================================================

/**
 * Partition chain assignments - S3.1.2 configuration.
 * Derived from PARTITIONS array for backward compatibility.
 *
 * IMMUTABILITY FIX: Arrays are frozen at runtime to prevent accidental mutation.
 * The `as const` TypeScript assertion only provides compile-time checks;
 * Object.freeze() provides actual runtime protection against mutation.
 *
 * @deprecated Use getChainsForPartition() from partitions.ts for runtime access.
 *             This export will be removed in a future version.
 */
const _PARTITION_CONFIG_INTERNAL = Object.freeze({
  // P1: Asia-Fast - EVM high-throughput chains
  P1_ASIA_FAST: Object.freeze(getChainsForPartition(PARTITION_IDS.ASIA_FAST)),
  // P2: L2-Turbo - Ethereum L2 rollups
  P2_L2_TURBO: Object.freeze(getChainsForPartition(PARTITION_IDS.L2_TURBO)),
  // P3: High-Value - Ethereum mainnet + ZK rollups
  P3_HIGH_VALUE: Object.freeze(getChainsForPartition(PARTITION_IDS.HIGH_VALUE)),
  // P4: Solana-Native - Non-EVM chains
  P4_SOLANA_NATIVE: Object.freeze(getChainsForPartition(PARTITION_IDS.SOLANA_NATIVE))
}) as {
  readonly P1_ASIA_FAST: readonly string[];
  readonly P2_L2_TURBO: readonly string[];
  readonly P3_HIGH_VALUE: readonly string[];
  readonly P4_SOLANA_NATIVE: readonly string[];
};

// P0-7 FIX: Runtime deprecation warning for PARTITION_CONFIG
// Logs a warning once on first access to help identify code that needs updating
let _partitionConfigWarningShown = false;
export const PARTITION_CONFIG = new Proxy(_PARTITION_CONFIG_INTERNAL, {
  get(target, prop, receiver) {
    if (!_partitionConfigWarningShown && process.env.NODE_ENV !== 'test') {
      _partitionConfigWarningShown = true;
      console.warn(
        '[DEPRECATED] PARTITION_CONFIG is deprecated. ' +
        'Use getChainsForPartition(partitionId) or getPartitionFromEnv() instead. ' +
        'This export will be removed in a future version.'
      );
    }
    return Reflect.get(target, prop, receiver);
  }
});

"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FUTURE_PARTITIONS = exports.PARTITIONS = void 0;
exports.isEvmChain = isEvmChain;
exports.getNonEvmChains = getNonEvmChains;
exports.assignChainToPartition = assignChainToPartition;
exports.getPartition = getPartition;
exports.getEnabledPartitions = getEnabledPartitions;
exports.getChainsForPartition = getChainsForPartition;
exports.createChainInstance = createChainInstance;
exports.createPartitionChainInstances = createPartitionChainInstances;
exports.calculatePartitionResources = calculatePartitionResources;
exports.validatePartitionConfig = validatePartitionConfig;
exports.validateAllPartitions = validateAllPartitions;
exports.getPartitionIdFromEnv = getPartitionIdFromEnv;
exports.getPartitionFromEnv = getPartitionFromEnv;
exports.getChainsFromEnv = getChainsFromEnv;
const index_1 = require("./index");
// =============================================================================
// Chain Utilities
// =============================================================================
/**
 * Check if a chain is EVM-compatible.
 * Non-EVM chains (like Solana) require different connection handling.
 *
 * @param chainId - The chain identifier
 * @returns true if EVM-compatible, false otherwise
 */
function isEvmChain(chainId) {
    const chain = index_1.CHAINS[chainId];
    if (!chain)
        return true; // Default to EVM for unknown chains (safe default)
    return chain.isEVM !== false; // Explicitly check for false (undefined = EVM)
}
/**
 * Get all non-EVM chain IDs currently configured.
 */
function getNonEvmChains() {
    return Object.keys(index_1.CHAINS).filter(chainId => !isEvmChain(chainId));
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
 * - P2: L2-Turbo (Arbitrum, Optimism, Base) - Ethereum L2 rollups
 * - P3: High-Value (Ethereum, zkSync, Linea) - High-value EVM chains
 * - P4: Solana-Native (Solana) - Non-EVM, dedicated partition
 */
exports.PARTITIONS = [
    // P1: Asia-Fast - High-throughput Asian chains
    {
        partitionId: index_1.PARTITION_IDS.ASIA_FAST,
        name: 'Asia Fast Chains',
        chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
        region: 'asia-southeast1',
        provider: 'oracle',
        resourceProfile: 'heavy',
        standbyRegion: 'us-west1',
        standbyProvider: 'render',
        priority: 1,
        maxMemoryMB: 768, // 4 chains need more memory
        enabled: true,
        healthCheckIntervalMs: 15000,
        failoverTimeoutMs: 60000
    },
    // P2: L2-Turbo - Fast Ethereum L2 rollups
    {
        partitionId: index_1.PARTITION_IDS.L2_TURBO,
        name: 'L2 Turbo Chains',
        chains: ['arbitrum', 'optimism', 'base'],
        region: 'asia-southeast1',
        provider: 'fly',
        resourceProfile: 'standard',
        standbyRegion: 'us-east1',
        standbyProvider: 'railway',
        priority: 1,
        maxMemoryMB: 512,
        enabled: true,
        healthCheckIntervalMs: 10000, // Faster checks for sub-second blocks
        failoverTimeoutMs: 45000
    },
    // P3: High-Value - Ethereum mainnet and ZK rollups
    {
        partitionId: index_1.PARTITION_IDS.HIGH_VALUE,
        name: 'High Value Chains',
        chains: ['ethereum', 'zksync', 'linea'],
        region: 'us-east1',
        provider: 'oracle',
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
        partitionId: index_1.PARTITION_IDS.SOLANA_NATIVE,
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
 */
exports.FUTURE_PARTITIONS = [
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
/**
 * Assign a chain to the appropriate partition based on ADR-003 rules.
 *
 * S3.1.2: 4-Partition Assignment Rules (in priority order):
 * 1. Non-EVM chains (Solana) → solana-native partition
 * 2. Ethereum L2 rollups (Arbitrum, Optimism, Base) → l2-turbo partition
 * 3. High-value EVM chains (Ethereum, zkSync, Linea) → high-value partition
 * 4. Fast Asian chains (BSC, Polygon, Avalanche, Fantom) → asia-fast partition
 * 5. Default: high-value partition
 */
function assignChainToPartition(chainId) {
    const chain = index_1.CHAINS[chainId];
    if (!chain) {
        return null;
    }
    // Rule 1: Non-EVM chains (Solana)
    if (!isEvmChain(chainId)) {
        return exports.PARTITIONS.find(p => p.partitionId === index_1.PARTITION_IDS.SOLANA_NATIVE) || null;
    }
    // Rule 2: Ethereum L2 rollups
    if (['arbitrum', 'optimism', 'base'].includes(chainId)) {
        return exports.PARTITIONS.find(p => p.partitionId === index_1.PARTITION_IDS.L2_TURBO) || null;
    }
    // Rule 3: High-value chains (Ethereum mainnet + ZK rollups)
    if (['ethereum', 'zksync', 'linea'].includes(chainId)) {
        return exports.PARTITIONS.find(p => p.partitionId === index_1.PARTITION_IDS.HIGH_VALUE) || null;
    }
    // Rule 4: Fast Asian chains (high-throughput EVM)
    if (['bsc', 'polygon', 'avalanche', 'fantom'].includes(chainId)) {
        return exports.PARTITIONS.find(p => p.partitionId === index_1.PARTITION_IDS.ASIA_FAST) || null;
    }
    // Default: high-value
    return exports.PARTITIONS.find(p => p.partitionId === index_1.PARTITION_IDS.HIGH_VALUE) || null;
}
/**
 * Get partition by ID.
 */
function getPartition(partitionId) {
    return exports.PARTITIONS.find(p => p.partitionId === partitionId);
}
/**
 * Get all enabled partitions.
 */
function getEnabledPartitions() {
    return exports.PARTITIONS.filter(p => p.enabled);
}
/**
 * Get chains for a partition.
 * Returns a copy of the chains array to prevent mutation of the partition config.
 */
function getChainsForPartition(partitionId) {
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
function createChainInstance(chainId) {
    const chain = index_1.CHAINS[chainId];
    if (!chain) {
        return null;
    }
    const dexes = (0, index_1.getEnabledDexes)(chainId);
    const tokens = index_1.CORE_TOKENS[chainId] || [];
    return {
        chainId,
        numericId: chain.id,
        wsUrl: chain.wsUrl || chain.rpcUrl, // Fallback to RPC URL if WS not configured
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
function createPartitionChainInstances(partitionId) {
    const chains = getChainsForPartition(partitionId);
    return chains
        .map(chainId => createChainInstance(chainId))
        .filter((c) => c !== null);
}
// =============================================================================
// Resource Calculation
// =============================================================================
/**
 * Calculate resource requirements for a partition.
 */
function calculatePartitionResources(partitionId) {
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
        const dexes = (0, index_1.getEnabledDexes)(chainId);
        totalDexes += dexes.length;
    }
    const dexMemory = totalDexes * 8; // 8MB per DEX
    // Token factor
    let totalTokens = 0;
    for (const chainId of partition.chains) {
        const tokens = index_1.CORE_TOKENS[chainId] || [];
        totalTokens += tokens.length;
    }
    const tokenMemory = totalTokens * 2; // 2MB per token
    // Block time factor (faster blocks = more CPU needed)
    let avgBlockTime = 10; // Default fallback for empty chains
    if (partition.chains.length > 0) {
        let totalBlockTime = 0;
        for (const chainId of partition.chains) {
            const chain = index_1.CHAINS[chainId];
            totalBlockTime += chain?.blockTime || 10;
        }
        avgBlockTime = totalBlockTime / partition.chains.length;
    }
    const estimatedMemoryMB = (partition.chains.length * baseMemoryPerChain) + dexMemory + tokenMemory + 64; // +64 overhead
    const estimatedCpuCores = avgBlockTime < 2 ? 1.0 : avgBlockTime < 5 ? 0.5 : 0.25;
    let recommendedProfile;
    if (estimatedMemoryMB > 400) {
        recommendedProfile = 'heavy';
    }
    else if (estimatedMemoryMB > 256) {
        recommendedProfile = 'standard';
    }
    else {
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
function validatePartitionConfig(partition) {
    const errors = [];
    const warnings = [];
    // Check partition ID
    if (!partition.partitionId || partition.partitionId.length < 3) {
        errors.push('Partition ID must be at least 3 characters');
    }
    // Check chains exist
    for (const chainId of partition.chains) {
        if (!index_1.CHAINS[chainId]) {
            errors.push(`Chain ${chainId} not found in CHAINS configuration`);
        }
    }
    // Check for duplicate chains across partitions
    const allChainsInOtherPartitions = exports.PARTITIONS
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
function validateAllPartitions() {
    const results = new Map();
    let allValid = true;
    for (const partition of exports.PARTITIONS) {
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
function getPartitionIdFromEnv() {
    return process.env.PARTITION_ID || index_1.PARTITION_IDS.ASIA_FAST;
}
/**
 * Get partition configuration from environment.
 */
function getPartitionFromEnv() {
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
function getChainsFromEnv() {
    const envChains = process.env.PARTITION_CHAINS;
    if (envChains) {
        // S3.2.3-FIX: Validate chains exist in CHAINS configuration
        const requestedChains = envChains.split(',').map(c => c.trim().toLowerCase());
        const validChainIds = Object.keys(index_1.CHAINS);
        return requestedChains.filter(chain => validChainIds.includes(chain));
    }
    const partition = getPartitionFromEnv();
    // S3.2.3-FIX: Return array copy to prevent mutation (consistent with getChainsForPartition)
    return partition?.chains ? [...partition.chains] : [];
}
//# sourceMappingURL=partitions.js.map
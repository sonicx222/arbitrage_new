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
// Partition Definitions (ADR-003)
// =============================================================================
/**
 * Production partition configurations.
 * Aligned with ARCHITECTURE_V2.md and ADR-003 specifications.
 */
exports.PARTITIONS = [
    {
        partitionId: 'asia-fast',
        name: 'Asia Fast Chains',
        chains: ['bsc', 'polygon'],
        region: 'asia-southeast1',
        provider: 'oracle',
        resourceProfile: 'heavy',
        standbyRegion: 'us-west1',
        standbyProvider: 'render',
        priority: 1,
        maxMemoryMB: 512,
        enabled: true,
        healthCheckIntervalMs: 15000,
        failoverTimeoutMs: 60000
    },
    {
        partitionId: 'l2-fast',
        name: 'L2 Fast Chains',
        chains: ['arbitrum', 'optimism', 'base'],
        region: 'asia-southeast1',
        provider: 'fly',
        resourceProfile: 'standard',
        standbyRegion: 'us-east1',
        standbyProvider: 'railway',
        priority: 1,
        maxMemoryMB: 384,
        enabled: true,
        healthCheckIntervalMs: 10000,
        failoverTimeoutMs: 45000
    },
    {
        partitionId: 'high-value',
        name: 'High Value Chains',
        chains: ['ethereum'],
        region: 'us-east1',
        provider: 'oracle',
        resourceProfile: 'heavy',
        standbyRegion: 'eu-west1',
        standbyProvider: 'gcp',
        priority: 2,
        maxMemoryMB: 512,
        enabled: true,
        healthCheckIntervalMs: 30000,
        failoverTimeoutMs: 60000
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
 * Rules (in priority order):
 * 1. Non-EVM chains get dedicated partition
 * 2. Ultra-fast L2s (< 1s blocks) go to L2-Fast
 * 3. High-value chains (Ethereum + ZK rollups) go to High-Value
 * 4. Fast Asian chains (< 5s blocks) go to Asia-Fast
 * 5. Default: High-Value partition
 */
function assignChainToPartition(chainId) {
    const chain = index_1.CHAINS[chainId];
    if (!chain) {
        return null;
    }
    // Rule 1: Non-EVM chains (future)
    // Currently all chains are EVM, so this is for future Solana support
    // Rule 2: Ultra-fast L2s (< 1s effective block time)
    if (chain.blockTime < 1 || chainId === 'arbitrum') {
        return exports.PARTITIONS.find(p => p.partitionId === 'l2-fast') || null;
    }
    // Rule 3: High-value chains
    if (chainId === 'ethereum' || chain.id === 1) {
        return exports.PARTITIONS.find(p => p.partitionId === 'high-value') || null;
    }
    // Rule 4: L2s with moderate block times
    if (['optimism', 'base'].includes(chainId)) {
        return exports.PARTITIONS.find(p => p.partitionId === 'l2-fast') || null;
    }
    // Rule 5: Fast Asian chains (< 5s blocks)
    if (chain.blockTime < 5) {
        return exports.PARTITIONS.find(p => p.partitionId === 'asia-fast') || null;
    }
    // Default: High-value
    return exports.PARTITIONS.find(p => p.partitionId === 'high-value') || null;
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
 */
function getChainsForPartition(partitionId) {
    const partition = getPartition(partitionId);
    return partition?.chains || [];
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
    const dexes = index_1.DEXES[chainId] || [];
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
    let totalDexes = 0;
    for (const chainId of partition.chains) {
        const dexes = index_1.DEXES[chainId] || [];
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
    return process.env.PARTITION_ID || 'asia-fast';
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
 */
function getChainsFromEnv() {
    const envChains = process.env.PARTITION_CHAINS;
    if (envChains) {
        return envChains.split(',').map(c => c.trim());
    }
    const partition = getPartitionFromEnv();
    return partition?.chains || [];
}
//# sourceMappingURL=partitions.js.map
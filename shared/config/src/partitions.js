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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFydGl0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBhcnRpdGlvbnMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7O0dBYUc7OztBQXdQSCx3REErQkM7QUFLRCxvQ0FFQztBQUtELG9EQUVDO0FBS0Qsc0RBR0M7QUFTRCxrREF1QkM7QUFLRCxzRUFLQztBQVNELGtFQXFEQztBQVNELDBEQStDQztBQUtELHNEQWdCQztBQVVELHNEQUVDO0FBS0Qsa0RBR0M7QUFLRCw0Q0FRQztBQWpnQkQsbUNBQXNGO0FBbUl0RixnRkFBZ0Y7QUFDaEYsa0NBQWtDO0FBQ2xDLGdGQUFnRjtBQUVoRjs7O0dBR0c7QUFDVSxRQUFBLFVBQVUsR0FBc0I7SUFDM0M7UUFDRSxXQUFXLEVBQUUsV0FBVztRQUN4QixJQUFJLEVBQUUsa0JBQWtCO1FBQ3hCLE1BQU0sRUFBRSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUM7UUFDMUIsTUFBTSxFQUFFLGlCQUFpQjtRQUN6QixRQUFRLEVBQUUsUUFBUTtRQUNsQixlQUFlLEVBQUUsT0FBTztRQUN4QixhQUFhLEVBQUUsVUFBVTtRQUN6QixlQUFlLEVBQUUsUUFBUTtRQUN6QixRQUFRLEVBQUUsQ0FBQztRQUNYLFdBQVcsRUFBRSxHQUFHO1FBQ2hCLE9BQU8sRUFBRSxJQUFJO1FBQ2IscUJBQXFCLEVBQUUsS0FBSztRQUM1QixpQkFBaUIsRUFBRSxLQUFLO0tBQ3pCO0lBQ0Q7UUFDRSxXQUFXLEVBQUUsU0FBUztRQUN0QixJQUFJLEVBQUUsZ0JBQWdCO1FBQ3RCLE1BQU0sRUFBRSxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsTUFBTSxDQUFDO1FBQ3hDLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLEtBQUs7UUFDZixlQUFlLEVBQUUsVUFBVTtRQUMzQixhQUFhLEVBQUUsVUFBVTtRQUN6QixlQUFlLEVBQUUsU0FBUztRQUMxQixRQUFRLEVBQUUsQ0FBQztRQUNYLFdBQVcs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QUFFaEY7OztHQUdHO0FBQ0gsU0FBZ0IscUJBQXFCO0lBQ25DLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLElBQUksV0FBVyxDQUFDO0FBQ2pELENBQUM7QUFFRDs7R0FFRztBQUNILFNBQWdCLG1CQUFtQjtJQUNqQyxNQUFNLFdBQVcsR0FBRyxxQkFBcUIsRUFBRSxDQUFDO0lBQzVDLE9BQU8sWUFBWSxDQUFDLFdBQVcsQ0FBQyxJQUFJLElBQUksQ0FBQztBQUMzQyxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixnQkFBZ0I7SUFDOUIsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQztJQUMvQyxJQUFJLFNBQVMsRUFBRSxDQUFDO1FBQ2QsT0FBTyxTQUFTLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFFRCxNQUFNLFNBQVMsR0FBRyxtQkFBbUIsRUFBRSxDQUFDO0lBQ3hDLE9BQU8sU0FBUyxFQUFFLE1BQU0sSUFBSSxFQUFFLENBQUM7QUFDakMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUGFydGl0aW9uIENvbmZpZ3VyYXRpb24gZm9yIERpc3RyaWJ1dGVkIERlcGxveW1lbnRcbiAqXG4gKiBEZWZpbmVzIGhvdyBjaGFpbnMgYXJlIGdyb3VwZWQgaW50byBwYXJ0aXRpb25zIGZvciBkaXN0cmlidXRlZCBkZXBsb3ltZW50LlxuICogSW1wbGVtZW50cyBBRFItMDAzIChQYXJ0aXRpb25lZCBDaGFpbiBEZXRlY3RvcnMpIGFuZCBzdXBwb3J0cyBBRFItMDA3IChGYWlsb3ZlciBTdHJhdGVneSkuXG4gKlxuICogUGFydGl0aW9uIERlc2lnbiBQcmluY2lwbGVzOlxuICogMS4gR2VvZ3JhcGhpYyBwcm94aW1pdHkgLSBjaGFpbnMgd2l0aCB2YWxpZGF0b3JzIGluIHNpbWlsYXIgcmVnaW9uc1xuICogMi4gQmxvY2sgdGltZSBzaW1pbGFyaXR5IC0gY2hhaW5zIHdpdGggc2ltaWxhciBwcm9jZXNzaW5nIHJoeXRobXNcbiAqIDMuIFJlc291cmNlIHJlcXVpcmVtZW50cyAtIGJhbGFuY2VkIHJlc291cmNlIGFsbG9jYXRpb25cbiAqXG4gKiBAc2VlIEFEUi0wMDM6IFBhcnRpdGlvbmVkIENoYWluIERldGVjdG9yc1xuICogQHNlZSBBRFItMDA3OiBDcm9zcy1SZWdpb24gRmFpbG92ZXIgU3RyYXRlZ3lcbiAqL1xuXG5pbXBvcnQgeyBDSEFJTlMsIERFWEVTLCBDT1JFX1RPS0VOUywgREVURUNUT1JfQ09ORklHLCBUT0tFTl9NRVRBREFUQSB9IGZyb20gJy4vaW5kZXgnO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVHlwZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCB0eXBlIENsb3VkUHJvdmlkZXIgPSAnZmx5JyB8ICdvcmFjbGUnIHwgJ3JhaWx3YXknIHwgJ3JlbmRlcicgfCAna295ZWInIHwgJ2djcCc7XG5leHBvcnQgdHlwZSBSZXNvdXJjZVByb2ZpbGUgPSAnbGlnaHQnIHwgJ3N0YW5kYXJkJyB8ICdoZWF2eSc7XG5leHBvcnQgdHlwZSBSZWdpb24gPSAnYXNpYS1zb3V0aGVhc3QxJyB8ICd1cy1lYXN0MScgfCAndXMtd2VzdDEnIHwgJ2V1LXdlc3QxJztcblxuZXhwb3J0IGludGVyZmFjZSBQYXJ0aXRpb25Db25maWcge1xuICAvKiogVW5pcXVlIGlkZW50aWZpZXIgZm9yIHRoZSBwYXJ0aXRpb24gKi9cbiAgcGFydGl0aW9uSWQ6IHN0cmluZztcblxuICAvKiogSHVtYW4tcmVhZGFibGUgbmFtZSAqL1xuICBuYW1lOiBzdHJpbmc7XG5cbiAgLyoqIENoYWlucyBpbmNsdWRlZCBpbiB0aGlzIHBhcnRpdGlvbiAqL1xuICBjaGFpbnM6IHN0cmluZ1tdO1xuXG4gIC8qKiBQcmltYXJ5IGRlcGxveW1lbnQgcmVnaW9uICovXG4gIHJlZ2lvbjogUmVnaW9uO1xuXG4gIC8qKiBDbG91ZCBwcm92aWRlciBmb3IgZGVwbG95bWVudCAqL1xuICBwcm92aWRlcjogQ2xvdWRQcm92aWRlcjtcblxuICAvKiogUmVzb3VyY2UgYWxsb2NhdGlvbiBwcm9maWxlICovXG4gIHJlc291cmNlUHJvZmlsZTogUmVzb3VyY2VQcm9maWxlO1xuXG4gIC8qKiBTdGFuZGJ5IHJlZ2lvbiBmb3IgZmFpbG92ZXIgKG9wdGlvbmFsKSAqL1xuICBzdGFuZGJ5UmVnaW9uPzogUmVnaW9uO1xuXG4gIC8qKiBTdGFuZGJ5IHByb3ZpZGVyIGZvciBmYWlsb3ZlciAob3B0aW9uYWwpICovXG4gIHN0YW5kYnlQcm92aWRlcj86IENsb3VkUHJvdmlkZXI7XG5cbiAgLyoqIFByaW9yaXR5IGZvciByZXNvdXJjZSBhbGxvY2F0aW9uICgxID0gaGlnaGVzdCkgKi9cbiAgcHJpb3JpdHk6IG51bWJlcjtcblxuICAvKiogTWF4aW11bSBtZW1vcnkgaW4gTUIgKi9cbiAgbWF4TWVtb3J5TUI6IG51bWJlcjtcblxuICAvKiogV2hldGhlciB0aGlzIHBhcnRpdGlvbiBpcyBlbmFibGVkICovXG4gIGVuYWJsZWQ6IGJvb2xlYW47XG5cbiAgLyoqIEhlYWx0aCBjaGVjayBpbnRlcnZhbCBpbiBtcyAqL1xuICBoZWFsdGhDaGVja0ludGVydmFsTXM6IG51bWJlcjtcblxuICAvKiogRmFpbG92ZXIgdGltZW91dCBpbiBtcyAqL1xuICBmYWlsb3ZlclRpbWVvdXRNczogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENoYWluSW5zdGFuY2Uge1xuICAvKiogQ2hhaW4gaWRlbnRpZmllciAqL1xuICBjaGFpbklkOiBzdHJpbmc7XG5cbiAgLyoqIENoYWluIG51bWVyaWMgSUQgKi9cbiAgbnVtZXJpY0lkOiBudW1iZXI7XG5cbiAgLyoqIFdlYlNvY2tldCBjb25uZWN0aW9uIFVSTCAqL1xuICB3c1VybDogc3RyaW5nO1xuXG4gIC8qKiBSUEMgVVJMIGZvciBmYWxsYmFjayAqL1xuICBycGNVcmw6IHN0cmluZztcblxuICAvKiogQmxvY2sgdGltZSBpbiBzZWNvbmRzICovXG4gIGJsb2NrVGltZTogbnVtYmVyO1xuXG4gIC8qKiBOYXRpdmUgdG9rZW4gc3ltYm9sICovXG4gIG5hdGl2ZVRva2VuOiBzdHJpbmc7XG5cbiAgLyoqIERFWGVzIHRvIG1vbml0b3Igb24gdGhpcyBjaGFpbiAqL1xuICBkZXhlczogc3RyaW5nW107XG5cbiAgLyoqIFRva2VucyB0byBtb25pdG9yIG9uIHRoaXMgY2hhaW4gKi9cbiAgdG9rZW5zOiBzdHJpbmdbXTtcblxuICAvKiogQ29ubmVjdGlvbiBzdGF0dXMgKi9cbiAgc3RhdHVzOiAnY29ubmVjdGVkJyB8ICdjb25uZWN0aW5nJyB8ICdkaXNjb25uZWN0ZWQnIHwgJ2Vycm9yJztcblxuICAvKiogTGFzdCBzdWNjZXNzZnVsIGJsb2NrIHJlY2VpdmVkICovXG4gIGxhc3RCbG9ja051bWJlcjogbnVtYmVyO1xuXG4gIC8qKiBMYXN0IGJsb2NrIHRpbWVzdGFtcCAqL1xuICBsYXN0QmxvY2tUaW1lc3RhbXA6IG51bWJlcjtcblxuICAvKiogRXZlbnRzIHByb2Nlc3NlZCBjb3VudCAqL1xuICBldmVudHNQcm9jZXNzZWQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQYXJ0aXRpb25IZWFsdGgge1xuICAvKiogUGFydGl0aW9uIElEICovXG4gIHBhcnRpdGlvbklkOiBzdHJpbmc7XG5cbiAgLyoqIE92ZXJhbGwgaGVhbHRoIHN0YXR1cyAqL1xuICBzdGF0dXM6ICdoZWFsdGh5JyB8ICdkZWdyYWRlZCcgfCAndW5oZWFsdGh5JztcblxuICAvKiogSW5kaXZpZHVhbCBjaGFpbiBoZWFsdGggKi9cbiAgY2hhaW5IZWFsdGg6IE1hcDxzdHJpbmcsIENoYWluSGVhbHRoPjtcblxuICAvKiogVG90YWwgZXZlbnRzIHByb2Nlc3NlZCAqL1xuICB0b3RhbEV2ZW50c1Byb2Nlc3NlZDogbnVtYmVyO1xuXG4gIC8qKiBBdmVyYWdlIGV2ZW50IGxhdGVuY3kgaW4gbXMgKi9cbiAgYXZnRXZlbnRMYXRlbmN5TXM6IG51bWJlcjtcblxuICAvKiogTWVtb3J5IHVzYWdlIGluIGJ5dGVzICovXG4gIG1lbW9yeVVzYWdlOiBudW1iZXI7XG5cbiAgLyoqIENQVSB1c2FnZSBwZXJjZW50YWdlICovXG4gIGNwdVVzYWdlOiBudW1iZXI7XG5cbiAgLyoqIFVwdGltZSBpbiBzZWNvbmRzICovXG4gIHVwdGltZVNlY29uZHM6IG51bWJlcjtcblxuICAvKiogTGFzdCBoZWFsdGggY2hlY2sgdGltZXN0YW1wICovXG4gIGxhc3RIZWFsdGhDaGVjazogbnVtYmVyO1xuXG4gIC8qKiBBY3RpdmUgb3Bwb3J0dW5pdGllcyBjb3VudCAqL1xuICBhY3RpdmVPcHBvcnR1bml0aWVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2hhaW5IZWFsdGgge1xuICBjaGFpbklkOiBzdHJpbmc7XG4gIHN0YXR1czogJ2hlYWx0aHknIHwgJ2RlZ3JhZGVkJyB8ICd1bmhlYWx0aHknO1xuICBibG9ja3NCZWhpbmQ6IG51bWJlcjtcbiAgbGFzdEJsb2NrVGltZTogbnVtYmVyO1xuICB3c0Nvbm5lY3RlZDogYm9vbGVhbjtcbiAgZXZlbnRzUGVyU2Vjb25kOiBudW1iZXI7XG4gIGVycm9yQ291bnQ6IG51bWJlcjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFBhcnRpdGlvbiBEZWZpbml0aW9ucyAoQURSLTAwMylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogUHJvZHVjdGlvbiBwYXJ0aXRpb24gY29uZmlndXJhdGlvbnMuXG4gKiBBbGlnbmVkIHdpdGggQVJDSElURUNUVVJFX1YyLm1kIGFuZCBBRFItMDAzIHNwZWNpZmljYXRpb25zLlxuICovXG5leHBvcnQgY29uc3QgUEFSVElUSU9OUzogUGFydGl0aW9uQ29uZmlnW10gPSBbXG4gIHtcbiAgICBwYXJ0aXRpb25JZDogJ2FzaWEtZmFzdCcsXG4gICAgbmFtZTogJ0FzaWEgRmFzdCBDaGFpbnMnLFxuICAgIGNoYWluczogWydic2MnLCAncG9seWdvbiddLFxuICAgIHJlZ2lvbjogJ2FzaWEtc291dGhlYXN0MScsXG4gICAgcHJvdmlkZXI6ICdvcmFjbGUnLFxuICAgIHJlc291cmNlUHJvZmlsZTogJ2hlYXZ5JyxcbiAgICBzdGFuZGJ5UmVnaW9uOiAndXMtd2VzdDEnLFxuICAgIHN0YW5kYnlQcm92aWRlcjogJ3JlbmRlcicsXG4gICAgcHJpb3JpdHk6IDEsXG4gICAgbWF4TWVtb3J5TUI6IDUxMixcbiAgICBlbmFibGVkOiB0cnVlLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWxNczogMTUwMDAsXG4gICAgZmFpbG92ZXJUaW1lb3V0TXM6IDYwMDAwXG4gIH0sXG4gIHtcbiAgICBwYXJ0aXRpb25JZDogJ2wyLWZhc3QnLFxuICAgIG5hbWU6ICdMMiBGYXN0IENoYWlucycsXG4gICAgY2hhaW5zOiBbJ2FyYml0cnVtJywgJ29wdGltaXNtJywgJ2Jhc2UnXSxcbiAgICByZWdpb246ICdhc2lhLXNvdXRoZWFzdDEnLFxuICAgIHByb3ZpZGVyOiAnZmx5JyxcbiAgICByZXNvdXJjZVByb2ZpbGU6ICdzdGFuZGFyZCcsXG4gICAgc3RhbmRieVJlZ2lvbjogJ3VzLWVhc3QxJyxcbiAgICBzdGFuZGJ5UHJvdmlkZXI6ICdyYWlsd2F5JyxcbiAgICBwcmlvcml0eTogMSxcbiAgICBtYXhNZW1vcnlNQjogMzg0LFxuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbE1zOiAxMDAwMCxcbiAgICBmYWlsb3ZlclRpbWVvdXRNczogNDUwMDBcbiAgfSxcbiAge1xuICAgIHBhcnRpdGlvbklkOiAnaGlnaC12YWx1ZScsXG4gICAgbmFtZTogJ0hpZ2ggVmFsdWUgQ2hhaW5zJyxcbiAgICBjaGFpbnM6IFsnZXRoZXJldW0nXSxcbiAgICByZWdpb246ICd1cy1lYXN0MScsXG4gICAgcHJvdmlkZXI6ICdvcmFjbGUnLFxuICAgIHJlc291cmNlUHJvZmlsZTogJ2hlYXZ5JyxcbiAgICBzdGFuZGJ5UmVnaW9uOiAnZXUtd2VzdDEnLFxuICAgIHN0YW5kYnlQcm92aWRlcjogJ2djcCcsXG4gICAgcHJpb3JpdHk6IDIsXG4gICAgbWF4TWVtb3J5TUI6IDUxMixcbiAgICBlbmFibGVkOiB0cnVlLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWxNczogMzAwMDAsXG4gICAgZmFpbG92ZXJUaW1lb3V0TXM6IDYwMDAwXG4gIH1cbl07XG5cbi8qKlxuICogRnV0dXJlIHBhcnRpdGlvbiBjb25maWd1cmF0aW9ucyAoUGhhc2UgMispLlxuICovXG5leHBvcnQgY29uc3QgRlVUVVJFX1BBUlRJVElPTlM6IFBhcnRpdGlvbkNvbmZpZ1tdID0gW1xuICB7XG4gICAgcGFydGl0aW9uSWQ6ICdhc2lhLWZhc3QtZXhwYW5kZWQnLFxuICAgIG5hbWU6ICdBc2lhIEZhc3QgQ2hhaW5zIChFeHBhbmRlZCknLFxuICAgIGNoYWluczogWydic2MnLCAncG9seWdvbicsICdhdmFsYW5jaGUnLCAnZmFudG9tJ10sXG4gICAgcmVnaW9uOiAnYXNpYS1zb3V0aGVhc3QxJyxcbiAgICBwcm92aWRlcjogJ29yYWNsZScsXG4gICAgcmVzb3VyY2VQcm9maWxlOiAnaGVhdnknLFxuICAgIHByaW9yaXR5OiAxLFxuICAgIG1heE1lbW9yeU1COiA3NjgsXG4gICAgZW5hYmxlZDogZmFsc2UsXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbE1zOiAxNTAwMCxcbiAgICBmYWlsb3ZlclRpbWVvdXRNczogNjAwMDBcbiAgfSxcbiAge1xuICAgIHBhcnRpdGlvbklkOiAnaGlnaC12YWx1ZS1leHBhbmRlZCcsXG4gICAgbmFtZTogJ0hpZ2ggVmFsdWUgQ2hhaW5zIChFeHBhbmRlZCknLFxuICAgIGNoYWluczogWydldGhlcmV1bScsICd6a3N5bmMnLCAnbGluZWEnLCAnc2Nyb2xsJ10sXG4gICAgcmVnaW9uOiAndXMtZWFzdDEnLFxuICAgIHByb3ZpZGVyOiAnb3JhY2xlJyxcbiAgICByZXNvdXJjZVByb2ZpbGU6ICdoZWF2eScsXG4gICAgcHJpb3JpdHk6IDIsXG4gICAgbWF4TWVtb3J5TUI6IDc2OCxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsTXM6IDMwMDAwLFxuICAgIGZhaWxvdmVyVGltZW91dE1zOiA2MDAwMFxuICB9LFxuICB7XG4gICAgcGFydGl0aW9uSWQ6ICdub24tZXZtJyxcbiAgICBuYW1lOiAnTm9uLUVWTSBDaGFpbnMnLFxuICAgIGNoYWluczogWydzb2xhbmEnXSxcbiAgICByZWdpb246ICd1cy13ZXN0MScsXG4gICAgcHJvdmlkZXI6ICdmbHknLFxuICAgIHJlc291cmNlUHJvZmlsZTogJ2hlYXZ5JyxcbiAgICBwcmlvcml0eTogMyxcbiAgICBtYXhNZW1vcnlNQjogNTEyLFxuICAgIGVuYWJsZWQ6IGZhbHNlLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWxNczogMTUwMDAsXG4gICAgZmFpbG92ZXJUaW1lb3V0TXM6IDYwMDAwXG4gIH1cbl07XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDaGFpbiBBc3NpZ25tZW50XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEFzc2lnbiBhIGNoYWluIHRvIHRoZSBhcHByb3ByaWF0ZSBwYXJ0aXRpb24gYmFzZWQgb24gQURSLTAwMyBydWxlcy5cbiAqXG4gKiBSdWxlcyAoaW4gcHJpb3JpdHkgb3JkZXIpOlxuICogMS4gTm9uLUVWTSBjaGFpbnMgZ2V0IGRlZGljYXRlZCBwYXJ0aXRpb25cbiAqIDIuIFVsdHJhLWZhc3QgTDJzICg8IDFzIGJsb2NrcykgZ28gdG8gTDItRmFzdFxuICogMy4gSGlnaC12YWx1ZSBjaGFpbnMgKEV0aGVyZXVtICsgWksgcm9sbHVwcykgZ28gdG8gSGlnaC1WYWx1ZVxuICogNC4gRmFzdCBBc2lhbiBjaGFpbnMgKDwgNXMgYmxvY2tzKSBnbyB0byBBc2lhLUZhc3RcbiAqIDUuIERlZmF1bHQ6IEhpZ2gtVmFsdWUgcGFydGl0aW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NpZ25DaGFpblRvUGFydGl0aW9uKGNoYWluSWQ6IHN0cmluZyk6IFBhcnRpdGlvbkNvbmZpZyB8IG51bGwge1xuICBjb25zdCBjaGFpbiA9IENIQUlOU1tjaGFpbklkXTtcbiAgaWYgKCFjaGFpbikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gUnVsZSAxOiBOb24tRVZNIGNoYWlucyAoZnV0dXJlKVxuICAvLyBDdXJyZW50bHkgYWxsIGNoYWlucyBhcmUgRVZNLCBzbyB0aGlzIGlzIGZvciBmdXR1cmUgU29sYW5hIHN1cHBvcnRcblxuICAvLyBSdWxlIDI6IFVsdHJhLWZhc3QgTDJzICg8IDFzIGVmZmVjdGl2ZSBibG9jayB0aW1lKVxuICBpZiAoY2hhaW4uYmxvY2tUaW1lIDwgMSB8fCBjaGFpbklkID09PSAnYXJiaXRydW0nKSB7XG4gICAgcmV0dXJuIFBBUlRJVElPTlMuZmluZChwID0+IHAucGFydGl0aW9uSWQgPT09ICdsMi1mYXN0JykgfHwgbnVsbDtcbiAgfVxuXG4gIC8vIFJ1bGUgMzogSGlnaC12YWx1ZSBjaGFpbnNcbiAgaWYgKGNoYWluSWQgPT09ICdldGhlcmV1bScgfHwgY2hhaW4uaWQgPT09IDEpIHtcbiAgICByZXR1cm4gUEFSVElUSU9OUy5maW5kKHAgPT4gcC5wYXJ0aXRpb25JZCA9PT0gJ2hpZ2gtdmFsdWUnKSB8fCBudWxsO1xuICB9XG5cbiAgLy8gUnVsZSA0OiBMMnMgd2l0aCBtb2RlcmF0ZSBibG9jayB0aW1lc1xuICBpZiAoWydvcHRpbWlzbScsICdiYXNlJ10uaW5jbHVkZXMoY2hhaW5JZCkpIHtcbiAgICByZXR1cm4gUEFSVElUSU9OUy5maW5kKHAgPT4gcC5wYXJ0aXRpb25JZCA9PT0gJ2wyLWZhc3QnKSB8fCBudWxsO1xuICB9XG5cbiAgLy8gUnVsZSA1OiBGYXN0IEFzaWFuIGNoYWlucyAoPCA1cyBibG9ja3MpXG4gIGlmIChjaGFpbi5ibG9ja1RpbWUgPCA1KSB7XG4gICAgcmV0dXJuIFBBUlRJVElPTlMuZmluZChwID0+IHAucGFydGl0aW9uSWQgPT09ICdhc2lhLWZhc3QnKSB8fCBudWxsO1xuICB9XG5cbiAgLy8gRGVmYXVsdDogSGlnaC12YWx1ZVxuICByZXR1cm4gUEFSVElUSU9OUy5maW5kKHAgPT4gcC5wYXJ0aXRpb25JZCA9PT0gJ2hpZ2gtdmFsdWUnKSB8fCBudWxsO1xufVxuXG4vKipcbiAqIEdldCBwYXJ0aXRpb24gYnkgSUQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQYXJ0aXRpb24ocGFydGl0aW9uSWQ6IHN0cmluZyk6IFBhcnRpdGlvbkNvbmZpZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBQQVJUSVRJT05TLmZpbmQocCA9PiBwLnBhcnRpdGlvbklkID09PSBwYXJ0aXRpb25JZCk7XG59XG5cbi8qKlxuICogR2V0IGFsbCBlbmFibGVkIHBhcnRpdGlvbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbmFibGVkUGFydGl0aW9ucygpOiBQYXJ0aXRpb25Db25maWdbXSB7XG4gIHJldHVybiBQQVJUSVRJT05TLmZpbHRlcihwID0+IHAuZW5hYmxlZCk7XG59XG5cbi8qKlxuICogR2V0IGNoYWlucyBmb3IgYSBwYXJ0aXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDaGFpbnNGb3JQYXJ0aXRpb24ocGFydGl0aW9uSWQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGFydGl0aW9uID0gZ2V0UGFydGl0aW9uKHBhcnRpdGlvbklkKTtcbiAgcmV0dXJuIHBhcnRpdGlvbj8uY2hhaW5zIHx8IFtdO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ2hhaW4gSW5zdGFuY2UgRmFjdG9yeVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBDcmVhdGUgYSBDaGFpbkluc3RhbmNlIGNvbmZpZ3VyYXRpb24gZm9yIGEgY2hhaW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDaGFpbkluc3RhbmNlKGNoYWluSWQ6IHN0cmluZyk6IENoYWluSW5zdGFuY2UgfCBudWxsIHtcbiAgY29uc3QgY2hhaW4gPSBDSEFJTlNbY2hhaW5JZF07XG4gIGlmICghY2hhaW4pIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGRleGVzID0gREVYRVNbY2hhaW5JZF0gfHwgW107XG4gIGNvbnN0IHRva2VucyA9IENPUkVfVE9LRU5TW2NoYWluSWRdIHx8IFtdO1xuXG4gIHJldHVybiB7XG4gICAgY2hhaW5JZCxcbiAgICBudW1lcmljSWQ6IGNoYWluLmlkLFxuICAgIHdzVXJsOiBjaGFpbi53c1VybCB8fCBjaGFpbi5ycGNVcmwsIC8vIEZhbGxiYWNrIHRvIFJQQyBVUkwgaWYgV1Mgbm90IGNvbmZpZ3VyZWRcbiAgICBycGNVcmw6IGNoYWluLnJwY1VybCxcbiAgICBibG9ja1RpbWU6IGNoYWluLmJsb2NrVGltZSxcbiAgICBuYXRpdmVUb2tlbjogY2hhaW4ubmF0aXZlVG9rZW4sXG4gICAgZGV4ZXM6IGRleGVzLm1hcChkID0+IGQubmFtZSksXG4gICAgdG9rZW5zOiB0b2tlbnMubWFwKHQgPT4gdC5zeW1ib2wpLFxuICAgIHN0YXR1czogJ2Rpc2Nvbm5lY3RlZCcsXG4gICAgbGFzdEJsb2NrTnVtYmVyOiAwLFxuICAgIGxhc3RCbG9ja1RpbWVzdGFtcDogMCxcbiAgICBldmVudHNQcm9jZXNzZWQ6IDBcbiAgfTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYWxsIGNoYWluIGluc3RhbmNlcyBmb3IgYSBwYXJ0aXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYXJ0aXRpb25DaGFpbkluc3RhbmNlcyhwYXJ0aXRpb25JZDogc3RyaW5nKTogQ2hhaW5JbnN0YW5jZVtdIHtcbiAgY29uc3QgY2hhaW5zID0gZ2V0Q2hhaW5zRm9yUGFydGl0aW9uKHBhcnRpdGlvbklkKTtcbiAgcmV0dXJuIGNoYWluc1xuICAgIC5tYXAoY2hhaW5JZCA9PiBjcmVhdGVDaGFpbkluc3RhbmNlKGNoYWluSWQpKVxuICAgIC5maWx0ZXIoKGMpOiBjIGlzIENoYWluSW5zdGFuY2UgPT4gYyAhPT0gbnVsbCk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBSZXNvdXJjZSBDYWxjdWxhdGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBDYWxjdWxhdGUgcmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciBhIHBhcnRpdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZVBhcnRpdGlvblJlc291cmNlcyhwYXJ0aXRpb25JZDogc3RyaW5nKToge1xuICBlc3RpbWF0ZWRNZW1vcnlNQjogbnVtYmVyO1xuICBlc3RpbWF0ZWRDcHVDb3JlczogbnVtYmVyO1xuICByZWNvbW1lbmRlZFByb2ZpbGU6IFJlc291cmNlUHJvZmlsZTtcbn0ge1xuICBjb25zdCBwYXJ0aXRpb24gPSBnZXRQYXJ0aXRpb24ocGFydGl0aW9uSWQpO1xuICBpZiAoIXBhcnRpdGlvbikge1xuICAgIHJldHVybiB7IGVzdGltYXRlZE1lbW9yeU1COiAyNTYsIGVzdGltYXRlZENwdUNvcmVzOiAwLjUsIHJlY29tbWVuZGVkUHJvZmlsZTogJ2xpZ2h0JyB9O1xuICB9XG5cbiAgLy8gQmFzZSBtZW1vcnkgcGVyIGNoYWluXG4gIGNvbnN0IGJhc2VNZW1vcnlQZXJDaGFpbiA9IDY0OyAvLyBNQlxuXG4gIC8vIERFWCBmYWN0b3IgKG1vcmUgREVYZXMgPSBtb3JlIG1lbW9yeSlcbiAgbGV0IHRvdGFsRGV4ZXMgPSAwO1xuICBmb3IgKGNvbnN0IGNoYWluSWQgb2YgcGFydGl0aW9uLmNoYWlucykge1xuICAgIGNvbnN0IGRleGVzID0gREVYRVNbY2hhaW5JZF0gfHwgW107XG4gICAgdG90YWxEZXhlcyArPSBkZXhlcy5sZW5ndGg7XG4gIH1cbiAgY29uc3QgZGV4TWVtb3J5ID0gdG90YWxEZXhlcyAqIDg7IC8vIDhNQiBwZXIgREVYXG5cbiAgLy8gVG9rZW4gZmFjdG9yXG4gIGxldCB0b3RhbFRva2VucyA9IDA7XG4gIGZvciAoY29uc3QgY2hhaW5JZCBvZiBwYXJ0aXRpb24uY2hhaW5zKSB7XG4gICAgY29uc3QgdG9rZW5zID0gQ09SRV9UT0tFTlNbY2hhaW5JZF0gfHwgW107XG4gICAgdG90YWxUb2tlbnMgKz0gdG9rZW5zLmxlbmd0aDtcbiAgfVxuICBjb25zdCB0b2tlbk1lbW9yeSA9IHRvdGFsVG9rZW5zICogMjsgLy8gMk1CIHBlciB0b2tlblxuXG4gIC8vIEJsb2NrIHRpbWUgZmFjdG9yIChmYXN0ZXIgYmxvY2tzID0gbW9yZSBDUFUgbmVlZGVkKVxuICBsZXQgYXZnQmxvY2tUaW1lID0gMTA7IC8vIERlZmF1bHQgZmFsbGJhY2sgZm9yIGVtcHR5IGNoYWluc1xuICBpZiAocGFydGl0aW9uLmNoYWlucy5sZW5ndGggPiAwKSB7XG4gICAgbGV0IHRvdGFsQmxvY2tUaW1lID0gMDtcbiAgICBmb3IgKGNvbnN0IGNoYWluSWQgb2YgcGFydGl0aW9uLmNoYWlucykge1xuICAgICAgY29uc3QgY2hhaW4gPSBDSEFJTlNbY2hhaW5JZF07XG4gICAgICB0b3RhbEJsb2NrVGltZSArPSBjaGFpbj8uYmxvY2tUaW1lIHx8IDEwO1xuICAgIH1cbiAgICBhdmdCbG9ja1RpbWUgPSB0b3RhbEJsb2NrVGltZSAvIHBhcnRpdGlvbi5jaGFpbnMubGVuZ3RoO1xuICB9XG5cbiAgY29uc3QgZXN0aW1hdGVkTWVtb3J5TUIgPSAocGFydGl0aW9uLmNoYWlucy5sZW5ndGggKiBiYXNlTWVtb3J5UGVyQ2hhaW4pICsgZGV4TWVtb3J5ICsgdG9rZW5NZW1vcnkgKyA2NDsgLy8gKzY0IG92ZXJoZWFkXG4gIGNvbnN0IGVzdGltYXRlZENwdUNvcmVzID0gYXZnQmxvY2tUaW1lIDwgMiA/IDEuMCA6IGF2Z0Jsb2NrVGltZSA8IDUgPyAwLjUgOiAwLjI1O1xuXG4gIGxldCByZWNvbW1lbmRlZFByb2ZpbGU6IFJlc291cmNlUHJvZmlsZTtcbiAgaWYgKGVzdGltYXRlZE1lbW9yeU1CID4gNDAwKSB7XG4gICAgcmVjb21tZW5kZWRQcm9maWxlID0gJ2hlYXZ5JztcbiAgfSBlbHNlIGlmIChlc3RpbWF0ZWRNZW1vcnlNQiA+IDI1Nikge1xuICAgIHJlY29tbWVuZGVkUHJvZmlsZSA9ICdzdGFuZGFyZCc7XG4gIH0gZWxzZSB7XG4gICAgcmVjb21tZW5kZWRQcm9maWxlID0gJ2xpZ2h0JztcbiAgfVxuXG4gIHJldHVybiB7IGVzdGltYXRlZE1lbW9yeU1CLCBlc3RpbWF0ZWRDcHVDb3JlcywgcmVjb21tZW5kZWRQcm9maWxlIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBWYWxpZGF0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFZhbGlkYXRlIHBhcnRpdGlvbiBjb25maWd1cmF0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVQYXJ0aXRpb25Db25maWcocGFydGl0aW9uOiBQYXJ0aXRpb25Db25maWcpOiB7XG4gIHZhbGlkOiBib29sZWFuO1xuICBlcnJvcnM6IHN0cmluZ1tdO1xuICB3YXJuaW5nczogc3RyaW5nW107XG59IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBDaGVjayBwYXJ0aXRpb24gSURcbiAgaWYgKCFwYXJ0aXRpb24ucGFydGl0aW9uSWQgfHwgcGFydGl0aW9uLnBhcnRpdGlvbklkLmxlbmd0aCA8IDMpIHtcbiAgICBlcnJvcnMucHVzaCgnUGFydGl0aW9uIElEIG11c3QgYmUgYXQgbGVhc3QgMyBjaGFyYWN0ZXJzJyk7XG4gIH1cblxuICAvLyBDaGVjayBjaGFpbnMgZXhpc3RcbiAgZm9yIChjb25zdCBjaGFpbklkIG9mIHBhcnRpdGlvbi5jaGFpbnMpIHtcbiAgICBpZiAoIUNIQUlOU1tjaGFpbklkXSkge1xuICAgICAgZXJyb3JzLnB1c2goYENoYWluICR7Y2hhaW5JZH0gbm90IGZvdW5kIGluIENIQUlOUyBjb25maWd1cmF0aW9uYCk7XG4gICAgfVxuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIGR1cGxpY2F0ZSBjaGFpbnMgYWNyb3NzIHBhcnRpdGlvbnNcbiAgY29uc3QgYWxsQ2hhaW5zSW5PdGhlclBhcnRpdGlvbnMgPSBQQVJUSVRJT05TXG4gICAgLmZpbHRlcihwID0+IHAucGFydGl0aW9uSWQgIT09IHBhcnRpdGlvbi5wYXJ0aXRpb25JZCAmJiBwLmVuYWJsZWQpXG4gICAgLmZsYXRNYXAocCA9PiBwLmNoYWlucyk7XG5cbiAgZm9yIChjb25zdCBjaGFpbklkIG9mIHBhcnRpdGlvbi5jaGFpbnMpIHtcbiAgICBpZiAoYWxsQ2hhaW5zSW5PdGhlclBhcnRpdGlvbnMuaW5jbHVkZXMoY2hhaW5JZCkpIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goYENoYWluICR7Y2hhaW5JZH0gaXMgYXNzaWduZWQgdG8gbXVsdGlwbGUgcGFydGl0aW9uc2ApO1xuICAgIH1cbiAgfVxuXG4gIC8vIENoZWNrIHJlc291cmNlIHByb2ZpbGUgbWF0Y2hlcyBjaGFpbiByZXF1aXJlbWVudHNcbiAgY29uc3QgcmVzb3VyY2VzID0gY2FsY3VsYXRlUGFydGl0aW9uUmVzb3VyY2VzKHBhcnRpdGlvbi5wYXJ0aXRpb25JZCk7XG4gIGlmIChyZXNvdXJjZXMucmVjb21tZW5kZWRQcm9maWxlID09PSAnaGVhdnknICYmIHBhcnRpdGlvbi5yZXNvdXJjZVByb2ZpbGUgPT09ICdsaWdodCcpIHtcbiAgICB3YXJuaW5ncy5wdXNoKGBQYXJ0aXRpb24gbWF5IG5lZWQgbW9yZSByZXNvdXJjZXMgdGhhbiBhbGxvY2F0ZWQgKHJlY29tbWVuZGVkOiAke3Jlc291cmNlcy5yZWNvbW1lbmRlZFByb2ZpbGV9KWApO1xuICB9XG5cbiAgLy8gQ2hlY2sgbWVtb3J5IGxpbWl0c1xuICBpZiAocGFydGl0aW9uLm1heE1lbW9yeU1CIDwgcmVzb3VyY2VzLmVzdGltYXRlZE1lbW9yeU1CKSB7XG4gICAgd2FybmluZ3MucHVzaChgTWF4IG1lbW9yeSAoJHtwYXJ0aXRpb24ubWF4TWVtb3J5TUJ9TUIpIG1heSBiZSBpbnN1ZmZpY2llbnQgKGVzdGltYXRlZDogJHtyZXNvdXJjZXMuZXN0aW1hdGVkTWVtb3J5TUJ9TUIpYCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHZhbGlkOiBlcnJvcnMubGVuZ3RoID09PSAwLFxuICAgIGVycm9ycyxcbiAgICB3YXJuaW5nc1xuICB9O1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGFsbCBwYXJ0aXRpb25zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVBbGxQYXJ0aXRpb25zKCk6IHtcbiAgdmFsaWQ6IGJvb2xlYW47XG4gIHJlc3VsdHM6IE1hcDxzdHJpbmcsIHsgdmFsaWQ6IGJvb2xlYW47IGVycm9yczogc3RyaW5nW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9Pjtcbn0ge1xuICBjb25zdCByZXN1bHRzID0gbmV3IE1hcDxzdHJpbmcsIHsgdmFsaWQ6IGJvb2xlYW47IGVycm9yczogc3RyaW5nW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9PigpO1xuICBsZXQgYWxsVmFsaWQgPSB0cnVlO1xuXG4gIGZvciAoY29uc3QgcGFydGl0aW9uIG9mIFBBUlRJVElPTlMpIHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVBhcnRpdGlvbkNvbmZpZyhwYXJ0aXRpb24pO1xuICAgIHJlc3VsdHMuc2V0KHBhcnRpdGlvbi5wYXJ0aXRpb25JZCwgcmVzdWx0KTtcbiAgICBpZiAoIXJlc3VsdC52YWxpZCkge1xuICAgICAgYWxsVmFsaWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyB2YWxpZDogYWxsVmFsaWQsIHJlc3VsdHMgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEVudmlyb25tZW50IENvbmZpZ3VyYXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR2V0IHBhcnRpdGlvbiBJRCBmcm9tIGVudmlyb25tZW50IHZhcmlhYmxlLlxuICogVXNlZCBieSB1bmlmaWVkLWRldGVjdG9yIHRvIGRldGVybWluZSB3aGljaCBwYXJ0aXRpb24gdG8gcnVuLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UGFydGl0aW9uSWRGcm9tRW52KCk6IHN0cmluZyB7XG4gIHJldHVybiBwcm9jZXNzLmVudi5QQVJUSVRJT05fSUQgfHwgJ2FzaWEtZmFzdCc7XG59XG5cbi8qKlxuICogR2V0IHBhcnRpdGlvbiBjb25maWd1cmF0aW9uIGZyb20gZW52aXJvbm1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQYXJ0aXRpb25Gcm9tRW52KCk6IFBhcnRpdGlvbkNvbmZpZyB8IG51bGwge1xuICBjb25zdCBwYXJ0aXRpb25JZCA9IGdldFBhcnRpdGlvbklkRnJvbUVudigpO1xuICByZXR1cm4gZ2V0UGFydGl0aW9uKHBhcnRpdGlvbklkKSB8fCBudWxsO1xufVxuXG4vKipcbiAqIEdldCBhbGwgY2hhaW4gSURzIGZyb20gZW52aXJvbm1lbnQgKHN1cHBvcnRzIGNvbW1hLXNlcGFyYXRlZCBvdmVycmlkZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDaGFpbnNGcm9tRW52KCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZW52Q2hhaW5zID0gcHJvY2Vzcy5lbnYuUEFSVElUSU9OX0NIQUlOUztcbiAgaWYgKGVudkNoYWlucykge1xuICAgIHJldHVybiBlbnZDaGFpbnMuc3BsaXQoJywnKS5tYXAoYyA9PiBjLnRyaW0oKSk7XG4gIH1cblxuICBjb25zdCBwYXJ0aXRpb24gPSBnZXRQYXJ0aXRpb25Gcm9tRW52KCk7XG4gIHJldHVybiBwYXJ0aXRpb24/LmNoYWlucyB8fCBbXTtcbn1cbiJdfQ==
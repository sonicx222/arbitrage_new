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
export type CloudProvider = 'fly' | 'oracle' | 'railway' | 'render' | 'koyeb' | 'gcp';
export type ResourceProfile = 'light' | 'standard' | 'heavy';
export type Region = 'asia-southeast1' | 'us-east1' | 'us-west1' | 'eu-west1';
export interface PartitionConfig {
    /** Unique identifier for the partition */
    partitionId: string;
    /** Human-readable name */
    name: string;
    /** Chains included in this partition */
    chains: string[];
    /** Primary deployment region */
    region: Region;
    /** Cloud provider for deployment */
    provider: CloudProvider;
    /** Resource allocation profile */
    resourceProfile: ResourceProfile;
    /** Standby region for failover (optional) */
    standbyRegion?: Region;
    /** Standby provider for failover (optional) */
    standbyProvider?: CloudProvider;
    /** Priority for resource allocation (1 = highest) */
    priority: number;
    /** Maximum memory in MB */
    maxMemoryMB: number;
    /** Whether this partition is enabled */
    enabled: boolean;
    /** Health check interval in ms */
    healthCheckIntervalMs: number;
    /** Failover timeout in ms */
    failoverTimeoutMs: number;
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
    /** Overall health status */
    status: 'healthy' | 'degraded' | 'unhealthy';
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
/**
 * Production partition configurations.
 * Aligned with ARCHITECTURE_V2.md and ADR-003 specifications.
 */
export declare const PARTITIONS: PartitionConfig[];
/**
 * Future partition configurations (Phase 2+).
 */
export declare const FUTURE_PARTITIONS: PartitionConfig[];
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
export declare function assignChainToPartition(chainId: string): PartitionConfig | null;
/**
 * Get partition by ID.
 */
export declare function getPartition(partitionId: string): PartitionConfig | undefined;
/**
 * Get all enabled partitions.
 */
export declare function getEnabledPartitions(): PartitionConfig[];
/**
 * Get chains for a partition.
 */
export declare function getChainsForPartition(partitionId: string): string[];
/**
 * Create a ChainInstance configuration for a chain.
 */
export declare function createChainInstance(chainId: string): ChainInstance | null;
/**
 * Create all chain instances for a partition.
 */
export declare function createPartitionChainInstances(partitionId: string): ChainInstance[];
/**
 * Calculate resource requirements for a partition.
 */
export declare function calculatePartitionResources(partitionId: string): {
    estimatedMemoryMB: number;
    estimatedCpuCores: number;
    recommendedProfile: ResourceProfile;
};
/**
 * Validate partition configuration.
 */
export declare function validatePartitionConfig(partition: PartitionConfig): {
    valid: boolean;
    errors: string[];
    warnings: string[];
};
/**
 * Validate all partitions.
 */
export declare function validateAllPartitions(): {
    valid: boolean;
    results: Map<string, {
        valid: boolean;
        errors: string[];
        warnings: string[];
    }>;
};
/**
 * Get partition ID from environment variable.
 * Used by unified-detector to determine which partition to run.
 */
export declare function getPartitionIdFromEnv(): string;
/**
 * Get partition configuration from environment.
 */
export declare function getPartitionFromEnv(): PartitionConfig | null;
/**
 * Get all chain IDs from environment (supports comma-separated override).
 */
export declare function getChainsFromEnv(): string[];
//# sourceMappingURL=partitions.d.ts.map
/**
 * Partition Router
 *
 * Provides routing utilities for the partitioned detector architecture.
 * Routes chains to their appropriate partition services based on ADR-003 rules.
 *
 * This module is part of S3.1.7 (Migrate existing detectors) and provides:
 * - Chain-to-partition routing
 * - Service endpoint resolution
 * - Deprecation warnings for old patterns
 * - Migration utilities
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.7: Migrate existing detectors
 * @see ADR-003: Partitioned Chain Detectors
 */
import { PartitionConfig } from '../../config/src/partitions';
/**
 * Represents a partition service endpoint.
 */
export interface PartitionEndpoint {
    /** Partition ID */
    partitionId: string;
    /** Service name (e.g., 'partition-asia-fast') */
    serviceName: string;
    /** Health check port */
    port: number;
    /** Chains handled by this partition */
    chains: string[];
    /** Primary deployment region */
    region: string;
    /** Cloud provider */
    provider: string;
}
/**
 * Default ports for partition services.
 * Each partition has a unique port to avoid conflicts when running locally.
 *
 * P1-1-FIX: Single source of truth for partition ports.
 * All partition services should import and use these constants.
 *
 * Note: Using string literals instead of PARTITION_IDS to avoid circular dependency
 * issues during module initialization. Values match those in partition-ids.ts.
 */
export declare const PARTITION_PORTS: Readonly<Record<string, number>>;
/**
 * Service names for each partition.
 * Maps partition IDs to their service directory names.
 *
 * P1-2-FIX: Single source of truth for partition service names.
 * All partition services should import and use these constants.
 *
 * Note: Using string literals instead of PARTITION_IDS to avoid circular dependency
 * issues during module initialization. Values match those in partition-ids.ts.
 */
export declare const PARTITION_SERVICE_NAMES: Readonly<Record<string, string>>;
/**
 * Static utility class for routing chains to partition services.
 *
 * Usage:
 * ```typescript
 * // Get partition for a chain
 * const partition = PartitionRouter.getPartitionForChain('bsc');
 *
 * // Get service endpoint for a chain
 * const endpoint = PartitionRouter.getServiceEndpoint('arbitrum');
 *
 * // Check if chain is routable
 * if (PartitionRouter.isRoutable('ethereum')) {
 *   // Route to partition service
 * }
 * ```
 */
export declare class PartitionRouter {
    /**
     * Get the partition configuration for a chain.
     *
     * @param chainId - The chain identifier
     * @returns Partition config or null if chain not found
     */
    static getPartitionForChain(chainId: string): PartitionConfig | null;
    /**
     * Get the service endpoint for a chain.
     *
     * P2-2-FIX: Standardized return type to null (consistent with getPartitionForChain).
     *
     * @param chainId - The chain identifier
     * @returns Service endpoint or null if chain not routable
     */
    static getServiceEndpoint(chainId: string): PartitionEndpoint | null;
    /**
     * Get all partition service endpoints.
     *
     * @returns Array of all partition endpoints
     */
    static getAllEndpoints(): PartitionEndpoint[];
    /**
     * Check if a chain can be routed to a partition.
     *
     * @param chainId - The chain identifier
     * @returns true if chain is routable, false otherwise
     */
    static isRoutable(chainId: string): boolean;
    /**
     * Get all chains that can be routed to partitions.
     *
     * @returns Array of routable chain IDs
     */
    static getRoutableChains(): string[];
    /**
     * Get the service name for a partition.
     *
     * P4-1-FIX: Use ?? instead of || for consistency with getPort.
     *
     * @param partitionId - The partition ID
     * @returns Service name or default
     */
    static getServiceName(partitionId: string): string;
    /**
     * Get the port for a partition service.
     *
     * @param partitionId - The partition ID
     * @returns Port number or default 3000
     */
    static getPort(partitionId: string): number;
    /**
     * Get chains for a specific partition.
     *
     * P4-3-FIX: Returns a copy of the chains array to prevent mutation.
     * Consistent with P3-2-FIX (getServiceEndpoint returns copy).
     *
     * @param partitionId - The partition ID
     * @returns Array of chain IDs (copy, safe to mutate)
     */
    static getChainsForPartition(partitionId: string): string[];
    /**
     * Get the partition ID for a chain (convenience method).
     *
     * P4-2-FIX: Use ?? instead of || for consistent null handling.
     *
     * @param chainId - The chain identifier
     * @returns Partition ID or null
     */
    static getPartitionId(chainId: string): string | null;
}
/**
 * Create a deprecation warning message for migrating from old patterns.
 *
 * @param oldPattern - The deprecated pattern (e.g., 'bsc-detector')
 * @param newService - The new partition service to use
 * @returns Deprecation warning message
 */
export declare function createDeprecationWarning(oldPattern: string, newService: string): string;
/**
 * Check if a service name represents a deprecated pattern.
 *
 * P2-1-FIX: Removed redundant hardcoded DEPRECATED_PATTERNS list.
 * Now uses dynamic chain detection which automatically handles new chains.
 *
 * Deprecated patterns:
 * - <chain>-detector (e.g., 'bsc-detector', 'ethereum-detector')
 * - Any single-chain detector that should use partition services instead
 *
 * @param serviceName - The service name to check
 * @returns true if deprecated, false if current
 */
export declare function isDeprecatedPattern(serviceName: string): boolean;
/**
 * Get migration recommendation for a deprecated pattern.
 *
 * @param deprecatedService - The deprecated service name
 * @returns Recommended new service name or null if not deprecated
 */
export declare function getMigrationRecommendation(deprecatedService: string): string | null;
/**
 * Log a deprecation warning if using a deprecated pattern.
 *
 * @param serviceName - The service name to check
 * @param logger - Optional logger (defaults to console.warn)
 */
export declare function warnIfDeprecated(serviceName: string, logger?: {
    warn: (msg: string) => void;
}): void;
//# sourceMappingURL=partition-router.d.ts.map
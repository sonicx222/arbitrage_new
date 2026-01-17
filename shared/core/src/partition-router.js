"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartitionRouter = exports.PARTITION_SERVICE_NAMES = exports.PARTITION_PORTS = void 0;
exports.createDeprecationWarning = createDeprecationWarning;
exports.isDeprecatedPattern = isDeprecatedPattern;
exports.getMigrationRecommendation = getMigrationRecommendation;
exports.warnIfDeprecated = warnIfDeprecated;
const partitions_1 = require("../../config/src/partitions");
const src_1 = require("../../config/src");
// =============================================================================
// Constants
// =============================================================================
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
exports.PARTITION_PORTS = {
    'asia-fast': 3001,
    'l2-turbo': 3002,
    'high-value': 3003,
    'solana-native': 3004
};
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
exports.PARTITION_SERVICE_NAMES = {
    'asia-fast': 'partition-asia-fast',
    'l2-turbo': 'partition-l2-turbo',
    'high-value': 'partition-high-value',
    'solana-native': 'partition-solana'
};
/**
 * Default port when partition is not found.
 */
const DEFAULT_PORT = 3000;
// =============================================================================
// Helper Functions (P3-1-FIX: DRY endpoint creation)
// =============================================================================
/**
 * Creates a PartitionEndpoint from a PartitionConfig.
 * Internal helper to ensure consistent endpoint creation.
 *
 * @param partition - The partition configuration
 * @returns PartitionEndpoint object
 */
function createEndpointFromPartition(partition) {
    return {
        partitionId: partition.partitionId,
        serviceName: exports.PARTITION_SERVICE_NAMES[partition.partitionId] ?? `partition-${partition.partitionId}`,
        port: exports.PARTITION_PORTS[partition.partitionId] ?? DEFAULT_PORT,
        chains: [...partition.chains], // P3-2-FIX: Return copy to prevent mutation
        region: partition.region,
        provider: partition.provider
    };
}
// =============================================================================
// Partition Router Class
// =============================================================================
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
class PartitionRouter {
    /**
     * Get the partition configuration for a chain.
     *
     * @param chainId - The chain identifier
     * @returns Partition config or null if chain not found
     */
    static getPartitionForChain(chainId) {
        return (0, partitions_1.assignChainToPartition)(chainId);
    }
    /**
     * Get the service endpoint for a chain.
     *
     * P2-2-FIX: Standardized return type to null (consistent with getPartitionForChain).
     *
     * @param chainId - The chain identifier
     * @returns Service endpoint or null if chain not routable
     */
    static getServiceEndpoint(chainId) {
        const partition = (0, partitions_1.assignChainToPartition)(chainId);
        if (!partition) {
            return null;
        }
        return createEndpointFromPartition(partition);
    }
    /**
     * Get all partition service endpoints.
     *
     * @returns Array of all partition endpoints
     */
    static getAllEndpoints() {
        const partitions = (0, partitions_1.getEnabledPartitions)();
        return partitions.map(createEndpointFromPartition);
    }
    /**
     * Check if a chain can be routed to a partition.
     *
     * @param chainId - The chain identifier
     * @returns true if chain is routable, false otherwise
     */
    static isRoutable(chainId) {
        return (0, partitions_1.assignChainToPartition)(chainId) !== null;
    }
    /**
     * Get all chains that can be routed to partitions.
     *
     * @returns Array of routable chain IDs
     */
    static getRoutableChains() {
        return Object.keys(src_1.CHAINS).filter(chainId => PartitionRouter.isRoutable(chainId));
    }
    /**
     * Get the service name for a partition.
     *
     * P4-1-FIX: Use ?? instead of || for consistency with getPort.
     *
     * @param partitionId - The partition ID
     * @returns Service name or default
     */
    static getServiceName(partitionId) {
        return exports.PARTITION_SERVICE_NAMES[partitionId] ?? `partition-${partitionId}`;
    }
    /**
     * Get the port for a partition service.
     *
     * @param partitionId - The partition ID
     * @returns Port number or default 3000
     */
    static getPort(partitionId) {
        return exports.PARTITION_PORTS[partitionId] ?? DEFAULT_PORT;
    }
    /**
     * Get chains for a specific partition.
     *
     * P4-3-FIX: Returns a copy of the chains array to prevent mutation.
     * Consistent with P3-2-FIX (getServiceEndpoint returns copy).
     *
     * @param partitionId - The partition ID
     * @returns Array of chain IDs (copy, safe to mutate)
     */
    static getChainsForPartition(partitionId) {
        const chains = (0, partitions_1.getChainsForPartition)(partitionId);
        return [...chains];
    }
    /**
     * Get the partition ID for a chain (convenience method).
     *
     * P4-2-FIX: Use ?? instead of || for consistent null handling.
     *
     * @param chainId - The chain identifier
     * @returns Partition ID or null
     */
    static getPartitionId(chainId) {
        const partition = (0, partitions_1.assignChainToPartition)(chainId);
        return partition?.partitionId ?? null;
    }
}
exports.PartitionRouter = PartitionRouter;
// =============================================================================
// Deprecation Utilities
// =============================================================================
/**
 * Create a deprecation warning message for migrating from old patterns.
 *
 * @param oldPattern - The deprecated pattern (e.g., 'bsc-detector')
 * @param newService - The new partition service to use
 * @returns Deprecation warning message
 */
function createDeprecationWarning(oldPattern, newService) {
    return `[DEPRECATED] '${oldPattern}' is deprecated. Use '${newService}' partition service instead. ` +
        `See ADR-003 for partition architecture details. ` +
        `Migration guide: Route ${oldPattern.replace('-detector', '')} chain to ${newService}.`;
}
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
function isDeprecatedPattern(serviceName) {
    // P2-1-FIX: Dynamic detection only - no hardcoded list needed
    // Pattern: <chain>-detector (e.g., bsc-detector, ethereum-detector)
    if (serviceName.endsWith('-detector')) {
        const chainPart = serviceName.replace('-detector', '');
        // If it's a valid chain and not a partition service, it's deprecated
        // The CHAINS check ensures we only flag real chains, not typos
        if (src_1.CHAINS[chainPart] && !serviceName.startsWith('partition-')) {
            return true;
        }
    }
    return false;
}
/**
 * Get migration recommendation for a deprecated pattern.
 *
 * @param deprecatedService - The deprecated service name
 * @returns Recommended new service name or null if not deprecated
 */
function getMigrationRecommendation(deprecatedService) {
    if (!isDeprecatedPattern(deprecatedService)) {
        return null;
    }
    // Extract chain ID from deprecated pattern
    const chainId = deprecatedService.replace('-detector', '');
    const partition = (0, partitions_1.assignChainToPartition)(chainId);
    if (!partition) {
        return null;
    }
    return exports.PARTITION_SERVICE_NAMES[partition.partitionId] || null;
}
/**
 * Log a deprecation warning if using a deprecated pattern.
 *
 * @param serviceName - The service name to check
 * @param logger - Optional logger (defaults to console.warn)
 */
function warnIfDeprecated(serviceName, logger) {
    if (isDeprecatedPattern(serviceName)) {
        const recommendation = getMigrationRecommendation(serviceName);
        const message = recommendation
            ? createDeprecationWarning(serviceName, recommendation)
            : `[DEPRECATED] '${serviceName}' is deprecated. Use partition services instead.`;
        if (logger) {
            logger.warn(message);
        }
        else {
            console.warn(message);
        }
    }
}
//# sourceMappingURL=partition-router.js.map
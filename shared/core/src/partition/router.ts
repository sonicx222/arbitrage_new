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

import {
  assignChainToPartition,
  getEnabledPartitions,
  PartitionConfig,
  getChainsForPartition,
  CHAINS,
} from '@arbitrage/config';
import { createPinoLogger, type ILogger } from '../logging';

// Lazy-initialized logger for deprecation warnings
let _routerLogger: ILogger | null = null;
function getRouterLogger(): ILogger {
  if (!_routerLogger) {
    _routerLogger = createPinoLogger('partition-router');
  }
  return _routerLogger;
}

// =============================================================================
// Shared Configuration (Single Source of Truth)
// =============================================================================

/**
 * Import port and service configurations from shared JSON.
 * This ensures consistency across TypeScript services and JavaScript scripts.
 *
 * @see shared/constants/service-ports.json
 */
import portConfig from '../../../constants/service-ports.json';

// =============================================================================
// Types
// =============================================================================

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

// =============================================================================
// Constants (derived from shared JSON config)
// =============================================================================

/**
 * Default ports for partition services.
 * Derived from shared JSON config (single source of truth).
 *
 * P1-1-FIX: Single source of truth for partition ports.
 * All partition services should import and use these constants.
 *
 * @see shared/constants/service-ports.json
 */
export const PARTITION_PORTS: Readonly<Record<string, number>> = portConfig.partitions as Record<string, number>;

/**
 * Default ports for all services in the arbitrage system.
 * Derived from shared JSON config (single source of truth).
 *
 * Port assignments:
 * - 3000: coordinator (system orchestration)
 * - 3001-3004: partition detectors (chain detection)
 * - 3005: execution-engine (trade execution)
 * - 3006: cross-chain-detector (cross-chain arbitrage)
 *
 * @see shared/constants/service-ports.json
 */
export const SERVICE_PORTS: Readonly<Record<string, number>> = portConfig.services as Record<string, number>;

/**
 * Service names for each partition.
 * Derived from shared JSON config (single source of truth).
 * Maps partition IDs to their service directory names.
 *
 * P1-2-FIX: Single source of truth for partition service names.
 * All partition services should import and use these constants.
 *
 * @see shared/constants/service-ports.json
 */
export const PARTITION_SERVICE_NAMES: Readonly<Record<string, string>> = portConfig.partitionServiceNames as Record<string, string>;

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
function createEndpointFromPartition(partition: PartitionConfig): PartitionEndpoint {
  return {
    partitionId: partition.partitionId,
    serviceName: PARTITION_SERVICE_NAMES[partition.partitionId] ?? `partition-${partition.partitionId}`,
    port: PARTITION_PORTS[partition.partitionId] ?? DEFAULT_PORT,
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
export class PartitionRouter {
  /**
   * Get the partition configuration for a chain.
   *
   * @param chainId - The chain identifier
   * @returns Partition config or null if chain not found
   */
  static getPartitionForChain(chainId: string): PartitionConfig | null {
    return assignChainToPartition(chainId);
  }

  /**
   * Get the service endpoint for a chain.
   *
   * P2-2-FIX: Standardized return type to null (consistent with getPartitionForChain).
   *
   * @param chainId - The chain identifier
   * @returns Service endpoint or null if chain not routable
   */
  static getServiceEndpoint(chainId: string): PartitionEndpoint | null {
    const partition = assignChainToPartition(chainId);
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
  static getAllEndpoints(): PartitionEndpoint[] {
    const partitions = getEnabledPartitions();
    return partitions.map(createEndpointFromPartition);
  }

  /**
   * Check if a chain can be routed to a partition.
   *
   * @param chainId - The chain identifier
   * @returns true if chain is routable, false otherwise
   */
  static isRoutable(chainId: string): boolean {
    return assignChainToPartition(chainId) !== null;
  }

  /**
   * Get all chains that can be routed to partitions.
   *
   * @returns Array of routable chain IDs
   */
  static getRoutableChains(): string[] {
    return Object.keys(CHAINS).filter(chainId => PartitionRouter.isRoutable(chainId));
  }

  /**
   * Get the service name for a partition.
   *
   * P4-1-FIX: Use ?? instead of || for consistency with getPort.
   *
   * @param partitionId - The partition ID
   * @returns Service name or default
   */
  static getServiceName(partitionId: string): string {
    return PARTITION_SERVICE_NAMES[partitionId] ?? `partition-${partitionId}`;
  }

  /**
   * Get the port for a partition service.
   *
   * @param partitionId - The partition ID
   * @returns Port number or default 3000
   */
  static getPort(partitionId: string): number {
    return PARTITION_PORTS[partitionId] ?? DEFAULT_PORT;
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
  static getChainsForPartition(partitionId: string): string[] {
    const chains = getChainsForPartition(partitionId);
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
  static getPartitionId(chainId: string): string | null {
    const partition = assignChainToPartition(chainId);
    return partition?.partitionId ?? null;
  }
}

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
export function createDeprecationWarning(oldPattern: string, newService: string): string {
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
export function isDeprecatedPattern(serviceName: string): boolean {
  // P2-1-FIX: Dynamic detection only - no hardcoded list needed
  // Pattern: <chain>-detector (e.g., bsc-detector, ethereum-detector)
  if (serviceName.endsWith('-detector')) {
    const chainPart = serviceName.replace('-detector', '');
    // If it's a valid chain and not a partition service, it's deprecated
    // The CHAINS check ensures we only flag real chains, not typos
    if (CHAINS[chainPart] && !serviceName.startsWith('partition-')) {
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
export function getMigrationRecommendation(deprecatedService: string): string | null {
  if (!isDeprecatedPattern(deprecatedService)) {
    return null;
  }

  // Extract chain ID from deprecated pattern
  const chainId = deprecatedService.replace('-detector', '');
  const partition = assignChainToPartition(chainId);

  if (!partition) {
    return null;
  }

  return PARTITION_SERVICE_NAMES[partition.partitionId] || null;
}

/**
 * Log a deprecation warning if using a deprecated pattern.
 *
 * @param serviceName - The service name to check
 * @param logger - Optional logger (defaults to lazy-initialized Pino logger)
 */
export function warnIfDeprecated(
  serviceName: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): void {
  if (isDeprecatedPattern(serviceName)) {
    const recommendation = getMigrationRecommendation(serviceName);
    const effectiveLogger = logger ?? getRouterLogger();

    effectiveLogger.warn('Deprecated service pattern detected', {
      serviceName,
      recommendation: recommendation ?? 'Use partition services instead',
    });
  }
}

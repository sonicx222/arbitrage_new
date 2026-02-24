/**
 * Partition Configuration
 *
 * Types, environment parsing, and validation for partition detector services.
 * Extracted from partition-service-utils.ts for focused responsibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module partition/config
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { CHAINS, TESTNET_CHAINS } from '@arbitrage/config';

// =============================================================================
// Types
// =============================================================================

export interface PartitionServiceConfig {
  /** Partition ID (e.g., 'asia-fast', 'l2-turbo') */
  partitionId: string;

  /** Service name for logging and health responses */
  serviceName: string;

  /** Default chains for this partition */
  defaultChains: readonly string[];

  /** Default health check port */
  defaultPort: number;

  /** Region ID for health responses */
  region: string;

  /** Provider name (e.g., 'oracle', 'fly') */
  provider: string;
}

export interface HealthServerOptions {
  /** Port to listen on */
  port: number;

  /** Service config for responses */
  config: PartitionServiceConfig;

  /** Detector instance for health checks */
  detector: PartitionDetectorInterface;

  /** Logger instance */
  logger: ReturnType<typeof createLogger>;

  /**
   * Optional auth token for the /stats endpoint.
   * When set, requests to /stats must include `Authorization: Bearer <token>`.
   * When not set, /stats is unauthenticated (backward-compatible).
   * @default process.env.HEALTH_AUTH_TOKEN
   */
  authToken?: string;

  /**
   * Bind address for the health server.
   * Defaults to '0.0.0.0' for backward compatibility.
   * Set to '127.0.0.1' to restrict to localhost-only access.
   * @default process.env.HEALTH_BIND_ADDRESS ?? '0.0.0.0'
   */
  bindAddress?: string;

  /**
   * TTL in milliseconds for the health check cache.
   * Higher values reduce async health check calls at the cost of freshness.
   * @default 1000
   */
  healthCacheTtlMs?: number;
}

export interface PartitionDetectorInterface extends EventEmitter {
  getPartitionHealth(): Promise<{
    status: string;
    partitionId: string;
    chainHealth: Map<string, unknown>;
    uptimeSeconds: number;
    totalEventsProcessed: number;
    memoryUsage: number;
  }>;
  getHealthyChains(): string[];
  getStats(): {
    partitionId: string;
    chains: string[];
    totalEventsProcessed: number;
    totalOpportunitiesFound: number;
    uptimeSeconds: number;
    memoryUsageMB: number;
    chainStats: Map<string, unknown>;
  };
  isRunning(): boolean;
  getPartitionId(): string;
  getChains(): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

// =============================================================================
// Typed Environment Configuration (Standardized across P1-P4)
// =============================================================================

/**
 * Typed environment configuration for partition services.
 * Provides compile-time safety for environment variable handling.
 *
 * ARCHITECTURE NOTE:
 * The RPC/WS URLs parsed here are used for VALIDATION AND OPERATOR FEEDBACK ONLY.
 * The actual URL values flow through the shared CHAINS config in @arbitrage/config,
 * which reads from the same environment variables at module load time.
 *
 * This validation layer provides:
 * - Production deployment warnings for operators about missing private endpoints
 * - Typed configuration for IDE autocomplete and compile-time safety
 * - Centralized environment parsing for testability
 *
 * NOTE: Environment config is parsed ONCE at module load time and should be
 * treated as immutable. If you need to test with different env values,
 * use jest.resetModules() to force a fresh module import.
 *
 * @see shared/config/src/chains/index.ts - Where env vars like BSC_RPC_URL are consumed
 */
export interface PartitionEnvironmentConfig {
  /** Redis URL (required in production) */
  redisUrl: string | undefined;
  /** Override chains to monitor */
  partitionChains: string | undefined;
  /** Health check port override */
  healthCheckPort: string | undefined;
  /** Instance identifier */
  instanceId: string | undefined;
  /** Region identifier override */
  regionId: string | undefined;
  /** Enable cross-region health reporting */
  enableCrossRegionHealth: boolean;
  /** Node environment */
  nodeEnv: string;
  /** RPC URLs for validation (actual URLs consumed by @arbitrage/config) */
  rpcUrls: Record<string, string | undefined>;
  /** WebSocket URLs for validation (actual URLs consumed by @arbitrage/config) */
  wsUrls: Record<string, string | undefined>;
}

/**
 * Parse environment variables into typed configuration for a partition.
 *
 * @param chainNames - Array of chain names to parse RPC/WS URLs for
 * @returns Typed environment configuration
 */
export function parsePartitionEnvironmentConfig(
  chainNames: readonly string[]
): PartitionEnvironmentConfig {
  const rpcUrls: Record<string, string | undefined> = {};
  const wsUrls: Record<string, string | undefined> = {};

  // Parse RPC/WS URLs for each chain
  for (const chain of chainNames) {
    const upperChain = chain.toUpperCase();
    rpcUrls[chain] = process.env[`${upperChain}_RPC_URL`];
    wsUrls[chain] = process.env[`${upperChain}_WS_URL`];
  }

  return {
    redisUrl: process.env.REDIS_URL,
    partitionChains: process.env.PARTITION_CHAINS,
    healthCheckPort: process.env.HEALTH_CHECK_PORT,
    instanceId: process.env.INSTANCE_ID,
    regionId: process.env.REGION_ID,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    rpcUrls,
    wsUrls
  };
}

/**
 * Validate environment configuration for a partition service.
 * Exits process on critical errors, warns on non-critical issues.
 *
 * @param envConfig - Parsed environment configuration
 * @param partitionId - Partition identifier for logging context
 * @param chainNames - Chain names to validate RPC/WS URLs for
 * @param logger - Logger instance for warnings
 */
export function validatePartitionEnvironmentConfig(
  envConfig: PartitionEnvironmentConfig,
  partitionId: string,
  chainNames: readonly string[],
  logger?: ReturnType<typeof createLogger>
): void {
  // Validate REDIS_URL - required for all partition services (except in test)
  if (!envConfig.redisUrl && envConfig.nodeEnv !== 'test') {
    exitWithConfigError('REDIS_URL environment variable is required', {
      partitionId,
      hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
    }, logger);
  }

  // Warn about missing RPC/WebSocket URLs in production
  if (envConfig.nodeEnv === 'production') {
    const missingRpcUrls: string[] = [];
    const missingWsUrls: string[] = [];

    for (const chain of chainNames) {
      const upperChain = chain.toUpperCase();
      if (!envConfig.rpcUrls[chain]) {
        missingRpcUrls.push(`${upperChain}_RPC_URL`);
      }
      if (!envConfig.wsUrls[chain]) {
        missingWsUrls.push(`${upperChain}_WS_URL`);
      }
    }

    if (missingRpcUrls.length > 0 && logger) {
      logger.warn('Production deployment without custom RPC URLs - public endpoints may have rate limits', {
        partitionId,
        missingRpcUrls,
        hint: 'Configure private RPC endpoints (Alchemy, Infura, QuickNode) for production reliability'
      });
    }

    if (missingWsUrls.length > 0 && logger) {
      logger.warn('Production deployment without custom WebSocket URLs - public endpoints may be unreliable', {
        partitionId,
        missingWsUrls,
        hint: 'Configure private WebSocket endpoints for production reliability'
      });
    }
  }
}

/**
 * Generate a unique instance ID for a partition service.
 * Uses HOSTNAME if available, falls back to 'local' with timestamp for uniqueness.
 *
 * @param partitionId - Partition identifier (e.g., 'asia-fast', 'l2-turbo')
 * @param providedId - Optional pre-configured instance ID from environment
 * @returns Unique instance identifier
 */
export function generateInstanceId(
  partitionId: string,
  providedId?: string
): string {
  if (providedId) {
    return providedId;
  }
  const hostname = process.env.HOSTNAME || 'local';
  return `${partitionId}-${hostname}-${Date.now()}`;
}

// =============================================================================
// Critical Configuration Validation (Shared across all partitions)
// =============================================================================

/**
 * Logs a critical configuration error and exits the process.
 * Use this for fatal configuration issues that prevent service startup.
 *
 * Returns `never` to help TypeScript understand this terminates the process,
 * allowing proper control flow analysis.
 *
 * @param message - Error message to log
 * @param context - Additional context for the error
 * @param logger - Logger instance (uses console.error as fallback)
 */
export function exitWithConfigError(
  message: string,
  context: Record<string, unknown>,
  logger?: ReturnType<typeof createLogger>
): never {
  if (logger) {
    logger.error(message, context);
  } else {
    console.error(message, context);
  }
  process.exit(1);
}

// =============================================================================
// Port Validation (P7-FIX Pattern)
// =============================================================================

/**
 * Validates and parses a port number from environment variable.
 * Returns defaultPort if the value is invalid or not provided.
 *
 * @param portEnv - The port environment variable value
 * @param defaultPort - Default port to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Valid port number
 */
export function parsePort(
  portEnv: string | undefined,
  defaultPort: number,
  logger?: ReturnType<typeof createLogger>
): number {
  if (!portEnv) {
    return defaultPort;
  }

  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    if (logger) {
      logger.warn('Invalid HEALTH_CHECK_PORT, using default', {
        provided: portEnv,
        default: defaultPort
      });
    }
    return defaultPort;
  }
  return parsed;
}

// =============================================================================
// Chain Validation (P4-FIX Pattern)
// =============================================================================

/**
 * Validates chains from environment variable against known chain IDs.
 * Returns only valid chains, or defaults if none are valid.
 *
 * P2-FIX: Now also validates against TESTNET_CHAINS to support devnet modes.
 * Testnet chains are logged with a warning for visibility.
 *
 * @param chainsEnv - Comma-separated chain IDs from environment
 * @param defaultChains - Default chains to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Array of valid chain IDs
 */
export function validateAndFilterChains(
  chainsEnv: string | undefined,
  defaultChains: readonly string[],
  logger?: ReturnType<typeof createLogger>
): string[] {
  if (!chainsEnv) {
    return [...defaultChains];
  }

  // Chain IDs are the keys of CHAINS (mainnet) and TESTNET_CHAINS
  // Guard against undefined (can happen in test environments due to module loading order)
  const mainnetChainIds = CHAINS && typeof CHAINS === 'object' ? Object.keys(CHAINS) : [];
  const testnetChainIds = TESTNET_CHAINS && typeof TESTNET_CHAINS === 'object' ? Object.keys(TESTNET_CHAINS) : [];
  const allValidChainIds = [...mainnetChainIds, ...testnetChainIds];

  const requestedChains = chainsEnv.split(',').map(c => c.trim().toLowerCase());
  const validChains: string[] = [];
  const testnetChains: string[] = [];
  const invalidChains: string[] = [];

  for (const chain of requestedChains) {
    if (mainnetChainIds.includes(chain)) {
      validChains.push(chain);
    } else if (testnetChainIds.includes(chain)) {
      // P2-FIX: Accept testnet chains but track them separately
      validChains.push(chain);
      testnetChains.push(chain);
    } else {
      invalidChains.push(chain);
    }
  }

  // P2-FIX: Warn when using testnet chains (important for visibility)
  if (testnetChains.length > 0 && logger) {
    logger.warn('Using TESTNET chains - ensure this is intended', {
      testnetChains,
      hint: 'Testnet chains should only be used for testing, not production'
    });
  }

  if (invalidChains.length > 0 && logger) {
    logger.warn('Invalid chain IDs in PARTITION_CHAINS, ignoring', {
      invalidChains,
      validChains,
      availableChains: allValidChainIds
    });
  }

  if (validChains.length === 0) {
    if (logger) {
      logger.warn('No valid chains in PARTITION_CHAINS, using defaults', {
        defaults: defaultChains
      });
    }
    return [...defaultChains];
  }

  // FIX #15: Warn when configured chains are outside the partition's default assignment.
  // This is intentional flexibility (operators CAN reassign chains), but should be flagged
  // so operators are aware of non-standard partition configurations.
  if (logger) {
    const defaultSet = new Set(defaultChains);
    const outsideDefault = validChains.filter(c => !defaultSet.has(c));
    if (outsideDefault.length > 0) {
      logger.warn('Configured chains are outside this partition\'s default assignment', {
        outsideDefaultChains: outsideDefault,
        defaultChains: [...defaultChains],
        hint: 'This is allowed but may indicate a misconfiguration. Verify PARTITION_CHAINS is intentional.'
      });
    }
  }

  return [...new Set(validChains)];
}

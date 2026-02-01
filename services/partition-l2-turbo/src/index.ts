/**
 * P2 L2-Turbo Partition Service Entry Point
 *
 * Deploys the unified detector for the L2-Turbo partition:
 * - Chains: Arbitrum, Optimism, Base
 * - Region: Fly.io Singapore (asia-southeast1)
 * - Resource Profile: Standard (3 chains)
 *
 * This service is a deployment wrapper for the unified-detector,
 * configured specifically for the P2 partition.
 *
 * L2-specific optimizations:
 * - Faster health checks (10s) for sub-second block times
 * - Shorter failover timeout (45s) for quick recovery
 * - High-frequency event handling for L2 throughput
 *
 * Environment Variables:
 * - PARTITION_ID: Set to 'l2-turbo' by default
 * - REDIS_URL: Redis connection URL (required)
 * - LOG_LEVEL: Logging level (default: info)
 * - HEALTH_CHECK_PORT: HTTP health check port (default: 3002)
 * - INSTANCE_ID: Unique instance identifier (auto-generated if not set)
 * - REGION_ID: Region identifier (default: asia-southeast1)
 * - ENABLE_CROSS_REGION_HEALTH: Enable cross-region health reporting (default: true)
 * - PARTITION_CHAINS: Override default chains (comma-separated)
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { Server } from 'http';
import { UnifiedChainDetector, UnifiedDetectorConfig } from '@arbitrage/unified-detector';
import {
  createLogger,
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  exitWithConfigError,
  closeServerWithTimeout,
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  PartitionServiceConfig,
  PartitionEnvironmentConfig,
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES
} from '@arbitrage/core';
import { getPartition, PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// P2 Partition Constants
// =============================================================================

const P2_PARTITION_ID = PARTITION_IDS.L2_TURBO;
// Use centralized port constant (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
const P2_DEFAULT_PORT = PARTITION_PORTS[P2_PARTITION_ID] ?? 3002;

// =============================================================================
// Configuration
// =============================================================================

const logger = createLogger('partition-l2-turbo:main');

// =============================================================================
// Partition Configuration Retrieval
// =============================================================================

// Single partition config retrieval
const partitionConfig = getPartition(P2_PARTITION_ID);
if (!partitionConfig) {
  exitWithConfigError('P2 partition configuration not found', { partitionId: P2_PARTITION_ID }, logger);
}

// BUG-FIX: Add defensive null-safety checks for test compatibility
// During test imports, mocks may not be fully initialized, so we use optional chaining
// and provide safe defaults to prevent "Cannot read properties of undefined" errors
const P2_CHAINS: readonly string[] = partitionConfig?.chains ?? [];
const P2_REGION = partitionConfig?.region ?? 'asia-southeast1';

// BUG-FIX: Validate partition config has chains
if (!P2_CHAINS || P2_CHAINS.length === 0) {
  exitWithConfigError('P2 partition has no chains configured', {
    partitionId: P2_PARTITION_ID,
    chains: P2_CHAINS
  }, logger);
}

// =============================================================================
// Environment Configuration (Using shared typed utilities)
// =============================================================================

// Parse environment into typed configuration using shared utility
const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(P2_CHAINS);

// Validate environment configuration (exits on critical errors, warns on non-critical)
validatePartitionEnvironmentConfig(envConfig, P2_PARTITION_ID, P2_CHAINS, logger);

// =============================================================================
// Service Configuration
// =============================================================================

// Service configuration for shared utilities
const serviceConfig: PartitionServiceConfig = {
  partitionId: P2_PARTITION_ID,
  serviceName: PARTITION_SERVICE_NAMES[P2_PARTITION_ID] ?? 'partition-l2-turbo',
  defaultChains: P2_CHAINS,
  defaultPort: P2_DEFAULT_PORT,
  region: P2_REGION,
  provider: partitionConfig?.provider ?? 'oracle'
};

// Store server reference for graceful shutdown
const healthServerRef: { current: Server | null } = { current: null };

// Unified detector configuration (uses typed envConfig)
// BUG-FIX: Use nullish coalescing (??) consistently instead of logical OR (||)
// to properly handle falsy but valid values like empty strings or 0
// BUG-FIX: Add optional chaining for envConfig properties for test compatibility
const config: UnifiedDetectorConfig = {
  partitionId: P2_PARTITION_ID,
  chains: validateAndFilterChains(envConfig?.partitionChains, P2_CHAINS, logger),
  instanceId: generateInstanceId(P2_PARTITION_ID, envConfig?.instanceId),
  regionId: envConfig?.regionId ?? P2_REGION,
  enableCrossRegionHealth: envConfig?.enableCrossRegionHealth ?? true,
  healthCheckPort: parsePort(envConfig?.healthCheckPort, P2_DEFAULT_PORT, logger)
};

// =============================================================================
// Service Instance
// =============================================================================

const detector = new UnifiedChainDetector(config);

// =============================================================================
// Event Handlers (Using shared utilities)
// =============================================================================

setupDetectorEventHandlers(detector, logger, P2_PARTITION_ID);

// =============================================================================
// Process Handlers (Using shared utilities with shutdown guard)
// =============================================================================

// Store cleanup function to prevent MaxListenersExceeded warnings
// in test scenarios and allow proper handler cleanup
const cleanupProcessHandlers = setupProcessHandlers(healthServerRef, detector, logger, serviceConfig.serviceName);

// =============================================================================
// Main Entry Point
// =============================================================================

// BUG-FIX P1: Use single state enum instead of dual boolean flags
// This is cleaner and more explicit about the service lifecycle state
type MainState = 'idle' | 'starting' | 'started' | 'failed';
let mainState: MainState = 'idle';

async function main(): Promise<void> {
  // Guard against multiple main() invocations (e.g., from integration tests)
  // Safe in Node.js single-threaded event loop - synchronous check within one tick
  if (mainState !== 'idle') {
    logger.warn('main() already started or starting, ignoring duplicate invocation', {
      currentState: mainState
    });
    return;
  }
  mainState = 'starting';

  // BUG-FIX P3: Track startup time for metrics
  const startupStartTime = Date.now();

  logger.info('Starting P2 L2-Turbo Partition Service', {
    partitionId: P2_PARTITION_ID,
    chains: config.chains,
    region: P2_REGION,
    provider: serviceConfig.provider,
    nodeVersion: process.version,
    pid: process.pid
  });

  try {
    // Start health check server first (using shared utilities)
    // BUG-FIX: Use nullish coalescing for port to handle port 0 correctly
    healthServerRef.current = createPartitionHealthServer({
      port: config.healthCheckPort ?? P2_DEFAULT_PORT,
      config: serviceConfig,
      detector,
      logger
    });

    // Start detector
    await detector.start();

    // BUG-FIX P1: Mark as fully started only after successful completion
    mainState = 'started';

    // BUG-FIX P3: Calculate startup metrics
    const startupDurationMs = Date.now() - startupStartTime;
    const memoryUsage = process.memoryUsage();

    logger.info('P2 L2-Turbo Partition Service started successfully', {
      partitionId: detector.getPartitionId(),
      chains: detector.getChains(),
      healthyChains: detector.getHealthyChains(),
      startupDurationMs,
      memoryUsageMB: Math.round(memoryUsage.heapUsed / 1024 / 1024 * 100) / 100,
      rssMemoryMB: Math.round(memoryUsage.rss / 1024 / 1024 * 100) / 100
    });

  } catch (error) {
    // BUG-FIX P1: Mark as failed instead of resetting to idle
    mainState = 'failed';

    // BUG-FIX P2: Add detailed error context for common failure modes
    const errorContext: Record<string, unknown> = {
      partitionId: P2_PARTITION_ID,
      port: config.healthCheckPort ?? P2_DEFAULT_PORT,
      error: error instanceof Error ? error.message : String(error)
    };

    // Add specific hints based on error type
    if (error instanceof Error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EADDRINUSE') {
        errorContext.errorCode = 'EADDRINUSE';
        errorContext.hint = `Port ${config.healthCheckPort ?? P2_DEFAULT_PORT} is already in use. Check for other running instances.`;
      } else if (nodeError.code === 'EACCES') {
        errorContext.errorCode = 'EACCES';
        errorContext.hint = `Insufficient permissions to bind to port ${config.healthCheckPort ?? P2_DEFAULT_PORT}. Try a port > 1024.`;
      } else if (nodeError.code === 'ECONNREFUSED') {
        errorContext.errorCode = 'ECONNREFUSED';
        errorContext.hint = 'Redis connection refused. Verify REDIS_URL and that Redis is running.';
      } else if (nodeError.code === 'ETIMEDOUT') {
        errorContext.errorCode = 'ETIMEDOUT';
        errorContext.hint = 'Connection timed out. Check network connectivity and Redis availability.';
      }
    }

    logger.error('Failed to start P2 L2-Turbo Partition Service', errorContext);

    // BUG-FIX: Explicit null check before closing server
    // Server may be null if createPartitionHealthServer threw before assignment
    if (healthServerRef.current) {
      await closeServerWithTimeout(healthServerRef.current, 1000, logger);
    }

    // BUG-FIX: Clear server reference after closing to prevent stale reference issues
    healthServerRef.current = null;

    // Clean up process handlers before exit to prevent listener leaks
    cleanupProcessHandlers();

    process.exit(1);
  }
}

// Run - only when this is the main entry point (not when imported by tests)
// Check for Jest worker to prevent auto-start during test imports
if (!process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    // BUG-FIX: Wrap logging in try-catch to prevent silent failures if logger fails
    try {
      if (logger) {
        logger.error('Fatal error in P2 L2-Turbo partition main', { error });
      } else {
        console.error('Fatal error in P2 L2-Turbo partition main (logger unavailable):', error);
      }
    } catch (logError) {
      // Last resort - write to stderr directly
      process.stderr.write(`FATAL: ${error}\nLOG ERROR: ${logError}\n`);
    }
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

export {
  detector,
  config,
  P2_PARTITION_ID,
  P2_CHAINS,
  P2_REGION,
  cleanupProcessHandlers,
  // Export for testing
  envConfig
};

// Re-export type from shared utilities for convenience
export type { PartitionEnvironmentConfig };

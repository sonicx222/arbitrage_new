/**
 * Partition Service Runner
 *
 * Service lifecycle management and entry point factory for partition services.
 * Extracted from partition-service-utils.ts for focused responsibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module partition/runner
 */

import { Server } from 'http';
import { createLogger } from '../logger';
import { getPartition } from '@arbitrage/config';
import type {
  PartitionServiceConfig,
  PartitionDetectorInterface,
  PartitionEnvironmentConfig,
} from './config';
import {
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  exitWithConfigError,
  parsePort,
  validateAndFilterChains,
} from './config';
import { createPartitionHealthServer, closeServerWithTimeout } from './health-server';
import { setupDetectorEventHandlers, setupProcessHandlers } from './handlers';
import type { ProcessHandlerCleanup } from './handlers';
import { PARTITION_PORTS, PARTITION_SERVICE_NAMES } from './router';

// =============================================================================
// R9: Partition Service Runner Factory
// =============================================================================

/**
 * Service lifecycle state for partition services.
 * Used to prevent duplicate startup/shutdown and track state.
 */
export type ServiceLifecycleState = 'idle' | 'starting' | 'started' | 'failed' | 'stopping';

/**
 * Options for creating a partition service runner.
 */
export interface PartitionServiceRunnerOptions {
  /** Service configuration */
  config: PartitionServiceConfig;

  /** Unified detector config (passed to UnifiedChainDetector constructor) */
  detectorConfig: {
    partitionId: string;
    chains: string[];
    instanceId: string;
    regionId: string;
    enableCrossRegionHealth: boolean;
    healthCheckPort: number;
  };

  /** Factory function to create the detector instance */
  createDetector: (config: PartitionServiceRunnerOptions['detectorConfig']) => PartitionDetectorInterface;

  /** Logger instance */
  logger: ReturnType<typeof createLogger>;

  /** Optional callback on successful startup (may be async) */
  onStarted?: (detector: PartitionDetectorInterface, startupDurationMs: number) => void | Promise<void>;

  /** Optional callback on startup failure (may be async) */
  onStartupError?: (error: Error) => void | Promise<void>;
}

/**
 * Result from createPartitionServiceRunner.
 */
export interface PartitionServiceRunner {
  /** The detector instance */
  detector: PartitionDetectorInterface;

  /** Start the service (call once) */
  start: () => Promise<void>;

  /** Get current service state */
  getState: () => ServiceLifecycleState;

  /** Cleanup function for process handlers */
  cleanup: ProcessHandlerCleanup;

  /** Health server reference (populated after start) */
  healthServer: { current: Server | null };
}

/**
 * R9: Creates a partition service runner that encapsulates common startup logic.
 *
 * This factory reduces boilerplate in partition service entry points by:
 * - Managing service lifecycle state (idle → starting → started/failed)
 * - Handling startup guards (preventing duplicate starts)
 * - Setting up event handlers and process handlers
 * - Creating health server
 * - Providing consistent error handling and logging
 *
 * @example
 * ```typescript
 * const runner = createPartitionServiceRunner({
 *   config: serviceConfig,
 *   detectorConfig: config,
 *   createDetector: (cfg) => new UnifiedChainDetector(cfg),
 *   logger,
 * });
 *
 * // In main()
 * await runner.start();
 *
 * // Exports
 * export { runner.detector as detector, runner.cleanup as cleanupProcessHandlers };
 * ```
 *
 * @param options - Runner configuration
 * @returns Partition service runner with start() method and detector instance
 */
export function createPartitionServiceRunner(
  options: PartitionServiceRunnerOptions
): PartitionServiceRunner {
  const { config, detectorConfig, createDetector, logger, onStarted, onStartupError } = options;

  // Create detector instance
  const detector = createDetector(detectorConfig);

  // Store server reference for graceful shutdown
  const healthServerRef: { current: Server | null } = { current: null };

  // Setup event handlers
  setupDetectorEventHandlers(detector, logger, config.partitionId);

  // Setup process handlers
  const cleanup = setupProcessHandlers(healthServerRef, detector, logger, config.serviceName);

  // Lifecycle state management
  let state: ServiceLifecycleState = 'idle';

  /**
   * Start the partition service.
   *
   * Guarded against duplicate invocations.
   */
  async function start(): Promise<void> {
    // Guard against multiple start() invocations
    if (state !== 'idle') {
      logger.warn('Service already started or starting, ignoring duplicate start()', {
        currentState: state,
        partitionId: config.partitionId,
      });
      return;
    }
    state = 'starting';

    const startupStartTime = Date.now();

    logger.info(`Starting ${config.serviceName} (${detectorConfig.chains.length} chains, port ${detectorConfig.healthCheckPort})`);
    logger.debug(`${config.serviceName} startup config`, {
      partitionId: config.partitionId,
      chains: detectorConfig.chains,
      region: config.region,
      provider: config.provider,
      nodeVersion: process.version,
      pid: process.pid,
    });

    try {
      // Start health check server first
      healthServerRef.current = createPartitionHealthServer({
        port: detectorConfig.healthCheckPort,
        config,
        detector,
        logger,
      });

      // Start detector
      await detector.start();

      // Mark as fully started
      state = 'started';

      const startupDurationMs = Date.now() - startupStartTime;
      const memoryUsage = process.memoryUsage();

      const chains = detector.getChains();
      const healthyChains = detector.getHealthyChains();
      logger.info(`${config.serviceName} started: ${healthyChains.length}/${chains.length} chains healthy, ${(startupDurationMs / 1000).toFixed(1)}s`);
      logger.debug(`${config.serviceName} startup details`, {
        partitionId: detector.getPartitionId(),
        chains,
        healthyChains,
        startupDurationMs,
        memoryUsageMB: Math.round(memoryUsage.heapUsed / 1024 / 1024 * 100) / 100,
        rssMemoryMB: Math.round(memoryUsage.rss / 1024 / 1024 * 100) / 100,
      });

      // Call optional success callback (may be async for partitions with custom startup)
      if (onStarted) {
        await onStarted(detector, startupDurationMs);
      }

    } catch (error) {
      state = 'failed';

      const err = error instanceof Error ? error : new Error(String(error));
      const errorContext: Record<string, unknown> = {
        partitionId: config.partitionId,
        port: detectorConfig.healthCheckPort,
        error: err.message,
      };

      // Add specific hints based on error type
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EADDRINUSE') {
        errorContext.errorCode = 'EADDRINUSE';
        errorContext.hint = `Port ${detectorConfig.healthCheckPort} is already in use.`;
      } else if (nodeError.code === 'EACCES') {
        errorContext.errorCode = 'EACCES';
        errorContext.hint = `Insufficient permissions for port ${detectorConfig.healthCheckPort}.`;
      } else if (nodeError.code === 'ECONNREFUSED') {
        errorContext.errorCode = 'ECONNREFUSED';
        errorContext.hint = 'Redis connection refused. Verify REDIS_URL.';
      } else if (nodeError.code === 'ETIMEDOUT') {
        errorContext.errorCode = 'ETIMEDOUT';
        errorContext.hint = 'Connection timed out.';
      }

      logger.error(`Failed to start ${config.serviceName}`, errorContext);

      // Cleanup health server if it was created
      if (healthServerRef.current) {
        await closeServerWithTimeout(healthServerRef.current, 1000, logger);
      }
      healthServerRef.current = null;

      // Clean up process handlers
      cleanup();

      // Call optional error callback (may be async for partitions with custom cleanup)
      if (onStartupError) {
        await onStartupError(err);
      }

      // Exit process
      process.exit(1);
    }
  }

  return {
    detector,
    start,
    getState: () => state,
    cleanup,
    healthServer: healthServerRef,
  };
}

/**
 * R9: Run a partition service with standard startup logic.
 *
 * This is the simplest way to start a partition service. It:
 * - Creates the service runner
 * - Guards against Jest auto-start
 * - Calls start() with proper error handling
 *
 * @example
 * ```typescript
 * // In partition index.ts
 * const { detector, cleanup } = runPartitionService({
 *   config: serviceConfig,
 *   detectorConfig: config,
 *   createDetector: (cfg) => new UnifiedChainDetector(cfg),
 *   logger,
 * });
 *
 * export { detector, cleanup as cleanupProcessHandlers };
 * ```
 *
 * @param options - Runner configuration
 * @returns Runner instance (for accessing detector and cleanup)
 */
export function runPartitionService(
  options: PartitionServiceRunnerOptions
): PartitionServiceRunner {
  const runner = createPartitionServiceRunner(options);

  // Run only when not in Jest (prevents auto-start during test imports)
  if (!process.env.JEST_WORKER_ID) {
    runner.start().catch((error) => {
      try {
        if (options.logger) {
          options.logger.error(`Fatal error in ${options.config.serviceName}`, { error });
        } else {
          console.error(`Fatal error in ${options.config.serviceName}:`, error);
        }
      } catch (logError) {
        process.stderr.write(`FATAL: ${error}\nLOG ERROR: ${logError}\n`);
      }
      process.exit(1);
    });
  }

  return runner;
}

// =============================================================================
// R10: Partition Entry Point Factory (ADR-003 Extension)
// =============================================================================

/**
 * Result from createPartitionEntry, containing all values needed for
 * backward-compatible exports from partition service entry points.
 */
export interface PartitionEntryResult {
  /** The detector instance (cast to concrete type by consumer if needed) */
  detector: PartitionDetectorInterface;

  /** Detector config (compatible with UnifiedDetectorConfig) */
  config: {
    partitionId: string;
    chains: string[];
    instanceId: string;
    regionId: string;
    enableCrossRegionHealth: boolean;
    healthCheckPort: number;
  };

  /** Partition ID constant */
  partitionId: string;

  /** Configured chains for this partition */
  chains: readonly string[];

  /** Deployment region */
  region: string;

  /** Process handler cleanup function */
  cleanupProcessHandlers: ProcessHandlerCleanup;

  /** Parsed environment configuration */
  envConfig: PartitionEnvironmentConfig;

  /** Full runner instance for advanced use */
  runner: PartitionServiceRunner;

  /** Service configuration (for partitions that need access to it) */
  serviceConfig: PartitionServiceConfig;

  /** Logger instance (for partitions that need to log from hooks) */
  logger: ReturnType<typeof createLogger>;
}

/**
 * Lifecycle hooks for createPartitionEntry.
 *
 * Allows partition services with custom initialization needs (e.g., P4 Solana)
 * to hook into the standard partition lifecycle without duplicating boilerplate.
 *
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */
export interface PartitionEntryHooks {
  /**
   * Called after the detector is started successfully within the runner's start() method.
   * Use this for post-startup initialization (e.g., starting additional detectors,
   * initializing Redis Streams clients).
   *
   * Receives the detector instance and startup duration in milliseconds.
   */
  onStarted?: (detector: PartitionDetectorInterface, startupDurationMs: number) => void | Promise<void>;

  /**
   * Called when the runner's start() fails.
   * Use this for cleanup of additional resources created during initialization.
   */
  onStartupError?: (error: Error) => void | Promise<void>;

  /**
   * Additional cleanup logic to run alongside the standard process handler cleanup.
   * This function is composed with the runner's cleanup: calling cleanupProcessHandlers()
   * will invoke both the standard cleanup and this additional cleanup.
   *
   * Use this to clean up additional resources (e.g., stopping a SolanaArbitrageDetector,
   * removing custom event listeners).
   */
  additionalCleanup?: () => void;
}

/**
 * R10: Creates a complete partition service entry point from just a partition ID.
 *
 * This factory eliminates boilerplate across P1/P2/P3/P4 partition services by
 * encapsulating the common initialization sequence:
 * 1. Retrieve partition config (chains, region, provider)
 * 2. Validate chains are configured
 * 3. Parse and validate environment config
 * 4. Build service and detector configs
 * 5. Run the partition service via runPartitionService()
 *
 * Each partition entry point reduces from ~140 lines to ~15 lines.
 * For partitions with custom needs (e.g., P4 Solana), lifecycle hooks
 * allow injecting additional initialization without duplicating boilerplate.
 *
 * @param partitionId - The partition ID (e.g., from PARTITION_IDS.ASIA_FAST)
 * @param createDetector - Factory function to create the detector instance
 * @param hooks - Optional lifecycle hooks for custom initialization/cleanup
 * @returns All values needed for backward-compatible exports
 *
 * @example
 * ```typescript
 * // Simple usage (P1-P3):
 * const entry = createPartitionEntry(
 *   PARTITION_IDS.ASIA_FAST,
 *   (cfg) => new UnifiedChainDetector(cfg)
 * );
 *
 * // Usage with lifecycle hooks (P4 Solana):
 * const entry = createPartitionEntry(
 *   PARTITION_IDS.SOLANA_NATIVE,
 *   (cfg) => new UnifiedChainDetector(cfg),
 *   {
 *     onStarted: (detector) => { /* post-startup logic *\/ },
 *     additionalCleanup: () => { /* extra cleanup *\/ },
 *   }
 * );
 * ```
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */
export function createPartitionEntry(
  partitionId: string,
  createDetector: (config: PartitionServiceRunnerOptions['detectorConfig']) => PartitionDetectorInterface,
  hooks?: PartitionEntryHooks
): PartitionEntryResult {
  const serviceName = PARTITION_SERVICE_NAMES[partitionId] ?? `partition-${partitionId}`;
  const logger = createLogger(`${serviceName}:main`);
  const defaultPort = PARTITION_PORTS[partitionId] ?? 3000;

  // Partition configuration retrieval
  const partitionConfig = getPartition(partitionId);
  if (!partitionConfig) {
    exitWithConfigError('Partition configuration not found', { partitionId }, logger);
  }

  // Defensive null-safety for test compatibility
  const chains: readonly string[] = partitionConfig?.chains ?? [];
  const region = partitionConfig?.region ?? 'us-east1';

  if (!chains || chains.length === 0) {
    exitWithConfigError('Partition has no chains configured', {
      partitionId,
      chains
    }, logger);
  }

  // Environment Configuration
  const envConfig: PartitionEnvironmentConfig = parsePartitionEnvironmentConfig(chains);
  validatePartitionEnvironmentConfig(envConfig, partitionId, chains, logger);

  // Service Configuration
  const serviceConfig: PartitionServiceConfig = {
    partitionId,
    serviceName,
    defaultChains: chains,
    defaultPort,
    region,
    provider: partitionConfig?.provider ?? 'oracle'
  };

  // Build detector config
  const detectorConfig = {
    partitionId,
    chains: validateAndFilterChains(envConfig?.partitionChains, chains, logger),
    instanceId: generateInstanceId(partitionId, envConfig?.instanceId),
    regionId: envConfig?.regionId ?? region,
    enableCrossRegionHealth: envConfig?.enableCrossRegionHealth ?? true,
    healthCheckPort: parsePort(envConfig?.healthCheckPort, defaultPort, logger)
  };

  // Service Runner (with optional lifecycle hooks)
  const runner = runPartitionService({
    config: serviceConfig,
    detectorConfig,
    createDetector,
    logger,
    onStarted: hooks?.onStarted,
    onStartupError: hooks?.onStartupError
  });

  // Compose cleanup: standard runner cleanup + optional additional cleanup
  const composedCleanup: ProcessHandlerCleanup = hooks?.additionalCleanup
    ? () => {
        hooks.additionalCleanup!();
        runner.cleanup();
      }
    : runner.cleanup;

  return {
    detector: runner.detector,
    config: detectorConfig,
    partitionId,
    chains,
    region,
    cleanupProcessHandlers: composedCleanup,
    envConfig,
    runner,
    serviceConfig,
    logger
  };
}

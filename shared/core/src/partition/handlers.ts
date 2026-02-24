/**
 * Partition Event & Process Handlers
 *
 * Detector event handlers and process signal handlers for partition services.
 * Extracted from partition-service-utils.ts for focused responsibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module partition/handlers
 */

import { Server } from 'http';
import { parentPort } from 'worker_threads';
import { createLogger } from '../logger';
import { setupParentPortListener } from '../lifecycle-utils';
import type { PartitionDetectorInterface } from './config';
import { shutdownPartitionService } from './health-server';

// =============================================================================
// Event Handlers (P16 Refactor)
// =============================================================================

/**
 * Cleanup function returned by setupDetectorEventHandlers to remove registered listeners.
 * Call this during testing or when reinitializing handlers.
 */
export type DetectorEventHandlerCleanup = () => void;

/**
 * Sets up standard event handlers for a partition detector.
 * Provides consistent logging across all partitions.
 *
 * FIX 10.3: Uses conditional debug logging to avoid object allocation
 * on hot-path events (priceUpdate fires 100s-1000s times/sec).
 *
 * FIX #9: Returns a cleanup function that removes all registered handlers.
 * Backward-compatible - existing callers that ignore the return value are unaffected.
 *
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param partitionId - Partition ID for log context
 * @returns Cleanup function to remove all registered event handlers
 */
export function setupDetectorEventHandlers(
  detector: PartitionDetectorInterface,
  logger: ReturnType<typeof createLogger>,
  partitionId: string
): DetectorEventHandlerCleanup {
  // FIX #20: Pre-compute debug flag ONCE to avoid per-event evaluation overhead.
  // priceUpdate events fire 1000+/sec - this eliminates method call + nullish coalescing per event.
  const debugEnabled = logger.isLevelEnabled?.('debug') ?? logger.level === 'debug';

  // FIX #9: Store handler references for cleanup (same pattern as setupProcessHandlers)
  const priceUpdateHandler = (update: { chain: string; dex: string; price: number }) => {
    // Only create log object if debug level is enabled
    if (debugEnabled) {
      logger.debug('Price update', {
        partition: partitionId,
        chain: update.chain,
        dex: update.dex,
        price: update.price
      });
    }
  };

  const opportunityHandler = (opp: {
    id: string;
    type: string;
    buyDex: string;
    sellDex: string;
    expectedProfit: number;
    profitPercentage: number;
  }) => {
    logger.info('Arbitrage opportunity detected', {
      partition: partitionId,
      id: opp.id,
      type: opp.type,
      buyDex: opp.buyDex,
      sellDex: opp.sellDex,
      profit: opp.expectedProfit,
      percentage: opp.profitPercentage.toFixed(2) + '%'  // profitPercentage is already a percentage value
    });
  };

  const chainErrorHandler = ({ chainId, error }: { chainId: string; error: Error }) => {
    logger.error(`Chain error: ${chainId}`, {
      partition: partitionId,
      error: error.message
    });
  };

  const chainConnectedHandler = ({ chainId }: { chainId: string }) => {
    logger.info(`Chain connected: ${chainId}`, { partition: partitionId });
  };

  const chainDisconnectedHandler = ({ chainId }: { chainId: string }) => {
    logger.warn(`Chain disconnected: ${chainId}`, { partition: partitionId });
  };

  // FIX: Handle statusChange event emitted by UnifiedChainDetector's chainInstanceManager
  const statusChangeHandler = ({ chainId, oldStatus, newStatus }: {
    chainId: string;
    oldStatus: string;
    newStatus: string;
  }) => {
    // Log status changes with appropriate severity based on transition
    const isRecovery = oldStatus === 'error' || oldStatus === 'disconnected';
    const isDegradation = newStatus === 'error' || newStatus === 'disconnected';

    if (isDegradation) {
      logger.warn(`Chain status degraded: ${chainId}`, {
        partition: partitionId,
        from: oldStatus,
        to: newStatus
      });
    } else if (isRecovery) {
      logger.info(`Chain status recovered: ${chainId}`, {
        partition: partitionId,
        from: oldStatus,
        to: newStatus
      });
    } else {
      // FIX 10.3: Conditional debug logging for status changes
      if (debugEnabled) {
        logger.debug(`Chain status changed: ${chainId}`, {
          partition: partitionId,
          from: oldStatus,
          to: newStatus
        });
      }
    }
  };

  const failoverEventHandler = (event: unknown) => {
    logger.warn('Failover event received', { partition: partitionId, ...event as object });
  };

  // Register all handlers
  detector.on('priceUpdate', priceUpdateHandler);
  detector.on('opportunity', opportunityHandler);
  detector.on('chainError', chainErrorHandler);
  detector.on('chainConnected', chainConnectedHandler);
  detector.on('chainDisconnected', chainDisconnectedHandler);
  detector.on('statusChange', statusChangeHandler);
  detector.on('failoverEvent', failoverEventHandler);

  // FIX #9: Return cleanup function to remove all registered handlers
  return () => {
    detector.off('priceUpdate', priceUpdateHandler);
    detector.off('opportunity', opportunityHandler);
    detector.off('chainError', chainErrorHandler);
    detector.off('chainConnected', chainConnectedHandler);
    detector.off('chainDisconnected', chainDisconnectedHandler);
    detector.off('statusChange', statusChangeHandler);
    detector.off('failoverEvent', failoverEventHandler);
  };
}

// =============================================================================
// Process Signal Handlers
// =============================================================================

/**
 * Cleanup function returned by setupProcessHandlers to remove registered listeners.
 * Call this during testing or when reinitializing handlers.
 */
export type ProcessHandlerCleanup = () => void;

/**
 * Sets up process signal handlers for graceful shutdown.
 *
 * P19-FIX: Uses a shutdown flag to prevent multiple concurrent shutdown attempts
 * when signals arrive close together (e.g., SIGTERM followed by SIGINT).
 *
 * S3.2.3-FIX: Returns cleanup function to prevent MaxListenersExceeded warnings
 * when handlers are registered multiple times (e.g., in tests).
 *
 * @param healthServerRef - Reference to health server (use object to allow mutation)
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 * @returns Cleanup function to remove all registered handlers
 */
export function setupProcessHandlers(
  healthServerRef: { current: Server | null },
  detector: PartitionDetectorInterface,
  logger: ReturnType<typeof createLogger>,
  serviceName: string
): ProcessHandlerCleanup {
  // P19-FIX: Guard flag to prevent multiple shutdown calls
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    // P19-FIX: Skip if already shutting down
    if (isShuttingDown) {
      logger.info(`Already shutting down, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;
    await shutdownPartitionService(signal, healthServerRef.current, detector, logger, serviceName);
  };

  // FIX #4: Track unhandled rejections and trigger shutdown after threshold.
  // A single transient rejection shouldn't kill the service, but repeated failures
  // (e.g., Redis disconnect, WebSocket loss) indicate a zombie state.
  // NOTE: When running with --unhandled-rejections=throw (set in partition Dockerfiles),
  // rejections become uncaught exceptions before this handler fires, so the uncaughtHandler
  // handles them immediately. This threshold serves as defense-in-depth for non-Docker
  // environments (local dev, tests, direct node execution).
  const REJECTION_THRESHOLD = 5;
  const REJECTION_WINDOW_MS = 60_000;
  const rejectionTimestamps: number[] = [];

  // S3.2.3-FIX: Store handler references for cleanup
  const sigtermHandler = () => shutdown('SIGTERM');
  const sigintHandler = () => shutdown('SIGINT');
  const uncaughtHandler = (error: Error) => {
    logger.error(`Uncaught exception in ${serviceName}`, { error });
    shutdown('uncaughtException').catch(() => {
      process.exit(1);
    });
  };
  const rejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
    logger.error(`Unhandled rejection in ${serviceName}`, { reason, promise });

    // FIX #4: Count rejections within time window; trigger shutdown if threshold exceeded
    const now = Date.now();
    rejectionTimestamps.push(now);
    // Evict timestamps outside the window
    while (rejectionTimestamps.length > 0 && rejectionTimestamps[0] <= now - REJECTION_WINDOW_MS) {
      rejectionTimestamps.shift();
    }
    if (rejectionTimestamps.length >= REJECTION_THRESHOLD) {
      logger.error(`${REJECTION_THRESHOLD} unhandled rejections within ${REJECTION_WINDOW_MS / 1000}s window - triggering shutdown`, {
        service: serviceName,
        rejectionCount: rejectionTimestamps.length,
      });
      shutdown('unhandledRejection').catch(() => {
        process.exit(1);
      });
    }
  };

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', rejectionHandler);

  // P0 Fix #37: Listen for shutdown and health_request messages from monolith WorkerManager.
  // Extracted to shared utility to eliminate duplication with service-bootstrap.ts.
  const cleanupParentPort = setupParentPortListener({
    parentPort,
    serviceName,
    logger,
    isShuttingDown: () => isShuttingDown,
    shutdown,
  });

  // S3.2.3-FIX: Return cleanup function to prevent listener accumulation
  return () => {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', rejectionHandler);
    cleanupParentPort?.();
  };
}

/**
 * Lifecycle Utilities
 *
 * Minimal helpers for safely clearing intervals, timeouts, and
 * worker thread shutdown messaging.
 * Returns null for direct assignment, replacing the common 3-line pattern:
 *
 * ```typescript
 * // Before (repeated 40+ times across codebase)
 * if (this.healthInterval) {
 *   clearInterval(this.healthInterval);
 *   this.healthInterval = null;
 * }
 *
 * // After
 * this.healthInterval = clearIntervalSafe(this.healthInterval);
 * ```
 */

/**
 * Clear an interval and return null for assignment.
 * Safe to call with null (no-op).
 */
export function clearIntervalSafe(interval: NodeJS.Timeout | null): null {
  if (interval) {
    clearInterval(interval);
  }
  return null;
}

/**
 * Clear a timeout and return null for assignment.
 * Safe to call with null (no-op).
 */
export function clearTimeoutSafe(timeout: NodeJS.Timeout | null): null {
  if (timeout) {
    clearTimeout(timeout);
  }
  return null;
}

/**
 * Stop a service and return null for assignment.
 * Safe to call with null (no-op). Handles both sync and async stop() methods.
 *
 * ```typescript
 * // Before (repeated 13+ times across codebase)
 * if (this.healthMonitor) {
 *   this.healthMonitor.stop();
 *   this.healthMonitor = null;
 * }
 *
 * // After
 * this.healthMonitor = await stopAndNullify(this.healthMonitor);
 * ```
 */
export async function stopAndNullify<T extends { stop(): void | Promise<void> }>(
  ref: T | null
): Promise<null> {
  if (ref) {
    await ref.stop();
  }
  return null;
}

// =============================================================================
// Worker Thread Parent Port Listener
// =============================================================================

/**
 * Minimal logger interface — only the methods used by the parentPort listener.
 * Avoids importing the full Logger type to keep lifecycle-utils dependency-free.
 */
interface LifecycleLogger {
  info(msg: string, ...args: unknown[]): void;
}

/**
 * Configuration for the parentPort listener utility.
 */
export interface ParentPortListenerConfig {
  /** The parentPort from `worker_threads` (null when not in a worker) */
  parentPort: { on(event: string, fn: (msg: unknown) => void): void; postMessage(msg: unknown): void } | null;
  /** Service name for log messages and health responses */
  serviceName: string;
  /** Logger instance */
  logger: LifecycleLogger;
  /** Getter for the current shutting-down state (must be a function because the value is mutable) */
  isShuttingDown: () => boolean;
  /** Callback invoked when a shutdown message is received from the parent */
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Set up a parentPort message listener for worker thread shutdown and health
 * check messages from the monolith WorkerManager.
 *
 * Handles two message types:
 * - `{ type: 'shutdown' }` — triggers graceful shutdown via the provided callback
 * - `{ type: 'health_request', requestId }` — responds with health status
 *
 * Returns a cleanup function that removes the listener, or null if parentPort
 * is not available (i.e., not running as a worker thread).
 *
 * This utility was extracted from identical code in `partition-service-utils.ts`
 * and `service-bootstrap.ts` to eliminate duplication.
 *
 * @see partition-service-utils.ts - setupGracefulShutdown
 * @see service-bootstrap.ts - setupServiceShutdown
 */
export function setupParentPortListener(config: ParentPortListenerConfig): (() => void) | null {
  const { parentPort, serviceName, logger, isShuttingDown, shutdown } = config;

  if (!parentPort) {
    return null;
  }

  const listener = (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const message = msg as Record<string, unknown>;

    if (message.type === 'shutdown') {
      logger.info(`${serviceName} received shutdown message from monolith`);
      shutdown('workerShutdown').catch(() => {
        process.exit(1);
      });
    } else if (message.type === 'health_request') {
      parentPort.postMessage({
        type: 'health_response',
        requestId: message.requestId,
        status: isShuttingDown() ? 'unhealthy' : 'healthy',
        details: {
          service: serviceName,
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      });
    }
  };

  parentPort.on('message', listener);

  return () => {
    // parentPort.off is available on MessagePort; cast to access it
    (parentPort as unknown as { off(event: string, fn: (...args: unknown[]) => void): void }).off('message', listener);
  };
}

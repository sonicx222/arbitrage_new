/**
 * Lifecycle Utilities
 *
 * Minimal helpers for safely clearing intervals and timeouts.
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

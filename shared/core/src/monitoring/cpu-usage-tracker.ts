/**
 * CPU Usage Tracker
 *
 * Provides delta-based CPU usage percentage calculation using process.cpuUsage().
 * Extracts the pattern from enhanced-health-monitor.ts into a shared utility
 * so all services can report real CPU metrics instead of hardcoded 0.
 *
 * @see H2 — CPU metric hardcoded to 0 in 4 services (Terminal Analysis Consolidated Plan)
 * @see enhanced-health-monitor.ts — Original delta pattern (P1 FIX #4)
 */

/**
 * Tracks CPU usage as a delta percentage between successive calls.
 *
 * process.cpuUsage() returns cumulative microseconds since process start.
 * This class computes the ratio of CPU time used in the interval vs
 * wall-clock time elapsed, yielding a 0–1 percentage.
 *
 * @example
 * ```ts
 * const tracker = new CpuUsageTracker();
 * // ... some time later ...
 * const cpuPercent = tracker.getUsagePercent(); // e.g., 0.35 = 35% CPU
 * ```
 */
export class CpuUsageTracker {
  private lastCpuUsage: { user: number; system: number } | null = null;
  private lastCheckTime = 0;

  /**
   * Get CPU usage as a percentage (0–1) since the last call.
   * Returns 0 on the first call (no prior baseline).
   */
  getUsagePercent(): number {
    const currentCpu = process.cpuUsage();
    const now = Date.now();

    let cpuPercent = 0;
    if (this.lastCpuUsage && this.lastCheckTime > 0) {
      const userDelta = currentCpu.user - this.lastCpuUsage.user;
      const systemDelta = currentCpu.system - this.lastCpuUsage.system;
      const wallTimeMicros = (now - this.lastCheckTime) * 1000; // ms → μs
      if (wallTimeMicros > 0) {
        cpuPercent = (userDelta + systemDelta) / wallTimeMicros;
        cpuPercent = Math.min(1, Math.max(0, cpuPercent));
      }
    }

    this.lastCpuUsage = currentCpu;
    this.lastCheckTime = now;

    return cpuPercent;
  }

  /**
   * Reset tracking state (e.g., for tests).
   */
  reset(): void {
    this.lastCpuUsage = null;
    this.lastCheckTime = 0;
  }
}

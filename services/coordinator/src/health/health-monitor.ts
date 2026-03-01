/**
 * Health Monitor
 *
 * Manages system health monitoring including:
 * - Degradation level evaluation (ADR-007)
 * - Service health analysis
 * - Alert checking with startup grace period
 * - Metrics updates
 *
 * @see R2 - Coordinator Subsystems extraction
 * @see ADR-007 - Cross-Region Failover
 */

import type { ServiceHealth } from '@arbitrage/types';
import type { SystemMetrics, Alert } from '../api/types';
import { getErrorMessage } from '@arbitrage/core/resilience';

/**
 * Logger interface for dependency injection
 */
export interface HealthMonitorLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Graceful degradation modes per ADR-007.
 * Allows coordinator to communicate system capability level.
 */
export enum DegradationLevel {
  FULL_OPERATION = 0,      // All services healthy
  REDUCED_CHAINS = 1,      // Some chain detectors down
  DETECTION_ONLY = 2,      // Execution disabled
  READ_ONLY = 3,           // Only dashboard/monitoring
  COMPLETE_OUTAGE = 4      // All services down
}

/**
 * Service name patterns for degradation level evaluation.
 * Extracted from hardcoded checks to enable configuration.
 */
export interface ServiceNamePatterns {
  /** Pattern to match execution engine service name */
  executionEngine: string;
  /** Pattern to identify detector services (contains pattern) */
  detectorPattern: string;
  /** Pattern to identify cross-chain services */
  crossChainPattern: string;
}

/**
 * Default service name patterns
 */
export const DEFAULT_SERVICE_PATTERNS: ServiceNamePatterns = {
  executionEngine: 'execution-engine',
  detectorPattern: 'detector',
  crossChainPattern: 'cross-chain',
};

/**
 * Result of service health analysis
 */
export interface ServiceHealthAnalysis {
  hasAnyServices: boolean;
  executorHealthy: boolean;
  hasHealthyDetectors: boolean;
  allDetectorsHealthy: boolean;
  detectorCount: number;
  healthyDetectorCount: number;
}

/**
 * Configuration for the health monitor
 */
export interface HealthMonitorConfig {
  /** Startup grace period in milliseconds (default: 180000) */
  startupGracePeriodMs?: number;
  /** Alert cooldown in milliseconds (default: 300000) */
  alertCooldownMs?: number;
  /** Minimum services before alerting during grace period (default: 3) */
  minServicesForGracePeriodAlert?: number;
  /** Service name patterns for degradation evaluation */
  servicePatterns?: Partial<ServiceNamePatterns>;
  // P2-005 FIX: Make hardcoded values configurable
  /** Threshold for triggering cooldown cleanup (default: 1000 entries) */
  cooldownCleanupThreshold?: number;
  /** Maximum age for cooldown entries before cleanup (default: 3600000 ms = 1 hour) */
  cooldownMaxAgeMs?: number;
  /** @see OP-13: Threshold in ms for detecting stale heartbeats (default: 90000) */
  staleHeartbeatThresholdMs?: number;
  /** Consecutive stale checks required before downgrading (default: 3) */
  consecutiveFailuresThreshold?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<Omit<HealthMonitorConfig, 'servicePatterns'>> & { servicePatterns: ServiceNamePatterns } = {
  // FIX #5: Increased from 60s to 180s. Services with vault-model adapters
  // (GMX, Beethoven X) can take 60-90s to initialize via slow RPC calls.
  startupGracePeriodMs: 180000,
  alertCooldownMs: 300000,
  minServicesForGracePeriodAlert: 3,
  servicePatterns: DEFAULT_SERVICE_PATTERNS,
  // P2-005 FIX: Default values for cooldown cleanup
  cooldownCleanupThreshold: 1000,
  cooldownMaxAgeMs: 3600000, // 1 hour
  // OP-13: Stale heartbeat detection threshold.
  // FIX #5: Increased from 30s to 90s. The previous 30s threshold raced with
  // P3's 30s healthCheckIntervalMs, causing oscillation at boundary edges.
  // 90s gives 3x headroom over the longest health check interval (30s).
  staleHeartbeatThresholdMs: 90000,
  consecutiveFailuresThreshold: 3,
};

/**
 * Health Monitor
 *
 * Manages system health monitoring and degradation level evaluation.
 */
export class HealthMonitor {
  private readonly config: typeof DEFAULT_CONFIG;
  private readonly logger: HealthMonitorLogger;
  private readonly onAlert: (alert: Alert) => void;

  private degradationLevel: DegradationLevel = DegradationLevel.FULL_OPERATION;
  private startTime: number = 0;
  private alertCooldowns: Map<string, number> = new Map();
  private consecutiveStaleCount = 0;

  /**
   * H1 FIX: Track last stale-heartbeat log time per service to reduce log noise.
   * Only log WARN on first detection and at escalation thresholds (60s, 120s, 300s).
   * Intermediate checks are logged at DEBUG level.
   */
  private staleLogState: Map<string, { firstLoggedAt: number; lastEscalationAge: number }> = new Map();

  /**
   * C4 FIX: Track which services have ever sent a heartbeat.
   * During grace period, "never heartbeated" (STARTING) is distinct from "heartbeat went stale" (FAILED).
   */
  private firstHeartbeatReceived: Set<string> = new Set();

  constructor(
    logger: HealthMonitorLogger,
    onAlert: (alert: Alert) => void,
    config?: HealthMonitorConfig
  ) {
    this.logger = logger;
    this.onAlert = onAlert;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      servicePatterns: { ...DEFAULT_SERVICE_PATTERNS, ...config?.servicePatterns },
    };
  }

  /**
   * Start the health monitor (records start time for grace period)
   */
  start(): void {
    this.startTime = Date.now();
    this.logger.info('Health monitor started', {
      gracePeriodMs: this.config.startupGracePeriodMs,
    });
  }

  /**
   * Get current degradation level
   */
  getDegradationLevel(): DegradationLevel {
    return this.degradationLevel;
  }

  /**
   * Check if we're in the startup grace period
   */
  isInGracePeriod(): boolean {
    return (Date.now() - this.startTime) < this.config.startupGracePeriodMs;
  }

  /**
   * Evaluate and update degradation level based on service health.
   * Single-pass evaluation for O(n) performance.
   *
   * @param serviceHealth - Map of service name to health status
   * @param systemHealth - Current system health percentage (0-100)
   */
  evaluateDegradationLevel(
    serviceHealth: Map<string, ServiceHealth>,
    systemHealth: number
  ): void {
    // Purge ancient heartbeat entries (>5 minutes) from previous runs
    const now = Date.now();
    for (const [name, health] of serviceHealth) {
      if (health.lastHeartbeat && (now - health.lastHeartbeat) > 300_000) {
        serviceHealth.delete(name);
        this.logger.info('Purged ancient heartbeat entry', { service: name, ageMs: now - health.lastHeartbeat });
      }
    }

    // OP-13 FIX: Detect stale heartbeats before evaluating degradation
    const staleCount = this.detectStaleServices(serviceHealth);

    // Hysteresis: require consecutive stale detections before downgrading
    if (staleCount > 0) {
      this.consecutiveStaleCount++;
      if (this.consecutiveStaleCount < this.config.consecutiveFailuresThreshold) {
        this.logger.debug('Stale services detected but below hysteresis threshold', {
          staleCount,
          consecutiveStaleCount: this.consecutiveStaleCount,
          threshold: this.config.consecutiveFailuresThreshold,
        });
        return;
      }
    } else {
      this.consecutiveStaleCount = 0;
    }

    const previousLevel = this.degradationLevel;

    // Single-pass analysis of all services
    const analysis = this.analyzeServiceHealth(serviceHealth);

    // Determine degradation level based on analysis
    if (!analysis.hasAnyServices || systemHealth === 0) {
      // C4 FIX: During grace period, suppress COMPLETE_OUTAGE — services may still be starting
      this.degradationLevel = this.isInGracePeriod()
        ? DegradationLevel.READ_ONLY
        : DegradationLevel.COMPLETE_OUTAGE;
    } else if (!analysis.executorHealthy && !analysis.hasHealthyDetectors) {
      this.degradationLevel = DegradationLevel.READ_ONLY;
    } else if (!analysis.executorHealthy) {
      this.degradationLevel = DegradationLevel.DETECTION_ONLY;
    } else if (!analysis.allDetectorsHealthy) {
      this.degradationLevel = DegradationLevel.REDUCED_CHAINS;
    } else {
      this.degradationLevel = DegradationLevel.FULL_OPERATION;
    }

    // Log degradation level changes
    if (previousLevel !== this.degradationLevel) {
      this.logger.warn('Degradation level changed', {
        previous: DegradationLevel[previousLevel],
        current: DegradationLevel[this.degradationLevel],
        systemHealth,
        analysis,
      });
    }
  }

  /**
   * Single-pass analysis of service health.
   * Determines executor and detector health in one iteration.
   *
   * @param serviceHealth - Map of service name to health status
   * @returns Analysis result with all degradation-relevant flags
   */
  analyzeServiceHealth(serviceHealth: Map<string, ServiceHealth>): ServiceHealthAnalysis {
    const result: ServiceHealthAnalysis = {
      hasAnyServices: serviceHealth.size > 0,
      executorHealthy: false,
      hasHealthyDetectors: false,
      allDetectorsHealthy: true, // Assume true, set false if unhealthy detector found
      detectorCount: 0,
      healthyDetectorCount: 0,
    };

    const { executionEngine, detectorPattern } = this.config.servicePatterns;

    // Single pass over all services
    for (const [name, health] of serviceHealth) {
      const isHealthy = health.status === 'healthy';

      // Check execution engine using configurable pattern
      if (name === executionEngine) {
        result.executorHealthy = isHealthy;
        continue;
      }

      // Check detectors using configurable pattern (contains pattern string)
      if (name.includes(detectorPattern)) {
        result.detectorCount++;
        if (isHealthy) {
          result.healthyDetectorCount++;
          result.hasHealthyDetectors = true;
        } else {
          result.allDetectorsHealthy = false;
        }
      }
    }

    // No detectors means allDetectorsHealthy should be false
    if (result.detectorCount === 0) {
      result.allDetectorsHealthy = false;
    }

    return result;
  }

  /**
   * OP-13 FIX: Detect services with stale heartbeats and mark them unhealthy.
   *
   * If a service crashes silently, its last 'healthy' status is retained forever
   * because lastHeartbeat is never compared to current time. This method checks
   * all services and marks those with stale heartbeats as 'unhealthy'.
   *
   * @param serviceHealth - Map of service name to health status (mutated in place)
   */
  detectStaleServices(serviceHealth: Map<string, ServiceHealth>): number {
    const now = Date.now();
    const threshold = this.config.staleHeartbeatThresholdMs;
    let staleCount = 0;
    const currentlyStale = new Set<string>();

    for (const [name, health] of serviceHealth) {
      if (health.status === 'healthy' && health.lastHeartbeat) {
        const age = now - health.lastHeartbeat;
        if (age > threshold) {
          // C4 FIX: During grace period, skip services that never sent a real heartbeat
          if (this.isInGracePeriod() && !this.firstHeartbeatReceived.has(name)) {
            this.logger.debug('Skipping stale check for never-heartbeated service during grace period', {
              service: name,
            });
            continue;
          }

          health.status = 'unhealthy';
          staleCount++;
          currentlyStale.add(name);

          // H1 FIX: Escalation-based logging to reduce noise
          const state = this.staleLogState.get(name);
          if (!state) {
            // First detection: log WARN with full details
            this.staleLogState.set(name, { firstLoggedAt: now, lastEscalationAge: 0 });
            // FIX #3: Include service name in message text for discoverability
            this.logger.warn(`Service ${name} heartbeat stale, marking unhealthy`, {
              service: name,
              lastHeartbeat: health.lastHeartbeat,
              ageMs: age,
              thresholdMs: threshold,
            });
          } else {
            // Subsequent detections: only WARN at escalation thresholds (60s, 120s, 300s)
            const staleDuration = now - state.firstLoggedAt;
            const escalationThresholds = [60_000, 120_000, 300_000];
            const nextThreshold = escalationThresholds.find(
              t => t > state.lastEscalationAge && staleDuration >= t
            );

            if (nextThreshold) {
              state.lastEscalationAge = nextThreshold;
              this.logger.warn('Service heartbeat still stale (escalation)', {
                service: name,
                staleDurationMs: staleDuration,
                ageMs: age,
                thresholdMs: threshold,
              });
            } else {
              this.logger.debug('Service heartbeat still stale', {
                service: name,
                staleDurationMs: staleDuration,
                ageMs: age,
              });
            }
          }
        }
      }
    }

    // H1 FIX: Clean up stale log state for recovered services
    for (const name of this.staleLogState.keys()) {
      if (!currentlyStale.has(name)) {
        this.staleLogState.delete(name);
        this.logger.debug('Service recovered from stale heartbeat', { service: name });
      }
    }

    return staleCount;
  }

  /**
   * Check for alerts and trigger notifications.
   * Respects startup grace period to avoid false alerts during initialization.
   *
   * @param serviceHealth - Map of service name to health status
   * @param systemHealth - Current system health percentage
   */
  checkForAlerts(
    serviceHealth: Map<string, ServiceHealth>,
    systemHealth: number
  ): void {
    const alerts: Alert[] = [];
    const now = Date.now();
    const inGracePeriod = this.isInGracePeriod();

    // Check service health
    // During grace period, don't alert about individual service health
    // Services are still starting up and may not have reported healthy yet
    if (!inGracePeriod) {
      for (const [serviceName, health] of serviceHealth) {
        // Skip 'starting' and 'stopping' status - these are transient states
        if (health.status !== 'healthy' && health.status !== 'starting' && health.status !== 'stopping') {
          alerts.push({
            type: 'SERVICE_UNHEALTHY',
            service: serviceName,
            message: `${serviceName} is ${health.status}`,
            severity: 'high',
            timestamp: now,
          });
        }
      }
    }

    // Check system metrics
    // During grace period, require minimum services before alerting
    // This prevents false alerts when only 1-2 services have reported
    const shouldAlertLowHealth = inGracePeriod
      ? serviceHealth.size >= this.config.minServicesForGracePeriodAlert && systemHealth < 80
      : systemHealth < 80;

    if (shouldAlertLowHealth) {
      alerts.push({
        type: 'SYSTEM_HEALTH_LOW',
        message: `System health is ${systemHealth.toFixed(1)}%`,
        severity: 'critical',
        timestamp: now,
      });
    }

    // Send alerts (with cooldown)
    for (const alert of alerts) {
      this.sendAlertWithCooldown(alert);
    }
  }

  /**
   * Send an alert to the coordinator for cooldown-managed delivery.
   *
   * P0 FIX #1: Removed local cooldown check to fix double-cooldown bug.
   * Previously, this method set cooldown in HealthMonitor's own Map, then
   * called onAlert → coordinator.sendAlert() → AlertCooldownManager, which
   * delegates back to HealthMonitor.getAlertCooldowns() and found the cooldown
   * just set 0ms ago, silently dropping ALL alerts from HealthMonitor.
   *
   * Cooldown management is now solely handled by AlertCooldownManager in
   * coordinator.sendAlert(). HealthMonitor raises alerts; the coordinator
   * decides whether to send them based on cooldown state.
   *
   * @param alert - Alert to send
   */
  sendAlertWithCooldown(alert: Alert): void {
    // OP-35 FIX: Wrap in try-catch to prevent one failed alert from breaking iteration loop
    try {
      this.onAlert(alert);
    } catch (error) {
      this.logger.error('Failed to send alert via callback', {
        alertType: alert.type,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Clean up stale alert cooldown entries.
   *
   * @param now - Current timestamp
   */
  cleanupAlertCooldowns(now: number): void {
    // P2-005 FIX: Use configurable max age for cleanup
    const maxAge = this.config.cooldownMaxAgeMs;
    const toDelete: string[] = [];

    for (const [key, timestamp] of this.alertCooldowns) {
      if (now - timestamp > maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.alertCooldowns.delete(key);
    }

    if (toDelete.length > 0) {
      this.logger.debug('Cleaned up stale alert cooldowns', {
        removed: toDelete.length,
        remaining: this.alertCooldowns.size,
      });
    }
  }

  /**
   * Update system metrics in a single pass.
   * Optimizes the multi-iteration approach in the original coordinator.
   *
   * @param serviceHealth - Map of service name to health status
   * @param metrics - Metrics object to update (mutated in place)
   */
  updateMetrics(
    serviceHealth: Map<string, ServiceHealth>,
    metrics: SystemMetrics
  ): void {
    const now = Date.now();
    let activeServices = 0;
    let totalMemory = 0;
    let totalLatency = 0;

    for (const health of serviceHealth.values()) {
      // Count healthy services
      if (health.status === 'healthy') {
        activeServices++;
      }
      // Sum memory usage
      // P1 FIX #5: Use ?? to preserve legitimate 0 values
      totalMemory += health.memoryUsage ?? 0;
      // Calculate latency - use explicit if available, else from heartbeat
      const latency = health.latency ?? (health.lastHeartbeat ? now - health.lastHeartbeat : 0);
      totalLatency += latency;
    }

    const totalServices = Math.max(serviceHealth.size, 1);
    const systemHealth = (activeServices / totalServices) * 100;
    const avgMemory = totalMemory / totalServices;
    const avgLatency = totalLatency / totalServices;

    metrics.activeServices = activeServices;
    metrics.systemHealth = systemHealth;
    metrics.averageLatency = avgLatency;
    metrics.averageMemory = avgMemory;
    metrics.lastUpdate = now;
  }

  /**
   * C4 FIX: Record that a service has sent a real heartbeat.
   * Used to distinguish "never heartbeated" (STARTING) from "heartbeat went stale" (FAILED).
   *
   * @param serviceName - Name of the service that sent a heartbeat
   */
  recordHeartbeat(serviceName: string): void {
    this.firstHeartbeatReceived.add(serviceName);
  }

  /**
   * Check if a service has ever sent a heartbeat
   */
  hasReceivedHeartbeat(serviceName: string): boolean {
    return this.firstHeartbeatReceived.has(serviceName);
  }

  /**
   * Get alert cooldowns map (for testing/monitoring)
   */
  getAlertCooldowns(): Map<string, number> {
    return new Map(this.alertCooldowns);
  }

  /**
   * Get a single alert cooldown timestamp by key (avoids Map copy)
   */
  getAlertCooldown(key: string): number | undefined {
    return this.alertCooldowns.get(key);
  }

  /**
   * Get the number of active alert cooldowns (avoids Map copy)
   */
  getAlertCooldownCount(): number {
    return this.alertCooldowns.size;
  }

  /**
   * Delete an alert cooldown entry
   */
  deleteAlertCooldown(key: string): boolean {
    return this.alertCooldowns.delete(key);
  }

  /**
   * Set an alert cooldown entry (R12 consolidation - replaces unsafe private access)
   * @param key - Alert key in format `${type}_${service}`
   * @param timestamp - Timestamp of the alert
   */
  setAlertCooldown(key: string, timestamp: number): void {
    this.alertCooldowns.set(key, timestamp);
  }

  /**
   * Reset all state (for testing)
   */
  reset(): void {
    this.degradationLevel = DegradationLevel.FULL_OPERATION;
    this.startTime = 0;
    this.alertCooldowns.clear();
    this.consecutiveStaleCount = 0;
    this.staleLogState.clear();
    this.firstHeartbeatReceived.clear();
  }
}

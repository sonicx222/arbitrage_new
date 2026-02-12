/**
 * Alert Cooldown Manager
 *
 * Manages alert cooldowns to prevent alert spam. Supports dual-storage
 * pattern where cooldowns can be delegated to HealthMonitor when available.
 *
 * @see R2 - Coordinator Subsystems extraction
 */

/**
 * Logger interface for dependency injection
 */
export interface CooldownManagerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Interface for HealthMonitor cooldown delegation
 * This allows the manager to delegate to HealthMonitor when available
 */
export interface CooldownDelegate {
  getAlertCooldowns(): Map<string, number>;
  setAlertCooldown(key: string, timestamp: number): void;
  cleanupAlertCooldowns(now: number): void;
}

/**
 * Configuration for AlertCooldownManager
 */
export interface AlertCooldownManagerConfig {
  /** Cooldown duration in milliseconds (default: 300000 = 5 minutes) */
  cooldownMs?: number;
  /** Max age before cleanup in milliseconds (default: 3600000 = 1 hour) */
  maxAgeMs?: number;
  /** Size threshold to trigger automatic cleanup (default: 1000) */
  cleanupThreshold?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<AlertCooldownManagerConfig> = {
  cooldownMs: 300000,    // 5 minutes
  maxAgeMs: 3600000,     // 1 hour
  cleanupThreshold: 1000,
};

/**
 * Alert Cooldown Manager
 *
 * Manages alert cooldowns with support for delegation to HealthMonitor.
 * When a delegate is provided, uses the delegate's storage. Otherwise,
 * manages its own local Map.
 */
export class AlertCooldownManager {
  private localCooldowns: Map<string, number> = new Map();
  private readonly config: Required<AlertCooldownManagerConfig>;

  constructor(
    private readonly logger?: CooldownManagerLogger,
    private readonly delegate?: CooldownDelegate,
    config?: AlertCooldownManagerConfig
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Generate a cooldown key from alert type and service
   */
  static createKey(alertType: string, service?: string): string {
    return `${alertType}_${service || 'system'}`;
  }

  /**
   * Check if an alert is currently on cooldown
   *
   * @param key - Alert key (use createKey to generate)
   * @param now - Current timestamp (defaults to Date.now())
   * @returns true if alert is on cooldown and should be suppressed
   */
  isOnCooldown(key: string, now: number = Date.now()): boolean {
    const cooldowns = this.getCooldowns();
    const lastAlert = cooldowns.get(key);
    // If no record exists, not on cooldown
    if (lastAlert === undefined) {
      return false;
    }
    return (now - lastAlert) <= this.config.cooldownMs;
  }

  /**
   * Record that an alert was sent (starts the cooldown)
   *
   * @param key - Alert key (use createKey to generate)
   * @param now - Current timestamp (defaults to Date.now())
   */
  recordAlert(key: string, now: number = Date.now()): void {
    if (this.delegate) {
      this.delegate.setAlertCooldown(key, now);
    } else {
      this.localCooldowns.set(key, now);
    }

    // Automatic cleanup when threshold exceeded
    if (this.getCooldowns().size > this.config.cleanupThreshold) {
      this.cleanup(now);
    }
  }

  /**
   * Check if alert should be sent (not on cooldown) and record it if so
   *
   * @param key - Alert key (use createKey to generate)
   * @param now - Current timestamp (defaults to Date.now())
   * @returns true if alert should be sent (not on cooldown)
   */
  shouldSendAndRecord(key: string, now: number = Date.now()): boolean {
    if (this.isOnCooldown(key, now)) {
      return false;
    }
    this.recordAlert(key, now);
    return true;
  }

  /**
   * Clean up stale cooldown entries
   *
   * @param now - Current timestamp (defaults to Date.now())
   */
  cleanup(now: number = Date.now()): void {
    if (this.delegate) {
      this.delegate.cleanupAlertCooldowns(now);
      return;
    }

    const toDelete: string[] = [];

    for (const [key, timestamp] of this.localCooldowns) {
      if (now - timestamp > this.config.maxAgeMs) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.localCooldowns.delete(key);
    }

    if (toDelete.length > 0 && this.logger) {
      this.logger.debug('Cleaned up stale alert cooldowns', {
        removed: toDelete.length,
        remaining: this.localCooldowns.size,
      });
    }
  }

  /**
   * Get the cooldowns map (for monitoring/testing)
   */
  getCooldowns(): Map<string, number> {
    if (this.delegate) {
      return this.delegate.getAlertCooldowns();
    }
    return this.localCooldowns;
  }

  /**
   * Get the current size of the cooldowns map
   */
  get size(): number {
    return this.getCooldowns().size;
  }

  /**
   * Get the configured cooldown duration in milliseconds
   */
  get cooldownMs(): number {
    return this.config.cooldownMs;
  }

  /**
   * Clear all cooldowns (mainly for testing)
   */
  clear(): void {
    if (!this.delegate) {
      this.localCooldowns.clear();
    } else {
      // Delegate mode: cooldowns are managed by HealthMonitor, clear is a no-op
      this.logger?.debug('clear() called in delegate mode - cooldowns are managed by HealthMonitor', {
        delegateSize: this.delegate.getAlertCooldowns().size,
      });
    }
  }
}

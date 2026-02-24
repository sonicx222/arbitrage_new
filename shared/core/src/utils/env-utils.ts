/**
 * Shared Environment Variable Parsing Utilities
 *
 * Consolidates duplicated env parsing functions across services.
 * Used by coordinator, execution-engine, and other services that
 * need validated environment variable parsing.
 *
 * Design notes:
 * - Uses `??` (nullish coalescing) not `||` for numeric values that can be 0
 * - parseEnvInt throws on invalid/out-of-range (strict, for service startup)
 * - parseEnvIntSafe warns and returns default (lenient, for config modules)
 * - parseEnvBool returns boolean with sensible defaults
 *
 * @see S-6: Consolidate Env Parsing Functions
 */

import { createLogger } from '../logger';

const logger = createLogger('env-utils');

// =============================================================================
// Strict Parsing (throws on invalid -- use at service startup)
// =============================================================================

/**
 * Parse and validate an integer environment variable (strict mode).
 *
 * Throws a descriptive error if the value is not a valid integer or is
 * out of the specified range. Returns defaultValue if the env var is not set.
 *
 * Use this for service startup where misconfigurations should fail fast.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param min - Minimum valid value (inclusive). Optional.
 * @param max - Maximum valid value (inclusive). Optional.
 * @returns Parsed integer value
 * @throws Error if value is not a valid integer or out of range
 *
 * @example
 * ```typescript
 * const port = parseEnvInt('PORT', 3000, 1, 65535);
 * const ttl = parseEnvInt('LOCK_TTL_MS', 30000, 5000, 300000);
 * ```
 */
export function parseEnvInt(
  name: string,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a valid integer`);
  }
  if (min !== undefined && max !== undefined) {
    if (parsed < min || parsed > max) {
      throw new Error(`Invalid ${name}: ${parsed} is out of range [${min}, ${max}]`);
    }
  } else if (min !== undefined && parsed < min) {
    throw new Error(`Invalid ${name}: ${parsed} is below minimum ${min}`);
  } else if (max !== undefined && parsed > max) {
    throw new Error(`Invalid ${name}: ${parsed} is above maximum ${max}`);
  }
  return parsed;
}

// =============================================================================
// Safe Parsing (warns and returns default -- use for config modules)
// =============================================================================

/**
 * Parse and validate an integer environment variable (safe mode).
 *
 * Returns defaultValue if the env var is not set or not a valid integer.
 * Returns min if the value is below the minimum. Logs a warning for
 * invalid values instead of throwing.
 *
 * Use this for config modules where a reasonable default is acceptable.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set or invalid
 * @param min - Minimum valid value (inclusive). Values below this return min.
 * @returns Parsed integer value
 *
 * @example
 * ```typescript
 * const samples = parseEnvIntSafe('RISK_MIN_SAMPLES', 10, 1);
 * ```
 */
export function parseEnvIntSafe(
  name: string,
  defaultValue: number,
  min = 0
): number {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    logger.warn(`[ENV] Invalid integer value for ${name}: "${raw}" - using default ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min) {
    logger.warn(`[ENV] Value for ${name} (${parsed}) below minimum ${min} - using minimum`);
    return min;
  }
  return parsed;
}

/**
 * Parse a boolean environment variable.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @returns Parsed boolean value
 *
 * @example
 * ```typescript
 * const isStandby = parseEnvBool('IS_STANDBY', false);
 * const canLead = parseEnvBool('CAN_BECOME_LEADER', true);
 * ```
 */
export function parseEnvBool(
  name: string,
  defaultValue: boolean
): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;

  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;

  return defaultValue;
}

// =============================================================================
// Standby Configuration (shared between coordinator and execution-engine)
// =============================================================================

/**
 * Common cross-region health fields shared by coordinator and execution-engine.
 * Each service extends this with its own specific fields.
 */
export interface CrossRegionEnvConfig {
  regionId: string;
  serviceName: string;
  healthCheckIntervalMs: number;
  failoverThreshold: number;
  failoverTimeoutMs: number;
  leaderHeartbeatIntervalMs: number;
  leaderLockTtlMs: number;
}

/**
 * Parse the common cross-region health configuration from environment variables.
 *
 * Both the coordinator and execution-engine services need these values for
 * cross-region failover (ADR-007). Service-specific fields (like leader election
 * keys or queue pause settings) should be parsed in the service's own config.
 *
 * @param defaultServiceName - Default service name if SERVICE_NAME is not set
 * @returns Common cross-region health configuration
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */
export function getCrossRegionEnvConfig(
  defaultServiceName: string
): CrossRegionEnvConfig {
  return {
    regionId: process.env.REGION_ID || 'us-east1',
    serviceName: process.env.SERVICE_NAME || defaultServiceName,
    healthCheckIntervalMs: parseEnvInt('HEALTH_CHECK_INTERVAL_MS', 10000, 1000, 60000),
    failoverThreshold: parseEnvInt('FAILOVER_THRESHOLD', 3, 1, 10),
    failoverTimeoutMs: parseEnvInt('FAILOVER_TIMEOUT_MS', 60000, 10000, 300000),
    leaderHeartbeatIntervalMs: parseEnvInt('LEADER_HEARTBEAT_INTERVAL_MS', 10000, 1000, 60000),
    leaderLockTtlMs: parseEnvInt('LEADER_LOCK_TTL_MS', 30000, 5000, 300000),
  };
}

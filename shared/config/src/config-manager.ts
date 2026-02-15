/**
 * ConfigManager for Environment Validation
 *
 * Provides centralized configuration validation with fail-fast behavior.
 * Services should call validateOrThrow() at startup to catch misconfigurations early.
 *
 * Features:
 * - Required and optional validation rules
 * - Conditional requirements (e.g., SOLANA_RPC_URL only for solana partition)
 * - Custom validation functions
 * - Warnings for optional but recommended configs
 *
 * @see Task 2.1: ConfigManager for Environment Validation
 * @see ADR-003: Partitioned Chain Detectors
 */

// FIX: Import from partition-ids.ts to avoid duplicate definitions
import { PARTITION_IDS, PartitionId } from './partition-ids';

// =============================================================================
// Types
// =============================================================================

/**
 * Validation rule for an environment variable.
 */
export interface ValidationRule {
  /**
   * Whether the variable is required.
   * Can be a boolean or a function that returns boolean based on other env vars.
   */
  required: boolean | ((env: NodeJS.ProcessEnv) => boolean);

  /**
   * Optional validation function.
   * Returns true if the value is valid.
   */
  validate?: (value: string) => boolean;

  /**
   * Error message shown when validation fails.
   */
  errorMessage: string;

  /**
   * Warning message shown when optional variable is not set.
   */
  warnMessage?: string;
}

/**
 * Result of configuration validation.
 */
export interface ValidationResult {
  /** Whether all required validations passed */
  valid: boolean;

  /** Array of error messages */
  errors: string[];

  /** Array of warning messages */
  warnings: string[];
}

// =============================================================================
// Valid Partition IDs (derived from partition-ids.ts - single source of truth)
// =============================================================================

/**
 * Valid partition IDs from ADR-003.
 * FIX: Derived from PARTITION_IDS to prevent duplicate definitions.
 */
const VALID_PARTITION_IDS = Object.values(PARTITION_IDS) as readonly PartitionId[];

// =============================================================================
// ConfigManager Implementation
// =============================================================================

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private rules = new Map<string, ValidationRule>();

  private constructor() {
    this.registerDefaultRules();
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   * FIX: Also clear rules from existing instance to prevent stale rules
   * if a reference to the old instance is held elsewhere.
   */
  static resetInstance(): void {
    if (ConfigManager.instance) {
      // Clear rules from existing instance before nullifying
      // This is defensive - helps if old instance reference is held elsewhere
      ConfigManager.instance.rules.clear();
    }
    ConfigManager.instance = null;
  }

  // ===========================================================================
  // Default Rules
  // ===========================================================================

  /**
   * Register default validation rules for common configuration variables.
   */
  private registerDefaultRules(): void {
    // REDIS_URL - Required unless REDIS_PORT is set (local dev fallback)
    // FIX: Accept either REDIS_URL or REDIS_PORT for flexibility
    // service-config.ts falls back to redis://localhost:6379 when REDIS_URL is not set
    this.rules.set('REDIS_URL', {
      required: (env) => !env.REDIS_PORT, // Not required if REDIS_PORT is set
      validate: (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
      errorMessage: 'REDIS_URL must start with redis:// or rediss://',
      warnMessage: 'REDIS_URL is not set, will use redis://localhost:${REDIS_PORT:-6379}'
    });

    // PARTITION_ID - Required for detector services
    this.rules.set('PARTITION_ID', {
      required: (env) => env.SERVICE_TYPE === 'detector',
      validate: (v) => VALID_PARTITION_IDS.includes(v as PartitionId),
      errorMessage: `PARTITION_ID must be one of: ${VALID_PARTITION_IDS.join(', ')}`
    });

    // SOLANA_RPC_URL - Required for solana-native partition
    // FIX: Use imported constant instead of hardcoded string
    this.rules.set('SOLANA_RPC_URL', {
      required: (env) => env.PARTITION_ID === PARTITION_IDS.SOLANA_NATIVE,
      validate: (v) => v.startsWith('https://') || v.startsWith('wss://'),
      errorMessage: 'SOLANA_RPC_URL required for solana-native partition (must start with https:// or wss://)'
    });

    // NODE_ENV - Optional but recommended
    this.rules.set('NODE_ENV', {
      required: false,
      validate: (v) => ['development', 'production', 'test'].includes(v),
      errorMessage: 'NODE_ENV must be development, production, or test',
      warnMessage: 'NODE_ENV is not set, defaulting to development'
    });

    // LOG_LEVEL - Optional
    this.rules.set('LOG_LEVEL', {
      required: false,
      validate: (v) => ['debug', 'info', 'warn', 'error'].includes(v),
      errorMessage: 'LOG_LEVEL must be debug, info, warn, or error',
      warnMessage: 'LOG_LEVEL is not set, defaulting to info'
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Add a custom validation rule.
   *
   * @param key - Environment variable name
   * @param rule - Validation rule
   */
  addRule(key: string, rule: ValidationRule): void {
    this.rules.set(key, rule);
  }

  /**
   * Remove a validation rule.
   *
   * @param key - Environment variable name
   */
  removeRule(key: string): void {
    this.rules.delete(key);
  }

  /**
   * Validate all configuration rules.
   *
   * @returns ValidationResult with valid flag, errors, and warnings
   */
  validate(): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [key, rule] of this.rules) {
      const value = process.env[key];
      const isRequired = typeof rule.required === 'function'
        ? rule.required(process.env)
        : rule.required;

      // Check if required variable is missing
      if (isRequired && !value) {
        errors.push(`${key}: ${rule.errorMessage}`);
        continue;
      }

      // Validate value if present and validator exists
      if (value && rule.validate && !rule.validate(value)) {
        errors.push(`${key}: ${rule.errorMessage}`);
      }

      // Collect warnings for optional missing vars
      if (!value && rule.warnMessage) {
        warnings.push(`${key}: ${rule.warnMessage}`);
      }
    }

    // STRICT_CONFIG_VALIDATION Handling
    // If strict validation is explicitly disabled, accept missing configuration
    // FIX #10: In production, NEVER allow relaxed mode — misconfiguration is too dangerous
    const strictEnv = process.env.STRICT_CONFIG_VALIDATION;
    const forceStrict = strictEnv === 'true' || strictEnv === '1';
    const forceRelaxed = strictEnv === 'false' || strictEnv === '0';
    const isProduction = process.env.NODE_ENV === 'production'
      || !!process.env.FLY_APP_NAME
      || !!process.env.RAILWAY_ENVIRONMENT
      || !!process.env.RENDER_SERVICE_NAME
      || !!process.env.KOYEB_SERVICE_NAME;

    // Logic: If errors exist and relaxed mode is ON, move errors to warnings —
    // BUT only in non-production environments. Production always enforces strict.
    if (errors.length > 0 && forceRelaxed && !isProduction) {
      warnings.push(...errors.map(e => `[RELAXED] ${e}`));
      // Clear errors to pass validation
      errors.length = 0;
    } else if (errors.length > 0 && forceRelaxed && isProduction) {
      warnings.push('[IGNORED] STRICT_CONFIG_VALIDATION=false is not allowed in production');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate configuration and throw if invalid.
   * Use this at service startup for fail-fast behavior.
   *
   * @throws Error if configuration validation fails
   */
  validateOrThrow(): void {
    const result = this.validate();

    // Log warnings (even if valid)
    if (result.warnings.length > 0) {
      console.warn('\u26A0\uFE0F Configuration warnings:');
      result.warnings.forEach(w => console.warn(`  - ${w}`));
    }

    // Throw if invalid
    if (!result.valid) {
      console.error('\u274C Configuration errors:');
      result.errors.forEach(e => console.error(`  - ${e}`));
      throw new Error('Configuration validation failed');
    }
  }

  /**
   * Get an environment variable with optional default.
   *
   * @param key - Environment variable name
   * @param defaultValue - Default value if not set
   * @returns The environment variable value or default
   */
  getEnv(key: string, defaultValue?: string): string | undefined {
    return process.env[key] ?? defaultValue;
  }

  /**
   * Get all registered rule keys.
   */
  getRuleKeys(): string[] {
    return Array.from(this.rules.keys());
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Pre-configured singleton instance.
 */
export const configManager = ConfigManager.getInstance();

/**
 * Reset function for testing.
 */
export function resetConfigManager(): void {
  ConfigManager.resetInstance();
}

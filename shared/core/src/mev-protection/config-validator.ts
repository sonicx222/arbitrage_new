/**
 * MEV Config Synchronization Validator
 *
 * Validates that MEV_RISK_DEFAULTS stays synchronized with external
 * configuration sources (e.g., MEV_CONFIG from @arbitrage/config).
 *
 * @module mev-protection/config-validator
 * @see mev-risk-analyzer.types.ts for MEV_RISK_DEFAULTS
 */

import { MEV_RISK_DEFAULTS } from './mev-risk-analyzer.types';

// =============================================================================
// Types
// =============================================================================

/**
 * Validation result for config synchronization
 */
export interface ConfigSyncValidationResult {
  /** Whether configs are synchronized */
  valid: boolean;
  /** List of mismatches found */
  mismatches: ConfigMismatch[];
}

/**
 * Details of a config mismatch
 */
export interface ConfigMismatch {
  chain: string;
  field: string;
  riskAnalyzerValue: number | string;
  externalConfigValue?: number | string;
  message: string;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate that MEV_RISK_DEFAULTS is synchronized with external config
 *
 * This function should be called during application startup or in tests
 * to ensure configuration consistency.
 *
 * @param externalChainConfig - Chain configuration from MEV_CONFIG or similar
 * @returns Validation result with any mismatches found
 *
 * @example
 * ```typescript
 * import { validateConfigSync } from './config-validator';
 * import { MEV_CONFIG } from '@arbitrage/config';
 *
 * // Convert MEV_CONFIG to the expected format
 * const chainConfigs = Object.entries(MEV_CONFIG.chainSettings).map(([chain, settings]) => ({
 *   chain,
 *   priorityFeeGwei: settings.priorityFeeGwei,
 * }));
 *
 * const result = validateConfigSync(chainConfigs);
 * if (!result.valid) {
 *   console.warn('Config mismatch detected:', result.mismatches);
 * }
 * ```
 */
export function validateConfigSync(
  externalChainConfig: Array<{ chain: string; priorityFeeGwei: number }>
): ConfigSyncValidationResult {
  const mismatches: ConfigMismatch[] = [];

  for (const { chain, priorityFeeGwei } of externalChainConfig) {
    const localValue = MEV_RISK_DEFAULTS.chainBasePriorityFees[chain];

    // Skip if chain is not in local config (external config may have more chains)
    if (localValue === undefined) {
      continue;
    }

    // Check for mismatch (allow small floating point differences)
    if (Math.abs(localValue - priorityFeeGwei) > 0.001) {
      mismatches.push({
        chain,
        field: 'priorityFeeGwei',
        riskAnalyzerValue: localValue,
        externalConfigValue: priorityFeeGwei,
        message: `Chain "${chain}": MEV_RISK_DEFAULTS.chainBasePriorityFees[${chain}] = ${localValue}, but external config has ${priorityFeeGwei}`,
      });
    }
  }

  // Also check for chains in local config that aren't in external config
  const externalChainSet = new Set(externalChainConfig.map((c) => c.chain));
  for (const chain of Object.keys(MEV_RISK_DEFAULTS.chainBasePriorityFees)) {
    if (!externalChainSet.has(chain)) {
      mismatches.push({
        chain,
        field: 'chain',
        riskAnalyzerValue: MEV_RISK_DEFAULTS.chainBasePriorityFees[chain],
        message: `Chain "${chain}" is in MEV_RISK_DEFAULTS but not in external config`,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Get all chains with their local priority fee defaults
 *
 * Useful for debugging or displaying config state.
 */
export function getLocalChainPriorityFees(): Record<string, number> {
  return { ...MEV_RISK_DEFAULTS.chainBasePriorityFees };
}

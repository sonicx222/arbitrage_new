#!/usr/bin/env tsx
/**
 * MEV Configuration Validation Script
 *
 * Validates MEV protection setup for all configured chains.
 * Run before deployment to catch configuration issues early.
 *
 * Usage:
 *   npm run validate:mev-setup
 *
 * Exit Codes:
 *   0 - All configurations valid
 *   1 - Configuration errors found
 *
 * @see Task 1.3: BloXroute & Fastlane Activation
 */

import './lib/load-env';
import { MEV_CONFIG } from '../shared/config/src/mev-config';
import { CHAIN_MEV_STRATEGIES } from '../shared/core/src/mev-protection/types';

interface ValidationResult {
  chain: string;
  strategy: string;
  enabled: boolean;
  configured: boolean;
  issues: string[];
  warnings: string[];
}

/**
 * Validate MEV configuration for all chains
 */
function validateMevSetup(): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const [chain, chainSettings] of Object.entries(MEV_CONFIG.chainSettings)) {
    const strategy = CHAIN_MEV_STRATEGIES[chain] || 'standard';
    const issues: string[] = [];
    const warnings: string[] = [];

    // Skip if chain is explicitly disabled
    if (!chainSettings.enabled) {
      results.push({
        chain,
        strategy,
        enabled: false,
        configured: false,
        issues: [],
        warnings: ['Chain is disabled in MEV_CONFIG'],
      });
      continue;
    }

    // Check global MEV protection toggle
    if (!MEV_CONFIG.enabled) {
      warnings.push('MEV_PROTECTION_ENABLED=false (global toggle disabled)');
    }

    // Check chain-specific requirements
    switch (strategy) {
      case 'flashbots':
        if (!MEV_CONFIG.flashbotsAuthKey) {
          issues.push('FLASHBOTS_AUTH_KEY not configured');
          issues.push('Generate one with: node -e "console.log(require(\'ethers\').Wallet.createRandom().privateKey)"');
        } else {
          // Validate format (should be 0x followed by 64 hex chars)
          if (!/^0x[0-9a-fA-F]{64}$/.test(MEV_CONFIG.flashbotsAuthKey)) {
            issues.push('FLASHBOTS_AUTH_KEY has invalid format (expected 0x + 64 hex chars)');
          }
        }

        if (!MEV_CONFIG.flashbotsRelayUrl) {
          issues.push('FLASHBOTS_RELAY_URL not configured');
        } else if (!MEV_CONFIG.flashbotsRelayUrl.startsWith('https://')) {
          warnings.push('FLASHBOTS_RELAY_URL should use HTTPS');
        }

        // Check MEV-Share configuration
        if (MEV_CONFIG.useMevShare && chain === 'ethereum') {
          // MEV-Share is enabled - good for value capture
        } else if (!MEV_CONFIG.useMevShare && chain === 'ethereum') {
          warnings.push('FEATURE_MEV_SHARE=false: Missing 50-90% rebate capture opportunity');
        }
        break;

      case 'bloxroute':
        if (!MEV_CONFIG.bloxrouteAuthHeader) {
          issues.push('BLOXROUTE_AUTH_HEADER not configured');
          issues.push('Sign up at https://bloxroute.com/ and get your auth header from the dashboard');
        }

        if (!MEV_CONFIG.bloxrouteUrl) {
          issues.push('BLOXROUTE_URL not configured');
        } else if (!MEV_CONFIG.bloxrouteUrl.startsWith('https://')) {
          warnings.push('BLOXROUTE_URL should use HTTPS');
        }
        break;

      case 'fastlane':
        if (!MEV_CONFIG.fastlaneUrl) {
          issues.push('FASTLANE_URL not configured');
        } else if (!MEV_CONFIG.fastlaneUrl.startsWith('https://')) {
          warnings.push('FASTLANE_URL should use HTTPS');
        }
        // Fastlane doesn't require auth - public endpoint
        break;

      case 'sequencer':
        // L2 sequencers don't require special configuration
        // Inherent MEV protection through sequencer ordering
        break;

      case 'jito':
        // Jito configuration handled in Solana-specific code
        // Not validated here (uses different connection types)
        warnings.push('Jito configuration not validated by this script (Solana-specific)');
        break;

      case 'standard':
        // Standard chains don't require MEV-specific configuration
        warnings.push('Using standard gas optimization (limited MEV protection)');
        break;
    }

    // Check fallback configuration
    if (MEV_CONFIG.fallbackToPublic === false && strategy !== 'sequencer') {
      warnings.push('MEV_FALLBACK_TO_PUBLIC=false: Transactions will fail if private submission fails');
    }

    // Check timeout settings
    if (MEV_CONFIG.submissionTimeoutMs < 10000) {
      warnings.push(`MEV_SUBMISSION_TIMEOUT_MS=${MEV_CONFIG.submissionTimeoutMs} is very low (< 10s)`);
    } else if (MEV_CONFIG.submissionTimeoutMs > 60000) {
      warnings.push(`MEV_SUBMISSION_TIMEOUT_MS=${MEV_CONFIG.submissionTimeoutMs} is very high (> 60s)`);
    }

    // Check retry settings
    if (MEV_CONFIG.maxRetries < 1) {
      warnings.push(`MEV_MAX_RETRIES=${MEV_CONFIG.maxRetries} is too low (minimum 1 recommended)`);
    } else if (MEV_CONFIG.maxRetries > 5) {
      warnings.push(`MEV_MAX_RETRIES=${MEV_CONFIG.maxRetries} is very high (> 5)`);
    }

    results.push({
      chain,
      strategy,
      enabled: chainSettings.enabled,
      configured: issues.length === 0,
      issues,
      warnings,
    });
  }

  return results;
}

/**
 * Print validation results to console
 */
function printResults(results: ValidationResult[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('MEV Protection Configuration Validation');
  console.log('='.repeat(70) + '\n');

  // Categorize results
  const configured = results.filter(r => r.configured && r.enabled);
  const disabled = results.filter(r => !r.enabled);
  const invalid = results.filter(r => r.enabled && !r.configured);
  const withWarnings = results.filter(r => r.configured && r.warnings.length > 0);

  // Print configured chains
  if (configured.length > 0) {
    console.log('\u2705 Properly Configured:\n');
    for (const result of configured) {
      console.log(`  - ${result.chain.padEnd(12)} | ${result.strategy.padEnd(12)} | MEV Protection Active`);
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`    \u26A0\uFE0F  ${warning}`);
        }
      }
    }
    console.log();
  }

  // Print disabled chains
  if (disabled.length > 0) {
    console.log('\u{1F6AB} Disabled Chains:\n');
    for (const result of disabled) {
      console.log(`  - ${result.chain.padEnd(12)} | ${result.strategy.padEnd(12)} | Disabled in config`);
    }
    console.log();
  }

  // Print configuration issues
  if (invalid.length > 0) {
    console.log('\u274C Configuration Issues:\n');
    for (const result of invalid) {
      console.log(`  - ${result.chain.padEnd(12)} | ${result.strategy.padEnd(12)}`);
      for (const issue of result.issues) {
        console.log(`      ${issue}`);
      }
      console.log();
    }
  }

  // Summary
  console.log('='.repeat(70));
  console.log(`Summary: ${configured.length} configured | ${disabled.length} disabled | ${invalid.length} invalid`);
  console.log('='.repeat(70));

  // Global warnings
  if (!MEV_CONFIG.enabled) {
    console.log('\n\u26A0\uFE0F  WARNING: MEV_PROTECTION_ENABLED=false');
    console.log('   MEV protection is disabled globally. All transactions use public mempool.');
    console.log('   Set MEV_PROTECTION_ENABLED=true in .env to enable protection.\n');
  }

  // Additional recommendations
  if (configured.length > 0 && !invalid.length) {
    console.log('\n\u2728 Recommendations:');
    console.log('   - Monitor metrics: mev_bloxroute_submissions_total, mev_fastlane_submissions_total');
    console.log('   - Check logs for MEV provider initialization on startup');
    console.log('   - Test on testnet before production deployment');
    console.log('   - Set up alerts for mev_fallback_submissions_total (high fallback rate)');
  }

  // Exit with error if any invalid configurations
  if (invalid.length > 0) {
    console.log('\n\u274C Validation failed. Fix configuration issues above.\n');
    process.exit(1);
  }

  console.log('\n\u2705 Validation passed!\n');
  process.exit(0);
}

/**
 * Main execution
 */
function main() {
  try {
    const results = validateMevSetup();
    printResults(results);
  } catch (error) {
    console.error('\n\u274C Error running validation script:');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nStack trace:');
    console.error(error instanceof Error ? error.stack : 'N/A');
    process.exit(1);
  }
}

// Run validation
main();

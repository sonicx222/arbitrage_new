#!/usr/bin/env node
/**
 * Pre-install Security Check
 *
 * Validates package installations against known malicious packages and typosquatting.
 * Run automatically via npm preinstall hook.
 */

const fs = require('fs');
const path = require('path');

const { logger, colors } = require('./lib/logger');

// Known malicious package names (add to this list as needed)
// Source: Various npm security advisories and security research
const MALICIOUS_PACKAGES = new Set([
  // Typosquatting of popular packages
  'crossenv',        // Typosquat of cross-env
  'cross-env.js',    // Typosquat of cross-env
  'crossenv.js',     // Typosquat of cross-env
  'lodahs',          // Typosquat of lodash
  'loadash',         // Typosquat of lodash
  'lodashs',         // Typosquat of lodash
  'babelcli',        // Typosquat of babel-cli
  'eslint-scope-util', // Malicious
  'event-stream',    // Known supply chain attack (version specific)
  'flatmap-stream',  // Supply chain attack payload
  'getcookies',      // Malicious
  'discord.js-user', // Discord token stealer
  'discordi.js',     // Discord token stealer
  'colors.js',       // Note: legit 'colors' was compromised, use chalk instead
  'faker.js',        // Note: legit 'faker' was sabotaged, use @faker-js/faker
  'ua-parser-js',    // Had compromised versions
  'coa',             // Had compromised versions
  'rc',              // Had compromised versions
  // Generic malicious patterns
  'steal-',          // Pattern: steal-*
  '-stealer',        // Pattern: *-stealer
  'keylogger',       // Pattern
  'cryptominer',     // Pattern
]);

// Suspicious patterns (regex checks)
const SUSPICIOUS_PATTERNS = [
  /^(steal|hack|crack|dump|grab)/i,
  /(stealer|grabber|keylogger|miner)$/i,
  /discord.*token/i,
  /crypto.*mine/i,
  /password.*dump/i,
];

// Expected packages (whitelist for this project)
// This helps detect if an attacker adds a malicious package
const EXPECTED_TOP_LEVEL = new Set([
  // Production dependencies
  'bcrypt', 'ethers', 'express-rate-limit', 'express-validator',
  'helmet', 'joi', 'jsonwebtoken', 'pino', 'pino-pretty', 'zod',
  // Dev dependencies
  '@pact-foundation/pact', '@stryker-mutator/core', '@stryker-mutator/jest-runner',
  '@stryker-mutator/typescript-checker', '@swc/core', '@swc/jest',
  '@types/jest', '@types/node', '@types/ws', '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser', 'concurrently', 'cross-env', 'dotenv',
  'eslint', 'fast-check', 'jest', 'lru-cache', 'redis-memory-server',
  'rimraf', 'supertest', 'ts-jest', 'ts-node', 'tsconfig-paths', 'tsx', 'typescript',
]);

function checkPackageJson() {
  const packageJsonPath = path.join(process.cwd(), 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return { success: true, warnings: [] };
  }

  const warnings = [];
  const blocked = [];

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };

    for (const depName of Object.keys(allDeps)) {
      // Check against known malicious packages
      if (MALICIOUS_PACKAGES.has(depName.toLowerCase())) {
        blocked.push(`BLOCKED: "${depName}" is a known malicious package`);
        continue;
      }

      // Check against suspicious patterns
      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(depName)) {
          blocked.push(`BLOCKED: "${depName}" matches suspicious pattern ${pattern}`);
          break;
        }
      }

      // Check for unexpected top-level packages (only warn)
      const baseName = depName.startsWith('@') ?
        depName : depName.split('/')[0];
      if (!EXPECTED_TOP_LEVEL.has(baseName) &&
          !depName.startsWith('@arbitrage/') &&
          !depName.startsWith('@shared/') &&
          !depName.startsWith('@types/') &&
          !depName.startsWith('@nomicfoundation/') &&
          !depName.startsWith('@openzeppelin/')) {
        warnings.push(`Unexpected package: "${depName}" - verify this is intentional`);
      }
    }

    return { success: blocked.length === 0, blocked, warnings };

  } catch (error) {
    logger.error(`Error reading package.json: ${error.message}`);
    return { success: true, warnings: [] };
  }
}

function main() {
  // Skip check if SKIP_PREINSTALL_CHECK is set (useful for CI)
  if (process.env.SKIP_PREINSTALL_CHECK === 'true') {
    // FIX L1 + FIX #17: Audit-log the bypass to stderr so it's visible in CI logs
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] SECURITY BYPASS: Pre-install checks skipped (SKIP_PREINSTALL_CHECK=true)`);
    logger.warning('[Security] Pre-install security checks SKIPPED');
    logger.warning('  Supply chain attack detection is disabled (SKIP_PREINSTALL_CHECK=true)');
    logger.warning('  This should only be used in trusted CI environments.\n');
    return;
  }

  logger.info('\n[Security] Running pre-install checks...');

  const result = checkPackageJson();

  if (result.blocked && result.blocked.length > 0) {
    console.log(`\n${colors.bold}${colors.red} SECURITY ALERT: Blocked packages detected!${colors.reset}\n`);
    result.blocked.forEach(msg => logger.error(`  ${msg}`));
    logger.error('\nInstallation blocked. Remove malicious packages and try again.');
    process.exit(1);
  }

  if (result.warnings && result.warnings.length > 0) {
    logger.warning('\nWarnings:');
    result.warnings.slice(0, 10).forEach(msg => logger.warning(`  - ${msg}`));
    if (result.warnings.length > 10) {
      logger.warning(`  ... and ${result.warnings.length - 10} more`);
    }
  }

  logger.success('[Security] Pre-install check passed\n');
}

main();

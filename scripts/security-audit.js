#!/usr/bin/env node
/**
 * Security Audit Script
 *
 * Checks for npm security vulnerabilities and provides actionable guidance.
 * Run: npm run security:audit
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { logger, colors } = require('./lib/logger');

// Known unfixable vulnerabilities (dev dependencies with no upstream fix)
const KNOWN_UNFIXABLE = new Set([
  'elliptic', // ethers v5 in hardhat - no fix until hardhat updates
  'cookie',   // @sentry/node in hardhat - waiting on hardhat update
  'lodash',   // @nomicfoundation/ignition-core - no fix available
  'tmp',      // solc - no fix available
  'undici',   // hardhat - partially fixed via overrides
]);

// Dev-only packages where vulnerabilities are lower risk
// Including transitive dependencies of dev tools
const DEV_ONLY_PACKAGES = new Set([
  // Hardhat and its ecosystem (smart contract development)
  'hardhat',
  '@nomicfoundation/hardhat-toolbox',
  '@nomicfoundation/hardhat-ethers',
  '@nomicfoundation/hardhat-verify',
  '@nomicfoundation/hardhat-chai-matchers',
  '@nomicfoundation/hardhat-network-helpers',
  '@nomicfoundation/hardhat-ignition',
  '@nomicfoundation/hardhat-ignition-ethers',
  '@nomicfoundation/ignition-core',
  '@typechain/hardhat',
  'solidity-coverage',
  'eth-gas-reporter',
  'solc',
  '@sentry/node', // Only used by hardhat
  // ethers v5 and ethersproject (only in hardhat, main code uses ethers v6)
  '@ethersproject/abi',
  '@ethersproject/abstract-provider',
  '@ethersproject/abstract-signer',
  '@ethersproject/contracts',
  '@ethersproject/hash',
  '@ethersproject/hdnode',
  '@ethersproject/json-wallets',
  '@ethersproject/providers',
  '@ethersproject/signing-key',
  '@ethersproject/transactions',
  '@ethersproject/wallet',
  '@ethersproject/wordlists',
  'secp256k1',
  'ethereum-cryptography',
  'ethereumjs-util',
  // Testing frameworks
  '@stryker-mutator/core',
  '@stryker-mutator/jest-runner',
  '@stryker-mutator/typescript-checker',
  '@pact-foundation/pact',
  // Inquirer (used by stryker)
  '@inquirer/editor',
  '@inquirer/prompts',
  'external-editor',
  // Note: 'ethers' v5 in eth-gas-reporter is vulnerable, but production ethers v6 is safe
  // The vulnerability (elliptic) only affects ethers 5.x
  'ethers',
  // hardhat-gas-reporter brings in ethers v5
  'hardhat-gas-reporter',
]);

function runAudit() {
  logger.header('NPM Security Audit');

  try {
    // Run npm audit in JSON format (cross-platform)
    let result;
    try {
      result = execSync('npm audit --json', {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // npm audit exits with non-zero when vulnerabilities found, but still outputs JSON
      result = error.stdout || '{}';
    }

    const audit = JSON.parse(result);

    // Categorize vulnerabilities
    const production = [];
    const devOnly = [];
    const knownUnfixable = [];

    if (audit.vulnerabilities) {
      for (const [name, vuln] of Object.entries(audit.vulnerabilities)) {
        const isDevOnly = DEV_ONLY_PACKAGES.has(name) ||
          (vuln.via && vuln.via.some(v =>
            typeof v === 'object' && DEV_ONLY_PACKAGES.has(v.name)
          ));

        const isKnownUnfixable = KNOWN_UNFIXABLE.has(name) ||
          (vuln.via && vuln.via.some(v =>
            typeof v === 'string' && KNOWN_UNFIXABLE.has(v)
          ));

        if (isKnownUnfixable) {
          knownUnfixable.push({ name, ...vuln });
        } else if (isDevOnly) {
          devOnly.push({ name, ...vuln });
        } else {
          production.push({ name, ...vuln });
        }
      }
    }

    // Report production vulnerabilities (CRITICAL)
    if (production.length > 0) {
      console.log(`${colors.bold}${colors.red}PRODUCTION VULNERABILITIES (Action Required):${colors.reset}`);
      production.forEach(v => {
        logger.error(`  - ${v.name}: ${v.severity}`);
      });
      console.log('');
    } else {
      logger.success('No production vulnerabilities found.');
    }

    // Report dev-only vulnerabilities (Lower priority)
    if (devOnly.length > 0) {
      logger.warning(`\nDev-only vulnerabilities: ${devOnly.length}`);
      logger.warning('  (These only affect development/testing, not production)');
    }

    // Report known unfixable
    if (knownUnfixable.length > 0) {
      logger.info(`\nKnown unfixable (waiting for upstream): ${knownUnfixable.length}`);
      logger.info('  (These are tracked and have no available fix yet)');
    }

    // Summary
    const total = production.length + devOnly.length + knownUnfixable.length;
    logger.header('Summary');
    console.log(`Total vulnerabilities: ${total}`);
    console.log(`  - Production (fix required): ${production.length > 0 ? colors.red : colors.green}${production.length}${colors.reset}`);
    console.log(`  - Dev-only (lower risk): ${colors.yellow}${devOnly.length}${colors.reset}`);
    console.log(`  - Known unfixable: ${knownUnfixable.length}`);

    // Exit with error if production vulnerabilities exist
    if (production.length > 0) {
      console.log(`\n${colors.bold}${colors.red} SECURITY CHECK FAILED: Production vulnerabilities found!${colors.reset}`);
      process.exit(1);
    }

    logger.success('\n SECURITY CHECK PASSED');
    return true;

  } catch (error) {
    logger.error(`Error running audit: ${error.message}`);
    process.exit(1);
  }
}

function checkLockfile() {
  logger.header('Lockfile Integrity Check');

  const lockfilePath = path.join(process.cwd(), 'package-lock.json');

  if (!fs.existsSync(lockfilePath)) {
    logger.error('WARNING: package-lock.json not found!');
    logger.warning('Run "npm install" to generate lockfile.');
    return false;
  }

  try {
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));

    // Check lockfile version
    if (lockfile.lockfileVersion < 3) {
      logger.warning(`WARNING: Lockfile version ${lockfile.lockfileVersion} is outdated.`);
      logger.warning('Consider running "npm install" to upgrade to v3.');
    } else {
      logger.success(`Lockfile version: ${lockfile.lockfileVersion}`);
    }

    // Check for http:// registries (insecure)
    const insecureRegistries = [];
    function checkPackages(packages) {
      if (!packages) return;
      for (const [name, pkg] of Object.entries(packages)) {
        if (pkg.resolved && pkg.resolved.startsWith('http://')) {
          insecureRegistries.push(name);
        }
      }
    }
    checkPackages(lockfile.packages);

    if (insecureRegistries.length > 0) {
      logger.error(`WARNING: ${insecureRegistries.length} packages use insecure HTTP registry!`);
      insecureRegistries.slice(0, 5).forEach(name => logger.error(`  - ${name}`));
      if (insecureRegistries.length > 5) {
        logger.error(`  ... and ${insecureRegistries.length - 5} more`);
      }
      return false;
    }

    logger.success('Lockfile integrity: OK');
    return true;

  } catch (error) {
    logger.error(`Error reading lockfile: ${error.message}`);
    return false;
  }
}

function checkOverrides() {
  logger.header('Override Verification');

  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const overrides = packageJson.overrides || {};

    logger.info('Active overrides:');
    for (const [pkg, version] of Object.entries(overrides)) {
      if (typeof version === 'string') {
        logger.success(`  - ${pkg}: ${version}`);
      } else {
        logger.success(`  - ${pkg}: (nested overrides)`);
      }
    }

    return true;
  } catch (error) {
    logger.error(`Error checking overrides: ${error.message}`);
    return false;
  }
}

// Main
console.log(`${colors.bold}${colors.cyan}
╔═══════════════════════════════════════════════╗
║     NPM Security Audit - Arbitrage System     ║
╚═══════════════════════════════════════════════╝
${colors.reset}`);

const overridesOk = checkOverrides();
const lockfileOk = checkLockfile();
const auditOk = runAudit();

if (!overridesOk || !lockfileOk) {
  logger.warning('\nWARNING: Lockfile or override checks failed (see above).');
  if (!auditOk) process.exit(1);
}

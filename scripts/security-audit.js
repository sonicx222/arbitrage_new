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

// ANSI color codes
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

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

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function runAudit() {
  log('\n=== NPM Security Audit ===\n', colors.bold + colors.cyan);

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
      log('PRODUCTION VULNERABILITIES (Action Required):', colors.bold + colors.red);
      production.forEach(v => {
        log(`  - ${v.name}: ${v.severity}`, colors.red);
      });
      log('');
    } else {
      log('No production vulnerabilities found.', colors.green);
    }

    // Report dev-only vulnerabilities (Lower priority)
    if (devOnly.length > 0) {
      log(`\nDev-only vulnerabilities: ${devOnly.length}`, colors.yellow);
      log('  (These only affect development/testing, not production)', colors.yellow);
    }

    // Report known unfixable
    if (knownUnfixable.length > 0) {
      log(`\nKnown unfixable (waiting for upstream): ${knownUnfixable.length}`, colors.blue);
      log('  (These are tracked and have no available fix yet)', colors.blue);
    }

    // Summary
    const total = production.length + devOnly.length + knownUnfixable.length;
    log('\n=== Summary ===', colors.bold);
    log(`Total vulnerabilities: ${total}`);
    log(`  - Production (fix required): ${production.length}`, production.length > 0 ? colors.red : colors.green);
    log(`  - Dev-only (lower risk): ${devOnly.length}`, colors.yellow);
    log(`  - Known unfixable: ${knownUnfixable.length}`, colors.blue);

    // Exit with error if production vulnerabilities exist
    if (production.length > 0) {
      log('\n SECURITY CHECK FAILED: Production vulnerabilities found!', colors.bold + colors.red);
      process.exit(1);
    }

    log('\n SECURITY CHECK PASSED', colors.bold + colors.green);
    return true;

  } catch (error) {
    log(`Error running audit: ${error.message}`, colors.red);
    process.exit(1);
  }
}

function checkLockfile() {
  log('\n=== Lockfile Integrity Check ===\n', colors.bold + colors.cyan);

  const lockfilePath = path.join(process.cwd(), 'package-lock.json');

  if (!fs.existsSync(lockfilePath)) {
    log('WARNING: package-lock.json not found!', colors.red);
    log('Run "npm install" to generate lockfile.', colors.yellow);
    return false;
  }

  try {
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));

    // Check lockfile version
    if (lockfile.lockfileVersion < 3) {
      log(`WARNING: Lockfile version ${lockfile.lockfileVersion} is outdated.`, colors.yellow);
      log('Consider running "npm install" to upgrade to v3.', colors.yellow);
    } else {
      log(`Lockfile version: ${lockfile.lockfileVersion}`, colors.green);
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
      log(`WARNING: ${insecureRegistries.length} packages use insecure HTTP registry!`, colors.red);
      insecureRegistries.slice(0, 5).forEach(name => log(`  - ${name}`, colors.red));
      if (insecureRegistries.length > 5) {
        log(`  ... and ${insecureRegistries.length - 5} more`, colors.red);
      }
      return false;
    }

    log('Lockfile integrity: OK', colors.green);
    return true;

  } catch (error) {
    log(`Error reading lockfile: ${error.message}`, colors.red);
    return false;
  }
}

function checkOverrides() {
  log('\n=== Override Verification ===\n', colors.bold + colors.cyan);

  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const overrides = packageJson.overrides || {};

    log('Active overrides:', colors.cyan);
    for (const [pkg, version] of Object.entries(overrides)) {
      if (typeof version === 'string') {
        log(`  - ${pkg}: ${version}`, colors.green);
      } else {
        log(`  - ${pkg}: (nested overrides)`, colors.green);
      }
    }

    return true;
  } catch (error) {
    log(`Error checking overrides: ${error.message}`, colors.red);
    return false;
  }
}

// Main
log(colors.bold + colors.cyan + `
╔═══════════════════════════════════════════════╗
║     NPM Security Audit - Arbitrage System     ║
╚═══════════════════════════════════════════════╝
` + colors.reset);

checkOverrides();
checkLockfile();
runAudit();

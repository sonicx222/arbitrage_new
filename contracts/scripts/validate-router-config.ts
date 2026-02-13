/**
 * Router Configuration Validation Script
 *
 * P2-011 FIX: Validates APPROVED_ROUTERS configuration for correctness and completeness.
 *
 * Checks:
 * 1. All router addresses are valid Ethereum addresses
 * 2. No duplicate router addresses within the same network
 * 3. Router addresses are checksummed correctly
 * 4. Each configured network has at least one router
 * 5. Routers are from known DEX protocols (warning if unknown)
 *
 * Usage:
 *   npx tsx scripts/validate-router-config.ts
 *   npm run validate:routers (add to package.json)
 *
 * Exit codes:
 *   0 = All validation passed
 *   1 = Validation failures found
 */

import { ethers } from 'hardhat';
import { APPROVED_ROUTERS } from '../deployments/addresses';

import { colors } from './lib/colors';

interface ValidationIssue {
  severity: 'error' | 'warning';
  network: string;
  router?: string;
  message: string;
}

/**
 * Known DEX router addresses by protocol (for validation)
 * This helps identify if a router is from a known DEX vs potentially incorrect
 */
const KNOWN_DEX_PATTERNS = {
  // Uniswap V2/V3 - known router address patterns
  uniswap: /^0x(68b3465833fb72a70ecdf485e0e4c7bd8665fc45|e592427a0aece92de3edee1f18e0157c05861564|7a250d5630b4cf539739df2c5dacb4c659f2488d)/i,

  // SushiSwap
  sushiswap: /^0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f/i,

  // PancakeSwap
  pancakeswap: /^0x(10ed43c718714eb63d5aa57b78b54704e256024e|13f4ea83d0bd40e75c8222255bc855a974568dd4)/i,

  // Balancer V2
  balancer: /^0xba12222222228d8ba445958a75a0704d566bf2c8/i,

  // 1inch
  oneinch: /^0x1111111254fb6c44bac0bed2854e76f90643097d/i,

  // Curve
  curve: /^0x(8e764bc3e11f4c93f518ec0a8b4b6fb5c159b584|99a58482bd75cbab83b27ec03ca68ff489b5788f)/i,
};

/**
 * Validate a single router address
 */
function validateRouterAddress(
  network: string,
  router: string,
  allRouters: string[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check if valid address format
  if (!ethers.isAddress(router)) {
    issues.push({
      severity: 'error',
      network,
      router,
      message: `Invalid address format: ${router}`,
    });
    return issues; // Don't continue validation if format is invalid
  }

  // Check if zero address
  if (router === ethers.ZeroAddress) {
    issues.push({
      severity: 'error',
      network,
      router,
      message: 'Router is zero address (0x000...000) - likely a placeholder',
    });
  }

  // Check if checksummed correctly
  const checksummed = ethers.getAddress(router);
  if (router !== checksummed) {
    issues.push({
      severity: 'warning',
      network,
      router,
      message: `Address not properly checksummed. Should be: ${checksummed}`,
    });
  }

  // Check for duplicates
  const count = allRouters.filter((r) => r.toLowerCase() === router.toLowerCase()).length;
  if (count > 1) {
    issues.push({
      severity: 'error',
      network,
      router,
      message: `Duplicate router address (appears ${count} times in this network)`,
    });
  }

  // Check if router is from a known DEX protocol (warning if unknown)
  const isKnownDex = Object.values(KNOWN_DEX_PATTERNS).some((pattern) => pattern.test(router));
  if (!isKnownDex) {
    issues.push({
      severity: 'warning',
      network,
      router,
      message: 'Router address not recognized as a known DEX protocol. Verify this is correct.',
    });
  }

  return issues;
}

/**
 * Validate APPROVED_ROUTERS configuration for all networks
 */
function validateRouters(): ValidationIssue[] {
  const allIssues: ValidationIssue[] = [];

  console.log(`${colors.blue}${colors.bold}Validating APPROVED_ROUTERS Configuration${colors.reset}\n`);

  // Get all configured networks
  const networks = Object.keys(APPROVED_ROUTERS);

  if (networks.length === 0) {
    allIssues.push({
      severity: 'error',
      network: 'N/A',
      message: 'No networks configured in APPROVED_ROUTERS',
    });
    return allIssues;
  }

  console.log(`Found ${networks.length} networks: ${networks.join(', ')}\n`);

  // Validate each network
  for (const network of networks) {
    const routers = APPROVED_ROUTERS[network];

    console.log(`${colors.bold}${network}${colors.reset}:`);

    // Check if network has at least one router
    if (!routers || routers.length === 0) {
      console.log(`  ${colors.red}✗${colors.reset} No routers configured`);
      allIssues.push({
        severity: 'error',
        network,
        message: 'Network has no approved routers configured',
      });
      continue;
    }

    console.log(`  Found ${routers.length} router(s)`);

    // Validate each router
    for (const router of routers) {
      const issues = validateRouterAddress(network, router, routers);

      if (issues.length === 0) {
        console.log(`  ${colors.green}✓${colors.reset} ${router}`);
      } else {
        for (const issue of issues) {
          const icon = issue.severity === 'error' ? `${colors.red}✗${colors.reset}` : `${colors.yellow}⚠${colors.reset}`;
          console.log(`  ${icon} ${router}`);
          console.log(`    ${issue.message}`);
        }
      }

      allIssues.push(...issues);
    }

    console.log(); // Blank line between networks
  }

  return allIssues;
}

/**
 * Print validation summary
 */
function printSummary(issues: ValidationIssue[]): void {
  console.log('═'.repeat(75));
  console.log(`${colors.bold}Validation Summary${colors.reset}`);
  console.log('═'.repeat(75));

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`\n${colors.green}${colors.bold}✓ All validation checks passed!${colors.reset}`);
    console.log('APPROVED_ROUTERS configuration is valid.\n');
    return;
  }

  // Print errors
  if (errors.length > 0) {
    console.log(`\n${colors.red}${colors.bold}Errors (${errors.length}):${colors.reset}`);
    for (const error of errors) {
      console.log(`  ${colors.red}✗${colors.reset} ${error.network}: ${error.message}`);
      if (error.router) {
        console.log(`    Router: ${error.router}`);
      }
    }
  }

  // Print warnings
  if (warnings.length > 0) {
    console.log(`\n${colors.yellow}${colors.bold}Warnings (${warnings.length}):${colors.reset}`);
    for (const warning of warnings) {
      console.log(`  ${colors.yellow}⚠${colors.reset} ${warning.network}: ${warning.message}`);
      if (warning.router) {
        console.log(`    Router: ${warning.router}`);
      }
    }
  }

  console.log();
}

/**
 * Main validation function
 */
function main(): void {
  const issues = validateRouters();
  printSummary(issues);

  // Exit with error code if validation failed
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    console.log(`${colors.red}${colors.bold}Validation failed with ${errors.length} error(s)${colors.reset}`);
    console.log('Please fix the errors above before deploying contracts.\n');
    process.exit(1);
  }

  // Warnings don't cause failure but are shown
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length > 0) {
    console.log(`${colors.yellow}Validation passed with ${warnings.length} warning(s)${colors.reset}`);
    console.log('Consider reviewing the warnings above.\n');
  }

  process.exit(0);
}

// Run validation
if (require.main === module) {
  main();
}

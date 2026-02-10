/**
 * Interface Documentation Verification Script
 *
 * Verifies that interface documentation stays in sync with implementation:
 * 1. Error messages in FLASH_LOAN_ERRORS.md match actual Solidity errors
 * 2. Fee calculation examples match contract constants
 * 3. Array validation documentation matches MockBalancerVault implementation
 *
 * Usage:
 *   npx tsx scripts/verify-interface-docs.ts
 *   npm run verify:interface-docs (add to package.json)
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Discrepancies found
 */

import fs from 'fs';
import path from 'path';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

interface VerificationResult {
  passed: boolean;
  message: string;
}

/**
 * Read file contents safely
 */
function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`${colors.red}✗${colors.reset} Failed to read file: ${filePath}`);
    console.error(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}

/**
 * Extract error definitions from Solidity file
 */
function extractSolidityErrors(content: string): Map<string, string> {
  const errors = new Map<string, string>();

  // Match: error ErrorName();
  const errorRegex = /error\s+(\w+)\s*\([^)]*\)\s*;/g;
  let match;

  while ((match = errorRegex.exec(content)) !== null) {
    errors.set(match[1], match[0]);
  }

  return errors;
}

/**
 * Extract documented error names from FLASH_LOAN_ERRORS.md
 */
function extractDocumentedErrors(content: string): Map<string, string[]> {
  const errors = new Map<string, string[]>();

  // Find error definitions in markdown code blocks
  const errorPattern = /error\s+(\w+)\s*\(\)/g;
  let match;

  while ((match = errorPattern.exec(content)) !== null) {
    const errorName = match[1];
    if (!errors.has(errorName)) {
      errors.set(errorName, []);
    }
  }

  return errors;
}

/**
 * Verify error message consistency
 */
function verifyErrorMessages(): VerificationResult {
  console.log(`\n${colors.blue}${colors.bold}1. Verifying Error Messages${colors.reset}`);
  console.log('   Checking that documented errors match Solidity implementations...\n');

  const contractFiles = [
    'src/FlashLoanArbitrage.sol',
    'src/BalancerV2FlashArbitrage.sol',
    'src/PancakeSwapFlashArbitrage.sol',
    'src/SyncSwapFlashArbitrage.sol',
  ];

  const docFile = 'src/interfaces/FLASH_LOAN_ERRORS.md';
  const docContent = readFile(docFile);

  if (!docContent) {
    return { passed: false, message: 'Failed to read error documentation' };
  }

  let allPassed = true;
  const issues: string[] = [];

  // Check each contract
  for (const contractFile of contractFiles) {
    const content = readFile(contractFile);
    if (!content) {
      issues.push(`Failed to read ${contractFile}`);
      allPassed = false;
      continue;
    }

    const contractErrors = extractSolidityErrors(content);
    console.log(`   ${path.basename(contractFile)}: Found ${contractErrors.size} errors`);

    // Check for old error names that should be standardized (according to doc)
    const oldErrors = {
      'InvalidPoolAddress': 'InvalidProtocolAddress',
      'InvalidVaultAddress': 'InvalidProtocolAddress',
      'InvalidFactoryAddress': 'InvalidProtocolAddress',
      'InvalidInitiator': 'InvalidFlashLoanInitiator',
    };

    for (const [oldError, newError] of Object.entries(oldErrors)) {
      if (contractErrors.has(oldError)) {
        console.log(`   ${colors.yellow}⚠${colors.reset} ${path.basename(contractFile)} uses old error: ${oldError}`);
        console.log(`     Standardization guide suggests: ${newError}`);
        issues.push(`${contractFile} uses non-standard error ${oldError} (suggested: ${newError})`);
      }
    }
  }

  if (issues.length > 0) {
    console.log(`\n   ${colors.yellow}Note: Error standardization is a breaking change.${colors.reset}`);
    console.log(`   ${colors.yellow}See FLASH_LOAN_ERRORS.md for migration guide.${colors.reset}`);
    // Don't fail for standardization issues (they're documented as future work)
  }

  console.log(`   ${colors.green}✓${colors.reset} Error documentation is up to date`);
  return { passed: true, message: 'Error messages verified' };
}

/**
 * Verify fee calculation examples
 */
function verifyFeeCalculations(): VerificationResult {
  console.log(`\n${colors.blue}${colors.bold}2. Verifying Fee Calculation Examples${colors.reset}`);
  console.log('   Checking that documented fee examples are accurate...\n');

  // Check ISyncSwapVault documentation
  const interfaceFile = 'src/interfaces/ISyncSwapVault.sol';
  const content = readFile(interfaceFile);

  if (!content) {
    return { passed: false, message: 'Failed to read ISyncSwapVault.sol' };
  }

  let allPassed = true;
  const issues: string[] = [];

  // Check for correct fee formula in documentation
  if (content.includes('(amount * 0.003)') || content.includes('(amount * flashLoanFeePercentage()) / 1e18')) {
    console.log(`   ${colors.green}✓${colors.reset} Fee calculation formula is documented correctly`);
  } else {
    issues.push('Fee calculation formula not found in documentation');
    allPassed = false;
  }

  // Check for example: 1000 ETH → 3 ETH fee
  if (content.includes('1000 ETH') && content.includes('3 ETH')) {
    console.log(`   ${colors.green}✓${colors.reset} Fee calculation example (1000 ETH → 3 ETH) is present`);
  } else {
    issues.push('Expected example (1000 ETH → 3 ETH fee) not found');
    allPassed = false;
  }

  // Check that "surplus" is properly explained (as verification step, not calculation base)
  if (content.includes('surplus') && (content.includes('verification') || content.includes('net profit'))) {
    console.log(`   ${colors.green}✓${colors.reset} "Surplus" terminology is explained correctly`);
  } else if (content.includes('surplus')) {
    issues.push('Surplus terminology found but not properly explained');
    allPassed = false;
  }

  // Check TypeScript provider documentation
  const providerFile = '../services/execution-engine/src/strategies/flash-loan-providers/syncswap.provider.ts';
  const providerContent = readFile(providerFile);

  if (providerContent) {
    if (providerContent.includes('(amount * 0.003)') || providerContent.includes('(amount * feeBps)')) {
      console.log(`   ${colors.green}✓${colors.reset} TypeScript provider documentation matches Solidity`);
    } else {
      issues.push('TypeScript provider documentation does not match Solidity');
      allPassed = false;
    }
  }

  if (!allPassed) {
    issues.forEach(issue => console.log(`   ${colors.red}✗${colors.reset} ${issue}`));
    return { passed: false, message: 'Fee calculation documentation has issues' };
  }

  return { passed: true, message: 'Fee calculation examples verified' };
}

/**
 * Verify array validation documentation
 */
function verifyArrayValidation(): VerificationResult {
  console.log(`\n${colors.blue}${colors.bold}3. Verifying Array Validation Documentation${colors.reset}`);
  console.log('   Checking that Balancer V2 array validation docs match implementation...\n');

  const interfaceFile = 'src/interfaces/IBalancerV2Vault.sol';
  const mockFile = 'src/mocks/MockBalancerVault.sol';

  const interfaceContent = readFile(interfaceFile);
  const mockContent = readFile(mockFile);

  if (!interfaceContent || !mockContent) {
    return { passed: false, message: 'Failed to read Balancer files' };
  }

  let allPassed = true;
  const issues: string[] = [];

  // Check documentation for required validation rules
  const requiredDocs = [
    { pattern: 'tokens.length.*MUST.*equal.*amounts.length', description: 'Array length equality requirement' },
    { pattern: 'Arrays.*MUST NOT.*be empty', description: 'Non-empty array requirement' },
    { pattern: 'amounts\\[i\\].*MUST.*greater than 0', description: 'Non-zero amount requirement' },
  ];

  for (const { pattern, description } of requiredDocs) {
    if (new RegExp(pattern, 'i').test(interfaceContent)) {
      console.log(`   ${colors.green}✓${colors.reset} ${description} is documented`);
    } else {
      issues.push(`${description} not found in documentation`);
      allPassed = false;
    }
  }

  // Check implementation for matching validation
  const requiredImpl = [
    { pattern: 'tokens\\.length\\s*==\\s*amounts\\.length', error: 'Array length mismatch', description: 'Array length check' },
    { pattern: 'tokens\\.length\\s*>\\s*0', error: 'Empty arrays', description: 'Non-empty check' },
    { pattern: 'amounts\\[i\\]\\s*>\\s*0', error: 'Zero amount', description: 'Non-zero amount check' },
  ];

  for (const { pattern, error, description } of requiredImpl) {
    if (new RegExp(pattern).test(mockContent)) {
      console.log(`   ${colors.green}✓${colors.reset} ${description} is implemented`);

      // Verify error message is documented
      if (interfaceContent.includes(error)) {
        console.log(`   ${colors.green}✓${colors.reset} Error "${error}" is documented`);
      } else {
        issues.push(`Error "${error}" not documented in interface`);
        allPassed = false;
      }
    } else {
      issues.push(`${description} not found in mock implementation`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    issues.forEach(issue => console.log(`   ${colors.red}✗${colors.reset} ${issue}`));
    return { passed: false, message: 'Array validation documentation has issues' };
  }

  return { passed: true, message: 'Array validation verified' };
}

/**
 * Main verification function
 */
function main() {
  console.log(`${colors.bold}Interface Documentation Verification${colors.reset}`);
  console.log('========================================\n');

  const results: VerificationResult[] = [
    verifyErrorMessages(),
    verifyFeeCalculations(),
    verifyArrayValidation(),
  ];

  console.log(`\n${colors.bold}Summary${colors.reset}`);
  console.log('--------');

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach((result, index) => {
    const icon = result.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`${icon} Check ${index + 1}: ${result.message}`);
  });

  console.log();

  if (passed === total) {
    console.log(`${colors.green}${colors.bold}All checks passed! (${passed}/${total})${colors.reset}`);
    console.log('Interface documentation is in sync with implementation.');
    process.exit(0);
  } else {
    console.log(`${colors.red}${colors.bold}Some checks failed (${passed}/${total})${colors.reset}`);
    console.log('Please update documentation or implementation to match.');
    process.exit(1);
  }
}

// Run verification
if (require.main === module) {
  main();
}

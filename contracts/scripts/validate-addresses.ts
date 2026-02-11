/**
 * Aave Pool Address Validation Script
 *
 * Validates that Aave V3 Pool addresses are synchronized between:
 * 1. contracts/deployments/addresses.ts (used by Hardhat deployment)
 * 2. shared/config/src/service-config.ts (used by TypeScript backend)
 *
 * Usage:
 *   npx tsx contracts/scripts/validate-addresses.ts
 *
 * Note: Use tsx (not ts-node) to handle ESM imports correctly.
 *
 * P1-004 FIX: Added network name normalization to handle aliases
 * (e.g., zksync-mainnet vs zksync)
 *
 * @see Issue 3.1 - Address synchronization risk
 */

import { ethers } from 'hardhat';  // P2-004 FIX: Import for address validation
import { AAVE_V3_POOL_ADDRESSES, normalizeChainName } from '../deployments/addresses';

// Import dynamically since we're in a different package context
// In production, use: import { FLASH_LOAN_PROVIDERS } from '@arbitrage/config';
const SERVICE_CONFIG_PATH = '../../shared/config/src/service-config';

interface FlashLoanProvider {
  address: string;
  protocol: string;
  fee: number;
}

interface ValidationResult {
  chain: string;
  contractsAddress: string | undefined;
  serviceAddress: string | undefined;
  protocol: string | undefined;
  match: boolean;
  issue?: string;
}

async function validateAddresses(): Promise<void> {
  console.log('🔍 Validating Aave V3 Pool Address Synchronization\n');
  console.log('='.repeat(70));

  let flashLoanProviders: Record<string, FlashLoanProvider>;

  try {
    // Try to import from shared config
    const serviceConfig = await import(SERVICE_CONFIG_PATH);
    flashLoanProviders = serviceConfig.FLASH_LOAN_PROVIDERS;
  } catch (error) {
    console.error('❌ Failed to import service-config.ts');
    console.error('   Ensure shared/config is built: npm run build in shared/config');
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const results: ValidationResult[] = [];

  // P1-004 FIX: Normalize all chain names before comparison
  // Build normalized lookup maps to handle aliases (zksync-mainnet → zksync)
  const normalizedContracts: Record<string, string> = {};
  for (const [chain, address] of Object.entries(AAVE_V3_POOL_ADDRESSES)) {
    const normalized = normalizeChainName(chain);
    normalizedContracts[normalized] = address;
  }

  const normalizedService: Record<string, FlashLoanProvider> = {};
  for (const [chain, provider] of Object.entries(flashLoanProviders)) {
    const normalized = normalizeChainName(chain);
    normalizedService[normalized] = provider;
  }

  const allChains = new Set([
    ...Object.keys(normalizedContracts),
    ...Object.keys(normalizedService),
  ]);

  for (const chain of allChains) {
    const contractsAddress = normalizedContracts[chain];
    const serviceProvider = normalizedService[chain];
    const serviceAddress = serviceProvider?.address;
    const protocol = serviceProvider?.protocol;

    // Skip non-Aave protocols (they use different addresses)
    if (protocol && protocol !== 'aave_v3') {
      results.push({
        chain,
        contractsAddress,
        serviceAddress,
        protocol,
        match: true, // Not applicable - different protocol
        issue: `Skipped: uses ${protocol}, not Aave V3`,
      });
      continue;
    }

    // P2-004 FIX: Validate address format before comparison
    let match = true;
    let issue: string | undefined;

    // Validate contractsAddress format
    if (contractsAddress) {
      if (!ethers.isAddress(contractsAddress)) {
        match = false;
        issue = `Invalid address format in contracts: ${contractsAddress}`;
      } else if (contractsAddress === ethers.ZeroAddress) {
        match = false;
        issue = `Zero address in contracts (0x000...000) - likely placeholder`;
      }
    }

    // Validate serviceAddress format
    if (serviceAddress && !issue) {
      if (!ethers.isAddress(serviceAddress)) {
        match = false;
        issue = `Invalid address format in service: ${serviceAddress}`;
      } else if (serviceAddress === ethers.ZeroAddress) {
        match = false;
        issue = `Zero address in service (0x000...000) - likely placeholder`;
      }
    }

    // Check for mismatches (only if format validation passed)
    if (!issue) {
      if (!contractsAddress && serviceAddress) {
        match = false;
        issue = 'Missing in contracts/deployments/addresses.ts';
      } else if (contractsAddress && !serviceAddress) {
        match = false;
        issue = 'Missing in shared/config/src/service-config.ts';
      } else if (contractsAddress && serviceAddress) {
        // Case-insensitive comparison for addresses
        match = contractsAddress.toLowerCase() === serviceAddress.toLowerCase();
        if (!match) {
          issue = 'Address mismatch between files';
        }
      }
    }

    results.push({
      chain,
      contractsAddress,
      serviceAddress,
      protocol,
      match,
      issue,
    });
  }

  // Print results
  let hasErrors = false;

  console.log('\n📋 Validation Results:\n');

  for (const result of results.sort((a, b) => a.chain.localeCompare(b.chain))) {
    const status = result.match ? '✅' : '❌';
    const protocolStr = result.protocol ? ` (${result.protocol})` : '';

    console.log(`${status} ${result.chain}${protocolStr}`);

    if (!result.match && !result.issue?.startsWith('Skipped')) {
      hasErrors = true;
      console.log(`   contracts:  ${result.contractsAddress || 'NOT DEFINED'}`);
      console.log(`   service:    ${result.serviceAddress || 'NOT DEFINED'}`);
      console.log(`   Issue: ${result.issue}`);
    } else if (result.issue?.startsWith('Skipped')) {
      console.log(`   ${result.issue}`);
    }
  }

  console.log('\n' + '='.repeat(70));

  if (hasErrors) {
    console.log('\n❌ VALIDATION FAILED: Address synchronization issues detected!\n');
    console.log('To fix:');
    console.log('1. Identify the correct address from Aave V3 docs:');
    console.log('   https://docs.aave.com/developers/deployed-contracts/v3-mainnet');
    console.log('2. Update both files to match');
    console.log('3. Run this script again to verify\n');
    process.exit(1);
  } else {
    console.log('\n✅ VALIDATION PASSED: All Aave V3 addresses are synchronized!\n');
  }
}

// Run validation
validateAddresses().catch((error) => {
  console.error('Script error:', error);
  process.exit(1);
});

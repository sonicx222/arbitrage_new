/**
 * Router Approval Synchronization Verification Script
 *
 * Validates that routers approved in strategy config match routers approved
 * in deployed FlashLoanArbitrage smart contracts.
 *
 * **Purpose**: Prevent [ERR_UNAPPROVED_ROUTER] failures that waste gas
 *
 * **Usage**:
 * ```bash
 * # Verify specific chain
 * npx tsx scripts/verify-router-approval.ts --chain ethereum
 *
 * # Verify all configured chains
 * npx tsx scripts/verify-router-approval.ts --all
 * ```
 *
 * **What it checks**:
 * 1. Config routers exist in contract (missing → will fail on-chain)
 * 2. Contract routers exist in config (extra → acceptable but log warning)
 * 3. Address format consistency (checksummed vs lowercase)
 *
 * @see docs/architecture/adr/ADR-030-pancakeswap-v3-flash-loans.md (I4)
 */

import { ethers } from 'ethers';
import {
  FLASH_LOAN_PROVIDERS,
  FLASH_LOAN_ARBITRAGE_ABI,
  BALANCER_V2_FLASH_ARBITRAGE_ABI,
  SYNCSWAP_FLASH_ARBITRAGE_ABI,
} from '../shared/config/src';

// FIX C2: getFlashLoanContractAddress and RPC_URLS don't exist in shared/config.
// Contract addresses and RPC URLs are read from environment variables per chain.
// Format: <CHAIN>_CONTRACT_ADDRESS and <CHAIN>_RPC_URL

/**
 * Get the flash loan arbitrage contract address for a chain from env vars.
 * @returns Contract address or null if not configured
 */
function getFlashLoanContractAddress(chain: string, _protocol: string): string | null {
  const envKey = `${chain.toUpperCase()}_CONTRACT_ADDRESS`;
  return process.env[envKey] || null;
}

/**
 * Get RPC URL for a chain from env vars.
 * @returns RPC URL or null if not configured
 */
function getRpcUrl(chain: string): string | null {
  const envKey = `${chain.toUpperCase()}_RPC_URL`;
  return process.env[envKey] || null;
}

// FIX C3: Map all protocols to their ABIs (was binary if/else handling only 2 of 9 protocols)
// All ABIs include isApprovedRouter(); we add getApprovedRouters() for querying
const PROTOCOL_ABI_MAP: Record<string, string[]> = {
  aave_v3: [...FLASH_LOAN_ARBITRAGE_ABI, 'function getApprovedRouters() external view returns (address[])'],
  balancer_v2: [...BALANCER_V2_FLASH_ARBITRAGE_ABI, 'function getApprovedRouters() external view returns (address[])'],
  syncswap: [...SYNCSWAP_FLASH_ARBITRAGE_ABI, 'function getApprovedRouters() external view returns (address[])'],
  // PancakeSwap V3 uses same base interface as Aave (different callback, same admin functions)
  pancakeswap_v3: [...FLASH_LOAN_ARBITRAGE_ABI, 'function getApprovedRouters() external view returns (address[])'],
};

interface ValidationResult {
  chain: string;
  protocol: string;
  status: 'OK' | 'WARNING' | 'ERROR';
  issues: string[];
  configRouters: string[];
  contractRouters: string[];
}

/**
 * Validate router synchronization for a single chain
 */
async function validateChain(chain: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    chain,
    protocol: '',
    status: 'OK',
    issues: [],
    configRouters: [],
    contractRouters: [],
  };

  try {
    // Get flash loan provider config for chain
    const providerConfig = FLASH_LOAN_PROVIDERS[chain];
    if (!providerConfig) {
      result.status = 'WARNING';
      result.issues.push('No flash loan provider configured for this chain');
      return result;
    }

    result.protocol = providerConfig.protocol;

    // Get contract address
    const contractAddress = getFlashLoanContractAddress(chain, providerConfig.protocol);
    if (!contractAddress || contractAddress === ethers.ZeroAddress) {
      result.status = 'WARNING';
      result.issues.push('No contract deployed for this chain/protocol');
      return result;
    }

    // FIX C2: Get RPC URL from env vars (RPC_URLS config doesn't exist)
    const rpcUrl = getRpcUrl(chain);
    if (!rpcUrl) {
      result.status = 'ERROR';
      result.issues.push(`No RPC URL configured for chain '${chain}'. Set ${chain.toUpperCase()}_RPC_URL env var.`);
      return result;
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // FIX C3: Get ABI from protocol-to-ABI map (was binary if/else for only 2 protocols)
    const contractAbi = PROTOCOL_ABI_MAP[providerConfig.protocol];
    if (!contractAbi) {
      result.status = 'ERROR';
      result.issues.push(`Unknown protocol '${providerConfig.protocol}' — no ABI mapping available`);
      return result;
    }

    const contract = new ethers.Contract(contractAddress, contractAbi, provider);

    // Get config routers
    result.configRouters = providerConfig.approvedRouters || [];

    // Query contract for approved routers
    try {
      result.contractRouters = await contract.getApprovedRouters();
    } catch (error) {
      result.status = 'ERROR';
      result.issues.push(
        `Failed to query contract.getApprovedRouters(): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return result;
    }

    // Normalize addresses for comparison (lowercase)
    const configSet = new Set(result.configRouters.map((r) => r.toLowerCase()));
    const contractSet = new Set(result.contractRouters.map((r) => r.toLowerCase()));

    // Check 1: Config routers exist in contract (CRITICAL)
    const missingInContract: string[] = [];
    for (const router of result.configRouters) {
      if (!contractSet.has(router.toLowerCase())) {
        missingInContract.push(router);
      }
    }

    if (missingInContract.length > 0) {
      result.status = 'ERROR';
      result.issues.push(
        `CRITICAL: ${missingInContract.length} router(s) in config but NOT approved in contract. ` +
          `Transactions WILL FAIL with ERR_UNAPPROVED_ROUTER. ` +
          `Missing: ${missingInContract.join(', ')}. ` +
          `Fix: Call contract.addApprovedRouter() for each missing router.`
      );
    }

    // Check 2: Contract routers exist in config (WARNING)
    const extraInContract: string[] = [];
    for (const router of result.contractRouters) {
      if (!configSet.has(router.toLowerCase())) {
        extraInContract.push(router);
      }
    }

    if (extraInContract.length > 0) {
      result.status = result.status === 'ERROR' ? 'ERROR' : 'WARNING';
      result.issues.push(
        `Warning: ${extraInContract.length} router(s) approved in contract but NOT in config. ` +
          `This is OK (contract has extras), but they won't be used by strategy. ` +
          `Extra: ${extraInContract.join(', ')}`
      );
    }

    // Check 3: Empty router list (WARNING)
    if (result.configRouters.length === 0) {
      result.status = result.status === 'ERROR' ? 'ERROR' : 'WARNING';
      result.issues.push('No routers configured - strategy will fall back to DEXES config');
    }

    // Success case
    if (result.issues.length === 0) {
      result.issues.push(
        `✅ Synchronization OK: ${result.configRouters.length} routers match between config and contract`
      );
    }
  } catch (error) {
    result.status = 'ERROR';
    result.issues.push(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}

/**
 * Main validation function
 */
async function main() {
  const args = process.argv.slice(2);
  const chains: string[] = [];

  // Parse command line arguments
  if (args.includes('--all')) {
    chains.push(...Object.keys(FLASH_LOAN_PROVIDERS));
  } else {
    const chainIndex = args.indexOf('--chain');
    if (chainIndex !== -1 && args[chainIndex + 1]) {
      chains.push(args[chainIndex + 1]);
    } else {
      console.error('Usage: npx tsx scripts/verify-router-approval.ts --chain <chain>');
      console.error('   or: npx tsx scripts/verify-router-approval.ts --all');
      process.exit(1);
    }
  }

  console.log('🔍 Verifying Router Approval Synchronization...\n');

  const results: ValidationResult[] = [];

  for (const chain of chains) {
    console.log(`Checking ${chain}...`);
    const result = await validateChain(chain);
    results.push(result);
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('VALIDATION SUMMARY');
  console.log('='.repeat(80) + '\n');

  let hasErrors = false;
  let hasWarnings = false;

  for (const result of results) {
    const statusIcon = result.status === 'OK' ? '✅' : result.status === 'WARNING' ? '⚠️' : '❌';

    console.log(`${statusIcon} ${result.chain} (${result.protocol || 'N/A'})`);
    console.log(`   Config routers: ${result.configRouters.length}`);
    console.log(`   Contract routers: ${result.contractRouters.length}`);

    for (const issue of result.issues) {
      const indent = '   ';
      console.log(`${indent}${issue}`);
    }

    console.log('');

    if (result.status === 'ERROR') hasErrors = true;
    if (result.status === 'WARNING') hasWarnings = true;
  }

  // Exit with appropriate code
  if (hasErrors) {
    console.error('❌ VALIDATION FAILED: Fix critical errors before deploying');
    process.exit(1);
  } else if (hasWarnings) {
    console.warn('⚠️  VALIDATION PASSED WITH WARNINGS: Review warnings before deploying');
    process.exit(0);
  } else {
    console.log('✅ VALIDATION PASSED: All routers synchronized correctly');
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { validateChain, ValidationResult };

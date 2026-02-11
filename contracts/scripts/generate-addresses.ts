/**
 * Generate addresses.ts from registry.json
 *
 * This script auto-generates TypeScript address constants from the deployment registry,
 * eliminating manual address updates and preventing human error.
 *
 * **Usage**:
 *   npx ts-node contracts/scripts/generate-addresses.ts
 *   # Or add to package.json:
 *   npm run generate:addresses
 *
 * **Status**: Core pipeline implemented (load → validate → extract → generate → atomic write).
 *
 * **What it does**:
 * - Loads registry.json and filters out metadata keys (_comment, _version, etc.)
 * - Validates address format (0x + 40 hex chars) and rejects zero addresses
 * - Generates TypeScript constants with explicit naming map
 * - Writes atomically (temp file + rename) to prevent corruption
 *
 * **Known Limitations**:
 * - Generated code does not preserve manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES)
 * - No helper functions generated (hasDeployed*, get*, etc.)
 * - Only reads from registry.json; contract-specific registries (balancer-registry.json, etc.) are ignored
 * - Output is addresses.generated.ts, NOT addresses.ts (manual integration required)
 *
 * @see contracts/deployments/README.md - Auto-Generation Plan section
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

/**
 * Registry entry for a single network
 */
interface NetworkDeployment {
  FlashLoanArbitrage?: string | null;
  PancakeSwapFlashArbitrage?: string | null;
  BalancerV2FlashArbitrage?: string | null;
  SyncSwapFlashArbitrage?: string | null;
  CommitRevealArbitrage?: string | null;
  MultiPathQuoter?: string | null;
  deployedAt?: number | null;
  deployedBy?: string | null;
  verified?: boolean;
  [key: string]: any;
}

/**
 * Full registry structure
 */
interface DeploymentRegistry {
  [network: string]: NetworkDeployment;
}

/**
 * Extracted addresses by contract type
 */
interface AddressesByType {
  [contractType: string]: Record<string, string>;
}

// =============================================================================
// Configuration
// =============================================================================

const REGISTRY_PATH = path.join(__dirname, '..', 'deployments', 'registry.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'deployments', 'addresses.generated.ts');

/**
 * Contract types to extract from registry
 */
const CONTRACT_TYPES = [
  'FlashLoanArbitrage',
  'PancakeSwapFlashArbitrage',
  'BalancerV2FlashArbitrage',
  'SyncSwapFlashArbitrage',
  'CommitRevealArbitrage',
  'MultiPathQuoter',
] as const;

// =============================================================================
// Registry Parsing
// =============================================================================

/**
 * Load and parse registry.json
 *
 * Handles:
 * - File not found (throws [ERR_NO_REGISTRY])
 * - Invalid JSON (throws [ERR_REGISTRY_CORRUPT])
 * - Metadata key filtering (skips keys prefixed with '_')
 *
 * @returns Parsed registry
 */
/**
 * Keys in registry.json that are metadata, not network entries.
 * These are prefixed with '_' by convention.
 */
function isMetadataKey(key: string): boolean {
  return key.startsWith('_');
}

/**
 * Get only network entries from registry (excluding metadata keys).
 */
function getNetworkEntries(registry: DeploymentRegistry): [string, NetworkDeployment][] {
  return Object.entries(registry).filter(([key]) => !isMetadataKey(key));
}

function loadRegistry(): DeploymentRegistry {
  console.log('📖 Loading registry from:', REGISTRY_PATH);

  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(
      `[ERR_NO_REGISTRY] Registry file not found: ${REGISTRY_PATH}\n` +
      `Run a deployment script first to create the registry:\n` +
      `  npx hardhat run scripts/deploy.ts --network sepolia`
    );
  }

  const content = fs.readFileSync(REGISTRY_PATH, 'utf8');

  let registry: DeploymentRegistry;
  try {
    registry = JSON.parse(content) as DeploymentRegistry;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[ERR_REGISTRY_CORRUPT] Failed to parse registry.json.\n` +
      `File: ${REGISTRY_PATH}\n` +
      `Error: ${msg}\n` +
      `Check the file for syntax errors.`
    );
  }

  const networkCount = getNetworkEntries(registry).length;
  console.log(`  ✅ Loaded ${networkCount} network(s)`);
  return registry;
}

/**
 * Extract addresses by contract type from registry
 *
 * Filters out:
 * - null/undefined addresses
 * - Zero addresses (0x000...000)
 * - Metadata keys (prefixed with '_')
 *
 * @param registry - Deployment registry
 * @returns Addresses grouped by contract type
 */
function extractAddressesByType(registry: DeploymentRegistry): AddressesByType {
  console.log('🔍 Extracting addresses by contract type...');

  const result: AddressesByType = {};
  const networkEntries = getNetworkEntries(registry);

  for (const contractType of CONTRACT_TYPES) {
    result[contractType] = {};

    for (const [network, deployment] of networkEntries) {
      const address = deployment[contractType];

      // Filter valid addresses (non-null, string, non-zero)
      if (
        address &&
        typeof address === 'string' &&
        address !== '0x0000000000000000000000000000000000000000'
      ) {
        result[contractType][network] = address;
      }
    }

    const count = Object.keys(result[contractType]).length;
    console.log(`  ✅ ${contractType}: ${count} deployment(s)`);
  }

  return result;
}

// =============================================================================
// Code Generation
// =============================================================================

/**
 * Generate TypeScript constant declarations from extracted addresses
 *
 * Generates export const declarations with JSDoc comments and a warning banner.
 *
 * **Limitations**:
 * - Does not preserve manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES)
 * - Does not generate helper functions (hasDeployed*, get*, etc.)
 * - Output file is separate from addresses.ts (addresses.generated.ts)
 *
 * @param addresses - Addresses by type
 * @returns Generated TypeScript code
 */
function generateTypeScriptCode(addresses: AddressesByType): string {
  console.log('📝 Generating TypeScript code...');

  const timestamp = new Date().toISOString();

  let code = `/**
 * Contract Deployment Addresses
 *
 * ⚠️  AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 *
 * Generated from: registry.json
 * Generator: scripts/generate-addresses.ts
 * Last updated: ${timestamp}
 *
 * To update addresses:
 * 1. Deploy contract: npm run deploy:<chain>
 * 2. Auto-generate: npm run generate:addresses
 * 3. Review changes and commit
 *
 * **DO NOT** manually edit this file. Changes will be overwritten.
 */

// =============================================================================
// Contract Address Constants
// =============================================================================

`;

  // Explicit mapping to match existing codebase constant names
  const CONSTANT_NAME_MAP: Record<string, string> = {
    FlashLoanArbitrage: 'FLASH_LOAN_CONTRACT_ADDRESSES',
    MultiPathQuoter: 'MULTI_PATH_QUOTER_ADDRESSES',
    PancakeSwapFlashArbitrage: 'PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES',
    BalancerV2FlashArbitrage: 'BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES',
    SyncSwapFlashArbitrage: 'SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES',
    CommitRevealArbitrage: 'COMMIT_REVEAL_ARBITRAGE_ADDRESSES',
  };

  // Generate constants for each contract type
  for (const [contractType, networkAddresses] of Object.entries(addresses)) {
    const constantName = CONSTANT_NAME_MAP[contractType]
      || `${contractType.replace(/([A-Z])/g, '_$1').toUpperCase()}_ADDRESSES`.replace(/^_/, '');

    code += `/**
 * ${contractType} contract addresses by chain.
 * Deployed contracts: ${Object.keys(networkAddresses).length}
 */
export const ${constantName}: Record<string, string> = ${JSON.stringify(
      networkAddresses,
      null,
      2
    )};

`;
  }

  // TODO: Add helper functions (hasDeployed*, get*, etc.)
  // TODO: Preserve manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES)

  code += `
// =============================================================================
// Note: Manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES) would be
// preserved here in full implementation
// =============================================================================
`;

  return code;
}

/**
 * Write generated code to file using atomic write (temp + rename).
 *
 * @param code - Generated TypeScript code
 */
function writeGeneratedFile(code: string): void {
  console.log('💾 Writing generated file to:', OUTPUT_PATH);

  // Atomic write: write to temp file, then rename to prevent corruption on crash
  const tempFile = `${OUTPUT_PATH}.tmp`;
  fs.writeFileSync(tempFile, code, 'utf8');
  fs.renameSync(tempFile, OUTPUT_PATH);

  console.log('  ✅ File written successfully');
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate extracted addresses before code generation
 *
 * Checks:
 * - Address format (0x + 40 hex characters)
 * - No zero addresses (0x000...000)
 *
 * @param addresses - Addresses to validate
 * @throws Error if any addresses are invalid
 */
function validateAddresses(addresses: AddressesByType): void {
  console.log('✓ Validating generated addresses...');

  const addressRegex = /^0x[0-9a-fA-F]{40}$/;
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  let totalAddresses = 0;
  const issues: string[] = [];

  for (const [contractType, networks] of Object.entries(addresses)) {
    for (const [network, address] of Object.entries(networks)) {
      totalAddresses++;

      if (!addressRegex.test(address)) {
        issues.push(`  ❌ ${contractType}.${network}: Invalid format: ${address}`);
      } else if (address === zeroAddress) {
        issues.push(`  ❌ ${contractType}.${network}: Zero address (placeholder)`);
      }
    }
  }

  if (issues.length > 0) {
    console.error('\n❌ Address validation failed:\n');
    issues.forEach((issue) => console.error(issue));
    throw new Error(
      `[ERR_INVALID_ADDRESSES] ${issues.length} invalid address(es) found in registry. ` +
      `Fix the registry entries and try again.`
    );
  }

  console.log(`  ✅ ${totalAddresses} total address(es) validated`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Generate addresses.generated.ts from registry.json
 *
 * Pipeline: load registry → extract by type → validate → generate TS → atomic write
 */
async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('Generate addresses.ts from registry.json');
  console.log('========================================\n');

  console.log('ℹ️  NOTE: Generates addresses.generated.ts (separate from addresses.ts)');
  console.log('   Does not overwrite manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES)\n');

  try {
    // Step 1: Load registry
    const registry = loadRegistry();

    // Step 2: Extract addresses
    const addresses = extractAddressesByType(registry);

    // Step 3: Validate
    validateAddresses(addresses);

    // Step 4: Generate code
    const code = generateTypeScriptCode(addresses);

    // Step 5: Write file
    writeGeneratedFile(code);

    console.log('\n========================================');
    console.log('✅ Generation complete');
    console.log('========================================\n');

    console.log('📋 Next steps:');
    console.log('  1. Review generated file:', OUTPUT_PATH);
    console.log('  2. Run type check: npm run typecheck');
    console.log('  3. Run tests: npm test contracts/deployments');
    console.log('  4. If valid, commit changes\n');
  } catch (error) {
    console.error('\n❌ Generation failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// Export for testing
export { loadRegistry, extractAddressesByType, generateTypeScriptCode, validateAddresses };

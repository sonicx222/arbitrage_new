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
 * **Status**: PARTIAL - Core pipeline works (load → extract → generate → write)
 * but lacks production safeguards (see TODOs below).
 *
 * **Limitations**:
 * - No address format validation (accepts any string)
 * - No atomic writes (crash during write corrupts file)
 * - Generated code does not preserve manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES)
 * - No helper functions generated (hasDeployed*, get*, etc.)
 * - Only reads from registry.json; contract-specific registries (balancer-registry.json, etc.) are ignored
 *
 * **Recommended Next Steps**:
 * 1. Test the script: npx tsx contracts/scripts/generate-addresses.ts
 * 2. Add address format validation (0x + 40 hex chars)
 * 3. Merge all contract-specific registries before extraction
 * 4. Add npm script: "generate:addresses": "tsx contracts/scripts/generate-addresses.ts"
 * 5. Add atomic file writes (temp + rename)
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
// Registry Parsing (TODO: Implement)
// =============================================================================

/**
 * Load and parse registry.json
 *
 * **TODO**: Implement error handling for:
 * - File not found
 * - Invalid JSON
 * - Schema validation
 *
 * @returns Parsed registry
 */
function loadRegistry(): DeploymentRegistry {
  // TODO: Implement
  console.log('📖 Loading registry from:', REGISTRY_PATH);

  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(
      `[ERR_NO_REGISTRY] Registry file not found: ${REGISTRY_PATH}\n` +
      `Run a deployment script first to create the registry.`
    );
  }

  const content = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const registry = JSON.parse(content) as DeploymentRegistry;

  console.log(`  ✅ Loaded ${Object.keys(registry).length} networks`);
  return registry;
}

/**
 * Extract addresses by contract type
 *
 * **TODO**: Implement extraction logic
 * - Filter out null/undefined addresses
 * - Validate address format
 * - Handle zero addresses
 *
 * @param registry - Deployment registry
 * @returns Addresses grouped by contract type
 */
function extractAddressesByType(registry: DeploymentRegistry): AddressesByType {
  // TODO: Implement
  console.log('🔍 Extracting addresses by contract type...');

  const result: AddressesByType = {};

  for (const contractType of CONTRACT_TYPES) {
    result[contractType] = {};

    for (const [network, deployment] of Object.entries(registry)) {
      const address = deployment[contractType];

      // Filter valid addresses
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
// Code Generation (TODO: Implement)
// =============================================================================

/**
 * Generate TypeScript constant declaration
 *
 * **TODO**: Improve formatting
 * - Add JSDoc comments
 * - Preserve manual sections
 * - Add warning banner
 *
 * @param addresses - Addresses by type
 * @returns Generated TypeScript code
 */
function generateTypeScriptCode(addresses: AddressesByType): string {
  // TODO: Implement proper code generation
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

  // Generate constants for each contract type
  for (const [contractType, networkAddresses] of Object.entries(addresses)) {
    const constantName = `${contractType.replace(/([A-Z])/g, '_$1').toUpperCase()}_ADDRESSES`.replace(
      /^_/,
      ''
    );

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
 * Write generated code to file
 *
 * **TODO**: Add safeguards
 * - Backup existing file
 * - Atomic write (temp + rename)
 * - Validate generated code syntax
 *
 * @param code - Generated TypeScript code
 */
function writeGeneratedFile(code: string): void {
  // TODO: Implement safeguards
  console.log('💾 Writing generated file to:', OUTPUT_PATH);

  fs.writeFileSync(OUTPUT_PATH, code, 'utf8');

  console.log('  ✅ File written successfully');
}

// =============================================================================
// Validation (TODO: Implement)
// =============================================================================

/**
 * Validate generated addresses
 *
 * **TODO**: Implement validation
 * - Address format (0x + 40 hex)
 * - No zero addresses
 * - No duplicates
 * - TypeScript compiles
 *
 * @param addresses - Addresses to validate
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
 * Generate addresses.ts from registry.json
 *
 * **Current Status**: Core pipeline functional, missing production safeguards
 * **Next Steps**: Address validation, atomic writes, multi-registry merge
 */
async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('Generate addresses.ts from registry.json');
  console.log('========================================\n');

  console.log('⚠️  NOTE: Core pipeline works but lacks production safeguards');
  console.log('   See TODOs in script for remaining work\n');

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

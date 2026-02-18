/**
 * P3-FIX 4.1 / Phase 5.3: Error Selector Auto-Generation Script
 *
 * Generates error selectors from ALL arbitrage contract ABIs to prevent
 * drift between contract and TypeScript error mappings.
 *
 * Reads ABIs from: BaseFlashArbitrage + all 5 derived contracts.
 * Deduplicates selectors (base errors appear in all derived ABIs).
 *
 * Usage:
 *   npx ts-node scripts/generate-error-selectors.ts
 *   npm run generate:error-selectors
 *
 * Output:
 *   services/execution-engine/src/strategies/error-selectors.generated.ts
 *
 * @see base.strategy.ts parseRevertReason() - uses the generated selectors
 */

import * as fs from 'fs';
import * as path from 'path';
import { keccak256, toUtf8Bytes } from 'ethers';

// =============================================================================
// Configuration
// =============================================================================

/** All arbitrage contract ABIs to scan for custom errors. */
const ABI_PATHS = [
  // Base contract (most errors defined here)
  '../contracts/artifacts/src/base/BaseFlashArbitrage.sol/BaseFlashArbitrage.json',
  // Derived contracts (may define additional errors)
  '../contracts/artifacts/src/FlashLoanArbitrage.sol/FlashLoanArbitrage.json',
  '../contracts/artifacts/src/BalancerV2FlashArbitrage.sol/BalancerV2FlashArbitrage.json',
  '../contracts/artifacts/src/PancakeSwapFlashArbitrage.sol/PancakeSwapFlashArbitrage.json',
  '../contracts/artifacts/src/SyncSwapFlashArbitrage.sol/SyncSwapFlashArbitrage.json',
  '../contracts/artifacts/src/CommitRevealArbitrage.sol/CommitRevealArbitrage.json',
].map(p => path.join(__dirname, p));

const OUTPUT_PATH = path.join(
  __dirname,
  '../services/execution-engine/src/strategies/error-selectors.generated.ts'
);

// =============================================================================
// Types
// =============================================================================

interface AbiItem {
  type: string;
  name?: string;
  inputs?: Array<{ name: string; type: string; internalType?: string }>;
}

interface AbiFile {
  contractName: string;
  abi: AbiItem[];
}

// =============================================================================
// Main
// =============================================================================

function generateErrorSelector(errorName: string, inputs: Array<{ type: string }> = []): string {
  // Build the error signature: ErrorName(type1,type2,...)
  const paramTypes = inputs.map(i => i.type).join(',');
  const signature = `${errorName}(${paramTypes})`;

  // Compute keccak256 hash and take first 4 bytes (8 hex chars + 0x prefix)
  const hash = keccak256(toUtf8Bytes(signature));
  return hash.slice(0, 10); // 0x + 8 hex chars
}

function main(): void {
  console.log('🔧 Generating error selectors from all arbitrage contract ABIs...\n');

  // Verify all ABI files exist
  const missingAbis = ABI_PATHS.filter(p => !fs.existsSync(p));
  if (missingAbis.length > 0) {
    console.error('❌ ABI file(s) not found:');
    for (const missing of missingAbis) {
      console.error(`   ${path.relative(path.join(__dirname, '..'), missing)}`);
    }
    console.error('   Run `cd contracts && npx hardhat compile` first.');
    process.exit(1);
  }

  // Generate selectors with collision detection across ALL contracts
  const selectors: Array<{ selector: string; name: string; signature: string; source: string }> = [];
  const selectorMap = new Map<string, { name: string; signature: string; source: string }>();

  for (const abiPath of ABI_PATHS) {
    const abiFile: AbiFile = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
    const contractName = abiFile.contractName;
    const errors = abiFile.abi.filter(item => item.type === 'error');

    if (errors.length === 0) continue;

    console.log(`${contractName}: ${errors.length} errors`);

    for (const error of errors) {
      if (!error.name) continue;

      const selector = generateErrorSelector(error.name, error.inputs || []);
      const paramTypes = (error.inputs || []).map(i => i.type).join(',');
      const signature = `${error.name}(${paramTypes})`;

      if (selectorMap.has(selector)) {
        const existing = selectorMap.get(selector)!;
        if (existing.signature === signature) {
          // Same error inherited from base — skip duplicate
          continue;
        }
        // TRUE collision: different error signatures produce the same 4-byte selector
        console.error(`\n❌ ERROR: Selector collision detected!`);
        console.error(`   Selector: ${selector}`);
        console.error(`   Error 1:  ${existing.signature} (from ${existing.source})`);
        console.error(`   Error 2:  ${signature} (from ${contractName})`);
        console.error(`\n   This is extremely rare (1 in 4 billion) but must be fixed in the contract.`);
        process.exit(1);
      }

      selectorMap.set(selector, { name: error.name, signature, source: contractName });
      selectors.push({ selector, name: error.name, signature, source: contractName });
      console.log(`  ${selector} => ${error.name}`);
    }
  }

  if (selectors.length === 0) {
    console.warn('⚠️  No custom errors found in any ABI');
    process.exit(0);
  }

  // Sort by selector for consistent output
  selectors.sort((a, b) => a.selector.localeCompare(b.selector));

  // Generate output file
  const timestamp = new Date().toISOString();
  const contractSources = ABI_PATHS.map(p => path.relative(path.join(__dirname, '..'), p));
  const output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 *
 * Generated by: scripts/generate-error-selectors.ts
 * Generated at: ${timestamp}
 * Contracts: ${contractSources.length} ABIs scanned
 * Sources:
${contractSources.map(s => ` *   - ${s}`).join('\n')}
 *
 * To regenerate, run: npm run generate:error-selectors
 *
 * @see base.strategy.ts - parseRevertReason() uses these selectors
 */

// =============================================================================
// Custom Error Selectors
// =============================================================================

/**
 * Mapping of 4-byte error selectors to error names.
 * Selectors are computed as: keccak256(ErrorName(types...)).slice(0, 10)
 */
export const CUSTOM_ERROR_SELECTORS: Record<string, string> = {
${selectors.map(s => `  '${s.selector}': '${s.name}', // ${s.signature}`).join('\n')}
};

/**
 * Reverse mapping: error name to selector
 */
export const ERROR_NAME_TO_SELECTOR: Record<string, string> = {
${selectors.map(s => `  '${s.name}': '${s.selector}',`).join('\n')}
};

/**
 * All known error signatures (for debugging/documentation)
 */
export const ERROR_SIGNATURES: Record<string, string> = {
${selectors.map(s => `  '${s.name}': '${s.signature}',`).join('\n')}
};

/**
 * Check if a selector matches a known custom error
 */
export function isKnownErrorSelector(selector: string): boolean {
  return Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_SELECTORS, selector.toLowerCase());
}

/**
 * Get error name from selector (returns undefined if not found)
 */
export function getErrorName(selector: string): string | undefined {
  return CUSTOM_ERROR_SELECTORS[selector.toLowerCase()];
}
`;

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output file
  fs.writeFileSync(OUTPUT_PATH, output, 'utf-8');

  console.log(`\n✅ Generated ${selectors.length} error selectors`);
  console.log(`   Output: ${OUTPUT_PATH}`);
}

// Run if executed directly
main();

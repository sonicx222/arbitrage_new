/**
 * Update Configuration Helper for Balancer V2 Deployments
 *
 * This script reads deployment artifacts and generates the configuration
 * updates needed for service-config.ts and addresses.ts.
 *
 * Usage:
 *   npx ts-node scripts/update-balancer-config.ts              # Print config snippets
 *   npx ts-node scripts/update-balancer-config.ts --write      # Auto-update addresses.ts
 *
 * Output:
 *   Prints configuration snippets that can be copy-pasted into config files
 *
 * P2-009 FIX: Added --write flag to auto-update contracts/deployments/addresses.ts
 * Note: service-config.ts and execution-engine config still require manual updates
 * due to complex TypeScript AST manipulation requirements.
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeNetworkName } from './lib/deployment-utils'; // P1-004 FIX: Import normalization

// =============================================================================
// Types
// =============================================================================

interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  vaultAddress: string;
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  minimumProfit: string;
  approvedRouters: string[];
  flashLoanFee: string;
  verified: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Load deployment registry
 */
function loadDeploymentRegistry(): Record<string, DeploymentResult> {
  const registryPath = path.join(__dirname, '..', 'deployments', 'balancer-registry.json');

  if (!fs.existsSync(registryPath)) {
    console.error('❌ Deployment registry not found at:', registryPath);
    console.log('\nRun deployment script first:');
    console.log('  npx hardhat run scripts/deploy-balancer.ts --network <network>');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  return registry;
}

/**
 * Generate service-config.ts FLASH_LOAN_PROVIDERS entries
 */
function generateFlashLoanProvidersConfig(
  deployments: Record<string, DeploymentResult>
): string {
  const lines: string[] = [];

  lines.push('// =============================================================================');
  lines.push('// Balancer V2 Flash Loan Providers (Task 2.2)');
  lines.push('// =============================================================================');
  lines.push('// Copy these entries into FLASH_LOAN_PROVIDERS in service-config.ts');
  lines.push('// REPLACE the corresponding Aave V3 entries to save 0.09% on flash loans');
  lines.push('// =============================================================================\n');

  for (const [network, deployment] of Object.entries(deployments).sort()) {
    // P1-004 FIX: Normalize network name for consistent lookups
    const normalizedNetwork = normalizeNetworkName(network);
    lines.push(`  ${normalizedNetwork}: {`);
    lines.push(`    address: '${deployment.vaultAddress}',  // Balancer V2 Vault`);
    lines.push(`    protocol: 'balancer_v2',`);
    lines.push(`    fee: 0  // 0% flash loan fee (saves 0.09% vs Aave V3)`);
    lines.push(`  },`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate contractAddresses config for FlashLoanStrategy
 */
function generateContractAddressesConfig(
  deployments: Record<string, DeploymentResult>
): string {
  const lines: string[] = [];

  lines.push('// =============================================================================');
  lines.push('// BalancerV2FlashArbitrage Contract Addresses (Task 2.2)');
  lines.push('// =============================================================================');
  lines.push('// Copy these entries into FlashLoanStrategyConfig.contractAddresses');
  lines.push('// =============================================================================\n');

  lines.push('contractAddresses: {');
  for (const [network, deployment] of Object.entries(deployments).sort()) {
      const normalizedNetwork = normalizeNetworkName(network);
    lines.push(`  ${normalizedNetwork}: '${deployment.contractAddress}',  // BalancerV2FlashArbitrage`);
  }
  lines.push('},');

  return lines.join('\n');
}

/**
 * Generate approvedRouters config
 */
function generateApprovedRoutersConfig(
  deployments: Record<string, DeploymentResult>
): string {
  const lines: string[] = [];

  lines.push('// =============================================================================');
  lines.push('// Approved DEX Routers for Balancer V2 (Task 2.2)');
  lines.push('// =============================================================================');
  lines.push('// Copy these entries into FlashLoanStrategyConfig.approvedRouters');
  lines.push('// =============================================================================\n');

  lines.push('approvedRouters: {');
  for (const [network, deployment] of Object.entries(deployments).sort()) {
    const normalizedNetwork = normalizeNetworkName(network);
    lines.push(`  ${normalizedNetwork}: [`);
    for (const router of deployment.approvedRouters) {
      lines.push(`    '${router}',`);
    }
    lines.push(`  ],`);
  }
  lines.push('},');

  return lines.join('\n');
}

/**
 * Generate deployment summary
 */
function generateDeploymentSummary(
  deployments: Record<string, DeploymentResult>
): string {
  const lines: string[] = [];

  lines.push('╔═══════════════════════════════════════════════════════════════════╗');
  lines.push('║         Balancer V2 Flash Arbitrage Deployment Summary           ║');
  lines.push('╚═══════════════════════════════════════════════════════════════════╝\n');

  for (const [network, deployment] of Object.entries(deployments).sort()) {
    lines.push(`📍 ${network.toUpperCase()} (Chain ID: ${deployment.chainId})`);
    lines.push(`   Contract:     ${deployment.contractAddress}`);
    lines.push(`   Vault:        ${deployment.vaultAddress}`);
    lines.push(`   Verified:     ${deployment.verified ? '✅ Yes' : '❌ No'}`);
    lines.push(`   Transaction:  ${deployment.transactionHash}`);
    lines.push(`   Block:        ${deployment.blockNumber}`);
    lines.push(`   Routers:      ${deployment.approvedRouters.length} approved`);
    lines.push('');
  }

  const totalDeployments = Object.keys(deployments).length;
  const verifiedDeployments = Object.values(deployments).filter((d) => d.verified).length;

  lines.push(`✅ Deployed:  ${totalDeployments}/6 chains`);
  lines.push(`✅ Verified:  ${verifiedDeployments}/${totalDeployments} contracts`);
  lines.push(`💰 Fee:       0% (vs Aave V3's 0.09%)`);
  lines.push(`💸 Savings:   $90 per $100K flash loan`);

  return lines.join('\n');
}

/**
 * Generate environment variable template
 */
function generateEnvTemplate(deployments: Record<string, DeploymentResult>): string {
  const lines: string[] = [];

  lines.push('# =============================================================================');
  lines.push('# Balancer V2 Flash Loan Configuration (Task 2.2)');
  lines.push('# =============================================================================');
  lines.push('# Add these to your .env file');
  lines.push('# =============================================================================\n');

  for (const [network, deployment] of Object.entries(deployments).sort()) {
    const envPrefix = network.toUpperCase();
    lines.push(`# ${network.charAt(0).toUpperCase() + network.slice(1)}`);
    lines.push(
      `BALANCER_V2_CONTRACT_${envPrefix}=${deployment.contractAddress}  # BalancerV2FlashArbitrage`
    );
    lines.push(`BALANCER_V2_VAULT_${envPrefix}=${deployment.vaultAddress}  # Balancer V2 Vault`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * P2-009 FIX: Auto-update contracts/deployments/addresses.ts with deployed addresses
 */
function autoUpdateAddressesFile(deployments: Record<string, DeploymentResult>): void {
  const addressesPath = path.join(__dirname, '..', 'deployments', 'addresses.ts');

  if (!fs.existsSync(addressesPath)) {
    console.error(`❌ [ERR_FILE_NOT_FOUND] addresses.ts not found at: ${addressesPath}`);
    return;
  }

  let content = fs.readFileSync(addressesPath, 'utf8');
  let modified = false;

  // Update BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES constant
  const addressesRegex = /export const BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES:\s*Record<string,\s*string>\s*=\s*\{[^}]*\}/s;

  if (addressesRegex.test(content)) {
    // Build new addresses object
    const addressesEntries = Object.entries(deployments)
      .sort()
      .map(([network, deployment]) => {
        const normalizedNetwork = normalizeNetworkName(network);
        return `  ${normalizedNetwork}: '${deployment.contractAddress}', // BalancerV2FlashArbitrage (deployed ${new Date(deployment.timestamp * 1000).toISOString().split('T')[0]})`;
      })
      .join('\n');

    const newAddressesBlock = `export const BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = {\n${addressesEntries}\n}`;

    content = content.replace(addressesRegex, newAddressesBlock);
    modified = true;
  } else {
    console.warn('⚠️  Warning: BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES constant not found in addresses.ts');
    console.warn('   Manual update required');
  }

  if (modified) {
    // Write updated content back to file
    fs.writeFileSync(addressesPath, content, 'utf8');
    console.log(`✅ Updated: contracts/deployments/addresses.ts`);
    console.log(`   Updated BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES with ${Object.keys(deployments).length} networks\n`);
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

function main(): void {
  // P2-009 FIX: Check for --write flag
  const shouldAutoUpdate = process.argv.includes('--write');

  console.log('\n🔧 Balancer V2 Configuration Update Helper\n');

  if (shouldAutoUpdate) {
    console.log('🔒 Auto-update mode enabled (--write flag detected)\n');
  }

  // Load deployments
  const deployments = loadDeploymentRegistry();

  if (Object.keys(deployments).length === 0) {
    console.log('❌ No deployments found in registry');
    console.log('\nDeploy contracts first:');
    console.log('  npx hardhat run scripts/deploy-balancer.ts --network ethereum');
    process.exit(1);
  }

  // P2-009 FIX: Auto-update addresses.ts if --write flag is present
  if (shouldAutoUpdate) {
    console.log('═'.repeat(75));
    console.log('AUTO-UPDATE: contracts/deployments/addresses.ts');
    console.log('═'.repeat(75));
    console.log();
    autoUpdateAddressesFile(deployments);
  }

  // Print summary
  console.log(generateDeploymentSummary(deployments));
  console.log('\n');

  // Print configuration updates
  console.log('═'.repeat(75));
  console.log('1️⃣  UPDATE: shared/config/src/service-config.ts');
  console.log('═'.repeat(75));
  console.log('\nIn FLASH_LOAN_PROVIDERS, REPLACE the Aave V3 entries with:\n');
  console.log(generateFlashLoanProvidersConfig(deployments));
  console.log('\n');

  console.log('═'.repeat(75));
  console.log('2️⃣  UPDATE: services/execution-engine FlashLoanStrategy initialization');
  console.log('═'.repeat(75));
  console.log('\n');
  console.log(generateContractAddressesConfig(deployments));
  console.log('\n');
  console.log(generateApprovedRoutersConfig(deployments));
  console.log('\n');

  console.log('═'.repeat(75));
  console.log('3️⃣  OPTIONAL: Add to .env file');
  console.log('═'.repeat(75));
  console.log('\n');
  console.log(generateEnvTemplate(deployments));
  console.log('\n');

  console.log('═'.repeat(75));
  console.log('✅ NEXT STEPS');
  console.log('═'.repeat(75));

  if (shouldAutoUpdate) {
    console.log('\n✅ addresses.ts has been auto-updated');
    console.log('\n⚠️  Manual updates still required:');
    console.log('1. Copy service-config.ts snippets above into shared/config/src/service-config.ts');
    console.log('2. Copy FlashLoanStrategy config snippets into execution-engine config');
    console.log('3. Restart services to load new configuration: npm run dev:stop && npm run dev:all');
    console.log('4. Run integration tests to verify deployment');
    console.log('5. Monitor flash loan metrics for success rate and fee savings');
    console.log('6. Update implementation plan document (Task 2.2 → Complete)');
  } else {
    console.log('\n💡 TIP: Run with --write flag to auto-update addresses.ts:');
    console.log('   npx ts-node scripts/update-balancer-config.ts --write\n');
    console.log('📋 Manual steps required:');
    console.log('1. Copy the configuration snippets above into the respective files');
    console.log('2. Or run with --write to auto-update addresses.ts');
    console.log('3. Restart services to load new configuration');
    console.log('4. Run integration tests to verify deployment');
    console.log('5. Monitor flash loan metrics for success rate and fee savings');
    console.log('6. Update implementation plan document (Task 2.2 → Complete)');
  }

  console.log('\n🎉 You\'ll save 0.09% on every flash loan with Balancer V2!\n');
}

// Run the script
main();

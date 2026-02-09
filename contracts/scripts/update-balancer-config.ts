/**
 * Update Configuration Helper for Balancer V2 Deployments
 *
 * This script reads deployment artifacts and generates the configuration
 * updates needed for service-config.ts and addresses.ts.
 *
 * Usage:
 *   npx ts-node scripts/update-balancer-config.ts
 *
 * Output:
 *   Prints configuration snippets that can be copy-pasted into config files
 */

import * as fs from 'fs';
import * as path from 'path';

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
    lines.push(`  ${network}: {`);
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
    lines.push(`  ${network}: '${deployment.contractAddress}',  // BalancerV2FlashArbitrage`);
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
    lines.push(`  ${network}: [`);
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

// =============================================================================
// Main Entry Point
// =============================================================================

function main(): void {
  console.log('\n🔧 Balancer V2 Configuration Update Helper\n');

  // Load deployments
  const deployments = loadDeploymentRegistry();

  if (Object.keys(deployments).length === 0) {
    console.log('❌ No deployments found in registry');
    console.log('\nDeploy contracts first:');
    console.log('  npx hardhat run scripts/deploy-balancer.ts --network ethereum');
    process.exit(1);
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
  console.log('\n1. Copy the configuration snippets above into the respective files');
  console.log('2. Restart services to load new configuration');
  console.log('3. Run integration tests to verify deployment');
  console.log('4. Monitor flash loan metrics for success rate and fee savings');
  console.log('5. Update implementation plan document (Task 2.2 → Complete)');
  console.log('\n🎉 You\'ll save 0.09% on every flash loan with Balancer V2!\n');
}

// Run the script
main();

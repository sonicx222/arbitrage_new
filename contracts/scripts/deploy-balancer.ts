/**
 * Balancer V2 Flash Arbitrage Contract Deployment Script
 *
 * Deploys the BalancerV2FlashArbitrage contract to supported networks.
 * Task 2.2: Balancer V2 Flash Loan Provider deployment across 6 chains.
 *
 * Key Advantages over Aave V3:
 * - 0% flash loan fees (vs Aave V3's 0.09%)
 * - Single Vault architecture (no pool discovery needed)
 * - Massive liquidity across all Balancer pools
 *
 * Usage:
 *   npx hardhat run scripts/deploy-balancer.ts --network ethereum
 *   npx hardhat run scripts/deploy-balancer.ts --network polygon
 *   npx hardhat run scripts/deploy-balancer.ts --network arbitrum
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum
 *   POLYGONSCAN_API_KEY - For contract verification on Polygon
 *   ARBISCAN_API_KEY - For contract verification on Arbitrum
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.2
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */

import { network } from 'hardhat';
import { BALANCER_V2_VAULTS } from '@arbitrage/config';
import {
  normalizeNetworkName,
  saveDeploymentResult,
  printDeploymentSummary,
  confirmMainnetDeployment,
  checkExistingDeployment,
  deployContractPipeline,
  type DeploymentPipelineConfig,
} from './lib/deployment-utils';

// =============================================================================
// Pipeline Configuration
// =============================================================================

function buildConfig(vaultAddress: string): DeploymentPipelineConfig {
  return {
    contractName: 'BalancerV2FlashArbitrage',
    registryName: 'balancer-registry.json',
    contractFactoryName: 'BalancerV2FlashArbitrage',
    constructorArgs: (deployer) => [vaultAddress, deployer],
    configureMinProfit: true,
    configureRouters: true,
    protocol: 'balancer',
    smokeTest: 'flashLoan',
    resultExtras: {
      vaultAddress,
      flashLoanFee: '0', // Balancer V2 has 0% fees
    },
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printNextSteps(result: Record<string, any>, networkName: string): void {
  // Print cost savings vs Aave V3 (preserved messaging)
  console.log('\nCost Savings vs Aave V3:');
  console.log('   Flash Loan Fee: 0% (vs Aave V3\'s 0.09%)');
  console.log('   Example: On a $100K flash loan, save $90 per trade!');
  console.log('========================================\n');

  console.log('Deployment complete!');
  console.log('\nNEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.vaultAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update service-config.ts:`);
  console.log(`   - Add contractAddress for ${networkName} in FLASH_LOAN_PROVIDERS`);
  console.log(`   - Set protocol: 'balancer_v2', fee: 0\n`);

  console.log(`${!result.verified ? '3' : '2'}. Update execution-engine config:`);
  console.log(`   - Add ${result.contractAddress} to contractAddresses.${networkName}`);
  console.log(`   - Add routers to approvedRouters.${networkName}\n`);

  console.log(`${!result.verified ? '4' : '3'}. Test deployment:`);
  console.log(`   - Run integration tests on ${networkName}`);
  console.log(`   - Verify router approvals are working`);
  console.log(`   - Execute a small test arbitrage\n`);

  console.log(`${!result.verified ? '5' : '4'}. Monitor metrics:`);
  console.log('   - Track flash loan success rate');
  console.log('   - Compare profit margins vs Aave V3');
  console.log('   - Monitor gas costs\n');

  console.log('Tip: Uncomment the Balancer V2 entry in service-config.ts');
  console.log('   to replace Aave V3 and start saving 0.09% on every flash loan!');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'BalancerV2FlashArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'BalancerV2FlashArbitrage');

  // Get Vault address for the network
  const vaultAddress = BALANCER_V2_VAULTS[networkName];
  if (!vaultAddress) {
    throw new Error(
      `[ERR_NO_VAULT] Balancer V2 Vault address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(BALANCER_V2_VAULTS).join(', ')}\n\n` +
        `To add support for ${networkName}:\n` +
        `1. Find the Balancer V2 Vault address from: https://docs.balancer.fi/reference/contracts/deployment-addresses.html\n` +
        `2. Add to shared/config/src/addresses.ts: BALANCER_V2_VAULTS\n` +
        `3. Re-export in contracts/deployments/addresses.ts`
    );
  }

  console.log(`\nStarting BalancerV2FlashArbitrage deployment to ${networkName}...`);
  console.log('Flash Loan Fee: 0% (Balancer V2 advantage!)');

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(buildConfig(vaultAddress));

  // Save and print summary
  await saveDeploymentResult(result as any, 'balancer-registry.json', 'BalancerV2FlashArbitrage');
  printDeploymentSummary(result as any);
  printNextSteps(result, networkName);
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

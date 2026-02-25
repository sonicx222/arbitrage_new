/**
 * MultiPathQuoter Contract Deployment Script
 *
 * Deploys the MultiPathQuoter contract to supported networks.
 * This contract batches multiple getAmountsOut() calls into a single RPC request,
 * reducing quote latency from ~150ms to ~50ms for typical arbitrage paths.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network sepolia
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network ethereum
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrum
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment wallet
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum/Sepolia
 *
 * @see ADR-029: Batched Quote Fetching
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 1 Task 1.2
 */

import { network } from 'hardhat';
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

/**
 * MultiPathQuoter is a stateless utility contract that only provides batched
 * price quotes. It has no owner, no profit threshold, and no router config.
 */
const PIPELINE_CONFIG: DeploymentPipelineConfig = {
  contractName: 'MultiPathQuoter',
  registryName: 'multi-path-quoter-registry.json',
  contractFactoryName: 'MultiPathQuoter',
  constructorArgs: () => [],
  configureMinProfit: false,
  configureRouters: false,
  smokeTest: 'multiPathQuoter',
};

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printMultiPathQuoterNextSteps(result: Record<string, any>): void {
  console.log('MULTI-PATH QUOTER SPECIFIC STEPS:');
  console.log('');
  console.log('1. Update contract addresses in TWO configuration files:');
  console.log('');
  console.log('   a) shared/config/src/service-config.ts');
  console.log(`      UPDATE: MULTI_PATH_QUOTER_ADDRESSES['${result.network}'] = '${result.contractAddress}';`);
  console.log('');
  console.log('   b) contracts/deployments/addresses.ts');
  console.log(`      UPDATE: MULTI_PATH_QUOTER_ADDRESSES['${result.network}'] = '${result.contractAddress}';`);
  console.log('');
  console.log('   NOTE: Update BOTH files to keep them in sync. In the future, this will be');
  console.log('   auto-generated. See contracts/deployments/README.md for details.');
  console.log('');
  console.log('2. Validate the updates:');
  console.log(`   npm run typecheck`);
  console.log(`   npm test contracts/deployments`);
  console.log('');
  console.log('3. Test the deployment on-chain:');
  console.log(`   npx hardhat console --network ${result.network}`);
  console.log(`   > const quoter = await ethers.getContractAt('MultiPathQuoter', '${result.contractAddress}');`);
  console.log(`   > await quoter.getBatchedQuotes([...]); // Test with real quote requests`);
  console.log('');
  console.log('4. Enable feature flag in environment (.env.local):');
  console.log(`   FEATURE_BATCHED_QUOTER=true`);
  console.log(`   MULTI_PATH_QUOTER_${result.network.toUpperCase()}=${result.contractAddress}`);
  console.log('');
  console.log('5. Restart services to pick up new configuration:');
  console.log(`   npm run dev:stop && npm run dev:all`);
  console.log('');

  if (!result.verified) {
    console.log('Contract not verified. To verify manually:');
    console.log(`   npx hardhat verify --network ${result.network} ${result.contractAddress}`);
    console.log('');
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'MultiPathQuoter');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'MultiPathQuoter');

  console.log(`\nStarting MultiPathQuoter deployment to ${networkName}...`);

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(PIPELINE_CONFIG);

  // Save and print summary
  await saveDeploymentResult(result, 'multi-path-quoter-registry.json', 'MultiPathQuoter');
  printDeploymentSummary(result);
  printMultiPathQuoterNextSteps(result);

  console.log('Deployment complete!');
  console.log('\nIMPORTANT: Remember to update service-config.ts with the deployed address!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

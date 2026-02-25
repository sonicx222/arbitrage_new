/**
 * Flash Loan Arbitrage Contract Deployment Script
 *
 * Deploys the FlashLoanArbitrage contract to supported networks.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum
 *   ARBISCAN_API_KEY - For contract verification on Arbitrum
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 (Flash Loan Arbitrage)
 */

import { network } from 'hardhat';
import { AAVE_V3_POOL_ADDRESSES } from '../deployments/addresses';
import {
  saveDeploymentResult,
  printDeploymentSummary,
  normalizeNetworkName,
  confirmMainnetDeployment,
  checkExistingDeployment,
  deployContractPipeline,
  type DeploymentPipelineConfig,
} from './lib/deployment-utils';

// =============================================================================
// Pipeline Configuration
// =============================================================================

function buildConfig(aavePoolAddress: string): DeploymentPipelineConfig {
  return {
    contractName: 'FlashLoanArbitrage',
    registryName: 'registry.json',
    contractFactoryName: 'FlashLoanArbitrage',
    constructorArgs: (deployer) => [aavePoolAddress, deployer],
    configureMinProfit: true,
    configureRouters: true,
    protocol: 'aave',
    smokeTest: 'flashLoan',
    resultExtras: { aavePoolAddress },
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printNextSteps(result: Record<string, any>, networkName: string): void {
  console.log('NEXT STEPS:\n');

  let stepNumber = 1;

  if (!result.verified) {
    console.log(`${stepNumber}. Verify contract manually:`);
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.aavePoolAddress} ${result.ownerAddress}\n`);
    stepNumber++;
  }

  if (result.ownerAddress !== result.deployerAddress) {
    console.log(`${stepNumber}. Transfer ownership to multisig (if needed):`);
    console.log(`   From owner account: await contract.acceptOwnership();\n`);
    stepNumber++;
  }

  console.log(`${stepNumber}. Update contract address in configuration:`);
  console.log(`   File: contracts/deployments/addresses.ts`);
  console.log(`   UPDATE: FLASH_LOAN_CONTRACT_ADDRESSES['${networkName}'] = '${result.contractAddress}';`);
  console.log(`   (Uncomment the line and replace placeholder address)\n`);
  stepNumber++;

  console.log(`${stepNumber}. Validate the update:`);
  console.log(`   npm run typecheck`);
  console.log(`   npm test contracts/deployments\n`);
  stepNumber++;

  console.log(`${stepNumber}. Restart services to pick up new configuration:`);
  console.log(`   npm run dev:stop && npm run dev:all\n`);

  console.log('For detailed deployment workflow, see: contracts/deployments/README.md\n');
  console.log('Deployment complete!\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'FlashLoanArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'FlashLoanArbitrage');

  // Get Aave Pool address for the network
  const aavePoolAddress = AAVE_V3_POOL_ADDRESSES[networkName];
  if (!aavePoolAddress) {
    throw new Error(
      `[ERR_NO_AAVE_POOL] Aave V3 Pool address not configured for network: ${networkName}\n` +
      `Supported networks: ${Object.keys(AAVE_V3_POOL_ADDRESSES).join(', ')}\n\n` +
      `To add support for ${networkName}:\n` +
      `1. Find the Aave V3 Pool address from: https://docs.aave.com/developers/deployed-contracts/v3-mainnet\n` +
      `2. Add to shared/config/src/addresses.ts: AAVE_V3_POOLS\n` +
      `3. Add to contracts/deployments/addresses.ts re-export`
    );
  }

  console.log(`\nStarting FlashLoanArbitrage deployment to ${networkName}...`);

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(buildConfig(aavePoolAddress));

  // Save and print summary
  await saveDeploymentResult(result, 'registry.json', 'FlashLoanArbitrage');
  printDeploymentSummary(result);
  printNextSteps(result, networkName);
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

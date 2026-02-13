/**
 * PancakeSwap V3 Flash Arbitrage Contract Deployment Script
 *
 * Deploys the PancakeSwapFlashArbitrage contract to supported networks.
 * Task 2.1 (C4): Includes batch pool whitelisting for efficient deployment.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-pancakeswap.ts --network bsc
 *   npx hardhat run scripts/deploy-pancakeswap.ts --network arbitrum
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   BSCSCAN_API_KEY - For contract verification on BSC
 *   ARBISCAN_API_KEY - For contract verification on Arbitrum
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.1
 */

import { network } from 'hardhat';
import { PANCAKESWAP_V3_FACTORIES } from '@arbitrage/config';
import {
  normalizeNetworkName,
  saveDeploymentResult,
  printDeploymentSummary,
  confirmMainnetDeployment,
  checkExistingDeployment,
  deployContractPipeline,
  type DeploymentPipelineConfig,
} from './lib/deployment-utils';
import {
  getCommonTokenPairs,
  discoverPools,
} from './lib/pancakeswap-utils';

// =============================================================================
// Pipeline Configuration
// =============================================================================

function buildConfig(factoryAddress: string): DeploymentPipelineConfig {
  return {
    contractName: 'PancakeSwapFlashArbitrage',
    registryName: 'pancakeswap-registry.json',
    contractFactoryName: 'PancakeSwapFlashArbitrage',
    constructorArgs: (deployer) => [factoryAddress, deployer],
    configureMinProfit: true,
    configureRouters: true,
    protocol: 'pancakeswap',
    smokeTest: 'flashLoan',
    resultExtras: { factoryAddress },
    postDeploy: async (contract, networkName) => {
      // Task 2.1 (C4): Batch whitelist common pools during deployment
      const whitelistedPools: string[] = [];

      console.log('\nWhitelisting common pools...');
      const tokenPairs = getCommonTokenPairs(networkName);

      if (tokenPairs.length > 0) {
        const discoveredPools = await discoverPools(factoryAddress, tokenPairs);

        if (discoveredPools.length > 0) {
          const poolAddresses = discoveredPools.map((p) => p.pool);

          console.log(`  Batch whitelisting ${poolAddresses.length} pools...`);
          const tx = await contract.whitelistMultiplePools(poolAddresses);
          const whitelistReceipt = await tx.wait();

          console.log(`  Whitelisted ${poolAddresses.length} pools (Gas used: ${whitelistReceipt?.gasUsed})`);

          for (const pool of discoveredPools) {
            console.log(`     - ${pool.pair} (${pool.feePercent}): ${pool.pool}`);
          }

          whitelistedPools.push(...poolAddresses);
        } else {
          console.log('  No pools discovered (factory might not have liquidity yet)');
        }
      } else {
        console.log('  No common token pairs configured for this network');
      }

      return { whitelistedPools };
    },
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printNextSteps(result: Record<string, any>, networkName: string): void {
  console.log('Deployment complete!');
  console.log('\nNEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.factoryAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update contract address in configuration:`);
  console.log(`   File: contracts/deployments/addresses.ts`);
  console.log(`   Update: PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES.${networkName} = '${result.contractAddress}';\n`);

  const whitelistedCount = result.whitelistedPools?.length ?? 0;
  console.log(`${!result.verified ? '3' : '2'}. Test the deployment:`);
  console.log(`   - Verify router approvals: ${result.approvedRouters?.length ?? 0} routers`);
  console.log(`   - Verify pool whitelisting: ${whitelistedCount} pools`);
  console.log(`   - Execute a small test arbitrage\n`);

  console.log(`${!result.verified ? '4' : '3'}. Restart services to pick up new configuration\n`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'PancakeSwapFlashArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'PancakeSwapFlashArbitrage');

  // Get Factory address for the network
  const factoryAddress = PANCAKESWAP_V3_FACTORIES[networkName];
  if (!factoryAddress) {
    throw new Error(
      `[ERR_NO_FACTORY] PancakeSwap V3 Factory address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(PANCAKESWAP_V3_FACTORIES).join(', ')}\n\n` +
        `To add support for ${networkName}:\n` +
        `1. Find the PancakeSwap V3 Factory address from: https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts\n` +
        `2. Add to shared/config/src/addresses.ts: PANCAKESWAP_V3_FACTORIES\n` +
        `3. Re-export in contracts/deployments/addresses.ts`
    );
  }

  console.log(`\nStarting PancakeSwapFlashArbitrage deployment to ${networkName}...`);

  // Deploy via shared pipeline (includes pool whitelisting in postDeploy)
  const { result } = await deployContractPipeline(buildConfig(factoryAddress));

  // Save and print summary
  await saveDeploymentResult(result as any, 'pancakeswap-registry.json', 'PancakeSwapFlashArbitrage');
  printDeploymentSummary(result as any);
  printNextSteps(result, networkName);
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

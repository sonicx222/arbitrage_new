/**
 * SyncSwap Flash Arbitrage Contract Deployment Script
 *
 * Deploys the SyncSwapFlashArbitrage contract to zkSync Era (testnet/mainnet).
 * Task 3.4: SyncSwap Flash Loan Provider deployment on zkSync Era.
 *
 * Key Advantages:
 * - EIP-3156 standard compliance
 * - 0.3% flash loan fee (competitive on zkSync Era)
 * - Vault-based architecture (no pool discovery needed)
 * - zkSync Era L2 optimizations
 *
 * Usage:
 *   npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet
 *   npx hardhat run scripts/deploy-syncswap.ts --network zksync-mainnet
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   ZKSYNC_ETHERSCAN_API_KEY - For contract verification (optional)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.4
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */

import { network } from 'hardhat';
import { SYNCSWAP_VAULTS } from '@arbitrage/config';
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
    contractName: 'SyncSwapFlashArbitrage',
    registryName: 'syncswap-registry.json',
    contractFactoryName: 'SyncSwapFlashArbitrage',
    constructorArgs: (deployer) => [vaultAddress, deployer],
    configureMinProfit: true,
    configureRouters: true,
    protocol: 'syncswap',
    smokeTest: 'flashLoan',
    resultExtras: {
      vaultAddress,
      flashLoanFee: '30', // 0.3% = 30 bps
    },
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printNextSteps(result: Record<string, any>, networkName: string): void {
  // Print cost comparison vs other protocols (preserved messaging)
  console.log('\nFlash Loan Fee Comparison:');
  console.log('   SyncSwap:   0.3% (30 bps) - This deployment');
  console.log('   Aave V3:    0.09% (9 bps) - Cheaper but not on zkSync Era');
  console.log('   Balancer:   0% - Cheapest but not on zkSync Era');
  console.log('   Note: SyncSwap is currently the best option for zkSync Era flash loans');
  console.log('========================================\n');

  console.log('Deployment complete!');
  console.log('\nNEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.vaultAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update .env file:`);
  console.log(`   ZKSYNC_FLASH_LOAN_CONTRACT=${result.contractAddress}`);
  console.log(`   ZKSYNC_APPROVED_ROUTERS=${(result.approvedRouters ?? []).join(',')}\n`);

  console.log(`${!result.verified ? '3' : '2'}. Update execution-engine config:`);
  console.log(`   contractAddresses: { zksync: '${result.contractAddress}' }`);
  console.log(`   approvedRouters: { zksync: ${JSON.stringify(result.approvedRouters ?? [])} }\n`);

  console.log(`${!result.verified ? '4' : '3'}. Test deployment:`);
  console.log(`   - Restart execution engine: npm run dev:execution:fast`);
  console.log(`   - Check logs for: "Created SyncSwap provider for zksync"`);
  console.log(`   - Run integration tests (if available)\n`);

  console.log(`${!result.verified ? '5' : '4'}. Monitor metrics:`);
  console.log('   - Track flash loan success rate');
  console.log('   - Compare profit margins vs other protocols');
  console.log('   - Monitor gas costs on zkSync Era\n');

  console.log('Tip: SyncSwap charges 0.3% flash loan fee (30 bps)');
  console.log('   This is competitive on zkSync Era where Aave V3 and Balancer V2');
  console.log('   are not yet deployed. Factor this into profit calculations!');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'SyncSwapFlashArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'SyncSwapFlashArbitrage');

  // Get Vault address for the network
  const vaultAddress = SYNCSWAP_VAULTS[networkName];
  if (!vaultAddress) {
    throw new Error(
      `[ERR_NO_VAULT] SyncSwap Vault address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(SYNCSWAP_VAULTS).join(', ')}\n\n` +
        `Available networks:\n` +
        `  - zksync-mainnet (or zksync): zkSync Era Mainnet\n` +
        `  - zksync-testnet (or zksync-sepolia): zkSync Era Sepolia Testnet\n\n` +
        `To add support for ${networkName}:\n` +
        `1. Find the SyncSwap Vault address from: https://syncswap.xyz/\n` +
        `2. Add to shared/config/src/addresses.ts: SYNCSWAP_VAULTS\n` +
        `3. Re-export in contracts/deployments/addresses.ts`
    );
  }

  console.log(`\nStarting SyncSwapFlashArbitrage deployment to ${networkName}...`);
  console.log('Flash Loan Fee: 0.3% (30 bps) - SyncSwap standard');

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(buildConfig(vaultAddress));

  // Save and print summary
  await saveDeploymentResult(result, 'syncswap-registry.json', 'SyncSwapFlashArbitrage');
  printDeploymentSummary(result);
  printNextSteps(result, networkName);
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

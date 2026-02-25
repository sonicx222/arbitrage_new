/**
 * DAI Flash Mint Arbitrage Contract Deployment Script
 *
 * Deploys the DaiFlashMintArbitrage contract to Ethereum mainnet.
 * Task 1A: DAI Flash Mint Provider (Ethereum-only).
 *
 * Key Advantages over other flash loan sources:
 * - Extremely low fee: 1 bps (0.01%) — lowest of any flash loan source
 * - No liquidity constraint (mints fresh DAI, limited only by debt ceiling)
 * - EIP-3156 standard compliance
 *
 * Limitations:
 * - Ethereum mainnet only (DssFlash is Ethereum-only)
 * - Single asset: DAI only
 *
 * Usage:
 *   npx hardhat run scripts/deploy-dai-flash-mint.ts --network ethereum
 *   npx hardhat run scripts/deploy-dai-flash-mint.ts --network sepolia
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum
 *
 * @see contracts/src/DaiFlashMintArbitrage.sol
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
// Protocol Addresses (Ethereum-only)
// =============================================================================

/**
 * MakerDAO DssFlash addresses per network.
 * DssFlash is the EIP-3156 flash lending facility for DAI.
 *
 * @see https://docs.makerdao.com/smart-contract-modules/flash-mint-module
 */
const DSS_FLASH_ADDRESSES: Record<string, string> = {
  ethereum: '0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853',
  // No testnet DssFlash deployment — use mock for testing
};

/**
 * DAI token addresses per network.
 */
const DAI_ADDRESSES: Record<string, string> = {
  ethereum: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  sepolia: '0x68194a729C2450ad26072b3D33ADaCbcef39D574', // Aave testnet DAI
};

// =============================================================================
// Pipeline Configuration
// =============================================================================

function buildConfig(dssFlashAddress: string, daiAddress: string): DeploymentPipelineConfig {
  return {
    contractName: 'DaiFlashMintArbitrage',
    registryName: 'dai-flash-mint-registry.json',
    contractFactoryName: 'DaiFlashMintArbitrage',
    constructorArgs: (deployer) => [dssFlashAddress, daiAddress, deployer],
    configureMinProfit: true,
    configureRouters: true,
    protocol: 'dai_flash_mint',
    smokeTest: 'flashLoan',
    resultExtras: {
      dssFlashAddress,
      daiAddress,
      flashLoanFee: '1', // 1 bps = 0.01%
    },
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printNextSteps(result: Record<string, any>, networkName: string): void {
  console.log('\nCost Savings vs Other Flash Loan Sources:');
  console.log('   Flash Loan Fee: 0.01% (1 bps)');
  console.log('   vs Aave V3: 0.09% (9 bps) — save 89% on fees!');
  console.log('   vs Balancer V2: 0% — Balancer is free but limited by pool liquidity');
  console.log('   vs PancakeSwap V3: 0.01-1% — DAI flash mint is always cheaper');
  console.log('========================================\n');

  console.log('Deployment complete!');
  console.log('\nNEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.dssFlashAddress} ${result.daiAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update service-config.ts:`);
  console.log(`   - Add contractAddress for ${networkName} in FLASH_LOAN_PROVIDERS`);
  console.log(`   - Set protocol: 'dai_flash_mint', fee: 0.0001 (1 bps)\n`);

  console.log(`${!result.verified ? '3' : '2'}. Update execution-engine config:`);
  console.log(`   - Add ${result.contractAddress} to contractAddresses.${networkName}`);
  console.log(`   - Add routers to approvedRouters.${networkName}\n`);

  console.log(`${!result.verified ? '4' : '3'}. Test deployment:`);
  console.log(`   - Run integration tests on ${networkName}`);
  console.log(`   - Verify router approvals are working`);
  console.log(`   - Execute a small test arbitrage with DAI\n`);

  console.log('Note: DaiFlashMintArbitrage is Ethereum-only (DssFlash limitation).');
  console.log('For other chains, use Aave V3, Balancer V2, or PancakeSwap V3.');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'DaiFlashMintArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'DaiFlashMintArbitrage');

  // Get DssFlash address for the network
  const dssFlashAddress = DSS_FLASH_ADDRESSES[networkName];
  if (!dssFlashAddress) {
    throw new Error(
      `[ERR_NO_DSS_FLASH] DssFlash address not configured for network: ${networkName}\n` +
        `DaiFlashMintArbitrage is Ethereum-only (DssFlash limitation).\n` +
        `Supported networks: ${Object.keys(DSS_FLASH_ADDRESSES).join(', ')}\n\n` +
        `For other chains, use:\n` +
        `  - Aave V3: npx hardhat run scripts/deploy.ts --network ${networkName}\n` +
        `  - Balancer V2: npx hardhat run scripts/deploy-balancer.ts --network ${networkName}\n` +
        `  - PancakeSwap V3: npx hardhat run scripts/deploy-pancakeswap.ts --network ${networkName}`
    );
  }

  // Get DAI address for the network
  const daiAddress = DAI_ADDRESSES[networkName];
  if (!daiAddress) {
    throw new Error(
      `[ERR_NO_DAI] DAI token address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(DAI_ADDRESSES).join(', ')}`
    );
  }

  console.log(`\nStarting DaiFlashMintArbitrage deployment to ${networkName}...`);
  console.log('Flash Loan Fee: 0.01% (1 bps — lowest available!)');
  console.log(`DssFlash: ${dssFlashAddress}`);
  console.log(`DAI: ${daiAddress}`);

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(buildConfig(dssFlashAddress, daiAddress));

  // Save and print summary
  await saveDeploymentResult(result, 'dai-flash-mint-registry.json', 'DaiFlashMintArbitrage');
  printDeploymentSummary(result);
  printNextSteps(result, networkName);
}

// Run the deployment
main().catch((error) => {
  console.error('\n Deployment failed:', error);
  process.exit(1);
});

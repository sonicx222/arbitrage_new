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
 * Phase 1 & 2 Improvements:
 *   ✅ Production config guards (prevents 0n profit on mainnet)
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Router approval error handling
 *   ✅ Smoke tests after deployment
 *   ✅ Network name normalization
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 (Flash Loan Arbitrage)
 */

import { ethers, network } from 'hardhat';
import { AAVE_V3_POOL_ADDRESSES, APPROVED_ROUTERS } from '../deployments/addresses';
import {
  checkDeployerBalance,
  estimateDeploymentCost,
  validateMinimumProfit,
  approveRouters,
  verifyContractWithRetry,
  smokeTestFlashLoanContract,
  saveDeploymentResult as saveResult,
  printDeploymentSummary,
  normalizeNetworkName,
  getSafeChainId,  // P1-007 FIX: Import safe chain ID getter
  DEFAULT_MINIMUM_PROFIT,  // P2-003 FIX: Import centralized profit policy
  getMinimumProfitForProtocol,  // P2-003 FIX: Import protocol adjuster
  DEFAULT_VERIFICATION_RETRIES,
  DEFAULT_VERIFICATION_INITIAL_DELAY_MS,
  type DeploymentResult,
} from './lib/deployment-utils';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * P2-003 FIX: Minimum profit thresholds now imported from deployment-utils.ts
 * (centralized policy shared across all deployment scripts)
 *
 * For Aave V3 deployments, we use the standard thresholds from DEFAULT_MINIMUM_PROFIT.
 * Use getMinimumProfitForProtocol('network', 'aave') to get protocol-adjusted values.
 *
 * @see lib/deployment-utils.ts - DEFAULT_MINIMUM_PROFIT for policy details
 */

// =============================================================================
// Types
// =============================================================================

interface FlashLoanDeploymentResult extends DeploymentResult {
  aavePoolAddress: string;
}

interface DeploymentConfig {
  aavePoolAddress: string;
  ownerAddress?: string;
  minimumProfit?: bigint;
  approvedRouters?: string[];
  skipVerification?: boolean;
}

// =============================================================================
// Deployment Function
// =============================================================================

/**
 * Deploy FlashLoanArbitrage contract with Phase 1 & 2 improvements
 */
async function deployFlashLoanArbitrage(
  config: DeploymentConfig
): Promise<FlashLoanDeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = normalizeNetworkName(network.name);
  // P1-007 FIX: Use safe chain ID getter with validation
  const chainId = await getSafeChainId();

  console.log('\n========================================');
  console.log('FlashLoanArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Aave Pool: ${config.aavePoolAddress}`);

  // Phase 1 Fix: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  if (ownerAddress !== deployer.address) {
    console.log('⚠️  Owner is different from deployer.');
    console.log('   Remember to call acceptOwnership() from owner account after deployment.');
  }

  // Phase 1 Fix: Estimate gas with error handling
  const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
  await estimateDeploymentCost(FlashLoanArbitrageFactory, config.aavePoolAddress, ownerAddress);

  // Deploy contract
  console.log('\nDeploying FlashLoanArbitrage...');
  const flashLoanArbitrage = await FlashLoanArbitrageFactory.deploy(
    config.aavePoolAddress,
    ownerAddress
  );

  await flashLoanArbitrage.waitForDeployment();
  const contractAddress = await flashLoanArbitrage.getAddress();
  const deployTx = flashLoanArbitrage.deploymentTransaction();

  console.log(`✅ Contract deployed at: ${contractAddress}`);
  console.log(`   Transaction: ${deployTx?.hash}`);

  // Get block info
  const receipt = await deployTx?.wait();
  const blockNumber = receipt?.blockNumber ?? 0;
  const block = await ethers.provider.getBlock(blockNumber);
  const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

  // Post-deployment configuration
  console.log('\nConfiguring contract...');

  // Phase 1 Fix: Validate minimum profit (throws on mainnet if zero/undefined)
  const rawMinimumProfit = config.minimumProfit ?? getMinimumProfitForProtocol(networkName, 'aave');
  const minimumProfit = validateMinimumProfit(networkName, rawMinimumProfit);

  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} ETH`);
    const tx = await flashLoanArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Phase 1 Fix: Router approval with error handling
  const routers = config.approvedRouters || APPROVED_ROUTERS[networkName] || [];
  let approvedRoutersList: string[] = [];

  if (routers.length > 0) {
    const approvalResult = await approveRouters(flashLoanArbitrage, routers, true);
    approvedRoutersList = approvalResult.succeeded;

    // If any router failed and we're on mainnet, warn loudly
    if (approvalResult.failed.length > 0) {
      console.warn('\n⚠️  WARNING: Some routers failed to approve');
      console.warn('   Contract is partially configured');
      console.warn('   Manually approve failed routers before executing arbitrage trades');
    }
  } else {
    console.warn('\n⚠️  No routers configured for this network');
    console.warn('   You must approve routers manually before the contract can execute swaps');
  }

  // Phase 1 Fix: Verification with retry logic
  let verified = false;
  if (!config.skipVerification) {
    verified = await verifyContractWithRetry(
      contractAddress,
      [config.aavePoolAddress, ownerAddress],
      DEFAULT_VERIFICATION_RETRIES,
      DEFAULT_VERIFICATION_INITIAL_DELAY_MS
    );
  }

  // Phase 2 Addition: Smoke tests
  // P2-010 FIX: Pass contract address for bytecode verification
  await smokeTestFlashLoanContract(flashLoanArbitrage, ownerAddress, contractAddress);

  return {
    network: networkName,
    chainId,
    contractAddress,
    aavePoolAddress: config.aavePoolAddress,
    ownerAddress,
    deployerAddress: deployer.address,
    transactionHash: deployTx?.hash || '',
    blockNumber,
    timestamp,
    minimumProfit: minimumProfit.toString(),
    approvedRouters: approvedRoutersList,
    verified,
  };
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

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

  // Deploy with Phase 1 & 2 improvements
  // P2-003 FIX: Use centralized profit policy with protocol adjustment
  const result = await deployFlashLoanArbitrage({
    aavePoolAddress,
    approvedRouters: APPROVED_ROUTERS[networkName],
    minimumProfit: getMinimumProfitForProtocol(networkName, 'aave'),
  });

  // Save deployment result
  await saveResult(result, 'registry.json', 'FlashLoanArbitrage');

  // Print summary
  printDeploymentSummary(result);

  // Print next steps
  console.log('📋 NEXT STEPS:\n');

  let stepNumber = 1;

  if (!result.verified) {
    console.log(`${stepNumber}. ⚠️  Verify contract manually:`);
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

  console.log('📖 For detailed deployment workflow, see: contracts/deployments/README.md\n');
  console.log('🎉 Deployment complete!\n');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

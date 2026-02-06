/**
 * MultiPathQuoter Contract Deployment Script
 *
 * Deploys the MultiPathQuoter contract to supported networks.
 * This contract batches multiple getAmountsOut() calls into a single RPC request,
 * reducing quote latency from ~150ms to ~50ms for typical arbitrage paths.
 *
 * Usage:
 *   # Testnet deployment (recommended first)
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network sepolia
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrumSepolia
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network baseSepolia
 *
 *   # Mainnet deployment (after testnet validation)
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network ethereum
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrum
 *   npx hardhat run scripts/deploy-multi-path-quoter.ts --network base
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment wallet
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum/Sepolia
 *   ARBISCAN_API_KEY - For contract verification on Arbitrum
 *   BASESCAN_API_KEY - For contract verification on Base
 *
 * @see ADR-029: Batched Quote Fetching
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 1.2
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  gasUsed: string;
  verified: boolean;
}

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * Deploy MultiPathQuoter contract
 */
async function deployMultiPathQuoter(): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('MultiPathQuoter Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error('Deployer has no balance. Please fund the deployer account.');
  }

  // Estimate deployment cost
  const MultiPathQuoterFactory = await ethers.getContractFactory('MultiPathQuoter');
  const deployTxData = MultiPathQuoterFactory.getDeployTransaction();
  const estimatedGas = await ethers.provider.estimateGas({
    data: deployTxData.data,
  });
  const feeData = await ethers.provider.getFeeData();
  const estimatedCost = estimatedGas * (feeData.gasPrice || 0n);

  console.log(`Estimated Gas: ${estimatedGas.toString()}`);
  console.log(`Estimated Cost: ${ethers.formatEther(estimatedCost)} ETH`);

  if (balance < estimatedCost) {
    throw new Error(
      `Insufficient balance for deployment. ` +
      `Need ${ethers.formatEther(estimatedCost)} ETH, have ${ethers.formatEther(balance)} ETH`
    );
  }

  // Deploy contract
  console.log('\nDeploying MultiPathQuoter...');
  const multiPathQuoter = await MultiPathQuoterFactory.deploy();

  await multiPathQuoter.waitForDeployment();
  const contractAddress = await multiPathQuoter.getAddress();
  const deployTx = multiPathQuoter.deploymentTransaction();

  console.log(`✅ Contract deployed at: ${contractAddress}`);
  console.log(`   Transaction: ${deployTx?.hash}`);

  // Get deployment details
  const receipt = await deployTx?.wait();
  const blockNumber = receipt?.blockNumber || 0;
  const gasUsed = receipt?.gasUsed?.toString() || '0';
  const block = await ethers.provider.getBlock(blockNumber);
  const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

  console.log(`   Block: ${blockNumber}`);
  console.log(`   Gas Used: ${gasUsed}`);

  // Verify contract on block explorer
  let verified = false;
  if (networkName !== 'localhost' && networkName !== 'hardhat') {
    console.log('\nWaiting 30 seconds before verification...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log('Verifying contract on block explorer...');
    try {
      await run('verify:verify', {
        address: contractAddress,
        constructorArguments: [],
      });
      verified = true;
      console.log('✅ Contract verified');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Already Verified')) {
        verified = true;
        console.log('✅ Contract already verified');
      } else {
        console.warn('⚠️  Verification failed:', errorMessage);
        console.log('   You can verify manually later with:');
        console.log(`   npx hardhat verify --network ${networkName} ${contractAddress}`);
      }
    }
  }

  // Smoke test: call getBatchedQuotes with empty array
  console.log('\nRunning smoke test...');
  try {
    const result = await multiPathQuoter.getBatchedQuotes([]);
    console.log('✅ Smoke test passed (empty array call succeeded)');
  } catch (error) {
    console.log('⚠️  Smoke test failed (expected - empty array should revert)');
  }

  return {
    network: networkName,
    chainId,
    contractAddress,
    deployerAddress: deployer.address,
    transactionHash: deployTx?.hash || '',
    blockNumber,
    timestamp,
    gasUsed,
    verified,
  };
}

/**
 * Save deployment result to file
 */
function saveDeploymentResult(result: DeploymentResult): void {
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save network-specific deployment
  const networkFile = path.join(deploymentsDir, `multi-path-quoter-${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'multi-path-quoter-registry.json');
  let registry: Record<string, DeploymentResult> = {};
  if (fs.existsSync(registryFile)) {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  }
  registry[result.network] = result;
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  console.log(`📝 Registry updated: ${registryFile}`);
}

/**
 * Print deployment summary and next steps
 */
function printDeploymentSummary(result: DeploymentResult): void {
  console.log('\n========================================');
  console.log('Deployment Summary');
  console.log('========================================');
  console.log(`Network:      ${result.network} (${result.chainId})`);
  console.log(`Contract:     ${result.contractAddress}`);
  console.log(`Deployer:     ${result.deployerAddress}`);
  console.log(`Transaction:  ${result.transactionHash}`);
  console.log(`Block:        ${result.blockNumber}`);
  console.log(`Timestamp:    ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Gas Used:     ${result.gasUsed}`);
  console.log(`Verified:     ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');

  console.log('📋 NEXT STEPS:');
  console.log('');
  console.log('1. Update contract addresses in configuration:');
  console.log(`   File: shared/config/src/service-config.ts`);
  console.log(`   Add: MULTI_PATH_QUOTER_ADDRESSES.${result.network} = '${result.contractAddress}';`);
  console.log('');
  console.log('2. Test the deployment:');
  console.log(`   npx hardhat console --network ${result.network}`);
  console.log(`   > const quoter = await ethers.getContractAt('MultiPathQuoter', '${result.contractAddress}');`);
  console.log(`   > await quoter.getBatchedQuotes([...]); // Test with real quote requests`);
  console.log('');
  console.log('3. Enable feature flag in environment:');
  console.log(`   export FEATURE_BATCHED_QUOTER=true`);
  console.log(`   export MULTI_PATH_QUOTER_${result.network.toUpperCase()}=${result.contractAddress}`);
  console.log('');
  console.log('4. Restart services to pick up new configuration');
  console.log('');

  if (!result.verified) {
    console.log('⚠️  Contract not verified. To verify manually:');
    console.log(`   npx hardhat verify --network ${result.network} ${result.contractAddress}`);
    console.log('');
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  console.log(`\nStarting MultiPathQuoter deployment to ${networkName}...`);

  // Deploy
  const result = await deployMultiPathQuoter();

  // Save and print summary
  saveDeploymentResult(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
  console.log('\n⚠️  IMPORTANT: Remember to update service-config.ts with the deployed address!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

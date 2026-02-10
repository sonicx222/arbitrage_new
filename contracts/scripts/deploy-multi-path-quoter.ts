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
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 1 Task 1.2
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeNetworkName,
  checkDeployerBalance,
  estimateDeploymentCost,
  verifyContractWithRetry,
  saveDeploymentResult,
  type MultiPathQuoterDeploymentResult
} from './lib/deployment-utils';

// =============================================================================
// Types
// =============================================================================

// Use standardized MultiPathQuoterDeploymentResult from deployment-utils
// This ensures type consistency across all deployment scripts
type DeploymentResult = MultiPathQuoterDeploymentResult;

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * NOTE: This contract does NOT define DEFAULT_MINIMUM_PROFIT or any
 * configuration constants like other deployment scripts.
 *
 * Reason: MultiPathQuoter is a stateless utility contract that only provides
 * batched price quotes. It does not execute trades or handle funds, so it
 * has no concept of profit thresholds. Profit validation occurs in the
 * execution-engine service which consumes quotes from this contract.
 *
 * @see contracts/src/MultiPathQuoter.sol (stateless view functions only)
 * @see ADR-029: Batched Quote Fetching (explains quoter architecture)
 */

/**
 * Deploy MultiPathQuoter contract
 */
async function deployMultiPathQuoter(): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = normalizeNetworkName(network.name);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('MultiPathQuoter Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  // Phase 1 Fix: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Phase 1 Fix: Estimate gas with error handling
  const MultiPathQuoterFactory = await ethers.getContractFactory('MultiPathQuoter');
  await estimateDeploymentCost(MultiPathQuoterFactory);

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

  // Phase 1 Fix: Verification with retry logic
  const verified = await verifyContractWithRetry(
    contractAddress,
    [], // no constructor arguments
    3, // max retries
    30000 // initial delay (30s)
  );

  // Smoke test: verify contract interface is accessible
  console.log('\nRunning smoke test...');
  try {
    // Check that the contract interface is accessible (doesn't actually call with empty array)
    const contractInterface = multiPathQuoter.interface;
    const hasBatchedQuotesFunction = contractInterface.hasFunction('getBatchedQuotes');

    if (hasBatchedQuotesFunction) {
      console.log('✅ Smoke test passed: getBatchedQuotes function is available');
    } else {
      console.log('⚠️  Smoke test failed: getBatchedQuotes function not found');
    }
  } catch (error) {
    console.log('⚠️  Smoke test failed:', error);
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
 * Save deployment result to file (now using utility function)
 * Kept as wrapper for backward compatibility
 */
function saveMultiPathQuoterDeployment(result: DeploymentResult): void {
  saveDeploymentResult(result, 'multi-path-quoter-registry.json');
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
  const networkName = normalizeNetworkName(network.name);

  console.log(`\nStarting MultiPathQuoter deployment to ${networkName}...`);

  // Deploy
  const result = await deployMultiPathQuoter();

  // Save and print summary
  saveMultiPathQuoterDeployment(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
  console.log('\n⚠️  IMPORTANT: Remember to update service-config.ts with the deployed address!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

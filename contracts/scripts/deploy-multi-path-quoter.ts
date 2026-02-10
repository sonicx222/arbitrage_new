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
 * Phase 4A Improvements:
 *   ✅ Uses deployment-utils.ts for consistency
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Network name normalization
 *   ✅ Improved smoke tests (bytecode validation)
 *   ✅ Standardized output format
 *   ✅ No config needed (stateless utility contract)
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
  DEFAULT_VERIFICATION_RETRIES,
  DEFAULT_VERIFICATION_INITIAL_DELAY_MS,
  type MultiPathQuoterDeploymentResult
} from './lib/deployment-utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Type alias for MultiPathQuoter contract deployment results
 *
 * Maps to MultiPathQuoterDeploymentResult from deployment-utils.ts for type safety.
 * This alias maintains backward compatibility with existing function signatures
 * (e.g., deployMultiPathQuoter() return type) while ensuring consistency
 * with the standardized deployment result types used internally.
 *
 * @see MultiPathQuoterDeploymentResult in deployment-utils.ts
 */
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
  // Chain IDs are always < Number.MAX_SAFE_INTEGER in practice (all EVM chains use IDs < 2^32)
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
    DEFAULT_VERIFICATION_RETRIES,
    DEFAULT_VERIFICATION_INITIAL_DELAY_MS
  );

  // Smoke test: verify contract is deployed and functional
  console.log('\nRunning smoke test...');
  try {
    // 1. Check interface exists
    const contractInterface = multiPathQuoter.interface;
    const hasBatchedQuotesFunction = contractInterface.hasFunction('getBatchedQuotes');

    if (!hasBatchedQuotesFunction) {
      console.log('⚠️  Smoke test failed: getBatchedQuotes function not found in ABI');
      return {
        network: networkName,
        chainId,
        contractAddress,
        deployerAddress: deployer.address,
        transactionHash: deployTx?.hash || '',
        blockNumber,
        timestamp,
        gasUsed,
        verified: false,
      };
    }

    // 2. Verify contract bytecode exists at address (catches deployment failures)
    const code = await ethers.provider.getCode(contractAddress);
    if (code === '0x') {
      console.log('⚠️  Smoke test failed: No bytecode at contract address');
      return {
        network: networkName,
        chainId,
        contractAddress,
        deployerAddress: deployer.address,
        transactionHash: deployTx?.hash || '',
        blockNumber,
        timestamp,
        gasUsed,
        verified: false,
      };
    }

    console.log('✅ Smoke test passed:');
    console.log('   - getBatchedQuotes function available in ABI');
    console.log(`   - Contract deployed at ${contractAddress}`);
    console.log(`   - Bytecode size: ${(code.length - 2) / 2} bytes`);
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
async function saveMultiPathQuoterDeployment(result: DeploymentResult): Promise<void> {
  await saveDeploymentResult(result, 'multi-path-quoter-registry.json');
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
  await saveMultiPathQuoterDeployment(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
  console.log('\n⚠️  IMPORTANT: Remember to update service-config.ts with the deployed address!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

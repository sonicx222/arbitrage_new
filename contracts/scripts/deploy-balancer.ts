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
 * Phase 4A Improvements:
 *   ✅ Uses deployment-utils.ts for consistency
 *   ✅ Production config guards (prevents 0n profit on mainnet)
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Router approval error handling
 *   ✅ Network name normalization
 *   ✅ Preserves 0% fee advantage messaging
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.2
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */

import { ethers, network } from 'hardhat';
import { BALANCER_V2_VAULTS } from '@arbitrage/config';
import { APPROVED_ROUTERS } from '../deployments/addresses';
import {
  normalizeNetworkName,
  checkDeployerBalance,
  estimateDeploymentCost,
  validateMinimumProfit,
  approveRouters,
  verifyContractWithRetry,
  smokeTestFlashLoanContract,
  saveDeploymentResult,
  printDeploymentSummary,
  DEFAULT_VERIFICATION_RETRIES,
  DEFAULT_VERIFICATION_INITIAL_DELAY_MS,
  type BalancerDeploymentResult,
} from './lib/deployment-utils';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * Balancer V2 Vault addresses by chain
 * Imported from @arbitrage/config (single source of truth)
 */
const BALANCER_V2_VAULT_ADDRESSES = BALANCER_V2_VAULTS;

/**
 * Default approved DEX routers by chain
 * Imported from deployments/addresses.ts (single source of truth)
 */
const DEFAULT_APPROVED_ROUTERS = APPROVED_ROUTERS;

/**
 * Default minimum profit settings by chain (in native token wei)
 * Balancer V2 charges 0% fees, so profit threshold can be lower
 *
 * MAINNET: Must be defined with positive values to prevent unprofitable trades
 * TESTNET: Low thresholds for testing
 *
 * Phase 4A: Now enforced by validateMinimumProfit() - mainnet deployments
 * without proper thresholds will fail with clear error messages
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  // Mainnets - set conservative thresholds to prevent unprofitable trades
  // Lower than Aave V3 thresholds since Balancer has 0% fees
  ethereum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  polygon: ethers.parseEther('0.5'), // 0.5 MATIC (~$0.50 at $1/MATIC)
  arbitrum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  optimism: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  base: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  fantom: ethers.parseEther('1'), // 1 FTM (~$0.50 at $0.50/FTM)
};

// =============================================================================
// Types
// =============================================================================

// Use standardized BalancerDeploymentResult from deployment-utils
// This ensures type consistency across all deployment scripts
type DeploymentResult = BalancerDeploymentResult;

interface DeploymentConfig {
  vaultAddress: string;
  ownerAddress?: string;
  minimumProfit?: bigint;
  approvedRouters?: string[];
  skipVerification?: boolean;
}

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * Deploy BalancerV2FlashArbitrage contract
 * Phase 4A: Refactored to use deployment-utils.ts
 */
async function deployBalancerV2FlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();

  // Phase 4A: Network name normalization
  const networkName = normalizeNetworkName(network.name);
  // Chain IDs are always < Number.MAX_SAFE_INTEGER in practice (all EVM chains use IDs < 2^32)
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('BalancerV2FlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault: ${config.vaultAddress}`);
  console.log('Flash Loan Fee: 0% (Balancer V2 advantage!)');

  // Phase 4A: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  // Phase 4A: Estimate gas with error handling
  const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory(
    'BalancerV2FlashArbitrage'
  );
  await estimateDeploymentCost(BalancerV2FlashArbitrageFactory, config.vaultAddress, ownerAddress);

  // Deploy contract
  console.log('\nDeploying BalancerV2FlashArbitrage...');
  const balancerV2FlashArbitrage = await BalancerV2FlashArbitrageFactory.deploy(
    config.vaultAddress,
    ownerAddress
  );

  await balancerV2FlashArbitrage.waitForDeployment();
  const contractAddress = await balancerV2FlashArbitrage.getAddress();
  const deployTx = balancerV2FlashArbitrage.deploymentTransaction();

  console.log(`✅ Contract deployed at: ${contractAddress}`);
  console.log(`   Transaction: ${deployTx?.hash}`);

  // Get block info
  const receipt = await deployTx?.wait();
  const blockNumber = receipt?.blockNumber || 0;
  const block = await ethers.provider.getBlock(blockNumber);
  const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

  // Post-deployment configuration
  console.log('\nConfiguring contract...');

  // Phase 4A: Validate minimum profit (throws on mainnet if zero/undefined)
  const rawMinimumProfit = config.minimumProfit || DEFAULT_MINIMUM_PROFIT[networkName];
  const minimumProfit = validateMinimumProfit(networkName, rawMinimumProfit);

  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} Native Token`);
    const tx = await balancerV2FlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Phase 4A: Router approval with error handling
  const routers = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  let approvedRoutersList: string[] = [];

  if (routers.length > 0) {
    const approvalResult = await approveRouters(balancerV2FlashArbitrage, routers, true);
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

  // Phase 4A: Verification with retry logic
  let verified = false;
  if (!config.skipVerification) {
    verified = await verifyContractWithRetry(
      contractAddress,
      [config.vaultAddress, ownerAddress],
      DEFAULT_VERIFICATION_RETRIES,
      DEFAULT_VERIFICATION_INITIAL_DELAY_MS
    );
  }

  // Phase 4A: Smoke test - verify contract is callable
  await smokeTestFlashLoanContract(balancerV2FlashArbitrage, ownerAddress);

  return {
    network: networkName,
    chainId,
    contractAddress,
    vaultAddress: config.vaultAddress,
    ownerAddress,
    deployerAddress: deployer.address,
    transactionHash: deployTx?.hash || '',
    blockNumber,
    timestamp,
    minimumProfit: minimumProfit.toString(),
    approvedRouters: approvedRoutersList,
    flashLoanFee: '0', // Balancer V2 has 0% fees!
    verified,
  };
}

/**
 * Save deployment result to file (now using utility function)
 * Kept as wrapper for backward compatibility
 */
async function saveBalancerDeployment(result: DeploymentResult): Promise<void> {
  await saveDeploymentResult(result, 'balancer-registry.json');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Get Vault address for the network
  const vaultAddress = BALANCER_V2_VAULT_ADDRESSES[networkName];
  if (!vaultAddress) {
    throw new Error(
      `[ERR_NO_VAULT] Balancer V2 Vault address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(BALANCER_V2_VAULT_ADDRESSES).join(', ')}\n\n` +
        `To add support for ${networkName}:\n` +
        `1. Find the Balancer V2 Vault address from: https://docs.balancer.fi/reference/contracts/deployment-addresses.html\n` +
        `2. Add to shared/config/src/addresses.ts: BALANCER_V2_VAULTS\n` +
        `3. Re-export in contracts/deployments/addresses.ts`
    );
  }

  console.log(`\nStarting BalancerV2FlashArbitrage deployment to ${networkName}...`);

  // Deploy with Phase 4A improvements
  const result = await deployBalancerV2FlashArbitrage({
    vaultAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
  });

  // Save and print summary
  await saveBalancerDeployment(result);
  printDeploymentSummary(result);

  // Print cost savings vs Aave V3 (preserved messaging)
  console.log('\n💰 Cost Savings vs Aave V3:');
  console.log('   Flash Loan Fee: 0% (vs Aave V3\'s 0.09%)');
  console.log('   Example: On a $100K flash loan, save $90 per trade!');
  console.log('========================================\n');

  console.log('🎉 Deployment complete!');
  console.log('\n📋 NEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. ⚠️  Verify contract manually:');
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

  console.log('💡 Tip: Uncomment the Balancer V2 entry in service-config.ts');
  console.log('   to replace Aave V3 and start saving 0.09% on every flash loan!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

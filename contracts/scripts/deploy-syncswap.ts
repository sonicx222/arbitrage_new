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
 *   # Testnet
 *   npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet
 *
 *   # Mainnet
 *   npx hardhat run scripts/deploy-syncswap.ts --network zksync-mainnet
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment
 *   ZKSYNC_ETHERSCAN_API_KEY - For contract verification (optional)
 *
 * Phase 4A Improvements:
 *   ✅ Uses deployment-utils.ts for consistency
 *   ✅ Production config guards (prevents 0n profit on mainnet)
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Router approval error handling
 *   ✅ Network name normalization
 *   ✅ Smoke tests added
 *   ✅ Standardized output format
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.4
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */

import { ethers, network } from 'hardhat';
import { SYNCSWAP_VAULTS } from '@arbitrage/config';
import { APPROVED_ROUTERS } from '../deployments/addresses';
import {
  normalizeNetworkName,
  getSafeChainId,  // P1-007 FIX: Import safe chain ID getter
  checkDeployerBalance,
  estimateDeploymentCost,
  validateMinimumProfit,
  approveRouters,
  verifyContractWithRetry,
  smokeTestFlashLoanContract,
  saveDeploymentResult,
  printDeploymentSummary,
  getMinimumProfitForProtocol,  // P2-003 FIX: Import centralized profit policy
  DEFAULT_VERIFICATION_RETRIES,
  DEFAULT_VERIFICATION_INITIAL_DELAY_MS,
  type SyncSwapDeploymentResult,
} from './lib/deployment-utils';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * SyncSwap Vault addresses by network
 * Imported from @arbitrage/config (single source of truth)
 */
const SYNCSWAP_VAULT_ADDRESSES = SYNCSWAP_VAULTS;

/**
 * Default approved DEX routers for zkSync Era
 * Imported from deployments/addresses.ts (single source of truth)
 */
const DEFAULT_APPROVED_ROUTERS = APPROVED_ROUTERS;

/**
 * P2-003 FIX: Minimum profit thresholds now imported from deployment-utils.ts
 * (centralized policy shared across all deployment scripts)
 *
 * For SyncSwap deployments (0.3% flash loan fee - higher than Aave's 0.09%),
 * we use the standard thresholds which already account for worst-case fees.
 *
 * Note: SyncSwap's higher fee means we keep conservative thresholds without discount.
 *
 * @see lib/deployment-utils.ts - DEFAULT_MINIMUM_PROFIT for policy details
 * @see lib/deployment-utils.ts - getMinimumProfitForProtocol() handles SyncSwap fee
 */

// =============================================================================
// Types
// =============================================================================

// Use standardized SyncSwapDeploymentResult from deployment-utils
// This ensures type consistency across all deployment scripts
type DeploymentResult = SyncSwapDeploymentResult;

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
 * Deploy SyncSwapFlashArbitrage contract
 * Phase 4A: Refactored to use deployment-utils.ts
 */
async function deploySyncSwapFlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();

  // Phase 4A: Network name normalization
  const networkName = normalizeNetworkName(network.name);
  // P1-007 FIX: Use safe chain ID getter with validation
  const chainId = await getSafeChainId();

  console.log('\n========================================');
  console.log('SyncSwapFlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault: ${config.vaultAddress}`);
  console.log('Flash Loan Fee: 0.3% (30 bps) - SyncSwap standard');

  // Phase 4A: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  // Phase 4A: Estimate gas with error handling
  const SyncSwapFlashArbitrageFactory = await ethers.getContractFactory(
    'SyncSwapFlashArbitrage'
  );
  await estimateDeploymentCost(SyncSwapFlashArbitrageFactory, config.vaultAddress, ownerAddress);

  // Deploy contract
  console.log('\nDeploying SyncSwapFlashArbitrage...');
  const syncSwapFlashArbitrage = await SyncSwapFlashArbitrageFactory.deploy(
    config.vaultAddress,
    ownerAddress
  );

  await syncSwapFlashArbitrage.waitForDeployment();
  const contractAddress = await syncSwapFlashArbitrage.getAddress();
  const deployTx = syncSwapFlashArbitrage.deploymentTransaction();

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
  const rawMinimumProfit = config.minimumProfit ?? getMinimumProfitForProtocol(networkName, 'syncswap');
  const minimumProfit = validateMinimumProfit(networkName, rawMinimumProfit);

  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} ETH`);
    const tx = await syncSwapFlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Phase 4A: Router approval with error handling
  const routers = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  let approvedRoutersList: string[] = [];

  if (routers.length > 0) {
    const approvalResult = await approveRouters(syncSwapFlashArbitrage, routers, true);
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
  // P2-010 FIX: Pass contract address for bytecode verification
  await smokeTestFlashLoanContract(syncSwapFlashArbitrage, ownerAddress, contractAddress);

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
    flashLoanFee: '30', // 0.3% = 30 bps
    verified,
  };
}

/**
 * Save deployment result to file (now using utility function)
 * Kept as wrapper for backward compatibility
 */
async function saveSyncSwapDeployment(result: DeploymentResult): Promise<void> {
  await saveDeploymentResult(result, 'syncswap-registry.json', 'SyncSwapFlashArbitrage');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Get Vault address for the network
  const vaultAddress = SYNCSWAP_VAULT_ADDRESSES[networkName];
  if (!vaultAddress) {
    throw new Error(
      `[ERR_NO_VAULT] SyncSwap Vault address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(SYNCSWAP_VAULT_ADDRESSES).join(', ')}\n\n` +
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

  // Deploy with Phase 4A improvements
  // P2-003 FIX: Use centralized profit policy (SyncSwap uses standard thresholds)
  const result = await deploySyncSwapFlashArbitrage({
    vaultAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: getMinimumProfitForProtocol(networkName, 'syncswap'),
  });

  // Save and print summary
  await saveSyncSwapDeployment(result);
  printDeploymentSummary(result);

  // Print cost comparison vs other protocols (preserved messaging)
  console.log('\n💰 Flash Loan Fee Comparison:');
  console.log('   SyncSwap:   0.3% (30 bps) - This deployment');
  console.log('   Aave V3:    0.09% (9 bps) - Cheaper but not on zkSync Era');
  console.log('   Balancer:   0% - Cheapest but not on zkSync Era');
  console.log('   Note: SyncSwap is currently the best option for zkSync Era flash loans');
  console.log('========================================\n');

  console.log('🎉 Deployment complete!');
  console.log('\n📋 NEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. ⚠️  Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.vaultAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update .env file:`);
  console.log(`   ZKSYNC_FLASH_LOAN_CONTRACT=${result.contractAddress}`);
  console.log(`   ZKSYNC_APPROVED_ROUTERS=${result.approvedRouters.join(',')}\n`);

  console.log(`${!result.verified ? '3' : '2'}. Update execution-engine config:`);
  console.log(`   contractAddresses: { zksync: '${result.contractAddress}' }`);
  console.log(`   approvedRouters: { zksync: ${JSON.stringify(result.approvedRouters)} }\n`);

  console.log(`${!result.verified ? '4' : '3'}. Test deployment:`);
  console.log(`   - Restart execution engine: npm run dev:execution:fast`);
  console.log(`   - Check logs for: "Created SyncSwap provider for zksync"`);
  console.log(`   - Run integration tests (if available)\n`);

  console.log(`${!result.verified ? '5' : '4'}. Monitor metrics:`);
  console.log('   - Track flash loan success rate');
  console.log('   - Compare profit margins vs other protocols');
  console.log('   - Monitor gas costs on zkSync Era\n');

  console.log('💡 Tip: SyncSwap charges 0.3% flash loan fee (30 bps)');
  console.log('   This is competitive on zkSync Era where Aave V3 and Balancer V2');
  console.log('   are not yet deployed. Factor this into profit calculations!');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

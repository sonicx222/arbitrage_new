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
 * Phase 4A Improvements:
 *   ✅ Uses deployment-utils.ts for consistency
 *   ✅ Production config guards (prevents 0n profit on mainnet)
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Router approval error handling
 *   ✅ Network name normalization
 *   ✅ Preserves pool discovery optimization (Phase 3)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.1
 */

import { ethers, network } from 'hardhat';
import { PANCAKESWAP_V3_FACTORIES } from '@arbitrage/config';
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
  type PancakeSwapDeploymentResult,
} from './lib/deployment-utils';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * PancakeSwap V3 Factory addresses by chain
 * Imported from @arbitrage/config (single source of truth)
 */
const PANCAKESWAP_V3_FACTORY_ADDRESSES = PANCAKESWAP_V3_FACTORIES;

/**
 * Default approved DEX routers by chain
 * Imported from deployments/addresses.ts (single source of truth)
 */
const DEFAULT_APPROVED_ROUTERS = APPROVED_ROUTERS;

/**
 * Common token pairs for pool whitelisting (by chain)
 * Task 2.1 (C4): Whitelist common pools during deployment
 */
const COMMON_TOKEN_PAIRS: Record<string, Array<{ tokenA: string; tokenB: string; name: string }>> = {
  bsc: [
    {
      tokenA: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      tokenB: '0x55d398326f99059fF775485246999027B3197955', // USDT
      name: 'WBNB/USDT',
    },
    {
      tokenA: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      tokenB: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      name: 'WBNB/USDC',
    },
    {
      tokenA: '0x55d398326f99059fF775485246999027B3197955', // USDT
      tokenB: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      name: 'USDT/USDC',
    },
  ],
  ethereum: [
    {
      tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      tokenB: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      name: 'WETH/USDC',
    },
    {
      tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      tokenB: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      name: 'WETH/USDT',
    },
    {
      tokenA: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      tokenB: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      name: 'USDC/USDT',
    },
  ],
  arbitrum: [
    {
      tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      tokenB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC (Native)
      name: 'WETH/USDC',
    },
    {
      tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      tokenB: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
      name: 'WETH/USDT',
    },
    {
      tokenA: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
      tokenB: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
      name: 'USDC/USDT',
    },
  ],
  base: [
    {
      tokenA: '0x4200000000000000000000000000000000000006', // WETH
      tokenB: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC (Native)
      name: 'WETH/USDC',
    },
    {
      tokenA: '0x4200000000000000000000000000000000000006', // WETH
      tokenB: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      name: 'WETH/DAI',
    },
  ],
};

/**
 * PancakeSwap V3 fee tiers (in hundredths of a bip)
 * 100 = 0.01%, 500 = 0.05%, 2500 = 0.25%, 10000 = 1%
 */
const FEE_TIERS = [100, 500, 2500, 10000] as const;

/**
 * Default minimum profit settings (in wei)
 *
 * MAINNET: Must be defined with positive values to prevent unprofitable trades
 * TESTNET: Low thresholds for testing
 *
 * Phase 4A: Now enforced by validateMinimumProfit() - mainnet deployments
 * without proper thresholds will fail with clear error messages
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  // Mainnets - set conservative thresholds to prevent unprofitable trades
  bsc: ethers.parseEther('0.001'), // 0.001 BNB (~$0.30 at $300/BNB)
  ethereum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  arbitrum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  base: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
};

// =============================================================================
// Types
// =============================================================================

// Use standardized PancakeSwapDeploymentResult from deployment-utils
// This ensures type consistency across all deployment scripts
type DeploymentResult = PancakeSwapDeploymentResult;

interface DeploymentConfig {
  factoryAddress: string;
  ownerAddress?: string;
  minimumProfit?: bigint;
  approvedRouters?: string[];
  whitelistPools?: boolean;
  skipVerification?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Discover pools from factory for given token pairs
 * Phase 3 Optimization: Preserved as-is (already optimized)
 */
async function discoverPools(
  factoryAddress: string,
  tokenPairs: Array<{ tokenA: string; tokenB: string; name: string }>
): Promise<Array<{ pool: string; pair: string; feeTier: number }>> {
  const factoryAbi = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  ];
  const factory = await ethers.getContractAt(factoryAbi, factoryAddress);

  const discoveredPools: Array<{ pool: string; pair: string; feeTier: number }> = [];

  console.log('\nDiscovering PancakeSwap V3 pools...');
  for (const pair of tokenPairs) {
    console.log(`  Checking ${pair.name}...`);

    for (const feeTier of FEE_TIERS) {
      try {
        const poolAddress = await factory.getPool(pair.tokenA, pair.tokenB, feeTier);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          console.log(`    ✅ Found pool at ${poolAddress} (fee: ${feeTier / 10000}%)`);
          discoveredPools.push({
            pool: poolAddress,
            pair: pair.name,
            feeTier,
          });
        }
      } catch (error) {
        // Pool doesn't exist for this fee tier, continue
        continue;
      }
    }
  }

  console.log(`\nDiscovered ${discoveredPools.length} pools`);
  return discoveredPools;
}

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * Deploy PancakeSwapFlashArbitrage contract
 * Phase 4A: Refactored to use deployment-utils.ts
 */
async function deployPancakeSwapFlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();

  // Phase 4A: Network name normalization
  const networkName = normalizeNetworkName(network.name);
  // Chain IDs are always < Number.MAX_SAFE_INTEGER in practice (all EVM chains use IDs < 2^32)
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('PancakeSwapFlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Factory: ${config.factoryAddress}`);

  // Phase 4A: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  // Phase 4A: Estimate gas with error handling
  const PancakeSwapFlashArbitrageFactory = await ethers.getContractFactory(
    'PancakeSwapFlashArbitrage'
  );
  await estimateDeploymentCost(PancakeSwapFlashArbitrageFactory, config.factoryAddress, ownerAddress);

  // Deploy contract
  console.log('\nDeploying PancakeSwapFlashArbitrage...');
  const pancakeSwapFlashArbitrage = await PancakeSwapFlashArbitrageFactory.deploy(
    config.factoryAddress,
    ownerAddress
  );

  await pancakeSwapFlashArbitrage.waitForDeployment();
  const contractAddress = await pancakeSwapFlashArbitrage.getAddress();
  const deployTx = pancakeSwapFlashArbitrage.deploymentTransaction();

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
    const tx = await pancakeSwapFlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Phase 4A: Router approval with error handling
  const routers = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  let approvedRoutersList: string[] = [];

  if (routers.length > 0) {
    const approvalResult = await approveRouters(pancakeSwapFlashArbitrage, routers, true);
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

  // Task 2.1 (C4): Batch whitelist common pools during deployment
  // Phase 3 Optimization: Preserved pool discovery and whitelisting
  let whitelistedPools: string[] = [];
  if (config.whitelistPools !== false) {
    console.log('\nWhitelisting common pools...');
    const tokenPairs = COMMON_TOKEN_PAIRS[networkName] || [];

    if (tokenPairs.length > 0) {
      // Discover pools from factory
      const discoveredPools = await discoverPools(config.factoryAddress, tokenPairs);

      if (discoveredPools.length > 0) {
        const poolAddresses = discoveredPools.map((p) => p.pool);

        // Batch whitelist using new whitelistMultiplePools function
        console.log(`  Batch whitelisting ${poolAddresses.length} pools...`);
        const tx = await pancakeSwapFlashArbitrage.whitelistMultiplePools(poolAddresses);
        const whitelistReceipt = await tx.wait();

        console.log(`  ✅ Whitelisted ${poolAddresses.length} pools (Gas used: ${whitelistReceipt?.gasUsed})`);

        // Log pool details
        for (const pool of discoveredPools) {
          console.log(`     - ${pool.pair} (${pool.feeTier / 10000}%): ${pool.pool}`);
        }

        whitelistedPools = poolAddresses;
      } else {
        console.log('  ⚠️ No pools discovered (factory might not have liquidity yet)');
      }
    } else {
      console.log('  ⚠️ No common token pairs configured for this network');
    }
  }

  // Phase 4A: Verification with retry logic
  let verified = false;
  if (!config.skipVerification) {
    verified = await verifyContractWithRetry(
      contractAddress,
      [config.factoryAddress, ownerAddress],
      DEFAULT_VERIFICATION_RETRIES,
      DEFAULT_VERIFICATION_INITIAL_DELAY_MS
    );
  }

  // Phase 4A: Smoke test - verify contract is callable
  await smokeTestFlashLoanContract(pancakeSwapFlashArbitrage, ownerAddress);

  return {
    network: networkName,
    chainId,
    contractAddress,
    factoryAddress: config.factoryAddress,
    ownerAddress,
    deployerAddress: deployer.address,
    transactionHash: deployTx?.hash || '',
    blockNumber,
    timestamp,
    minimumProfit: minimumProfit.toString(),
    approvedRouters: approvedRoutersList,
    whitelistedPools,
    verified,
  };
}

/**
 * Save deployment result to file (now using utility function)
 * Kept as wrapper for backward compatibility
 */
async function savePancakeSwapDeployment(result: DeploymentResult): Promise<void> {
  await saveDeploymentResult(result, 'pancakeswap-registry.json');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Get Factory address for the network
  const factoryAddress = PANCAKESWAP_V3_FACTORY_ADDRESSES[networkName];
  if (!factoryAddress) {
    throw new Error(
      `[ERR_NO_FACTORY] PancakeSwap V3 Factory address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(PANCAKESWAP_V3_FACTORY_ADDRESSES).join(', ')}\n\n` +
        `To add support for ${networkName}:\n` +
        `1. Find the PancakeSwap V3 Factory address from: https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts\n` +
        `2. Add to shared/config/src/addresses.ts: PANCAKESWAP_V3_FACTORIES\n` +
        `3. Re-export in contracts/deployments/addresses.ts`
    );
  }

  console.log(`\nStarting PancakeSwapFlashArbitrage deployment to ${networkName}...`);

  // Deploy with Phase 4A improvements
  const result = await deployPancakeSwapFlashArbitrage({
    factoryAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
    whitelistPools: true, // Task 2.1 (C4): Enable batch pool whitelisting
  });

  // Save and print summary
  await savePancakeSwapDeployment(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
  console.log('\n📋 NEXT STEPS:\n');

  if (!result.verified) {
    console.log('1. ⚠️  Verify contract manually:');
    console.log(`   npx hardhat verify --network ${networkName} ${result.contractAddress} ${result.factoryAddress} ${result.ownerAddress}\n`);
  }

  console.log(`${!result.verified ? '2' : '1'}. Update contract address in configuration:`);
  console.log(`   File: contracts/deployments/addresses.ts`);
  console.log(`   Update: PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES.${networkName} = '${result.contractAddress}';\n`);

  console.log(`${!result.verified ? '3' : '2'}. Test the deployment:`);
  console.log(`   - Verify router approvals: ${result.approvedRouters.length} routers`);
  console.log(`   - Verify pool whitelisting: ${result.whitelistedPools.length} pools`);
  console.log(`   - Execute a small test arbitrage\n`);

  console.log(`${!result.verified ? '4' : '3'}. Restart services to pick up new configuration\n`);
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

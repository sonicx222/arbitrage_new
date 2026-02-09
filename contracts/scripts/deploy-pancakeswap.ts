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
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 2.1
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * PancakeSwap V3 Factory addresses by chain
 * @see https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
 */
const PANCAKESWAP_V3_FACTORY_ADDRESSES: Record<string, string> = {
  bsc: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  ethereum: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  arbitrum: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  zksync: '0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB',
  base: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  linea: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
};

/**
 * Default approved DEX routers by chain
 */
const DEFAULT_APPROVED_ROUTERS: Record<string, string[]> = {
  bsc: [
    '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap V2 Router
    '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8', // Biswap
  ],
  ethereum: [
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap
  ],
  arbitrum: [
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap
    '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', // Camelot
  ],
  base: [
    '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // BaseSwap
    '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb', // Aerodrome
  ],
};

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
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  bsc: ethers.parseEther('0.001'), // 0.001 BNB (~$0.30 at $300/BNB)
  ethereum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  arbitrum: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  base: ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
};

// =============================================================================
// Types
// =============================================================================

interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  factoryAddress: string;
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  minimumProfit: string;
  approvedRouters: string[];
  whitelistedPools: string[];
  verified: boolean;
}

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
 */
async function deployPancakeSwapFlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('PancakeSwapFlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Factory: ${config.factoryAddress}`);

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH/Native`);

  if (balance === 0n) {
    throw new Error('Deployer has no balance. Please fund the deployer account.');
  }

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  // Deploy contract
  console.log('\nDeploying PancakeSwapFlashArbitrage...');
  const PancakeSwapFlashArbitrageFactory = await ethers.getContractFactory(
    'PancakeSwapFlashArbitrage'
  );
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

  // Set minimum profit if specified
  const minimumProfit = config.minimumProfit || DEFAULT_MINIMUM_PROFIT[networkName] || 0n;
  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} Native Token`);
    const tx = await pancakeSwapFlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Add approved routers
  const approvedRouters = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  for (const router of approvedRouters) {
    console.log(`  Adding approved router: ${router}`);
    const tx = await pancakeSwapFlashArbitrage.addApprovedRouter(router);
    await tx.wait();
    console.log('  ✅ Router approved');
  }

  // Task 2.1 (C4): Batch whitelist common pools during deployment
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

  // Verify contract on block explorer
  let verified = false;
  if (!config.skipVerification && networkName !== 'localhost' && networkName !== 'hardhat') {
    console.log('\nVerifying contract on block explorer...');
    try {
      await run('verify:verify', {
        address: contractAddress,
        constructorArguments: [config.factoryAddress, ownerAddress],
      });
      verified = true;
      console.log('✅ Contract verified');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Already Verified')) {
        verified = true;
        console.log('✅ Contract already verified');
      } else {
        console.warn('⚠️ Verification failed:', errorMessage);
        console.log('   You can verify manually later with:');
        console.log(
          `   npx hardhat verify --network ${networkName} ${contractAddress} ${config.factoryAddress} ${ownerAddress}`
        );
      }
    }
  }

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
    approvedRouters,
    whitelistedPools,
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
  const networkFile = path.join(deploymentsDir, `pancakeswap-${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'pancakeswap-registry.json');
  let registry: Record<string, DeploymentResult> = {};
  if (fs.existsSync(registryFile)) {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  }
  registry[result.network] = result;
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  console.log(`📝 Registry updated: ${registryFile}`);
}

/**
 * Print deployment summary
 */
function printDeploymentSummary(result: DeploymentResult): void {
  console.log('\n========================================');
  console.log('Deployment Summary');
  console.log('========================================');
  console.log(`Network:           ${result.network} (${result.chainId})`);
  console.log(`Contract:          ${result.contractAddress}`);
  console.log(`Factory:           ${result.factoryAddress}`);
  console.log(`Owner:             ${result.ownerAddress}`);
  console.log(`Deployer:          ${result.deployerAddress}`);
  console.log(`Transaction:       ${result.transactionHash}`);
  console.log(`Block:             ${result.blockNumber}`);
  console.log(`Timestamp:         ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Minimum Profit:    ${ethers.formatEther(result.minimumProfit)} Native Token`);
  console.log(`Approved Routers:  ${result.approvedRouters.length}`);
  console.log(`Whitelisted Pools: ${result.whitelistedPools.length}`);
  console.log(`Verified:          ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  // Get Factory address for the network
  const factoryAddress = PANCAKESWAP_V3_FACTORY_ADDRESSES[networkName];
  if (!factoryAddress) {
    throw new Error(
      `PancakeSwap V3 Factory address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(PANCAKESWAP_V3_FACTORY_ADDRESSES).join(', ')}`
    );
  }

  // Deploy
  const result = await deployPancakeSwapFlashArbitrage({
    factoryAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
    whitelistPools: true, // Task 2.1 (C4): Enable batch pool whitelisting
  });

  // Save and print summary
  saveDeploymentResult(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
}

// Run the deployment
main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exit(1);
});

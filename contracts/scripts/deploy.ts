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
 * @see implementation_plan_v2.md Task 3.1.3
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * Aave V3 Pool addresses by chain
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
const AAVE_V3_POOL_ADDRESSES: Record<string, string> = {
  // Testnets
  sepolia: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951', // Aave V3 Sepolia Pool
  arbitrumSepolia: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff', // Aave V3 Arbitrum Sepolia Pool

  // Mainnets (for reference - uncomment when ready)
  // ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  // arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  // optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  // polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  // base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
};

/**
 * Default approved DEX routers by chain
 */
const DEFAULT_APPROVED_ROUTERS: Record<string, string[]> = {
  sepolia: [
    '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008', // Uniswap V2 Router (Sepolia)
  ],
  arbitrumSepolia: [
    '0x101F443B4d1b059569D643917553c771E1b9663E', // Uniswap V2 Router (Arbitrum Sepolia)
  ],
  // Production routers - add when ready
  // ethereum: ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'], // Uniswap V2
  // arbitrum: ['0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'], // SushiSwap
};

/**
 * Default minimum profit settings (in wei)
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  sepolia: ethers.parseEther('0.001'), // Low threshold for testing
  arbitrumSepolia: ethers.parseEther('0.001'),
  // Production - set higher thresholds
  // ethereum: ethers.parseEther('0.01'),
  // arbitrum: ethers.parseEther('0.005'),
};

// =============================================================================
// Types
// =============================================================================

interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  aavePoolAddress: string;
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  minimumProfit: string;
  approvedRouters: string[];
  verified: boolean;
}

interface DeploymentConfig {
  aavePoolAddress: string;
  ownerAddress?: string;
  minimumProfit?: bigint;
  approvedRouters?: string[];
  skipVerification?: boolean;
}

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * Deploy FlashLoanArbitrage contract
 */
async function deployFlashLoanArbitrage(config: DeploymentConfig): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('FlashLoanArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Aave Pool: ${config.aavePoolAddress}`);

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error('Deployer has no balance. Please fund the deployer account.');
  }

  // Determine owner address
  const ownerAddress = config.ownerAddress || deployer.address;
  console.log(`Owner: ${ownerAddress}`);

  // Deploy contract
  console.log('\nDeploying FlashLoanArbitrage...');
  const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
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
  const blockNumber = receipt?.blockNumber || 0;
  const block = await ethers.provider.getBlock(blockNumber);
  const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

  // Post-deployment configuration
  console.log('\nConfiguring contract...');

  // Set minimum profit if specified
  const minimumProfit = config.minimumProfit || DEFAULT_MINIMUM_PROFIT[networkName] || 0n;
  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} ETH`);
    const tx = await flashLoanArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Add approved routers
  const approvedRouters = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  for (const router of approvedRouters) {
    console.log(`  Adding approved router: ${router}`);
    const tx = await flashLoanArbitrage.addApprovedRouter(router);
    await tx.wait();
    console.log('  ✅ Router approved');
  }

  // Verify contract on Etherscan
  let verified = false;
  if (!config.skipVerification && networkName !== 'localhost' && networkName !== 'hardhat') {
    console.log('\nVerifying contract on block explorer...');
    try {
      await run('verify:verify', {
        address: contractAddress,
        constructorArguments: [config.aavePoolAddress, ownerAddress],
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
        console.log(`   npx hardhat verify --network ${networkName} ${contractAddress} ${config.aavePoolAddress} ${ownerAddress}`);
      }
    }
  }

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
    approvedRouters,
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
  const networkFile = path.join(deploymentsDir, `${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'registry.json');
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
  console.log(`Network:          ${result.network} (${result.chainId})`);
  console.log(`Contract:         ${result.contractAddress}`);
  console.log(`Aave Pool:        ${result.aavePoolAddress}`);
  console.log(`Owner:            ${result.ownerAddress}`);
  console.log(`Deployer:         ${result.deployerAddress}`);
  console.log(`Transaction:      ${result.transactionHash}`);
  console.log(`Block:            ${result.blockNumber}`);
  console.log(`Timestamp:        ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Minimum Profit:   ${ethers.formatEther(result.minimumProfit)} ETH`);
  console.log(`Approved Routers: ${result.approvedRouters.length}`);
  console.log(`Verified:         ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  // Get Aave Pool address for the network
  const aavePoolAddress = AAVE_V3_POOL_ADDRESSES[networkName];
  if (!aavePoolAddress) {
    throw new Error(
      `Aave V3 Pool address not configured for network: ${networkName}\n` +
      `Supported networks: ${Object.keys(AAVE_V3_POOL_ADDRESSES).join(', ')}`
    );
  }

  // Deploy
  const result = await deployFlashLoanArbitrage({
    aavePoolAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
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

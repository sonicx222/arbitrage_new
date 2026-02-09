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
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 2.2
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * Balancer V2 Vault addresses by chain
 * Single Vault per chain handles all flash loans (no pool discovery needed)
 * @see https://docs.balancer.fi/reference/contracts/deployment-addresses/mainnet.html
 */
const BALANCER_V2_VAULT_ADDRESSES: Record<string, string> = {
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  optimism: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  fantom: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce', // Beethoven X (Balancer V2 fork)
};

/**
 * Default approved DEX routers by chain
 * These routers are commonly used for arbitrage swaps
 */
const DEFAULT_APPROVED_ROUTERS: Record<string, string[]> = {
  ethereum: [
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap Router
    '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  ],
  polygon: [
    '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // QuickSwap Router
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
    '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  ],
  arbitrum: [
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
    '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', // Camelot Router
    '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  ],
  optimism: [
    '0x9c12939390052919aF3155f41Bf4160Fd3666A6f', // Velodrome Router
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
    '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  ],
  base: [
    '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // BaseSwap Router
    '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb', // Aerodrome Router
    '0x2626664c2603336E57B271c5C0b26F421741e481', // SushiSwap Router
  ],
  fantom: [
    '0xF491e7B69E4244ad4002BC14e878a34207E38c29', // SpookySwap Router
    '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52', // SpiritSwap Router
    '0x31F63A33141fFee63D4B26755430a390ACdD8a4d', // Beethoven X Router
  ],
};

/**
 * Default minimum profit settings by chain (in native token wei)
 * Balancer V2 charges 0% fees, so profit threshold can be lower
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
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

interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  vaultAddress: string;
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  minimumProfit: string;
  approvedRouters: string[];
  flashLoanFee: string;
  verified: boolean;
}

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
 */
async function deployBalancerV2FlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('BalancerV2FlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault: ${config.vaultAddress}`);
  console.log('Flash Loan Fee: 0% (Balancer V2 advantage!)');

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
  console.log('\nDeploying BalancerV2FlashArbitrage...');
  const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory(
    'BalancerV2FlashArbitrage'
  );
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

  // Set minimum profit if specified
  const minimumProfit = config.minimumProfit || DEFAULT_MINIMUM_PROFIT[networkName] || 0n;
  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} Native Token`);
    const tx = await balancerV2FlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Add approved routers
  const approvedRouters = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  if (approvedRouters.length > 0) {
    console.log(`\nAdding ${approvedRouters.length} approved routers...`);
    for (const router of approvedRouters) {
      console.log(`  Adding router: ${router}`);
      const tx = await balancerV2FlashArbitrage.addApprovedRouter(router);
      await tx.wait();
      console.log('  ✅ Router approved');
    }
  } else {
    console.log('\n⚠️ No routers configured (add manually before use)');
  }

  // Verify contract on block explorer
  let verified = false;
  if (!config.skipVerification && networkName !== 'localhost' && networkName !== 'hardhat') {
    console.log('\nVerifying contract on block explorer...');
    try {
      await run('verify:verify', {
        address: contractAddress,
        constructorArguments: [config.vaultAddress, ownerAddress],
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
          `   npx hardhat verify --network ${networkName} ${contractAddress} ${config.vaultAddress} ${ownerAddress}`
        );
      }
    }
  }

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
    approvedRouters,
    flashLoanFee: '0', // Balancer V2 has 0% fees!
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
  const networkFile = path.join(deploymentsDir, `balancer-${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'balancer-registry.json');
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
  console.log(`Vault:             ${result.vaultAddress}`);
  console.log(`Owner:             ${result.ownerAddress}`);
  console.log(`Deployer:          ${result.deployerAddress}`);
  console.log(`Transaction:       ${result.transactionHash}`);
  console.log(`Block:             ${result.blockNumber}`);
  console.log(`Timestamp:         ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Minimum Profit:    ${ethers.formatEther(result.minimumProfit)} Native Token`);
  console.log(`Flash Loan Fee:    ${result.flashLoanFee}% (0% - Balancer V2 advantage!)`);
  console.log(`Approved Routers:  ${result.approvedRouters.length}`);
  console.log(`Verified:          ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');

  // Print cost savings vs Aave V3
  console.log('💰 Cost Savings vs Aave V3:');
  console.log('   Flash Loan Fee: 0% (vs Aave V3\'s 0.09%)');
  console.log('   Example: On a $100K flash loan, save $90 per trade!');
  console.log('========================================\n');
}

/**
 * Print post-deployment instructions
 */
function printPostDeploymentInstructions(result: DeploymentResult): void {
  console.log('📋 Next Steps:');
  console.log('========================================');
  console.log('1. Update service-config.ts:');
  console.log(`   - Add contractAddress for ${result.network} in FLASH_LOAN_PROVIDERS`);
  console.log(`   - Set protocol: 'balancer_v2', fee: 0`);
  console.log('');
  console.log('2. Update execution-engine config:');
  console.log(`   - Add ${result.contractAddress} to contractAddresses.${result.network}`);
  console.log(`   - Add routers to approvedRouters.${result.network}`);
  console.log('');
  console.log('3. Test deployment:');
  console.log(`   - Run integration tests on ${result.network}`);
  console.log('   - Verify router approvals are working');
  console.log('   - Execute a small test arbitrage');
  console.log('');
  console.log('4. Monitor metrics:');
  console.log('   - Track flash loan success rate');
  console.log('   - Compare profit margins vs Aave V3');
  console.log('   - Monitor gas costs');
  console.log('========================================\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  // Get Vault address for the network
  const vaultAddress = BALANCER_V2_VAULT_ADDRESSES[networkName];
  if (!vaultAddress) {
    throw new Error(
      `Balancer V2 Vault address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(BALANCER_V2_VAULT_ADDRESSES).join(', ')}`
    );
  }

  // Deploy
  const result = await deployBalancerV2FlashArbitrage({
    vaultAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
  });

  // Save and print summary
  saveDeploymentResult(result);
  printDeploymentSummary(result);
  printPostDeploymentInstructions(result);

  console.log('🎉 Deployment complete!');
  console.log('\n💡 Tip: Uncomment the Balancer V2 entry in service-config.ts');
  console.log('   to replace Aave V3 and start saving 0.09% on every flash loan!');
}

// Run the deployment
main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exit(1);
});

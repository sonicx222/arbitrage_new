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
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.4
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */

import { ethers, network, run } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Network Configuration
// =============================================================================

/**
 * SyncSwap Vault addresses by network
 * Single Vault per network handles all flash loans (no pool discovery needed)
 * @see https://syncswap.xyz/
 * @see docs/syncswap_api_dpcu.md
 */
const SYNCSWAP_VAULT_ADDRESSES: Record<string, string> = {
  // zkSync Era Mainnet
  'zksync-mainnet': '0x621425a1Ef6abE91058E9712575dcc4258F8d091',
  'zksync': '0x621425a1Ef6abE91058E9712575dcc4258F8d091',

  // zkSync Era Sepolia Testnet (Staging)
  'zksync-testnet': '0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8',
  'zksync-sepolia': '0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8',
};

/**
 * Default approved DEX routers for zkSync Era
 * These routers are commonly used for arbitrage swaps
 */
const DEFAULT_APPROVED_ROUTERS: Record<string, string[]> = {
  // zkSync Era Mainnet
  'zksync-mainnet': [
    '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', // SyncSwap Router
    '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io Router
    '0x39E098A153Ad69834a9Dac32f0FCa92066aD03f4', // Velocore Router
  ],
  'zksync': [
    '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', // SyncSwap Router
    '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io Router
    '0x39E098A153Ad69834a9Dac32f0FCa92066aD03f4', // Velocore Router
  ],

  // zkSync Era Sepolia Testnet
  'zksync-testnet': [
    '0xB3b7fCbb8Db37bC6f572634299A58f51622A847e', // SyncSwap Router (Testnet)
    '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io Router (if available)
  ],
  'zksync-sepolia': [
    '0xB3b7fCbb8Db37bC6f572634299A58f51622A847e', // SyncSwap Router (Testnet)
    '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io Router (if available)
  ],
};

/**
 * Default minimum profit settings by network (in native token wei)
 * SyncSwap charges 0.3% fees, so profit threshold should account for this
 */
const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  'zksync-mainnet': ethers.parseEther('0.001'), // 0.001 ETH (~$3 at $3000/ETH)
  'zksync': ethers.parseEther('0.001'),
  'zksync-testnet': ethers.parseEther('0.0001'), // Lower for testnet
  'zksync-sepolia': ethers.parseEther('0.0001'),
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
 * Deploy SyncSwapFlashArbitrage contract
 */
async function deploySyncSwapFlashArbitrage(
  config: DeploymentConfig
): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('SyncSwapFlashArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault: ${config.vaultAddress}`);
  console.log('Flash Loan Fee: 0.3% (30 bps) - SyncSwap standard');

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
  console.log('\nDeploying SyncSwapFlashArbitrage...');
  const SyncSwapFlashArbitrageFactory = await ethers.getContractFactory(
    'SyncSwapFlashArbitrage'
  );
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

  // Set minimum profit if specified
  const minimumProfit = config.minimumProfit || DEFAULT_MINIMUM_PROFIT[networkName] || 0n;
  if (minimumProfit > 0n) {
    console.log(`  Setting minimum profit: ${ethers.formatEther(minimumProfit)} ETH`);
    const tx = await syncSwapFlashArbitrage.setMinimumProfit(minimumProfit);
    await tx.wait();
    console.log('  ✅ Minimum profit set');
  }

  // Add approved routers
  const approvedRouters = config.approvedRouters || DEFAULT_APPROVED_ROUTERS[networkName] || [];
  if (approvedRouters.length > 0) {
    console.log(`\nAdding ${approvedRouters.length} approved routers...`);
    for (const router of approvedRouters) {
      console.log(`  Adding router: ${router}`);
      const tx = await syncSwapFlashArbitrage.addApprovedRouter(router);
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
    flashLoanFee: '30', // 0.3% = 30 bps
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
  const networkFile = path.join(deploymentsDir, `syncswap-${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'syncswap-registry.json');
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
  console.log(`Minimum Profit:    ${ethers.formatEther(result.minimumProfit)} ETH`);
  console.log(`Flash Loan Fee:    ${result.flashLoanFee} bps (0.3%)`);
  console.log(`Approved Routers:  ${result.approvedRouters.length}`);
  console.log(`Verified:          ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');

  // Print cost comparison vs other protocols
  console.log('💰 Flash Loan Fee Comparison:');
  console.log('   SyncSwap:   0.3% (30 bps) - This deployment');
  console.log('   Aave V3:    0.09% (9 bps) - Cheaper but not on zkSync Era');
  console.log('   Balancer:   0% - Cheapest but not on zkSync Era');
  console.log('   Note: SyncSwap is currently the best option for zkSync Era flash loans');
  console.log('========================================\n');
}

/**
 * Print post-deployment instructions
 */
function printPostDeploymentInstructions(result: DeploymentResult): void {
  console.log('📋 Next Steps:');
  console.log('========================================');
  console.log('1. Update .env file:');
  console.log(`   ZKSYNC_FLASH_LOAN_CONTRACT=${result.contractAddress}`);
  console.log(`   ZKSYNC_APPROVED_ROUTERS=${result.approvedRouters.join(',')}`);
  console.log('');
  console.log('2. Update execution-engine config:');
  console.log(`   contractAddresses: {`);
  console.log(`     zksync: '${result.contractAddress}',`);
  console.log(`   }`);
  console.log(`   approvedRouters: {`);
  console.log(`     zksync: ${JSON.stringify(result.approvedRouters, null, 6)},`);
  console.log(`   }`);
  console.log('');
  console.log('3. Test deployment:');
  console.log(`   - Restart execution engine: npm run dev:execution:fast`);
  console.log(`   - Check logs for: "Created SyncSwap provider for zksync"`);
  console.log(`   - Run integration tests (if available)`);
  console.log('');
  console.log('4. Monitor metrics:');
  console.log('   - Track flash loan success rate');
  console.log('   - Compare profit margins vs other protocols');
  console.log('   - Monitor gas costs on zkSync Era');
  console.log('========================================\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  // Get Vault address for the network
  const vaultAddress = SYNCSWAP_VAULT_ADDRESSES[networkName];
  if (!vaultAddress) {
    throw new Error(
      `SyncSwap Vault address not configured for network: ${networkName}\n` +
      `Supported networks: ${Object.keys(SYNCSWAP_VAULT_ADDRESSES).join(', ')}\n` +
      `\nAvailable networks:\n` +
      `  - zksync-mainnet (or zksync): zkSync Era Mainnet\n` +
      `  - zksync-testnet (or zksync-sepolia): zkSync Era Sepolia Testnet`
    );
  }

  // Deploy
  const result = await deploySyncSwapFlashArbitrage({
    vaultAddress,
    approvedRouters: DEFAULT_APPROVED_ROUTERS[networkName],
    minimumProfit: DEFAULT_MINIMUM_PROFIT[networkName],
  });

  // Save and print summary
  saveDeploymentResult(result);
  printDeploymentSummary(result);
  printPostDeploymentInstructions(result);

  console.log('🎉 Deployment complete!');
  console.log('\n💡 Tip: SyncSwap charges 0.3% flash loan fee (30 bps)');
  console.log('   This is competitive on zkSync Era where Aave V3 and Balancer V2');
  console.log('   are not yet deployed. Factor this into profit calculations!');
}

// Run the deployment
main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exit(1);
});

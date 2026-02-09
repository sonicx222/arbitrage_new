/**
 * CommitRevealArbitrage Contract Deployment Script
 *
 * Deploys the CommitRevealArbitrage contract to supported networks.
 * This contract implements a two-phase commit-reveal pattern to prevent MEV attacks
 * on high-risk arbitrage transactions when private mempools are unavailable.
 *
 * Usage:
 *   # Testnet deployment (recommended first)
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network sepolia
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrumSepolia
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network baseSepolia
 *
 *   # Mainnet deployment (after testnet validation)
 *   # Phase 1: Core chains
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network ethereum
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrum
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network bsc
 *
 *   # Phase 2: Additional chains
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network polygon
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network optimism
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network base
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network avalanche
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network fantom
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network zksync
 *
 *   # Phase 3: Linea
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network linea
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment wallet
 *   CONTRACT_OWNER - Owner address (defaults to deployer if not set)
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum/Sepolia
 *   ARBISCAN_API_KEY - For contract verification on Arbitrum
 *   BSCSCAN_API_KEY - For contract verification on BSC
 *   POLYGONSCAN_API_KEY - For contract verification on Polygon
 *   OPTIMISTIC_ETHERSCAN_API_KEY - For verification on Optimism
 *   BASESCAN_API_KEY - For contract verification on Base
 *   SNOWTRACE_API_KEY - For contract verification on Avalanche
 *   FTMSCAN_API_KEY - For contract verification on Fantom
 *   ZKSYNC_ETHERSCAN_API_KEY - For verification on zkSync
 *   LINEASCAN_API_KEY - For contract verification on Linea
 *
 * Post-Deployment Steps:
 *   1. Approve DEX routers via approveRouter(address)
 *   2. Set minimum profit threshold via setMinimumProfit(uint256)
 *   3. Transfer ownership to multisig via transferOwnership(address) + acceptOwnership()
 *   4. Update configuration files with deployed address
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
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
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  gasUsed: string;
  verified: boolean;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get contract owner address from environment or use deployer
 */
function getOwnerAddress(deployerAddress: string): string {
  return process.env.CONTRACT_OWNER || deployerAddress;
}

// =============================================================================
// Deployment Functions
// =============================================================================

/**
 * Deploy CommitRevealArbitrage contract
 */
async function deployCommitRevealArbitrage(): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('\n========================================');
  console.log('CommitRevealArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error('Deployer has no balance. Please fund the deployer account.');
  }

  // Determine owner address
  const ownerAddress = getOwnerAddress(deployer.address);
  console.log(`Owner Address: ${ownerAddress}`);

  if (ownerAddress !== deployer.address) {
    console.log('⚠️  Owner is different from deployer. Remember to accept ownership from owner account.');
  }

  // Estimate deployment cost
  const CommitRevealArbitrageFactory = await ethers.getContractFactory('CommitRevealArbitrage');
  const deployTxData = CommitRevealArbitrageFactory.getDeployTransaction(ownerAddress);
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
  console.log('\nDeploying CommitRevealArbitrage...');
  const commitRevealArbitrage = await CommitRevealArbitrageFactory.deploy(ownerAddress);

  await commitRevealArbitrage.waitForDeployment();
  const contractAddress = await commitRevealArbitrage.getAddress();
  const deployTx = commitRevealArbitrage.deploymentTransaction();

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
        constructorArguments: [ownerAddress],
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
        console.log(`   npx hardhat verify --network ${networkName} ${contractAddress} ${ownerAddress}`);
      }
    }
  }

  // Smoke test: check contract state
  console.log('\nRunning smoke tests...');
  try {
    const minDelayBlocks = await commitRevealArbitrage.MIN_DELAY_BLOCKS();
    const maxCommitAgeBlocks = await commitRevealArbitrage.MAX_COMMIT_AGE_BLOCKS();
    const minimumProfit = await commitRevealArbitrage.minimumProfit();
    const paused = await commitRevealArbitrage.paused();

    console.log('✅ Smoke tests passed:');
    console.log(`   MIN_DELAY_BLOCKS: ${minDelayBlocks}`);
    console.log(`   MAX_COMMIT_AGE_BLOCKS: ${maxCommitAgeBlocks}`);
    console.log(`   minimumProfit: ${ethers.formatEther(minimumProfit)} ETH`);
    console.log(`   paused: ${paused}`);
  } catch (error) {
    console.log('⚠️  Smoke test failed:', error);
  }

  return {
    network: networkName,
    chainId,
    contractAddress,
    ownerAddress,
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
  const networkFile = path.join(deploymentsDir, `commit-reveal-${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry
  const registryFile = path.join(deploymentsDir, 'commit-reveal-registry.json');
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
  console.log(`Owner:        ${result.ownerAddress}`);
  console.log(`Deployer:     ${result.deployerAddress}`);
  console.log(`Transaction:  ${result.transactionHash}`);
  console.log(`Block:        ${result.blockNumber}`);
  console.log(`Timestamp:    ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Gas Used:     ${result.gasUsed}`);
  console.log(`Verified:     ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');

  console.log('📋 NEXT STEPS:\n');

  console.log('1. Approve DEX routers for swap execution:');
  console.log(`   npx hardhat console --network ${result.network}`);
  console.log(`   > const contract = await ethers.getContractAt('CommitRevealArbitrage', '${result.contractAddress}');`);
  console.log(`   > await contract.approveRouter('0xROUTER_ADDRESS'); // Repeat for each DEX`);
  console.log('');

  console.log('2. (Optional) Adjust minimum profit threshold:');
  console.log(`   > await contract.setMinimumProfit(ethers.parseEther('0.01')); // Set to 0.01 ETH`);
  console.log('');

  if (result.ownerAddress !== result.deployerAddress) {
    console.log('3. Transfer ownership to multisig (RECOMMENDED):');
    console.log(`   From deployer: await contract.transferOwnership('${result.ownerAddress}');`);
    console.log(`   From owner: await contract.acceptOwnership();`);
    console.log('');
  } else {
    console.log('3. Transfer ownership to multisig (RECOMMENDED):');
    console.log(`   > await contract.transferOwnership('0xMULTISIG_ADDRESS');`);
    console.log(`   Then from multisig: await contract.acceptOwnership();`);
    console.log('');
  }

  console.log('4. Update contract address in configuration:');
  console.log(`   File: shared/config/src/addresses.ts`);
  console.log(`   Update: COMMIT_REVEAL_CONTRACTS.${result.network} = '${result.contractAddress}';`);
  console.log('   Or set environment variable:');
  console.log(`   export COMMIT_REVEAL_CONTRACT_${result.network.toUpperCase()}=${result.contractAddress}`);
  console.log('');

  console.log('5. Enable feature flag in environment:');
  console.log(`   export FEATURE_COMMIT_REVEAL=true  # Enable commit-reveal MEV protection`);
  console.log(`   export FEATURE_COMMIT_REVEAL_REDIS=true  # (Optional) Use Redis storage`);
  console.log('');

  console.log('6. Restart services to pick up new configuration');
  console.log('');

  console.log('7. Test the deployment:');
  console.log(`   # Create a test commitment`);
  console.log(`   > const params = { tokenIn: '0x...', tokenOut: '0x...', amountIn: 1000, minProfit: 100, router: '0x...', deadline: Math.floor(Date.now()/1000) + 300, salt: ethers.hexlify(ethers.randomBytes(32)) };`);
  console.log(`   > const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint256','uint256','address','uint256','bytes32'], [params.tokenIn, params.tokenOut, params.amountIn, params.minProfit, params.router, params.deadline, params.salt]));`);
  console.log(`   > await contract.commit(hash);`);
  console.log(`   # Wait 1 block, then reveal`);
  console.log(`   > await contract.reveal(params);`);
  console.log('');

  if (!result.verified) {
    console.log('⚠️  Contract not verified. To verify manually:');
    console.log(`   npx hardhat verify --network ${result.network} ${result.contractAddress} ${result.ownerAddress}`);
    console.log('');
  }

  console.log('📖 For detailed usage, see:');
  console.log('   docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1');
  console.log('   contracts/src/CommitRevealArbitrage.sol (inline documentation)');
  console.log('');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = network.name;

  console.log(`\nStarting CommitRevealArbitrage deployment to ${networkName}...`);

  // Validate network
  const supportedNetworks = [
    'ethereum', 'arbitrum', 'bsc', 'polygon', 'optimism', 'base',
    'avalanche', 'fantom', 'zksync', 'linea',
    'sepolia', 'arbitrumSepolia', 'baseSepolia', 'localhost', 'hardhat'
  ];

  if (!supportedNetworks.includes(networkName)) {
    console.warn(`⚠️  WARNING: Network '${networkName}' is not in the standard list.`);
    console.warn('   Deployment will proceed, but you may need to add custom verification config.');
  }

  // Deploy
  const result = await deployCommitRevealArbitrage();

  // Save and print summary
  saveDeploymentResult(result);
  printDeploymentSummary(result);

  console.log('🎉 Deployment complete!');
  console.log('\n⚠️  IMPORTANT: Remember to:');
  console.log('   1. Approve DEX routers');
  console.log('   2. Transfer ownership to multisig');
  console.log('   3. Update addresses.ts with deployed address');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

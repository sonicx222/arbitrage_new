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
 * Phase 4A Improvements:
 *   ✅ Uses deployment-utils.ts for consistency
 *   ✅ Gas estimation error handling
 *   ✅ Verification retry with exponential backoff
 *   ✅ Network name normalization
 *   ✅ Smoke tests with constraint validation
 *   ✅ No minimumProfit (off-chain validation)
 *   ✅ No router approval (configured manually post-deployment)
 *
 * Post-Deployment Steps:
 *   1. Approve DEX routers via approveRouter(address)
 *   2. Set minimum profit threshold via setMinimumProfit(uint256)
 *   3. Transfer ownership to multisig via transferOwnership(address) + acceptOwnership()
 *   4. Update configuration files with deployed address
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
 */

import { ethers, network } from 'hardhat';
import {
  normalizeNetworkName,
  getSafeChainId,  // P1-007 FIX: Import safe chain ID getter
  checkDeployerBalance,
  estimateDeploymentCost,
  verifyContractWithRetry,
  smokeTestCommitRevealContract,
  saveDeploymentResult,
  printDeploymentSummary,  // P3-005 FIX: Use shared function instead of duplicate
  DEFAULT_VERIFICATION_RETRIES,
  DEFAULT_VERIFICATION_INITIAL_DELAY_MS,
  type CommitRevealDeploymentResult
} from './lib/deployment-utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Type alias for commit-reveal contract deployment results
 *
 * Maps to CommitRevealDeploymentResult from deployment-utils.ts for type safety.
 * This alias maintains backward compatibility with existing function signatures
 * (e.g., deployCommitRevealArbitrage() return type) while ensuring consistency
 * with the standardized deployment result types used internally.
 *
 * @see CommitRevealDeploymentResult in deployment-utils.ts
 */
type DeploymentResult = CommitRevealDeploymentResult;

// =============================================================================
// Configuration
// =============================================================================

/**
 * NOTE: This contract does NOT define DEFAULT_MINIMUM_PROFIT like other
 * deployment scripts (deploy.ts, deploy-balancer.ts, deploy-pancakeswap.ts).
 *
 * Reason: CommitRevealArbitrage performs profit validation off-chain in the
 * execution-engine service before calling executeArbitrage(). The two-phase
 * commit-reveal pattern already requires off-chain coordination, so profit
 * checks naturally occur at that stage rather than wasting gas on-chain.
 *
 * @see services/execution-engine/src/strategies/commit-reveal-strategy.ts
 * @see contracts/src/CommitRevealArbitrage.sol (no minimumProfit state variable)
 */

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
  const networkName = normalizeNetworkName(network.name);
  // P1-007 FIX: Use safe chain ID getter with validation
  const chainId = await getSafeChainId();

  console.log('\n========================================');
  console.log('CommitRevealArbitrage Deployment');
  console.log('========================================');
  console.log(`Network: ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  // Phase 1 Fix: Proper balance checking with helpful error messages
  await checkDeployerBalance(deployer);

  // Determine owner address
  const ownerAddress = getOwnerAddress(deployer.address);
  console.log(`Owner Address: ${ownerAddress}`);

  if (ownerAddress !== deployer.address) {
    console.log('⚠️  Owner is different from deployer. Remember to accept ownership from owner account.');
  }

  // Phase 1 Fix: Estimate gas with error handling
  const CommitRevealArbitrageFactory = await ethers.getContractFactory('CommitRevealArbitrage');
  await estimateDeploymentCost(CommitRevealArbitrageFactory, ownerAddress);

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
  const blockNumber = receipt?.blockNumber ?? 0;
  const gasUsed = receipt?.gasUsed?.toString() || '0';
  const block = await ethers.provider.getBlock(blockNumber);
  const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

  console.log(`   Block: ${blockNumber}`);
  console.log(`   Gas Used: ${gasUsed}`);

  // Phase 4A: Verification with retry logic
  const verified = await verifyContractWithRetry(
    contractAddress,
    [ownerAddress],
    DEFAULT_VERIFICATION_RETRIES,
    DEFAULT_VERIFICATION_INITIAL_DELAY_MS
  );

  // Phase 4A: Smoke tests with constraint validation
  await smokeTestCommitRevealContract(commitRevealArbitrage, ownerAddress);

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
 * Save deployment result to file (now using utility function)
 * Kept as wrapper for backward compatibility
 */
async function saveCommitRevealDeployment(result: DeploymentResult): Promise<void> {
  await saveDeploymentResult(result, 'commit-reveal-registry.json', 'CommitRevealArbitrage');
}

/**
 * P3-005 FIX: Print contract-specific next steps (shared summary moved to deployment-utils)
 * This function prints CommitRevealArbitrage-specific configuration steps
 */
function printCommitRevealNextSteps(result: DeploymentResult): void {
  console.log('📋 COMMIT-REVEAL SPECIFIC STEPS:\n');

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
  console.log(`   # Create a test commitment using RevealParams struct`);
  console.log(`   > const salt = ethers.hexlify(ethers.randomBytes(32));`);
  console.log(`   > const params = {`);
  console.log(`   >   asset: '0xWETH...',`);
  console.log(`   >   amountIn: ethers.parseEther('0.1'),`);
  console.log(`   >   swapPath: [{ router: '0xROUTER', tokenIn: '0xWETH', tokenOut: '0xUSDC', amountOutMin: 0 }],`);
  console.log(`   >   minProfit: ethers.parseEther('0.001'),`);
  console.log(`   >   deadline: Math.floor(Date.now()/1000) + 300,`);
  console.log(`   >   salt: salt`);
  console.log(`   > };`);
  console.log(`   > const encoded = ethers.AbiCoder.defaultAbiCoder().encode(`);
  console.log(`   >   ['address','uint256','(address,address,address,uint256)[]','uint256','uint256','bytes32'],`);
  console.log(`   >   [params.asset, params.amountIn, params.swapPath.map(s => [s.router, s.tokenIn, s.tokenOut, s.amountOutMin]), params.minProfit, params.deadline, params.salt]`);
  console.log(`   > );`);
  console.log(`   > const hash = ethers.keccak256(encoded);`);
  console.log(`   > await contract.commit(hash);`);
  console.log(`   # Wait MIN_DELAY_BLOCKS (1 block), then reveal`);
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
  const networkName = normalizeNetworkName(network.name);

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
  await saveCommitRevealDeployment(result);
  // P3-005 FIX: Use shared summary, then contract-specific next steps
  printDeploymentSummary(result);
  printCommitRevealNextSteps(result);

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

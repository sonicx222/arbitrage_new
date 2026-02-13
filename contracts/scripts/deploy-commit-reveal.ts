/**
 * CommitRevealArbitrage Contract Deployment Script
 *
 * Deploys the CommitRevealArbitrage contract to supported networks.
 * This contract implements a two-phase commit-reveal pattern to prevent MEV attacks
 * on high-risk arbitrage transactions when private mempools are unavailable.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network sepolia
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network ethereum
 *   npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrum
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key for deployment wallet
 *   CONTRACT_OWNER - Owner address (defaults to deployer if not set)
 *   ETHERSCAN_API_KEY - For contract verification on Ethereum/Sepolia
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
 */

import { network } from 'hardhat';
import {
  normalizeNetworkName,
  saveDeploymentResult,
  printDeploymentSummary,
  confirmMainnetDeployment,
  checkExistingDeployment,
  deployContractPipeline,
  type DeploymentPipelineConfig,
} from './lib/deployment-utils';

// =============================================================================
// Pipeline Configuration
// =============================================================================

/**
 * NOTE: CommitRevealArbitrage does NOT configure minimumProfit or routers during
 * deployment. Profit validation is off-chain in the execution-engine service.
 * Routers are configured manually post-deployment.
 *
 * @see services/execution-engine/src/strategies/commit-reveal-strategy.ts
 */
function buildConfig(): DeploymentPipelineConfig {
  const ownerAddress = process.env.CONTRACT_OWNER;

  return {
    contractName: 'CommitRevealArbitrage',
    registryName: 'commit-reveal-registry.json',
    contractFactoryName: 'CommitRevealArbitrage',
    constructorArgs: (deployer) => [ownerAddress ?? deployer],
    ownerAddress: (deployer) => ownerAddress ?? deployer,
    configureMinProfit: false,
    configureRouters: false,
    smokeTest: 'commitReveal',
    supportedNetworks: [
      'ethereum', 'arbitrum', 'bsc', 'polygon', 'optimism', 'base',
      'avalanche', 'fantom', 'zksync', 'linea',
      'sepolia', 'arbitrumSepolia', 'baseSepolia', 'localhost', 'hardhat',
    ],
  };
}

// =============================================================================
// Next Steps (contract-specific)
// =============================================================================

function printCommitRevealNextSteps(result: Record<string, any>): void {
  console.log('COMMIT-REVEAL SPECIFIC STEPS:\n');

  console.log('1. Approve DEX routers for swap execution:');
  console.log(`   npx hardhat console --network ${result.network}`);
  console.log(`   > const contract = await ethers.getContractAt('CommitRevealArbitrage', '${result.contractAddress}');`);
  console.log(`   > await contract.addApprovedRouter('0xROUTER_ADDRESS'); // Repeat for each DEX`);
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
    console.log('Contract not verified. To verify manually:');
    console.log(`   npx hardhat verify --network ${result.network} ${result.contractAddress} ${result.ownerAddress}`);
    console.log('');
  }

  console.log('For detailed usage, see:');
  console.log('   docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1');
  console.log('   contracts/src/CommitRevealArbitrage.sol (inline documentation)');
  console.log('');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'CommitRevealArbitrage');

  // Check for existing deployment on this network
  await checkExistingDeployment(networkName, 'CommitRevealArbitrage');

  console.log(`\nStarting CommitRevealArbitrage deployment to ${networkName}...`);

  // Deploy via shared pipeline
  const { result } = await deployContractPipeline(buildConfig());

  // Save and print summary
  await saveDeploymentResult(result as any, 'commit-reveal-registry.json', 'CommitRevealArbitrage');
  printDeploymentSummary(result as any);
  printCommitRevealNextSteps(result);

  console.log('Deployment complete!');
  console.log('\nIMPORTANT: Remember to:');
  console.log('   1. Approve DEX routers');
  console.log('   2. Transfer ownership to multisig');
  console.log('   3. Update addresses.ts with deployed address');
}

// Run the deployment
main().catch((error) => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});

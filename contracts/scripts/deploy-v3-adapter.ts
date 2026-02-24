/**
 * UniswapV3Adapter Deployment Script
 *
 * Deploys the UniswapV3Adapter contract and registers it as an approved
 * router on an existing FlashLoanArbitrage contract.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY        - Private key for deployment
 *   V3_SWAP_ROUTER              - Uniswap V3 SwapRouter address (required)
 *   V3_QUOTER                   - Uniswap V3 QuoterV2 address (optional, address(0) if not set)
 *   FLASH_LOAN_CONTRACT_ADDRESS - FlashLoanArbitrage address to register adapter as router
 *   DEFAULT_FEE_TIER            - Default V3 fee tier in bps (default: 3000 = 0.3%)
 *
 * @see docs/plans/2026-02-24-profitability-boost.md Phase 3 Task 3.4
 */

import { ethers, network } from 'hardhat';
import {
  normalizeNetworkName,
  confirmMainnetDeployment,
} from './lib/deployment-utils';
import { FLASH_LOAN_CONTRACT_ADDRESSES } from '../deployments/addresses';

// =============================================================================
// V3 SwapRouter Addresses (well-known, deployed via CREATE2)
// =============================================================================

const V3_SWAP_ROUTERS: Record<string, string> = {
  // Uniswap V3 SwapRouter (same address on most EVM chains via CREATE2)
  ethereum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  polygon: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  base: '0x2626664c2603336E57B271c5C0b26F421741e481',
  // Testnets
  arbitrumSepolia: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  sepolia: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
};

const V3_QUOTERS: Record<string, string> = {
  ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  polygon: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  // Testnets — QuoterV2 may not be deployed on all testnets
  arbitrumSepolia: '0x0000000000000000000000000000000000000000',
  sepolia: '0x0000000000000000000000000000000000000000',
};

// Common fee tier configurations per pair
const PAIR_FEES: Record<string, { tokenA: string; tokenB: string; fee: number }[]> = {
  arbitrum: [
    // WETH/USDC 0.05% (most liquid)
    { tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', tokenB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', fee: 500 },
    // WETH/WBTC 0.3%
    { tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', tokenB: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', fee: 3000 },
  ],
  // Testnet pairs — skip pair-specific fees (use default)
  arbitrumSepolia: [],
};

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const networkName = normalizeNetworkName(network.name);

  // Require confirmation before mainnet deployment
  await confirmMainnetDeployment(networkName, 'UniswapV3Adapter');

  // Resolve V3 SwapRouter address
  const v3RouterAddress = process.env.V3_SWAP_ROUTER ?? V3_SWAP_ROUTERS[networkName];
  if (!v3RouterAddress) {
    throw new Error(
      `[ERR_NO_V3_ROUTER] Uniswap V3 SwapRouter address not configured for network: ${networkName}\n` +
      `Set V3_SWAP_ROUTER env var or add to V3_SWAP_ROUTERS map in this script.\n` +
      `Known networks: ${Object.keys(V3_SWAP_ROUTERS).join(', ')}`
    );
  }

  // Resolve QuoterV2 address (optional — address(0) disables getAmountsOut/In)
  const quoterAddress = process.env.V3_QUOTER ?? V3_QUOTERS[networkName] ?? ethers.ZeroAddress;

  // Resolve FlashLoanArbitrage address for router registration
  const flashLoanAddress = process.env.FLASH_LOAN_CONTRACT_ADDRESS
    ?? FLASH_LOAN_CONTRACT_ADDRESSES[networkName];

  // Default fee tier
  const defaultFeeTier = parseInt(process.env.DEFAULT_FEE_TIER ?? '3000', 10);

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error('[ERR_NO_DEPLOYER] No deployer account available. Set DEPLOYER_PRIVATE_KEY.');
  }

  console.log('\n========================================');
  console.log('UniswapV3Adapter Deployment');
  console.log('========================================');
  console.log(`Network:        ${networkName}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`V3 SwapRouter:  ${v3RouterAddress}`);
  console.log(`V3 QuoterV2:    ${quoterAddress === ethers.ZeroAddress ? '(not configured)' : quoterAddress}`);
  console.log(`Default Fee:    ${defaultFeeTier} (${defaultFeeTier / 10000 * 100}%)`);
  if (flashLoanAddress) {
    console.log(`FlashLoan:      ${flashLoanAddress}`);
  }
  console.log('');

  // Deploy UniswapV3Adapter
  console.log('Deploying UniswapV3Adapter...');
  const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
  const adapter = await AdapterFactory.deploy(
    v3RouterAddress,
    quoterAddress,
    deployer.address,
    defaultFeeTier
  );
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`UniswapV3Adapter deployed to: ${adapterAddress}`);

  // Configure pair-specific fee tiers
  const pairFees = PAIR_FEES[networkName] ?? [];
  if (pairFees.length > 0) {
    console.log(`\nConfiguring ${pairFees.length} pair-specific fee tiers...`);
    for (const { tokenA, tokenB, fee } of pairFees) {
      const tx = await adapter.setPairFee(tokenA, tokenB, fee);
      await tx.wait();
      console.log(`  Set fee ${fee} for ${tokenA.slice(0, 10)}.../${tokenB.slice(0, 10)}...`);
    }
  }

  // Register adapter as approved router on FlashLoanArbitrage
  if (flashLoanAddress) {
    console.log(`\nRegistering adapter as approved router on FlashLoanArbitrage...`);
    const flashLoan = await ethers.getContractAt('FlashLoanArbitrage', flashLoanAddress);

    // Check if already approved
    const isApproved = await flashLoan.isApprovedRouter(adapterAddress);
    if (isApproved) {
      console.log('  Adapter already approved (skipping)');
    } else {
      const tx = await flashLoan.addApprovedRouter(adapterAddress);
      await tx.wait();
      console.log(`  Adapter approved as router on FlashLoanArbitrage`);
    }
  } else {
    console.log('\nNo FlashLoanArbitrage address found — skipping router registration.');
    console.log('Register manually later with:');
    console.log(`  await flashLoan.addApprovedRouter("${adapterAddress}")`);
  }

  // Print summary
  console.log('\n========================================');
  console.log('Deployment Complete');
  console.log('========================================');
  console.log(`UniswapV3Adapter: ${adapterAddress}`);
  console.log(`V3 SwapRouter:    ${v3RouterAddress}`);
  console.log(`Default Fee:      ${defaultFeeTier}`);
  console.log(`Pair Fees Set:    ${pairFees.length}`);
  console.log('');
  console.log('NEXT STEPS:');
  console.log(`1. Add adapter to APPROVED_ROUTERS in contracts/deployments/addresses.ts:`);
  console.log(`   ${networkName}: [...existing, '${adapterAddress}']`);
  console.log(`2. Run: npm run typecheck`);
  console.log(`3. Commit: git add contracts/deployments/ && git commit -m "deploy: UniswapV3Adapter to ${networkName}"`);
  console.log('');
}

main().catch((error) => {
  console.error('\n Deployment failed:', error);
  process.exit(1);
});

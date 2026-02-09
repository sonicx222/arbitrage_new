/**
 * Check Balance Script
 *
 * Checks the balance of the deployer account on the current network.
 * Useful before deployment to ensure sufficient funds.
 *
 * Usage:
 *   npx hardhat run scripts/check-balance.ts --network zksync
 *   npx hardhat run scripts/check-balance.ts --network ethereum
 *   npx hardhat run scripts/check-balance.ts --network arbitrum
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY - Private key of the deployer account
 *
 * @see contracts/SYNCSWAP_DEPLOYMENT.md#troubleshooting
 */

import { ethers, network } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkInfo = await ethers.provider.getNetwork();

  console.log('\n========================================');
  console.log('Account Balance Check');
  console.log('========================================');
  console.log(`Network: ${network.name} (chainId: ${networkInfo.chainId})`);
  console.log(`Address: ${deployer.address}`);

  try {
    // Get native token balance
    const balance = await ethers.provider.getBalance(deployer.address);
    const balanceEth = ethers.formatEther(balance);

    console.log(`\nNative Token Balance: ${balanceEth} ETH`);

    // Get approximate USD value (using rough estimates)
    const ethPriceEstimates: Record<string, number> = {
      ethereum: 2500,
      sepolia: 2500,
      arbitrum: 2500,
      'arbitrum-sepolia': 2500,
      zksync: 2500,
      'zksync-testnet': 2500,
      bsc: 300, // BNB price
      polygon: 0.8, // MATIC price
      avalanche: 25, // AVAX price
      fantom: 0.3, // FTM price
    };

    const estimatedPrice = ethPriceEstimates[network.name] || 2500;
    const usdValue = parseFloat(balanceEth) * estimatedPrice;

    console.log(`Estimated Value: ~$${usdValue.toFixed(2)} USD`);

    // Estimate deployment costs
    console.log('\n========================================');
    console.log('Estimated Deployment Costs');
    console.log('========================================');

    const gasEstimates = {
      'FlashLoanArbitrage': 2000000,
      'SyncSwapFlashArbitrage': 2000000,
      'CommitRevealArbitrage': 1500000,
      'MultiPathQuoter': 500000,
    };

    // Get current gas price
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

    console.log(`Current Gas Price: ${gasPriceGwei.toFixed(2)} gwei`);
    console.log('');

    Object.entries(gasEstimates).forEach(([contract, gas]) => {
      const costWei = BigInt(gas) * gasPrice;
      const costEth = ethers.formatEther(costWei);
      const costUsd = parseFloat(costEth) * estimatedPrice;
      console.log(`${contract}:`);
      console.log(`  Gas: ~${(gas / 1000000).toFixed(1)}M`);
      console.log(`  Cost: ~${parseFloat(costEth).toFixed(4)} ETH (~$${costUsd.toFixed(2)} USD)`);
      console.log('');
    });

    // Determine if balance is sufficient
    console.log('========================================');
    console.log('Balance Assessment');
    console.log('========================================');

    const minDeploymentCost = BigInt(500000) * gasPrice; // Smallest contract
    const hasSufficientFunds = balance > minDeploymentCost;

    if (hasSufficientFunds) {
      console.log('✅ SUFFICIENT FUNDS');
      console.log('   You have enough to deploy contracts.');
    } else {
      console.log('❌ INSUFFICIENT FUNDS');
      console.log('   Please fund this account before deploying.');
      console.log(`   Minimum needed: ~${ethers.formatEther(minDeploymentCost)} ETH`);
      console.log(`   Current balance: ${balanceEth} ETH`);
    }

    // Show funding instructions
    if (!hasSufficientFunds) {
      console.log('\n========================================');
      console.log('How to Fund This Account');
      console.log('========================================');

      if (network.name === 'zksync' || network.name === 'zksync-testnet') {
        console.log('zkSync Era requires bridging from Ethereum:');
        console.log('1. Go to: https://portal.zksync.io/bridge/');
        console.log('2. Connect wallet');
        console.log('3. Bridge ETH from Ethereum to zkSync Era');
        console.log(`4. Send to: ${deployer.address}`);
      } else if (network.name === 'sepolia' || network.name === 'arbitrum-sepolia') {
        console.log('Testnet ETH:');
        console.log('1. Use a faucet to get testnet ETH');
        console.log('2. Sepolia faucet: https://sepoliafaucet.com/');
        console.log('3. Arbitrum Sepolia faucet: https://faucet.quicknode.com/arbitrum/sepolia');
        console.log(`4. Send to: ${deployer.address}`);
      } else {
        console.log(`Send ETH to: ${deployer.address}`);
      }
    }
  } catch (error: unknown) {
    console.error('\n❌ Failed to check balance');
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ Script failed:', error);
  process.exit(1);
});

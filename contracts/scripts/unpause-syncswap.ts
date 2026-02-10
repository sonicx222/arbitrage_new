/**
 * ⚠️ DEPRECATED: Use toggle-syncswap-pause.ts instead
 *
 * This script is deprecated in favor of the unified toggle-syncswap-pause.ts script.
 *
 * New usage:
 *   npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network zksync
 *   npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network zksync-testnet
 *
 * @deprecated Use toggle-syncswap-pause.ts instead
 * @see scripts/toggle-syncswap-pause.ts
 *
 * ---
 *
 * Unpause Script for SyncSwapFlashArbitrage Contract
 *
 * Unpauses the SyncSwapFlashArbitrage contract to resume arbitrage execution.
 * Only use this after issues have been resolved and testing is complete.
 *
 * Usage:
 *   npx hardhat run scripts/unpause-syncswap.ts --network zksync
 *   npx hardhat run scripts/unpause-syncswap.ts --network zksync-testnet
 *
 * Environment Variables:
 *   SYNCSWAP_CONTRACT_ADDRESS - Address of deployed SyncSwapFlashArbitrage contract
 *   DEPLOYER_PRIVATE_KEY - Private key of contract owner (required for unpause)
 *
 * @see contracts/SYNCSWAP_DEPLOYMENT.md#rollback-plan
 */

import { ethers } from 'hardhat';

async function main() {
  console.warn('\n⚠️  DEPRECATION WARNING ⚠️');
  console.warn('This script (unpause-syncswap.ts) is deprecated.');
  console.warn('Please use: npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network <network>');
  console.warn('Continuing in 3 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  const [signer] = await ethers.getSigners();
  const contractAddress = process.env.SYNCSWAP_CONTRACT_ADDRESS;

  console.log('\n========================================');
  console.log('SyncSwapFlashArbitrage Unpause');
  console.log('========================================');
  console.log(`Signer: ${signer.address}`);

  if (!contractAddress) {
    throw new Error(
      'SYNCSWAP_CONTRACT_ADDRESS environment variable not set.\n' +
      'Set it to the deployed contract address:\n' +
      '  export SYNCSWAP_CONTRACT_ADDRESS=0x...'
    );
  }

  console.log(`Contract: ${contractAddress}`);

  // Validate contract address has code
  const code = await ethers.provider.getCode(contractAddress);
  if (code === '0x') {
    throw new Error(
      `No contract found at address ${contractAddress}.\n` +
      'Please verify the address is correct.'
    );
  }

  // Get contract instance
  const syncSwapArbitrage = await ethers.getContractAt(
    'SyncSwapFlashArbitrage',
    contractAddress
  );

  // Check if currently paused
  try {
    const isPaused = await syncSwapArbitrage.paused();
    if (!isPaused) {
      console.log('\n⚠️  Contract is not paused.');
      console.log('   No action needed.');
      return;
    }
  } catch (error) {
    console.warn('Warning: Could not check pause status');
  }

  // Confirm action
  console.log('\n⚠️  This will resume arbitrage execution.');
  console.log('   Make sure issues have been resolved before unpausing.');

  // Unpause the contract
  console.log('\nUnpausing contract...');
  try {
    const tx = await syncSwapArbitrage.unpause();
    console.log(`Transaction sent: ${tx.hash}`);

    console.log('Waiting for confirmation...');
    const receipt = await tx.wait();

    console.log(`✅ Contract unpaused successfully!`);
    console.log(`   Block: ${receipt?.blockNumber}`);
    console.log(`   Gas used: ${receipt?.gasUsed?.toString()}`);

    // Verify pause status
    const isPaused = await syncSwapArbitrage.paused();
    console.log(`   Pause status: ${isPaused ? 'PAUSED ❌' : 'ACTIVE ✅'}`);

    console.log('\n========================================');
    console.log('Contract is now active and accepting arbitrage transactions');
  } catch (error: unknown) {
    console.error('\n❌ Failed to unpause contract');
    if (error instanceof Error) {
      if (error.message.includes('Ownable: caller is not the owner')) {
        console.error('Error: Signer is not the contract owner.');
        console.error(`Signer address: ${signer.address}`);
        console.error('Please use the owner\'s private key.');
      } else if (error.message.includes('Pausable: not paused')) {
        console.error('Error: Contract is not paused.');
      } else {
        console.error(`Error: ${error.message}`);
      }
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

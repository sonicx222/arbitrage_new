/**
 * ⚠️ DEPRECATED: Use toggle-syncswap-pause.ts instead
 *
 * This script is deprecated in favor of the unified toggle-syncswap-pause.ts script.
 *
 * New usage:
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync-testnet
 *
 * @deprecated Use toggle-syncswap-pause.ts instead
 * @see scripts/toggle-syncswap-pause.ts
 *
 * ---
 *
 * Emergency Pause Script for SyncSwapFlashArbitrage Contract
 *
 * Pauses the SyncSwapFlashArbitrage contract to halt all arbitrage execution.
 * Use this in emergency situations when issues are detected.
 *
 * Usage:
 *   npx hardhat run scripts/pause-syncswap.ts --network zksync
 *   npx hardhat run scripts/pause-syncswap.ts --network zksync-testnet
 *
 * Environment Variables:
 *   SYNCSWAP_CONTRACT_ADDRESS - Address of deployed SyncSwapFlashArbitrage contract
 *   DEPLOYER_PRIVATE_KEY - Private key of contract owner (required for pause)
 *
 * @see contracts/SYNCSWAP_DEPLOYMENT.md#rollback-plan
 */

import { ethers } from 'hardhat';

async function main() {
  console.warn('\n⚠️  DEPRECATION WARNING ⚠️');
  console.warn('This script (pause-syncswap.ts) is deprecated.');
  console.warn('Please use: npx hardhat run scripts/toggle-syncswap-pause.ts pause --network <network>');
  console.warn('Continuing in 3 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  const [signer] = await ethers.getSigners();
  const contractAddress = process.env.SYNCSWAP_CONTRACT_ADDRESS;

  console.log('\n========================================');
  console.log('SyncSwapFlashArbitrage Emergency Pause');
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

  // Check if already paused
  try {
    const isPaused = await syncSwapArbitrage.paused();
    if (isPaused) {
      console.log('\n⚠️  Contract is already paused.');
      console.log('   No action needed.');
      return;
    }
  } catch (error) {
    console.warn('Warning: Could not check pause status');
  }

  // Confirm action
  console.log('\n⚠️  WARNING: This will pause all arbitrage execution.');
  console.log('   The contract will reject all executeArbitrage() calls until unpaused.');

  // Pause the contract
  console.log('\nPausing contract...');
  try {
    const tx = await syncSwapArbitrage.pause();
    console.log(`Transaction sent: ${tx.hash}`);

    console.log('Waiting for confirmation...');
    const receipt = await tx.wait();

    console.log(`✅ Contract paused successfully!`);
    console.log(`   Block: ${receipt?.blockNumber}`);
    console.log(`   Gas used: ${receipt?.gasUsed?.toString()}`);

    // Verify pause status
    const isPaused = await syncSwapArbitrage.paused();
    console.log(`   Pause status: ${isPaused ? 'PAUSED ✅' : 'NOT PAUSED ❌'}`);

    console.log('\n========================================');
    console.log('Next Steps:');
    console.log('========================================');
    console.log('1. Investigate the issue that required the pause');
    console.log('2. Deploy fix if needed');
    console.log('3. Test thoroughly on testnet');
    console.log('4. Unpause the contract when ready:');
    console.log(`   npx hardhat run scripts/unpause-syncswap.ts --network ${(await ethers.provider.getNetwork()).name}`);
  } catch (error: unknown) {
    console.error('\n❌ Failed to pause contract');
    if (error instanceof Error) {
      if (error.message.includes('Ownable: caller is not the owner')) {
        console.error('Error: Signer is not the contract owner.');
        console.error(`Signer address: ${signer.address}`);
        console.error('Please use the owner\'s private key.');
      } else if (error.message.includes('Pausable: paused')) {
        console.error('Error: Contract is already paused.');
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

/**
 * Toggle Pause State Script for SyncSwapFlashArbitrage Contract
 *
 * Unified script to pause or unpause the SyncSwapFlashArbitrage contract.
 * Replaces the separate pause-syncswap.ts and unpause-syncswap.ts scripts.
 *
 * Usage:
 *   # Pause (emergency stop)
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync-testnet
 *
 *   # Unpause (resume operations)
 *   npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network zksync
 *   npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network zksync-testnet
 *
 * Environment Variables:
 *   SYNCSWAP_CONTRACT_ADDRESS - Address of deployed SyncSwapFlashArbitrage contract
 *   DEPLOYER_PRIVATE_KEY - Private key of contract owner (required for pause/unpause)
 *
 * @see contracts/SYNCSWAP_DEPLOYMENT.md#rollback-plan
 */

import { ethers, network } from 'hardhat';

type Action = 'pause' | 'unpause';

/**
 * P2-007 FIX: Parse command line arguments properly
 * Handles both positional and flag-style arguments:
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync
 *   npx hardhat run scripts/toggle-syncswap-pause.ts --action=pause --network zksync
 */
function parseAction(): Action {
  // Check for --action=<value> flag
  const actionFlagMatch = process.argv.find(arg => arg.startsWith('--action='));
  if (actionFlagMatch) {
    const action = actionFlagMatch.split('=')[1];
    if (action === 'pause' || action === 'unpause') {
      return action;
    }
    console.error(`\n❌ [ERR_INVALID_ACTION] Invalid action flag: ${action}`);
    console.error('Valid values: pause, unpause');
    process.exit(1);
  }

  // Check for positional argument (after script name, before --network)
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (args.length > 0) {
    const action = args[0];
    if (action === 'pause' || action === 'unpause') {
      return action;
    }
    console.error(`\n❌ [ERR_INVALID_ACTION] Invalid positional argument: ${action}`);
    console.error('Valid values: pause, unpause');
    process.exit(1);
  }

  // No action provided - show usage
  console.error('\n❌ [ERR_INVALID_ACTION] Invalid or missing action argument');
  console.error('\nUsage:');
  console.error('  npx hardhat run scripts/toggle-syncswap-pause.ts pause --network <network>');
  console.error('  npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network <network>');
  console.error('  npx hardhat run scripts/toggle-syncswap-pause.ts --action=pause --network <network>');
  console.error('\nActions:');
  console.error('  pause   - Emergency stop (halt all arbitrage execution)');
  console.error('  unpause - Resume operations (enable arbitrage execution)');
  process.exit(1);
}

async function main() {
  // P2-007 FIX: Use proper argument parser
  const action = parseAction();

  const [signer] = await ethers.getSigners();
  const contractAddress = process.env.SYNCSWAP_CONTRACT_ADDRESS;

  // Print header based on action
  const header = action === 'pause'
    ? 'SyncSwapFlashArbitrage Emergency Pause'
    : 'SyncSwapFlashArbitrage Unpause';

  console.log('\n========================================');
  console.log(header);
  console.log('========================================');
  console.log(`Signer: ${signer.address}`);

  if (!contractAddress) {
    // P2-008 FIX: Add error code
    throw new Error(
      '[ERR_NO_CONTRACT_ADDRESS] SYNCSWAP_CONTRACT_ADDRESS environment variable not set.\n' +
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

  // Check current pause state and validate action is needed
  try {
    const isPaused = await syncSwapArbitrage.paused();
    const shouldPause = action === 'pause';

    if (isPaused === shouldPause) {
      const status = isPaused ? 'already paused' : 'not paused';
      console.log(`\n⚠️  Contract is ${status}.`);
      console.log('   No action needed.');
      return;
    }
  } catch (error) {
    console.warn('Warning: Could not check pause status');
  }

  // Print warning message based on action
  if (action === 'pause') {
    console.log('\n⚠️  WARNING: This will pause all arbitrage execution.');
    console.log('   The contract will reject all executeArbitrage() calls until unpaused.');
  } else {
    console.log('\n⚠️  This will resume arbitrage execution.');
    console.log('   Make sure issues have been resolved before unpausing.');
  }

  // Execute the action
  console.log(`\n${action === 'pause' ? 'Pausing' : 'Unpausing'} contract...`);
  try {
    // Call the appropriate method
    const tx = action === 'pause'
      ? await syncSwapArbitrage.pause()
      : await syncSwapArbitrage.unpause();

    console.log(`Transaction sent: ${tx.hash}`);

    console.log('Waiting for confirmation...');
    const receipt = await tx.wait();

    console.log(`✅ Contract ${action}d successfully!`);
    console.log(`   Block: ${receipt?.blockNumber}`);
    console.log(`   Gas used: ${receipt?.gasUsed?.toString()}`);

    // Verify final pause status
    const isPaused = await syncSwapArbitrage.paused();

    if (action === 'pause') {
      console.log(`   Pause status: ${isPaused ? 'PAUSED ✅' : 'NOT PAUSED ❌'}`);

      console.log('\n========================================');
      console.log('Next Steps:');
      console.log('========================================');
      console.log('1. Investigate the issue that required the pause');
      console.log('2. Deploy fix if needed');
      console.log('3. Test thoroughly on testnet');
      console.log('4. Unpause the contract when ready:');
      console.log(`   npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network ${network.name}`);
    } else {
      console.log(`   Pause status: ${isPaused ? 'PAUSED ❌' : 'ACTIVE ✅'}`);

      console.log('\n========================================');
      console.log('Contract is now active and accepting arbitrage transactions');
    }
  } catch (error: unknown) {
    console.error(`\n❌ Failed to ${action} contract`);
    if (error instanceof Error) {
      if (error.message.includes('Ownable: caller is not the owner')) {
        console.error('Error: Signer is not the contract owner.');
        console.error(`Signer address: ${signer.address}`);
        console.error('Please use the owner\'s private key.');
      } else if (error.message.includes('Pausable: paused') || error.message.includes('Pausable: not paused')) {
        const expectedState = action === 'pause' ? 'not paused' : 'paused';
        console.error(`Error: Contract is not in expected state (should be ${expectedState}).`);
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

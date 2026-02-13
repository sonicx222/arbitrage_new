/**
 * Toggle Pause State Script for SyncSwapFlashArbitrage Contract
 *
 * Unified script to pause or unpause the SyncSwapFlashArbitrage contract.
 * Replaces the separate pause-syncswap.ts and unpause-syncswap.ts scripts.
 *
 * Usage (environment variable — recommended, works reliably with Hardhat):
 *   SYNCSWAP_ACTION=pause npx hardhat run scripts/toggle-syncswap-pause.ts --network zksync
 *   SYNCSWAP_ACTION=unpause npx hardhat run scripts/toggle-syncswap-pause.ts --network zksync
 *
 * Usage (positional argument — may not work with all Hardhat versions):
 *   npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync
 *
 * Environment Variables:
 *   SYNCSWAP_ACTION - Action to perform: 'pause' or 'unpause' (recommended)
 *   SYNCSWAP_CONTRACT_ADDRESS - Address of deployed SyncSwapFlashArbitrage contract
 *   DEPLOYER_PRIVATE_KEY - Private key of contract owner (required for pause/unpause)
 *
 * @see contracts/SYNCSWAP_DEPLOYMENT.md#rollback-plan
 */

import { ethers, network } from 'hardhat';
import { isMainnet, normalizeChainName } from '../deployments/addresses';
import { confirmMainnetDeployment } from './lib/deployment-utils';

type Action = 'pause' | 'unpause';

/**
 * Parse action from environment variable or CLI arguments.
 *
 * Priority order:
 * 1. SYNCSWAP_ACTION env var (most reliable — Hardhat always passes env vars)
 * 2. --action=<value> CLI flag (fallback for non-Hardhat invocation)
 * 3. Positional argument (may not work with all Hardhat versions)
 *
 * Hardhat's `run` task intercepts unknown CLI flags and positional arguments,
 * which can cause them to be stripped or trigger argument parsing errors.
 * Environment variables bypass this entirely.
 */
function parseAction(): Action {
  // 1. Environment variable (recommended — always works with Hardhat)
  const envAction = process.env.SYNCSWAP_ACTION;
  if (envAction) {
    if (envAction === 'pause' || envAction === 'unpause') {
      return envAction;
    }
    throw new Error(
      `[ERR_INVALID_ACTION] Invalid SYNCSWAP_ACTION env var: '${envAction}'\n` +
      `Valid values: pause, unpause`
    );
  }

  // 2. --action=<value> flag (fallback)
  const actionFlagMatch = process.argv.find(arg => arg.startsWith('--action='));
  if (actionFlagMatch) {
    const action = actionFlagMatch.split('=')[1];
    if (action === 'pause' || action === 'unpause') {
      return action;
    }
    throw new Error(
      `[ERR_INVALID_ACTION] Invalid action flag: '${action}'\n` +
      `Valid values: pause, unpause`
    );
  }

  // 3. Positional argument (may not work with Hardhat — kept for backward compat)
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (args.length > 0) {
    const action = args[0];
    if (action === 'pause' || action === 'unpause') {
      return action;
    }
    throw new Error(
      `[ERR_INVALID_ACTION] Invalid positional argument: '${action}'\n` +
      `Valid values: pause, unpause`
    );
  }

  // No action provided - throw with usage instructions
  throw new Error(
    `[ERR_INVALID_ACTION] Missing action argument.\n\n` +
    `Usage (recommended):\n` +
    `  SYNCSWAP_ACTION=pause npx hardhat run scripts/toggle-syncswap-pause.ts --network <network>\n` +
    `  SYNCSWAP_ACTION=unpause npx hardhat run scripts/toggle-syncswap-pause.ts --network <network>\n\n` +
    `Alternative (may not work with all Hardhat versions):\n` +
    `  npx hardhat run scripts/toggle-syncswap-pause.ts pause --network <network>\n\n` +
    `Actions:\n` +
    `  pause   - Emergency stop (halt all arbitrage execution)\n` +
    `  unpause - Resume operations (enable arbitrage execution)`
  );
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

  // Require confirmation before mainnet state changes
  const networkName = normalizeChainName(network.name);
  if (isMainnet(networkName)) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirmed = await new Promise<boolean>((resolve) => {
      rl.question(
        `\n  You are about to ${action} on MAINNET (${networkName}).\n` +
        `  Type 'CONFIRM' to continue, anything else to abort: `,
        (answer) => { rl.close(); resolve(answer.trim() === 'CONFIRM'); }
      );
    });
    if (!confirmed) {
      console.log('  Operation cancelled by user.');
      return;
    }
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
      console.log(`   SYNCSWAP_ACTION=unpause npx hardhat run scripts/toggle-syncswap-pause.ts --network ${network.name}`);
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

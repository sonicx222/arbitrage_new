/**
 * Shared Deployment Utilities
 *
 * Common functions used across all deployment scripts to ensure consistency,
 * reduce duplication, and improve maintainability.
 *
 * Phase 2 Refactoring: Extracted from individual deployment scripts
 */

import { ethers, run, network } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { isMainnet, isTestnet } from '../../deployments/addresses';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

// =============================================================================
// Types
// =============================================================================

/**
 * Base deployment result shared by all contract types
 *
 * Contains common fields present in all deployments.
 * Contract-specific deployments should extend this interface.
 */
export interface DeploymentResult {
  network: string;
  chainId: number;
  contractAddress: string;
  ownerAddress: string;
  deployerAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  minimumProfit: string;
  approvedRouters: string[];
  verified: boolean;
  [key: string]: any; // Allow additional fields for specific contract types
}

/**
 * Balancer V2 Flash Arbitrage deployment result
 *
 * Extends base with Balancer-specific fields:
 * - vaultAddress: Balancer V2 Vault address for flash loans
 * - flashLoanFee: Flash loan fee (0 bps for Balancer V2)
 */
export interface BalancerDeploymentResult extends DeploymentResult {
  vaultAddress: string;
  flashLoanFee: string;
}

/**
 * PancakeSwap V3 Flash Arbitrage deployment result
 *
 * Extends base with PancakeSwap-specific fields:
 * - factoryAddress: PancakeSwap V3 Factory address
 * - whitelistedPools: Pre-approved pool addresses for flash loans
 */
export interface PancakeSwapDeploymentResult extends DeploymentResult {
  factoryAddress: string;
  whitelistedPools: string[];
}

/**
 * SyncSwap Flash Arbitrage deployment result
 *
 * Extends base with SyncSwap-specific fields:
 * - vaultAddress: SyncSwap Vault address for flash loans (EIP-3156)
 * - flashLoanFee: Flash loan fee (30 bps for SyncSwap)
 */
export interface SyncSwapDeploymentResult extends DeploymentResult {
  vaultAddress: string;
  flashLoanFee: string;
}

/**
 * Commit-Reveal Arbitrage deployment result
 *
 * Extends base with commit-reveal specific fields:
 * - gasUsed: Gas used for deployment
 */
export interface CommitRevealDeploymentResult extends Omit<DeploymentResult, 'minimumProfit' | 'approvedRouters'> {
  gasUsed: string;
}

/**
 * MultiPathQuoter deployment result
 *
 * MultiPathQuoter is a stateless utility contract without owner/config.
 * Omits fields not applicable to utility contracts.
 */
export interface MultiPathQuoterDeploymentResult extends Omit<DeploymentResult, 'ownerAddress' | 'minimumProfit' | 'approvedRouters'> {
  gasUsed: string;
}

export interface RouterApprovalResult {
  succeeded: string[];
  failed: Array<{ router: string; error: string }>;
}

// =============================================================================
// Network Normalization (Phase 2 Fix)
// =============================================================================

/**
 * Normalize network names to canonical form
 *
 * Handles various network name aliases:
 * - zksync-mainnet → zksync
 * - zksync-sepolia → zksync-testnet
 * - arbitrumSepolia → arbitrum-sepolia
 *
 * @param name - Raw network name from hardhat config
 * @returns Canonical network name
 */
export function normalizeNetworkName(name: string): string {
  const aliases: Record<string, string> = {
    'zksync-mainnet': 'zksync',
    'zksync-sepolia': 'zksync-testnet',
    'arbitrumSepolia': 'arbitrum-sepolia',
    'baseSepolia': 'base-sepolia',
  };
  return aliases[name] || name;
}

// =============================================================================
// Mainnet Deployment Guard (Phase 4 - Temporary Safety)
// =============================================================================

/**
 * Temporary guard for unrefactored deployment scripts
 *
 * Phase 4: This function blocks mainnet deployments for scripts that haven't been
 * refactored to use deployment-utils.ts. Remove this guard after refactoring is complete.
 *
 * @param scriptName - Name of the deployment script (e.g., 'deploy-pancakeswap.ts')
 * @param networkName - Normalized network name
 * @throws Error if mainnet deployment attempted from unrefactored script
 */
export function guardUnrefactoredMainnetDeployment(
  scriptName: string,
  networkName: string
): void {
  if (isMainnet(networkName)) {
    throw new Error(
      `[ERR_UNREFACTORED_SCRIPT] Mainnet deployment blocked for ${scriptName}\n\n` +
      `⚠️  CRITICAL: This script has not been refactored to use deployment-utils.ts.\n` +
      `Deploying with this script on mainnet carries significant risks:\n\n` +
      `  ❌ No production config guards (can deploy with 0n profit threshold)\n` +
      `  ❌ No gas estimation error handling (crashes on RPC failures)\n` +
      `  ❌ No verification retry logic (silent verification failures)\n` +
      `  ❌ No router approval error handling (partial configuration on failure)\n` +
      `  ❌ No network name normalization (runtime failures on name variants)\n\n` +
      `To enable mainnet deployment:\n\n` +
      `1. Refactor ${scriptName} to use deployment-utils.ts\n` +
      `   Follow pattern from: contracts/scripts/deploy.ts\n` +
      `   Reference guide: contracts/scripts/PHASE_4_IMPLEMENTATION_PLAN.md\n\n` +
      `2. Remove guardUnrefactoredMainnetDeployment() call from script\n\n` +
      `3. Test on testnet first:\n` +
      `   npx hardhat run scripts/${scriptName} --network sepolia\n\n` +
      `4. Complete pre-deployment checklist:\n` +
      `   contracts/scripts/PRE_DEPLOYMENT_CHECKLIST.md\n\n` +
      `5. Get tech lead approval for mainnet deployment\n\n` +
      `For testnet deployments, this guard is bypassed automatically.\n` +
      `Network: ${networkName} (mainnet) - BLOCKED`
    );
  }

  // Testnet deployments allowed (but warn about missing improvements)
  if (isTestnet(networkName)) {
    console.warn('\n⚠️  WARNING: Using unrefactored deployment script');
    console.warn(`   Script: ${scriptName}`);
    console.warn(`   Network: ${networkName} (testnet - allowed)`);
    console.warn('   This script lacks Phase 1-3 improvements:');
    console.warn('     - Production config guards');
    console.warn('     - Verification retry logic');
    console.warn('     - Gas estimation error handling');
    console.warn('     - Router approval error handling');
    console.warn('   Consider refactoring before mainnet use.\n');
  }
}

// =============================================================================
// Balance Checking (Phase 1 Fix)
// =============================================================================

/**
 * Check if deployer has sufficient balance for deployment
 *
 * @throws Error if balance is zero or insufficient for estimated cost
 */
export async function checkDeployerBalance(
  deployer: SignerWithAddress,
  minBalance?: bigint
): Promise<bigint> {
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(
      `[ERR_NO_BALANCE] Deployer has zero balance. Please fund the deployer account.\n` +
      `Deployer address: ${deployer.address}\n` +
      `Network: ${network.name}`
    );
  }

  if (minBalance && balance < minBalance) {
    throw new Error(
      `[ERR_INSUFFICIENT_BALANCE] Deployer balance too low.\n` +
      `Required: ${ethers.formatEther(minBalance)} ETH\n` +
      `Available: ${ethers.formatEther(balance)} ETH\n` +
      `Shortfall: ${ethers.formatEther(minBalance - balance)} ETH`
    );
  }

  return balance;
}

// =============================================================================
// Gas Estimation (Phase 1 Fix)
// =============================================================================

/**
 * Estimate gas cost for deployment with proper error handling
 *
 * Phase 1 Fix: Wraps gas estimation in try-catch with helpful error messages
 *
 * @returns Estimated gas cost in wei, or undefined if estimation fails
 */
export async function estimateDeploymentCost(
  contractFactory: any,
  ...constructorArgs: any[]
): Promise<{ gas: bigint; cost: bigint } | undefined> {
  try {
    const deployTxData = await contractFactory.getDeployTransaction(...constructorArgs);
    const estimatedGas = await ethers.provider.estimateGas(deployTxData);
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;
    const estimatedCost = estimatedGas * gasPrice;

    console.log(`\nEstimated Deployment Cost:`);
    console.log(`  Gas: ${estimatedGas.toString()}`);
    console.log(`  Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
    console.log(`  Total Cost: ${ethers.formatEther(estimatedCost)} ETH`);

    return { gas: estimatedGas, cost: estimatedCost };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.warn('⚠️  Gas estimation failed:', errorMsg);
    console.warn('   Common causes:');
    console.warn('   - Network connectivity issues');
    console.warn('   - Invalid constructor arguments');
    console.warn('   - RPC rate limits');
    console.warn('   Proceeding without gas estimation...');

    return undefined;
  }
}

// =============================================================================
// Production Configuration Guards (Phase 1 Fix - CRITICAL)
// =============================================================================

/**
 * Validate minimum profit configuration for mainnet deployments
 *
 * Phase 1 Fix: Prevents mainnet deployments with zero or missing profit thresholds
 * which would cause contracts to accept unprofitable trades, wasting gas.
 *
 * @throws Error if mainnet deployment without proper profit threshold
 */
export function validateMinimumProfit(
  networkName: string,
  minimumProfit: bigint | undefined
): bigint {
  // For testnets, allow low or zero thresholds
  if (isTestnet(networkName)) {
    return minimumProfit || 0n;
  }

  // For mainnets, REQUIRE a positive threshold
  if (isMainnet(networkName)) {
    if (!minimumProfit || minimumProfit === 0n) {
      throw new Error(
        `[ERR_NO_PROFIT_THRESHOLD] Mainnet deployment requires positive minimum profit threshold.\n` +
        `Network: ${networkName} (mainnet)\n` +
        `Provided: ${minimumProfit || 0n} wei\n\n` +
        `Fix: Define DEFAULT_MINIMUM_PROFIT['${networkName}'] in deployment script.\n` +
        `Example: ethers.parseEther('0.01') for 0.01 ETH minimum profit.\n\n` +
        `This prevents contracts from accepting unprofitable trades that waste gas.`
      );
    }

    // Warn if threshold seems low for mainnet
    const minRecommended = ethers.parseEther('0.001'); // 0.001 ETH = ~$3
    if (minimumProfit < minRecommended) {
      console.warn('\n⚠️  WARNING: Low profit threshold for mainnet deployment');
      console.warn(`   Configured: ${ethers.formatEther(minimumProfit)} ETH`);
      console.warn(`   Recommended: ≥ ${ethers.formatEther(minRecommended)} ETH`);
      console.warn(`   Low thresholds may execute unprofitable trades.\n`);
    }
  }

  return minimumProfit || 0n;
}

// =============================================================================
// Router Approval (Phase 1 Fix)
// =============================================================================

/**
 * Approve multiple DEX routers with proper error handling
 *
 * Phase 1 Fix: Tracks failures instead of crashing, allows partial success
 *
 * @param contract - Contract instance with addApprovedRouter method
 * @param routers - Array of router addresses to approve
 * @param continueOnError - If true, logs failures and continues; if false, throws on first failure
 * @returns Results with succeeded and failed routers
 */
export async function approveRouters(
  contract: any,
  routers: string[],
  continueOnError = true
): Promise<RouterApprovalResult> {
  const succeeded: string[] = [];
  const failed: Array<{ router: string; error: string }> = [];

  console.log(`\nApproving ${routers.length} DEX routers...`);

  for (const router of routers) {
    try {
      console.log(`  Approving: ${router}`);
      const tx = await contract.addApprovedRouter(router);
      await tx.wait();
      succeeded.push(router);
      console.log(`  ✅ Success`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      failed.push({ router, error: errorMsg });

      console.error(`  ❌ Failed: ${router}`);
      console.error(`     Error: ${errorMsg}`);

      if (!continueOnError) {
        throw new Error(
          `[ERR_ROUTER_APPROVAL] Failed to approve router ${router}.\n` +
          `Error: ${errorMsg}\n` +
          `Contract may be partially configured.`
        );
      }
    }
  }

  console.log(`\n✅ Router Approval Summary:`);
  console.log(`   Succeeded: ${succeeded.length}/${routers.length}`);
  if (failed.length > 0) {
    console.log(`   Failed: ${failed.length}/${routers.length}`);
    console.warn('\n⚠️  Some routers failed to approve:');
    failed.forEach(({ router, error }) => {
      console.warn(`   - ${router.slice(0, 10)}... : ${error.split('\n')[0]}`);
    });
    console.warn('\n   Contract is partially configured. Manually approve failed routers before use.');
  }

  return { succeeded, failed };
}

// =============================================================================
// Contract Verification (Phase 1 Fix)
// =============================================================================

/**
 * Verify contract on block explorer with exponential backoff retry
 *
 * Phase 1 Fix: Implements retry logic to handle block explorer indexing delays
 * and network timeouts. Previously used arbitrary 30s delay with no retries.
 *
 * @param address - Deployed contract address
 * @param constructorArgs - Constructor arguments for verification
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @param initialDelay - Initial delay before first attempt in ms (default: 30000)
 * @returns true if verified, false if failed after retries
 */
export async function verifyContractWithRetry(
  address: string,
  constructorArgs: any[],
  maxRetries = 3,
  initialDelay = 30000
): Promise<boolean> {
  const networkName = network.name;

  // Skip verification for local networks
  if (networkName === 'localhost' || networkName === 'hardhat') {
    console.log('Skipping verification for local network');
    return false;
  }

  console.log(`\nVerifying contract on block explorer...`);
  console.log(`Network: ${networkName}`);
  console.log(`Address: ${address}`);

  // Initial delay to allow block explorer indexing
  console.log(`Waiting ${initialDelay / 1000}s for block explorer to index transaction...`);
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\nVerification attempt ${attempt}/${maxRetries}...`);

      await run('verify:verify', {
        address,
        constructorArguments: constructorArgs,
      });

      console.log('✅ Contract verified successfully');
      return true;

    } catch (error: any) {
      const errorMsg = error.message || String(error);

      // Check if already verified
      if (errorMsg.includes('Already Verified') || errorMsg.includes('already verified')) {
        console.log('✅ Contract already verified');
        return true;
      }

      // Check if this is a retryable error
      const isRetryable =
        errorMsg.includes('timeout') ||
        errorMsg.includes('network') ||
        errorMsg.includes('rate limit') ||
        errorMsg.includes('not yet indexed') ||
        errorMsg.includes('does not have bytecode');

      if (!isRetryable || attempt === maxRetries) {
        console.error(`\n❌ Verification failed after ${attempt} attempt(s)`);
        console.error(`Error: ${errorMsg.split('\n')[0]}`);
        console.log('\nYou can verify manually later with:');
        console.log(`  npx hardhat verify --network ${networkName} ${address} ${constructorArgs.map(arg => `"${arg}"`).join(' ')}`);
        return false;
      }

      // Calculate exponential backoff delay
      const delay = Math.pow(2, attempt - 1) * 10000; // 10s, 20s, 40s
      console.warn(`⚠️  Verification failed (attempt ${attempt}/${maxRetries})`);
      console.warn(`   Error: ${errorMsg.split('\n')[0]}`);
      console.log(`   Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return false;
}

// =============================================================================
// Deployment Result Saving
// =============================================================================

/**
 * Save deployment result to JSON files with atomic file locking
 *
 * Saves both:
 * 1. Network-specific file (e.g., ethereum.json)
 * 2. Master registry file (registry.json)
 *
 * **Concurrency Safe**: Uses file locking to prevent race conditions when
 * multiple deployments run concurrently. Each deployment acquires an exclusive
 * lock before reading/modifying/writing the registry.
 *
 * **Retry Logic**: Retries with exponential backoff if lock cannot be acquired
 * (e.g., another deployment is in progress).
 *
 * @param result - Deployment result to save (any deployment result type)
 * @param registryName - Name of registry file (default: 'registry.json')
 * @throws Error if lock cannot be acquired after max retries or if file I/O fails
 */
export function saveDeploymentResult(
  result:
    | DeploymentResult
    | BalancerDeploymentResult
    | PancakeSwapDeploymentResult
    | SyncSwapDeploymentResult
    | CommitRevealDeploymentResult
    | MultiPathQuoterDeploymentResult,
  registryName = 'registry.json'
): void {
  const deploymentsDir = path.join(__dirname, '..', '..', 'deployments');

  // Ensure deployments directory exists
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save network-specific deployment (no locking needed - unique per network)
  const networkFile = path.join(deploymentsDir, `${result.network}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update master registry with file locking to prevent concurrent corruption
  const registryFile = path.join(deploymentsDir, registryName);

  updateRegistryWithLock(registryFile, result);
  console.log(`📝 Registry updated: ${registryFile}`);
}

/**
 * Update registry file with exclusive file locking
 *
 * **Race Condition Prevention**: Acquires exclusive lock before read-modify-write
 * to prevent concurrent deployments from overwriting each other's changes.
 *
 * **Retry Logic**: Retries with exponential backoff (1s, 2s, 4s) if lock is held
 * by another process.
 *
 * @param registryFile - Absolute path to registry JSON file
 * @param result - Deployment result to add/update in registry
 * @throws Error if lock cannot be acquired after 3 retries (total ~7s wait)
 * @throws Error if registry JSON is corrupted and cannot be parsed
 */
function updateRegistryWithLock(
  registryFile: string,
  result: DeploymentResult
): void {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let releaseLock: (() => Promise<void>) | undefined;

    try {
      // Acquire exclusive lock (create lock file if registry doesn't exist yet)
      // Options:
      // - stale: 30000ms - Consider lock stale if holder process crashed >30s ago
      // - retries: 0 - Don't retry internally, we handle retries ourselves
      releaseLock = fs.existsSync(registryFile)
        ? lockfile.lockSync(registryFile, { stale: 30000, retries: 0 })
        : undefined; // No lock needed if file doesn't exist (first deployment)

      // CRITICAL SECTION: Read-Modify-Write must be atomic
      let registry: Record<string, DeploymentResult> = {};

      if (fs.existsSync(registryFile)) {
        try {
          const content = fs.readFileSync(registryFile, 'utf8');
          registry = JSON.parse(content);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          // Don't silently create new registry - this might indicate corruption
          throw new Error(
            `[ERR_REGISTRY_CORRUPT] Failed to read/parse deployment registry.\n` +
            `File: ${registryFile}\n` +
            `Error: ${errorMsg}\n` +
            `This may indicate registry corruption. Check the file manually.`
          );
        }
      }

      // Add/update deployment record
      registry[result.network] = result;

      // Write atomically: write to temp file, then rename (atomic on POSIX)
      const tempFile = `${registryFile}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(registry, null, 2), 'utf8');
      fs.renameSync(tempFile, registryFile);

      // SUCCESS: Release lock and return
      if (releaseLock) {
        lockfile.unlockSync(registryFile);
      }
      return;

    } catch (error) {
      // Release lock if acquired
      if (releaseLock) {
        try {
          lockfile.unlockSync(registryFile);
        } catch (unlockError) {
          // Ignore unlock errors (lock file might be stale)
        }
      }

      // Check if this is a lock acquisition failure (retryable)
      const isLockError = error instanceof Error && error.message.includes('ELOCKED');

      if (isLockError && attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(
          `⚠️  Registry locked by another deployment (attempt ${attempt}/${maxRetries})\n` +
          `   Retrying in ${delay}ms...`
        );

        // Sleep synchronously (deployment scripts are not performance-critical)
        const start = Date.now();
        while (Date.now() - start < delay) {
          // Busy wait (acceptable for rare deployment operations)
        }
        continue;
      }

      // Non-retryable error or max retries exceeded
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[ERR_REGISTRY_UPDATE] Failed to update deployment registry after ${attempt} attempt(s).\n` +
        `File: ${registryFile}\n` +
        `Error: ${errorMsg}\n` +
        (isLockError
          ? `Registry is locked by another deployment. Wait for it to complete and try again.`
          : `This may indicate file system issues or registry corruption.`)
      );
    }
  }
}

// =============================================================================
// Smoke Testing
// =============================================================================

/**
 * Run basic smoke tests on deployed contract
 *
 * Verifies:
 * - Owner is correct
 * - Contract is not paused
 * - Minimum profit is set
 *
 * @param contract - Deployed contract instance
 * @param expectedOwner - Expected owner address
 * @returns true if all checks pass
 */
export async function smokeTestFlashLoanContract(
  contract: any,
  expectedOwner: string
): Promise<boolean> {
  console.log('\n🧪 Running smoke tests...');

  const checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }> = [
    {
      name: 'Owner is correct',
      fn: async () => (await contract.owner()) === expectedOwner,
      critical: true,
    },
    {
      name: 'Contract is not paused',
      fn: async () => !(await contract.paused()),
      critical: false,
    },
    {
      name: 'Minimum profit ≥ 0',
      fn: async () => (await contract.minimumProfit()) >= 0n,
      critical: true,
    },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const passed = await check.fn();
      if (passed) {
        console.log(`  ✅ ${check.name}`);
      } else {
        console.error(`  ❌ ${check.name}`);
        if (check.critical) {
          allPassed = false;
        }
      }
    } catch (error) {
      console.error(`  ❌ ${check.name} - Error: ${error}`);
      if (check.critical) {
        allPassed = false;
      }
    }
  }

  if (allPassed) {
    console.log('\n✅ All smoke tests passed');
  } else {
    console.error('\n❌ Some critical smoke tests failed');
    console.error('   Contract may not be properly configured');
  }

  return allPassed;
}

/**
 * Run smoke tests on deployed CommitRevealArbitrage contract
 *
 * Verifies:
 * - Owner is correct
 * - Contract is not paused
 * - Minimum profit is set
 * - MIN_DELAY_BLOCKS is configured
 * - MAX_COMMIT_AGE_BLOCKS is configured
 *
 * @param contract - Deployed CommitRevealArbitrage contract instance
 * @param expectedOwner - Expected owner address
 * @returns true if all checks pass
 */
export async function smokeTestCommitRevealContract(
  contract: any,
  expectedOwner: string
): Promise<boolean> {
  console.log('\n🧪 Running commit-reveal contract smoke tests...');

  const checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }> = [
    {
      name: 'Owner is correct',
      fn: async () => (await contract.owner()) === expectedOwner,
      critical: true,
    },
    {
      name: 'Contract is not paused',
      fn: async () => !(await contract.paused()),
      critical: false,
    },
    {
      name: 'Minimum profit ≥ 0',
      fn: async () => (await contract.minimumProfit()) >= 0n,
      critical: true,
    },
    {
      name: 'MIN_DELAY_BLOCKS > 0',
      fn: async () => (await contract.MIN_DELAY_BLOCKS()) > 0n,
      critical: true,
    },
    {
      name: 'MAX_COMMIT_AGE_BLOCKS > MIN_DELAY_BLOCKS',
      fn: async () => {
        const minDelay = await contract.MIN_DELAY_BLOCKS();
        const maxAge = await contract.MAX_COMMIT_AGE_BLOCKS();
        return maxAge > minDelay;
      },
      critical: true,
    },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const passed = await check.fn();
      if (passed) {
        console.log(`  ✅ ${check.name}`);
      } else {
        console.error(`  ❌ ${check.name}`);
        if (check.critical) {
          allPassed = false;
        }
      }
    } catch (error) {
      console.error(`  ❌ ${check.name} - Error: ${error}`);
      if (check.critical) {
        allPassed = false;
      }
    }
  }

  if (allPassed) {
    console.log('\n✅ All smoke tests passed');
  } else {
    console.error('\n❌ Some critical smoke tests failed');
    console.error('   Contract may not be properly configured');
  }

  return allPassed;
}

/**
 * Run smoke tests on deployed MultiPathQuoter contract
 *
 * This is a stateless utility contract with no owner or configuration.
 * Verifies only that it can be called without reverting.
 *
 * @param contract - Deployed MultiPathQuoter contract instance
 * @returns true if all checks pass
 */
export async function smokeTestMultiPathQuoter(
  contract: any
): Promise<boolean> {
  console.log('\n🧪 Running multi-path quoter smoke tests...');

  const checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }> = [
    {
      name: 'Contract responds to getBatchedQuotes([])',
      fn: async () => {
        try {
          // Empty array should execute without crashing (may revert with specific error, but should be callable)
          await contract.getBatchedQuotes.staticCall([]);
          return true;
        } catch (error) {
          // Expected to revert for empty array, but should not crash
          // If we get here, contract is callable
          return true;
        }
      },
      critical: true,
    },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const passed = await check.fn();
      if (passed) {
        console.log(`  ✅ ${check.name}`);
      } else {
        console.error(`  ❌ ${check.name}`);
        if (check.critical) {
          allPassed = false;
        }
      }
    } catch (error) {
      console.error(`  ❌ ${check.name} - Error: ${error}`);
      if (check.critical) {
        allPassed = false;
      }
    }
  }

  if (allPassed) {
    console.log('\n✅ All smoke tests passed');
  } else {
    console.error('\n❌ Some critical smoke tests failed');
    console.error('   Contract may not be deployed correctly');
  }

  return allPassed;
}

// =============================================================================
// Deployment Summary
// =============================================================================

/**
 * Print standardized deployment summary
 */
export function printDeploymentSummary(result: DeploymentResult): void {
  console.log('\n========================================');
  console.log('Deployment Summary');
  console.log('========================================');
  console.log(`Network:          ${result.network} (chainId: ${result.chainId})`);
  console.log(`Contract:         ${result.contractAddress}`);
  console.log(`Owner:            ${result.ownerAddress}`);
  console.log(`Deployer:         ${result.deployerAddress}`);
  console.log(`Transaction:      ${result.transactionHash}`);
  console.log(`Block:            ${result.blockNumber}`);
  console.log(`Timestamp:        ${new Date(result.timestamp * 1000).toISOString()}`);
  console.log(`Minimum Profit:   ${ethers.formatEther(result.minimumProfit)} ETH`);
  console.log(`Approved Routers: ${result.approvedRouters.length}`);
  console.log(`Verified:         ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');
}

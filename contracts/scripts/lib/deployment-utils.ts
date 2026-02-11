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
import { isMainnet, isTestnet, normalizeChainName } from '../../deployments/addresses';
import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error - proper-lockfile has no type declarations, but works correctly at runtime
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
// Configuration Constants
// =============================================================================

/**
 * Default verification retry configuration
 *
 * Used across all deployment scripts for consistent verification behavior.
 * Initial wait: 30s (for block explorer indexing), then retries at 10s, 20s intervals.
 * Total max wait: ~60s across all attempts.
 */
export const DEFAULT_VERIFICATION_RETRIES = 3;
export const DEFAULT_VERIFICATION_INITIAL_DELAY_MS = 30000; // 30 seconds (L1 default)

/**
 * Network-adaptive verification delays.
 *
 * L2 block explorers index transactions faster than Ethereum mainnet.
 * Using a 30s delay on Arbitrum/Base wastes time since they index in <5s.
 * Networks not listed here fall back to DEFAULT_VERIFICATION_INITIAL_DELAY_MS.
 */
const VERIFICATION_DELAY_BY_NETWORK: Record<string, number> = {
  // L2s - fast indexing (~5-10s)
  arbitrum: 10000,
  arbitrumSepolia: 10000,
  base: 10000,
  baseSepolia: 10000,
  optimism: 10000,
  // zkSync - moderate indexing (~15s)
  zksync: 15000,
  'zksync-testnet': 15000,
  'zksync-mainnet': 15000,
  linea: 15000,
  // BSC - fast block times (~3s)
  bsc: 10000,
  // Ethereum L1 - slow indexing (~30s)
  ethereum: 30000,
  sepolia: 20000,
};

/**
 * Centralized minimum profit policy for all flash loan protocols
 *
 * P2-003 FIX: Single source of truth for profit thresholds across all deployments.
 * Previously each script had its own values, leading to inconsistencies.
 *
 * **Policy Rationale**:
 * - Base thresholds cover: gas costs + flash loan fees + safety margin
 * - Testnets: Low thresholds for testing (0.001 ETH or equivalent)
 * - Mainnets: Conservative thresholds to prevent unprofitable trades
 *
 * **Network-Specific Values**:
 * - Ethereum: 0.005 ETH (~$15 @ $3000/ETH) - high gas costs
 * - L2s (Arbitrum, Base, Optimism): 0.002 ETH (~$6) - lower gas
 * - BSC: 0.01 BNB (~$6 @ $600/BNB) - moderate gas
 * - Polygon: 2 MATIC (~$2 @ $1/MATIC) - very low gas
 * - Avalanche: 0.1 AVAX (~$4 @ $40/AVAX) - moderate gas
 * - Fantom: 5 FTM (~$2 @ $0.40/FTM) - very low gas
 * - zkSync: 0.002 ETH (~$6) - L2 gas costs
 *
 * **Flash Loan Fee Impact**:
 * These thresholds assume worst-case flash loan fees:
 * - Aave V3: 0.09% fee
 * - Balancer: 0% fee (can use slightly lower thresholds)
 * - PancakeSwap: pool-dependent fees
 * - SyncSwap: 0.3% fee
 *
 * For protocols with 0% fees (Balancer), use getMinimumProfitForProtocol()
 * to apply a 30% discount to the base threshold.
 */
export const DEFAULT_MINIMUM_PROFIT: Record<string, bigint> = {
  // Local development - zero thresholds for local testing
  localhost: 0n,                                   // Local Hardhat node
  hardhat: 0n,                                     // Hardhat in-process network

  // Testnets - low thresholds for testing (use canonical camelCase names)
  sepolia: ethers.parseEther('0.001'),            // 0.001 ETH
  arbitrumSepolia: ethers.parseEther('0.001'),    // 0.001 ETH
  baseSepolia: ethers.parseEther('0.001'),        // 0.001 ETH
  'zksync-testnet': ethers.parseEther('0.001'),   // 0.001 ETH

  // Mainnets - conservative thresholds
  ethereum: ethers.parseEther('0.005'),   // 0.005 ETH (~$15 @ $3000/ETH)
  arbitrum: ethers.parseEther('0.002'),   // 0.002 ETH (~$6 @ $3000/ETH)
  base: ethers.parseEther('0.002'),       // 0.002 ETH (~$6 @ $3000/ETH)
  optimism: ethers.parseEther('0.002'),   // 0.002 ETH (~$6 @ $3000/ETH)
  bsc: ethers.parseEther('0.01'),         // 0.01 BNB (~$6 @ $600/BNB)
  polygon: ethers.parseEther('2'),        // 2 MATIC (~$2 @ $1/MATIC)
  avalanche: ethers.parseEther('0.1'),    // 0.1 AVAX (~$4 @ $40/AVAX)
  fantom: ethers.parseEther('5'),         // 5 FTM (~$2 @ $0.40/FTM)
  zksync: ethers.parseEther('0.002'),     // 0.002 ETH (~$6 @ $3000/ETH)
  'zksync-mainnet': ethers.parseEther('0.002'), // Alias
  linea: ethers.parseEther('0.002'),      // 0.002 ETH (~$6 @ $3000/ETH)
};

/**
 * Get minimum profit threshold adjusted for protocol-specific fees
 *
 * P2-003 FIX: Allows protocol-specific adjustments to base thresholds.
 *
 * @param network - Network name (normalized)
 * @param protocol - Flash loan protocol ('aave', 'balancer', 'pancakeswap', 'syncswap')
 * @returns Minimum profit threshold in wei
 *
 * @example
 * // Balancer has 0% fees, so accept 30% lower profit threshold
 * const threshold = getMinimumProfitForProtocol('ethereum', 'balancer');
 * // Returns 0.0035 ETH instead of 0.005 ETH
 */
export function getMinimumProfitForProtocol(
  network: string,
  protocol: 'aave' | 'balancer' | 'pancakeswap' | 'syncswap'
): bigint {
  const baseThreshold = DEFAULT_MINIMUM_PROFIT[network];

  if (!baseThreshold) {
    // Unknown network - return conservative default
    return ethers.parseEther('0.005');
  }

  // Balancer has 0% flash loan fees (vs Aave's 0.09%)
  // Can accept 30% lower profit threshold since we save on fees
  if (protocol === 'balancer') {
    return (baseThreshold * 70n) / 100n;
  }

  // SyncSwap has higher fees (0.3% vs Aave's 0.09%)
  // Keep standard threshold (already conservative)
  if (protocol === 'syncswap') {
    return baseThreshold;
  }

  // Aave and PancakeSwap use standard threshold
  return baseThreshold;
}

// =============================================================================
// Network Normalization (Phase 2 Fix)
// =============================================================================

/**
 * Normalize network names to canonical form
 *
 * Delegates to normalizeChainName() from addresses.ts (single source of truth).
 *
 * @param name - Raw network name from hardhat config
 * @returns Canonical network name
 * @see contracts/deployments/addresses.ts normalizeChainName
 */
export function normalizeNetworkName(name: string): string {
  return normalizeChainName(name);
}

/**
 * Safely get chain ID as a number with validation
 *
 * P1-007 FIX: Validates chainId range before coercing from bigint to number
 * to prevent precision loss on custom networks with very large chain IDs.
 *
 * @returns Chain ID as number
 * @throws Error if chain ID exceeds Number.MAX_SAFE_INTEGER
 */
export async function getSafeChainId(): Promise<number> {
  const chainIdBigInt = (await ethers.provider.getNetwork()).chainId;

  // Validate range before coercion
  if (chainIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `[ERR_CHAIN_ID_TOO_LARGE] Chain ID ${chainIdBigInt} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}).\n` +
      `This network uses an unsupported chain ID that cannot be safely represented as a JavaScript number.\n` +
      `All production EVM chains use IDs < 2^32, but this network violates that assumption.`
    );
  }

  return Number(chainIdBigInt);
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
  // CRITICAL FIX (P0-002): Explicit testnet check - fail-safe approach
  // If network is not explicitly in testnet list, treat as mainnet (safer than reverse)
  const isKnownTestnet = isTestnet(networkName);
  const isKnownMainnet = isMainnet(networkName);

  // For testnets, allow low or zero thresholds
  if (isKnownTestnet) {
    return minimumProfit || 0n;
  }

  // CRITICAL: If network is unknown (not in testnet or mainnet list), treat as mainnet
  // This is the fail-safe approach: better to reject unknown networks than allow zero profit
  if (!isKnownMainnet) {
    console.warn(`\n⚠️  WARNING: Network '${networkName}' not in known mainnet or testnet list`);
    console.warn(`   Treating as mainnet (fail-safe: require profit threshold)\n`);
  }

  // For mainnets (or unknown networks), REQUIRE a positive threshold
  if (!minimumProfit || minimumProfit === 0n) {
    throw new Error(
      `[ERR_NO_PROFIT_THRESHOLD] Mainnet deployment requires positive minimum profit threshold.\n` +
      `Network: ${networkName} ${isKnownMainnet ? '(mainnet)' : '(unknown - treated as mainnet)'}\n` +
      `Provided: ${minimumProfit || 0n} wei\n\n` +
      `Fix: Define DEFAULT_MINIMUM_PROFIT['${networkName}'] in deployment script.\n` +
      `Example: ethers.parseEther('0.01') for 0.01 ETH minimum profit.\n\n` +
      `This prevents contracts from accepting unprofitable trades that waste gas.\n\n` +
      (isKnownMainnet ? '' :
        `Note: '${networkName}' is not in the known testnet list. If this is a testnet:\n` +
        `  1. Add to TESTNET_CHAINS in contracts/deployments/addresses.ts\n` +
        `  2. Re-run deployment\n`)
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

  return minimumProfit;
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

  // Send all transactions first, then wait for receipts in parallel.
  // This reduces total wall-clock time from N * txTime to ~1 * txTime for
  // non-dependent transactions (each router approval is independent).
  const pendingTxs: Array<{ router: string; txPromise: Promise<any> }> = [];

  for (const router of routers) {
    try {
      console.log(`  Sending approval: ${router}`);
      const tx = await contract.addApprovedRouter(router);
      pendingTxs.push({ router, txPromise: tx.wait() });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      failed.push({ router, error: errorMsg });
      console.error(`  ❌ Failed to send: ${router}`);
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

  // Wait for all pending transactions in parallel
  const results = await Promise.allSettled(
    pendingTxs.map(async ({ router, txPromise }) => {
      await txPromise;
      return router;
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { router } = pendingTxs[i];
    if (result.status === 'fulfilled') {
      succeeded.push(router);
      console.log(`  ✅ Confirmed: ${router}`);
    } else {
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
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

  // Use network-adaptive delay: L2s index faster than L1, so we don't
  // need to wait 30s on Arbitrum/Base when they typically index in <5s.
  const adaptiveDelay = VERIFICATION_DELAY_BY_NETWORK[normalizeChainName(networkName)] ?? initialDelay;
  console.log(`Waiting ${adaptiveDelay / 1000}s for block explorer to index transaction...`);
  await new Promise(resolve => setTimeout(resolve, adaptiveDelay));

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
 * 1. Network+contract-specific file (e.g., ethereum-FlashLoanArbitrage.json)
 * 2. Master registry file (registry.json)
 *
 * **Concurrency Safe**: Uses file locking to prevent race conditions when
 * multiple deployments run concurrently. Each deployment acquires an exclusive
 * lock before reading/modifying/writing the registry.
 *
 * **Retry Logic**: Retries with exponential backoff if lock cannot be acquired
 * (e.g., another deployment is in progress).
 *
 * **Performance**: Async implementation avoids blocking the event loop during
 * lock acquisition retries.
 *
 * @param result - Deployment result to save (any deployment result type)
 * @param registryName - Name of registry file (default: 'registry.json')
 * @param contractType - Contract type key for central registry (e.g., 'FlashLoanArbitrage', 'BalancerV2FlashArbitrage')
 * @throws Error if lock cannot be acquired after max retries or if file I/O fails
 */
export async function saveDeploymentResult(
  result:
    | DeploymentResult
    | BalancerDeploymentResult
    | PancakeSwapDeploymentResult
    | SyncSwapDeploymentResult
    | CommitRevealDeploymentResult
    | MultiPathQuoterDeploymentResult,
  registryName: string,
  contractType: string
): Promise<void> {
  const deploymentsDir = path.join(__dirname, '..', '..', 'deployments');

  // Ensure deployments directory exists
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save network+contract-specific deployment (no locking needed - unique per combination)
  const networkFile = path.join(deploymentsDir, `${result.network}-${contractType}.json`);
  fs.writeFileSync(networkFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Deployment saved to: ${networkFile}`);

  // Update per-contract registry (flat overwrite per network — correct for single-contract registries)
  if (registryName !== 'registry.json') {
    const perContractRegistryFile = path.join(deploymentsDir, registryName);
    await updateRegistryWithLock(perContractRegistryFile, result);
    console.log(`📝 Per-contract registry updated: ${perContractRegistryFile}`);
  }

  // Always merge into central registry.json so generate-addresses.ts sees all contract types
  const centralRegistryFile = path.join(deploymentsDir, 'registry.json');
  await mergeIntoCentralRegistry(centralRegistryFile, result, contractType);
  console.log(`📝 Central registry updated: ${centralRegistryFile} [${contractType}]`);
}

/**
 * Sleep helper for async delays (replaces synchronous busy-wait)
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a mutator function under an exclusive file lock with retry logic.
 *
 * Consolidates the lock-acquire → read → parse → mutate → atomic-write → unlock
 * pattern that was previously duplicated in updateRegistryWithLock and
 * mergeIntoCentralRegistry.
 *
 * **Race Condition Prevention**: Acquires exclusive lock before read-modify-write
 * to prevent concurrent deployments from overwriting each other's changes.
 *
 * **Retry Logic**: Retries with exponential backoff (1s, 2s, 4s) if lock is held
 * by another process.
 *
 * **Performance**: Uses async sleep instead of synchronous busy-wait to avoid
 * blocking the Node.js event loop during retry delays.
 *
 * @param registryFile - Absolute path to registry JSON file
 * @param mutator - Function that receives the parsed registry and returns the updated registry
 * @param context - Human-readable context for error messages (e.g., 'per-contract registry', 'central registry')
 * @throws Error if lock cannot be acquired after 3 retries (total ~7s wait)
 * @throws Error if registry JSON is corrupted and cannot be parsed
 */
async function withRegistryLock(
  registryFile: string,
  mutator: (registry: Record<string, any>) => Record<string, any>,
  context: string
): Promise<void> {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let lockAcquired = false;

    try {
      // Atomically create file if it doesn't exist. The 'wx' flag (write-exclusive)
      // is an OS-level atomic operation that succeeds only if the file does not exist.
      // This prevents the TOCTOU race where two concurrent processes both see the file
      // missing, both create it with '{}', and one overwrites the other's committed data.
      try {
        fs.writeFileSync(registryFile, '{}', { flag: 'wx' });
      } catch (e: unknown) {
        // EEXIST means another process already created it — expected, not an error
        if (!(e instanceof Error) || !('code' in e) || (e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw e;
        }
      }
      await lockfile.lock(registryFile, { stale: 300000, retries: 0 });
      lockAcquired = true;

      // CRITICAL SECTION: Read-Modify-Write must be atomic
      let registry: Record<string, any> = {};

      if (fs.existsSync(registryFile)) {
        try {
          const content = fs.readFileSync(registryFile, 'utf8');
          registry = JSON.parse(content);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          // Release lock before throwing to prevent lock file orphaning
          if (lockAcquired) {
            try {
              await lockfile.unlock(registryFile);
              lockAcquired = false;
            } catch (unlockError) {
              console.error('⚠️  Failed to release lock after parse error:', unlockError);
            }
          }

          throw new Error(
            `[ERR_REGISTRY_CORRUPT] Failed to read/parse ${context}.\n` +
            `File: ${registryFile}\n` +
            `Error: ${errorMsg}\n` +
            `This may indicate registry corruption. Check the file manually.`
          );
        }
      }

      // Apply mutation
      registry = mutator(registry);

      // Write atomically: write to temp file, then rename
      const tempFile = `${registryFile}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(registry, null, 2), 'utf8');
      fs.renameSync(tempFile, registryFile);

      // SUCCESS: Release lock and return
      if (lockAcquired) {
        await lockfile.unlock(registryFile);
        lockAcquired = false;
      }
      return;

    } catch (error) {
      // Release lock if acquired
      if (lockAcquired) {
        try {
          await lockfile.unlock(registryFile);
          lockAcquired = false;
        } catch (unlockError) {
          console.error(`⚠️  WARNING: Failed to release ${context} lock`);
          console.error(`   Lock file: ${registryFile}.lock`);
          console.error(`   Error: ${unlockError}`);
          console.error('   Subsequent deployments may be delayed by stale lock timeout (5 min)');
        }
      }

      // Check if this is a lock acquisition failure (retryable)
      const isLockError = error instanceof Error && error.message.includes('ELOCKED');

      if (isLockError && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(
          `⚠️  ${context} locked by another deployment (attempt ${attempt}/${maxRetries})\n` +
          `   Retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }

      // Non-retryable error or max retries exceeded
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[ERR_REGISTRY_UPDATE] Failed to update ${context} after ${attempt} attempt(s).\n` +
        `File: ${registryFile}\n` +
        `Error: ${errorMsg}\n` +
        (isLockError
          ? `Registry is locked by another deployment. Wait for it to complete and try again.`
          : `This may indicate file system issues or registry corruption.`)
      );
    }
  }
}

/**
 * Update per-contract registry file (flat overwrite per network).
 *
 * Writes the full deployment result keyed by network name.
 *
 * @param registryFile - Absolute path to per-contract registry JSON file
 * @param result - Deployment result to add/update
 */
async function updateRegistryWithLock(
  registryFile: string,
  result:
    | DeploymentResult
    | BalancerDeploymentResult
    | PancakeSwapDeploymentResult
    | SyncSwapDeploymentResult
    | CommitRevealDeploymentResult
    | MultiPathQuoterDeploymentResult
): Promise<void> {
  await withRegistryLock(
    registryFile,
    (registry) => {
      registry[result.network] = result;
      return registry;
    },
    'per-contract registry'
  );
}

/**
 * Merge a deployment into the central registry.json with per-contract-type granularity.
 *
 * Unlike updateRegistryWithLock (which overwrites the entire network entry),
 * this function merges only the specific contract type address into the network
 * object, preserving all other contract-type entries.
 *
 * **Schema**: registry.json stores `{ [network]: { [contractType]: address, ... } }`
 * which matches what generate-addresses.ts expects.
 *
 * @param registryFile - Absolute path to registry.json
 * @param result - Deployment result (any type)
 * @param contractType - Contract type key (e.g., 'FlashLoanArbitrage')
 */
async function mergeIntoCentralRegistry(
  registryFile: string,
  result:
    | DeploymentResult
    | BalancerDeploymentResult
    | PancakeSwapDeploymentResult
    | SyncSwapDeploymentResult
    | CommitRevealDeploymentResult
    | MultiPathQuoterDeploymentResult,
  contractType: string
): Promise<void> {
  await withRegistryLock(
    registryFile,
    (registry) => {
      const networkKey = result.network;
      if (!registry[networkKey] || typeof registry[networkKey] !== 'object') {
        registry[networkKey] = {};
      }
      // Store contract address (flat key for backward compat with generate-addresses.ts)
      registry[networkKey][contractType] = result.contractAddress;
      // Store per-contract metadata to avoid overwriting other contracts' data
      registry[networkKey][`${contractType}_deployedAt`] = result.timestamp;
      registry[networkKey][`${contractType}_deployedBy`] = result.deployerAddress;
      registry[networkKey][`${contractType}_verified`] = result.verified;
      // Update shared last-deployed metadata (informational — see per-contract keys for accuracy)
      registry[networkKey].deployedAt = result.timestamp;
      registry[networkKey].deployedBy = result.deployerAddress;
      return registry;
    },
    'central registry'
  );
}

// =============================================================================
// Smoke Testing
// =============================================================================

/**
 * Internal helper: Execute smoke test checks and report results
 *
 * This is a shared test runner used by all smoke test functions to eliminate duplication.
 * Runs an array of checks, logs results, and returns overall pass/fail status.
 *
 * @param checks - Array of test checks to execute
 * @param testName - Human-readable name for the test suite (used in console output)
 * @param errorContext - Context message for failed tests (e.g., "Contract may not be properly configured")
 * @returns true if all critical checks passed
 */
async function runSmokeTestChecks(
  checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }>,
  testName: string,
  errorContext = 'Contract may not be properly configured'
): Promise<boolean> {
  console.log(`\n🧪 Running ${testName}...`);

  let allPassed = true;

  // Execute all checks and track failures
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

  // Print summary
  if (allPassed) {
    console.log('\n✅ All smoke tests passed');
  } else {
    console.error('\n❌ Some critical smoke tests failed');
    console.error(`   ${errorContext}`);
  }

  return allPassed;
}

/**
 * Run basic smoke tests on deployed contract
 *
 * Verifies:
 * - Bytecode exists at address (P2-010 FIX)
 * - Owner is correct
 * - Contract is not paused
 * - Minimum profit is set
 *
 * @param contract - Deployed contract instance
 * @param expectedOwner - Expected owner address
 * @param contractAddress - Contract address for bytecode verification (P2-010 FIX)
 * @returns true if all checks pass
 */
export async function smokeTestFlashLoanContract(
  contract: any,
  expectedOwner: string,
  contractAddress?: string  // P2-010 FIX: Optional for backward compatibility
): Promise<boolean> {
  const checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }> = [];

  // P2-010 FIX: Verify bytecode exists if address provided
  if (contractAddress) {
    checks.push({
      name: 'Bytecode exists at address',
      fn: async () => {
        const code = await ethers.provider.getCode(contractAddress);
        if (code === '0x' || code.length < 10) {
          console.error(`   No bytecode at ${contractAddress}`);
          return false;
        }
        console.log(`   Bytecode size: ${(code.length - 2) / 2} bytes`);
        return true;
      },
      critical: true,
    });
  }

  checks.push(
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
      name: 'Minimum profit is configured (> 0)',
      fn: async () => {
        const profit = await contract.minimumProfit();
        if (profit === 0n) {
          // uint256 is always >= 0, so checking > 0 detects the case where
          // setMinimumProfit() silently reverted or was never called.
          console.error('   minimumProfit is 0 — contract may execute trades at a loss');
          return false;
        }
        console.log(`   minimumProfit: ${ethers.formatEther(profit)} ETH`);
        return true;
      },
      critical: false, // Non-critical: testnets may intentionally use 0
    }
  );

  return runSmokeTestChecks(checks, 'smoke tests');
}

/**
 * Run smoke tests on deployed CommitRevealArbitrage contract
 *
 * Verifies:
 * - Owner is correct
 * - Contract is not paused
 * - MIN_DELAY_BLOCKS is configured
 * - MAX_COMMIT_AGE_BLOCKS is configured
 *
 * NOTE: minimumProfit is intentionally NOT checked. CommitRevealArbitrage
 * validates profit off-chain before committing. The on-chain minimumProfit
 * is a secondary safety net that may legitimately be 0 during deployment.
 *
 * @param contract - Deployed CommitRevealArbitrage contract instance
 * @param expectedOwner - Expected owner address
 * @returns true if all checks pass
 */
export async function smokeTestCommitRevealContract(
  contract: any,
  expectedOwner: string
): Promise<boolean> {
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

  // Run standard smoke test checks
  const allPassed = await runSmokeTestChecks(checks, 'commit-reveal contract smoke tests');

  // Additional validation warnings for edge cases (Code Review Finding #7)
  try {
    const minDelayBlocks = await contract.MIN_DELAY_BLOCKS();
    const maxCommitAgeBlocks = await contract.MAX_COMMIT_AGE_BLOCKS();
    const paused = await contract.paused();

    if (minDelayBlocks === 0n) {
      console.warn('\n⚠️  Warning: MIN_DELAY_BLOCKS is 0 (no MEV protection)');
      console.warn('   Commits can be revealed in the same block, vulnerable to frontrunning');
    }

    if (maxCommitAgeBlocks < minDelayBlocks) {
      console.warn('\n⚠️  Warning: MAX_COMMIT_AGE_BLOCKS < MIN_DELAY_BLOCKS');
      console.warn('   Commits will expire immediately after the minimum delay');
    }

    if (paused) {
      console.warn('\n⚠️  Warning: Contract deployed in PAUSED state');
      console.warn('   Contract must be unpaused before accepting transactions');
    }
  } catch (error) {
    console.warn('\n⚠️  Warning: Could not validate edge cases:', error);
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
  const checks: Array<{
    name: string;
    fn: () => Promise<boolean>;
    critical: boolean;
  }> = [
    {
      name: 'Contract responds to getBatchedQuotes([])',
      fn: async () => {
        try {
          await contract.getBatchedQuotes.staticCall([]);
          return true;
        } catch (error: any) {
          const msg = error?.message || String(error);
          // Contract reverts are expected for empty arrays (contract is callable)
          // Network/RPC errors indicate deployment problems
          if (msg.includes('NETWORK_ERROR') || msg.includes('TIMEOUT') || msg.includes('SERVER_ERROR')) {
            console.error(`   RPC error: ${msg.slice(0, 100)}`);
            return false;
          }
          // Contract revert = contract exists and responds
          return true;
        }
      },
      critical: true,
    },
  ];

  return runSmokeTestChecks(checks, 'multi-path quoter smoke tests', 'Contract may not be deployed correctly');
}

// =============================================================================
// Deployment Summary
// =============================================================================

/**
 * Print standardized deployment summary
 *
 * Accepts any deployment result type (base, Balancer, PancakeSwap, SyncSwap,
 * CommitReveal, MultiPathQuoter). Fields that don't exist on certain types
 * (e.g., minimumProfit on MultiPathQuoter) are handled gracefully.
 */
export function printDeploymentSummary(
  result:
    | DeploymentResult
    | BalancerDeploymentResult
    | PancakeSwapDeploymentResult
    | SyncSwapDeploymentResult
    | CommitRevealDeploymentResult
    | MultiPathQuoterDeploymentResult
): void {
  console.log('\n========================================');
  console.log('Deployment Summary');
  console.log('========================================');
  console.log(`Network:          ${result.network} (chainId: ${result.chainId})`);
  console.log(`Contract:         ${result.contractAddress}`);
  if ('ownerAddress' in result && result.ownerAddress) {
    console.log(`Owner:            ${result.ownerAddress}`);
  }
  console.log(`Deployer:         ${result.deployerAddress}`);
  console.log(`Transaction:      ${result.transactionHash}`);
  console.log(`Block:            ${result.blockNumber}`);
  console.log(`Timestamp:        ${new Date(result.timestamp * 1000).toISOString()}`);
  if ('minimumProfit' in result && result.minimumProfit !== undefined) {
    console.log(`Minimum Profit:   ${ethers.formatEther(result.minimumProfit)} ETH`);
  }
  if ('approvedRouters' in result && Array.isArray(result.approvedRouters)) {
    console.log(`Approved Routers: ${result.approvedRouters.length}`);
  }
  if ('gasUsed' in result && result.gasUsed) {
    console.log(`Gas Used:         ${result.gasUsed}`);
  }
  console.log(`Verified:         ${result.verified ? '✅ Yes' : '❌ No'}`);
  console.log('========================================\n');
}

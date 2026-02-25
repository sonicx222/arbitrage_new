/**
 * Batch Deployment Script
 *
 * Deploys multiple contract types to multiple networks in sequence.
 * Reads a deployment manifest and executes each deployment, skipping
 * already-deployed contracts and recording results.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-batch.ts
 *
 * Environment Variables:
 *   DEPLOYER_PRIVATE_KEY        - Private key for deployment
 *   BATCH_NETWORKS              - Comma-separated networks (default: all L2 mainnets)
 *   BATCH_CONTRACTS             - Comma-separated contract types (default: all)
 *   BATCH_DRY_RUN               - Set "true" to print plan without deploying
 *   BATCH_SKIP_CONFIRMATION     - Set "true" to skip mainnet confirmation prompts
 *
 * Examples:
 *   # Deploy all contracts to Arbitrum and Base
 *   BATCH_NETWORKS=arbitrum,base npx hardhat run scripts/deploy-batch.ts
 *
 *   # Deploy only FlashLoan and Balancer to all L2s
 *   BATCH_CONTRACTS=FlashLoanArbitrage,BalancerV2FlashArbitrage npx hardhat run scripts/deploy-batch.ts
 *
 *   # Dry run — show plan without deploying
 *   BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts
 *
 * @see docs/reports/DEPLOYMENT_TESTNET_ASSESSMENT_2026-02-25.md Section 4
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// =============================================================================
// Deployment Manifest
// =============================================================================

interface DeploymentEntry {
  contract: string;
  script: string;
  /** Networks where this contract should be deployed */
  networks: string[];
  /** Extra env vars to set before running the script */
  env?: Record<string, string>;
}

/**
 * Contract deployment manifest.
 *
 * Each entry maps a contract type to its deploy script and applicable networks.
 * Order matters: contracts are deployed in this sequence per network.
 */
const DEPLOYMENT_MANIFEST: DeploymentEntry[] = [
  {
    contract: 'FlashLoanArbitrage',
    script: 'scripts/deploy.ts',
    networks: [
      // Testnets
      'sepolia', 'arbitrumSepolia', 'baseSepolia',
      // L2 Mainnets (Phase 7)
      'arbitrum', 'base', 'optimism',
      // Extended (Phase 8)
      'polygon', 'avalanche',
    ],
  },
  {
    contract: 'BalancerV2FlashArbitrage',
    script: 'scripts/deploy-balancer.ts',
    networks: [
      'arbitrumSepolia',
      'arbitrum', 'base', 'optimism',
      'polygon',
    ],
  },
  {
    contract: 'PancakeSwapFlashArbitrage',
    script: 'scripts/deploy-pancakeswap.ts',
    networks: [
      'arbitrumSepolia',
      'arbitrum', 'base',
      'bsc',
    ],
  },
  {
    contract: 'SyncSwapFlashArbitrage',
    script: 'scripts/deploy-syncswap.ts',
    networks: ['zksync-testnet', 'zksync'],
    env: { DISABLE_VIA_IR: 'true' },
  },
  {
    contract: 'CommitRevealArbitrage',
    script: 'scripts/deploy-commit-reveal.ts',
    networks: [
      'arbitrumSepolia',
      'arbitrum', 'base', 'optimism',
      'polygon', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
    ],
  },
  {
    contract: 'MultiPathQuoter',
    script: 'scripts/deploy-multi-path-quoter.ts',
    networks: [
      'arbitrumSepolia',
      'arbitrum', 'base', 'optimism',
      'polygon', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
    ],
  },
  {
    contract: 'UniswapV3Adapter',
    script: 'scripts/deploy-v3-adapter.ts',
    networks: [
      'arbitrumSepolia',
      'arbitrum', 'base', 'optimism',
      'polygon', 'bsc', 'linea',
    ],
  },
];

// =============================================================================
// Registry Check
// =============================================================================

/**
 * Check if a contract is already deployed to a network by reading registry.json.
 *
 * Registry format: `{ "arbitrumSepolia": { "FlashLoanArbitrage": "0x..." } }`
 * Deployed entries are non-null strings (addresses). Null means not deployed.
 */
function isAlreadyDeployed(contract: string, network: string): boolean {
  try {
    const registryPath = path.resolve(__dirname, '../deployments/registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const networkEntry = registry[network] ?? registry.networks?.[network];
    if (!networkEntry) return false;
    const value = networkEntry[contract];
    return typeof value === 'string' && value.startsWith('0x') && value.length === 42;
  } catch {
    return false;
  }
}

// =============================================================================
// Main
// =============================================================================

const MAINNET_NETWORKS = new Set([
  'ethereum', 'arbitrum', 'base', 'optimism', 'polygon',
  'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
]);

async function main(): Promise<void> {
  const dryRun = process.env.BATCH_DRY_RUN === 'true';
  const skipConfirmation = process.env.BATCH_SKIP_CONFIRMATION === 'true';
  const filterNetworks = process.env.BATCH_NETWORKS?.split(',').map(n => n.trim()) ?? null;
  const filterContracts = process.env.BATCH_CONTRACTS?.split(',').map(c => c.trim()) ?? null;

  console.log('\n========================================');
  console.log('Batch Contract Deployment');
  console.log('========================================');
  if (dryRun) console.log('MODE: DRY RUN (no deployments will be made)\n');

  // Build deployment plan
  interface PlannedDeployment {
    contract: string;
    network: string;
    script: string;
    env?: Record<string, string>;
    status: 'pending' | 'skipped' | 'success' | 'failed';
    reason?: string;
  }

  const plan: PlannedDeployment[] = [];

  for (const entry of DEPLOYMENT_MANIFEST) {
    if (filterContracts && !filterContracts.includes(entry.contract)) continue;

    for (const network of entry.networks) {
      if (filterNetworks && !filterNetworks.includes(network)) continue;

      if (isAlreadyDeployed(entry.contract, network)) {
        plan.push({
          contract: entry.contract,
          network,
          script: entry.script,
          env: entry.env,
          status: 'skipped',
          reason: 'already deployed',
        });
      } else {
        plan.push({
          contract: entry.contract,
          network,
          script: entry.script,
          env: entry.env,
          status: 'pending',
        });
      }
    }
  }

  // Print plan
  const pending = plan.filter(d => d.status === 'pending');
  const skipped = plan.filter(d => d.status === 'skipped');

  console.log(`Total deployments: ${plan.length}`);
  console.log(`  Pending:  ${pending.length}`);
  console.log(`  Skipped:  ${skipped.length} (already deployed)\n`);

  if (pending.length === 0) {
    console.log('Nothing to deploy. All contracts are already deployed to the requested networks.');
    return;
  }

  console.log('Deployment Plan:');
  console.log('─'.repeat(70));
  for (const d of plan) {
    const icon = d.status === 'skipped' ? '  SKIP' : '  DEPLOY';
    const note = d.reason ? ` (${d.reason})` : '';
    console.log(`${icon}  ${d.contract.padEnd(30)} → ${d.network}${note}`);
  }
  console.log('─'.repeat(70));

  if (dryRun) {
    console.log('\nDry run complete. Set BATCH_DRY_RUN=false to execute.');
    return;
  }

  // Check for mainnet deployments
  const mainnetDeployments = pending.filter(d => MAINNET_NETWORKS.has(d.network));
  if (mainnetDeployments.length > 0 && !skipConfirmation) {
    console.log(`\n⚠  ${mainnetDeployments.length} MAINNET deployments in plan.`);
    console.log('   Set BATCH_SKIP_CONFIRMATION=true to proceed without prompts.');
    console.log('   Each mainnet deployment will still prompt individually.\n');
  }

  // Execute deployments
  let successCount = 0;
  let failCount = 0;

  for (const d of pending) {
    console.log(`\n[${'='.repeat(60)}]`);
    console.log(`Deploying ${d.contract} to ${d.network}...`);
    console.log(`Script: ${d.script}`);

    try {
      const envVars = { ...process.env, ...d.env };
      const cmd = `npx hardhat run ${d.script} --network ${d.network}`;

      execSync(cmd, {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        env: envVars,
        timeout: 300_000, // 5 minute timeout per deployment
      });

      d.status = 'success';
      successCount++;
      console.log(`✓ ${d.contract} deployed to ${d.network}`);
    } catch (error) {
      d.status = 'failed';
      d.reason = error instanceof Error ? error.message : String(error);
      failCount++;
      console.error(`✗ ${d.contract} FAILED on ${d.network}: ${d.reason}`);
    }
  }

  // Print summary
  console.log('\n========================================');
  console.log('Batch Deployment Summary');
  console.log('========================================');
  console.log(`  Succeeded: ${successCount}`);
  console.log(`  Failed:    ${failCount}`);
  console.log(`  Skipped:   ${skipped.length}`);
  console.log('');

  if (failCount > 0) {
    console.log('Failed deployments:');
    for (const d of plan.filter(d => d.status === 'failed')) {
      console.log(`  ✗ ${d.contract} → ${d.network}: ${d.reason}`);
    }
    console.log('');
  }

  console.log('NEXT STEPS:');
  console.log('1. Run: npm run generate:addresses');
  console.log('2. Run: npm run typecheck');
  console.log('3. Verify contracts on block explorers:');
  console.log('   npx hardhat verify --network <network> <address> <constructor-args>');
  console.log('');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nBatch deployment failed:', error);
  process.exit(1);
});

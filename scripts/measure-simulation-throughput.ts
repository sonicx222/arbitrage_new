/**
 * Measure simulation event rates across all chains.
 *
 * Runs ChainSimulator for each chain for 30 seconds and reports:
 * - Events/second per chain
 * - Opportunities generated
 * - Block count and average block time
 * - Gas cost ranges
 *
 * Usage: SIMULATION_REALISM_LEVEL=medium npx tsx scripts/measure-simulation-throughput.ts
 */

import { ChainSimulator } from '../shared/core/src/simulation/chain-simulator';
import { DEXES, CHAIN_SPECIFIC_PAIRS, getTokenPrice } from '../shared/core/src/simulation/constants';
import { CHAIN_THROUGHPUT_PROFILES } from '../shared/core/src/simulation/throughput-profiles';
import type { SimulatedPairConfig, SimulatedSyncEvent, SimulatedOpportunity } from '../shared/core/src/simulation/types';

// Set realism level
process.env.SIMULATION_REALISM_LEVEL = process.env.SIMULATION_REALISM_LEVEL ?? 'medium';

const MEASUREMENT_DURATION_MS = 30_000; // 30 seconds

// Common pairs + chain-specific
const COMMON_PAIRS: [string, string][] = [
  ['WETH', 'USDC'], ['WETH', 'USDT'], ['WBTC', 'WETH'], ['WBTC', 'USDC'],
];

function buildPairsForChain(chainId: string): SimulatedPairConfig[] {
  const dexes = DEXES[chainId] ?? ['dex1', 'dex2'];
  const chainPairs = CHAIN_SPECIFIC_PAIRS[chainId] ?? [];
  const allPairDefs = [...COMMON_PAIRS, ...chainPairs.map(p => [p[0], p[1]] as [string, string])];

  const pairs: SimulatedPairConfig[] = [];
  let addrCounter = 0;

  for (const [t0, t1] of allPairDefs) {
    for (const dex of dexes) {
      addrCounter++;
      const decimals0 = ['USDC', 'USDT'].includes(t0) ? 6 : 18;
      const decimals1 = ['USDC', 'USDT'].includes(t1) ? 6 : 18;
      pairs.push({
        address: `0x${addrCounter.toString(16).padStart(40, '0')}`,
        token0Symbol: t0,
        token1Symbol: t1,
        token0Decimals: decimals0,
        token1Decimals: decimals1,
        dex,
        fee: 0.003,
      });
    }
  }

  return pairs;
}

interface ChainMetrics {
  chainId: string;
  syncEvents: number;
  opportunities: number;
  blocks: number;
  avgBlockTimeMs: number;
  eventsPerSec: number;
  oppsPerMin: number;
  gasCostMin: number;
  gasCostMax: number;
  gasCostAvg: number;
  profile: { swapsPerBlock: number; blockTimeMs: number };
}

async function measureChain(chainId: string): Promise<ChainMetrics> {
  const pairs = buildPairsForChain(chainId);
  const simulator = new ChainSimulator({
    chainId,
    updateIntervalMs: 1000,
    volatility: 0.02,
    arbitrageChance: 0.08,
    minArbitrageSpread: 0.003,
    maxArbitrageSpread: 0.015,
    pairs,
  });

  let syncEvents = 0;
  let opportunities = 0;
  let blocks = 0;
  const blockTimestamps: number[] = [];
  const gasCosts: number[] = [];

  simulator.on('syncEvent', () => { syncEvents++; });
  simulator.on('opportunity', (opp: SimulatedOpportunity) => {
    opportunities++;
    if (opp.expectedGasCost !== undefined) {
      gasCosts.push(opp.expectedGasCost);
    }
  });
  simulator.on('blockUpdate', () => {
    blocks++;
    blockTimestamps.push(Date.now());
  });

  simulator.start();

  await new Promise(resolve => setTimeout(resolve, MEASUREMENT_DURATION_MS));

  simulator.stop();

  // Calculate average block time from timestamps
  let avgBlockTimeMs = 0;
  if (blockTimestamps.length > 1) {
    const deltas: number[] = [];
    for (let i = 1; i < blockTimestamps.length; i++) {
      deltas.push(blockTimestamps[i] - blockTimestamps[i - 1]);
    }
    avgBlockTimeMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  const profile = CHAIN_THROUGHPUT_PROFILES[chainId];

  return {
    chainId,
    syncEvents,
    opportunities,
    blocks,
    avgBlockTimeMs: Math.round(avgBlockTimeMs),
    eventsPerSec: Math.round((syncEvents / (MEASUREMENT_DURATION_MS / 1000)) * 10) / 10,
    oppsPerMin: Math.round((opportunities / (MEASUREMENT_DURATION_MS / 1000)) * 60),
    gasCostMin: gasCosts.length > 0 ? Math.round(Math.min(...gasCosts) * 100) / 100 : 0,
    gasCostMax: gasCosts.length > 0 ? Math.round(Math.max(...gasCosts) * 100) / 100 : 0,
    gasCostAvg: gasCosts.length > 0 ? Math.round((gasCosts.reduce((a, b) => a + b, 0) / gasCosts.length) * 100) / 100 : 0,
    profile: {
      swapsPerBlock: profile?.dexSwapsPerBlock ?? 0,
      blockTimeMs: profile?.blockTimeMs ?? 0,
    },
  };
}

async function main(): Promise<void> {
  const realismLevel = process.env.SIMULATION_REALISM_LEVEL ?? 'medium';
  console.log(`\n=== Simulation Throughput Measurement ===`);
  console.log(`Realism level: ${realismLevel}`);
  console.log(`Duration: ${MEASUREMENT_DURATION_MS / 1000}s per chain`);
  console.log(`Measuring all 15 chains in parallel...\n`);

  const chains = Object.keys(CHAIN_THROUGHPUT_PROFILES);

  // Run all chains in parallel
  const results = await Promise.all(chains.map(chain => measureChain(chain)));

  // Sort by events/sec descending
  results.sort((a, b) => b.eventsPerSec - a.eventsPerSec);

  // Print table
  console.log('┌─────────────┬────────┬──────────┬────────┬──────────────┬──────────────┬─────────────────────┐');
  console.log('│ Chain       │ Blocks │ Events/s │ Opps/m │ Avg Block ms │ Profile λ    │ Gas Cost USD        │');
  console.log('├─────────────┼────────┼──────────┼────────┼──────────────┼──────────────┼─────────────────────┤');

  let totalEventsPerSec = 0;
  let totalOppsPerMin = 0;

  for (const r of results) {
    totalEventsPerSec += r.eventsPerSec;
    totalOppsPerMin += r.oppsPerMin;

    const chain = r.chainId.padEnd(11);
    const blocks = String(r.blocks).padStart(6);
    const eps = r.eventsPerSec.toFixed(1).padStart(8);
    const opm = String(r.oppsPerMin).padStart(6);
    const abt = String(r.avgBlockTimeMs).padStart(12);
    const lambda = `${r.profile.swapsPerBlock}/${r.profile.blockTimeMs}ms`.padStart(12);
    const gas = r.gasCostAvg > 0
      ? `$${r.gasCostMin.toFixed(2)}-${r.gasCostMax.toFixed(2)} (avg $${r.gasCostAvg.toFixed(2)})`.padStart(19)
      : '           N/A'.padStart(19);

    console.log(`│ ${chain} │ ${blocks} │ ${eps} │ ${opm} │ ${abt} │ ${lambda} │ ${gas} │`);
  }

  console.log('├─────────────┼────────┼──────────┼────────┼──────────────┼──────────────┼─────────────────────┤');
  console.log(`│ TOTAL       │        │ ${totalEventsPerSec.toFixed(1).padStart(8)} │ ${String(totalOppsPerMin).padStart(6)} │              │              │                     │`);
  console.log('└─────────────┴────────┴──────────┴────────┴──────────────┴──────────────┴─────────────────────┘');

  console.log(`\nRealism: ${realismLevel} | Total throughput: ${totalEventsPerSec.toFixed(0)} events/s | ${totalOppsPerMin} opportunities/min`);
}

main().catch(console.error);

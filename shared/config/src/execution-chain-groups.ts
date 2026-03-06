/**
 * Execution Chain Group Configuration (Phase 2: Chain-Grouped EE)
 *
 * Maps each blockchain to an execution engine group, which determines which
 * Redis stream the coordinator routes to and which stream each EE instance consumes.
 *
 * Chain groups mirror the existing detector partitions (ADR-003):
 *   - fast    ↔ asia-fast    (bsc, polygon, avalanche, fantom)
 *   - l2      ↔ l2-turbo     (arbitrum, optimism, base, scroll, blast)
 *   - premium ↔ high-value   (ethereum, zksync, linea)
 *   - solana  ↔ solana-native (solana)
 *
 * Set EXECUTION_CHAIN_GROUP env var on each EE instance to control which
 * group it serves. The coordinator routes each opportunity to the matching stream.
 *
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 2
 * @see ADR-038: Chain-Grouped Execution Engines
 * @see shared/config/src/partitions.ts — Detector partition definitions
 */

import { RedisStreams } from '@arbitrage/types';
import { PARTITIONS } from './partitions';
import { PARTITION_IDS } from './partition-ids';

// =============================================================================
// Types
// =============================================================================

export type ExecutionChainGroup = 'fast' | 'l2' | 'premium' | 'solana';

// =============================================================================
// Constants
// =============================================================================

/** All valid execution chain group names */
export const EXECUTION_CHAIN_GROUPS: readonly ExecutionChainGroup[] = [
  'fast', 'l2', 'premium', 'solana',
] as const;

/**
 * Map from execution chain group to the Redis stream it consumes/produces to.
 * Coordinator writes to these streams; EE instances read from them.
 */
export const EXECUTION_GROUP_STREAMS: Record<ExecutionChainGroup, string> = {
  fast:    RedisStreams.EXEC_REQUESTS_FAST,
  l2:      RedisStreams.EXEC_REQUESTS_L2,
  premium: RedisStreams.EXEC_REQUESTS_PREMIUM,
  solana:  RedisStreams.EXEC_REQUESTS_SOLANA,
};

// =============================================================================
// Internal: Pre-computed chain → group lookup (O(1) hot-path access)
// =============================================================================

/** Maps detector partition ID to execution chain group */
const PARTITION_TO_GROUP: Record<string, ExecutionChainGroup> = {
  [PARTITION_IDS.ASIA_FAST]:    'fast',
  [PARTITION_IDS.L2_TURBO]:     'l2',
  [PARTITION_IDS.HIGH_VALUE]:   'premium',
  [PARTITION_IDS.SOLANA_NATIVE]: 'solana',
};

/** Pre-computed chain → execution group (O(1) lookup, built at module load) */
const CHAIN_TO_GROUP = new Map<string, ExecutionChainGroup>();
for (const partition of PARTITIONS) {
  const group = PARTITION_TO_GROUP[partition.partitionId];
  if (group) {
    for (const chainId of partition.chains) {
      CHAIN_TO_GROUP.set(chainId, group);
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Returns the execution chain group for a given chain ID, or null if the chain
 * is not assigned to any group.
 *
 * O(1) — uses pre-computed Map built at module load.
 */
export function getExecutionGroupForChain(chainId: string): ExecutionChainGroup | null {
  return CHAIN_TO_GROUP.get(chainId) ?? null;
}

/**
 * Returns the execution stream name for a given chain ID.
 * Falls back to the legacy single-EE stream for unknown chains.
 *
 * O(1) — uses pre-computed Map built at module load.
 */
export function getStreamForChain(chainId: string): string {
  const group = CHAIN_TO_GROUP.get(chainId);
  return group ? EXECUTION_GROUP_STREAMS[group] : RedisStreams.EXECUTION_REQUESTS;
}

/**
 * Returns the chain IDs assigned to a given execution group.
 * Returns a copy of the array to prevent mutation.
 */
export function getChainsForExecutionGroup(group: ExecutionChainGroup): string[] {
  const partitionId = Object.entries(PARTITION_TO_GROUP).find(([, g]) => g === group)?.[0];
  if (!partitionId) return [];
  const partition = PARTITIONS.find(p => p.partitionId === partitionId);
  return partition ? [...partition.chains] : [];
}

/**
 * Reads EXECUTION_CHAIN_GROUP from the environment and returns the typed group,
 * or null if not set or the value is not a known group.
 *
 * Used by the EE index.ts to determine which stream to consume.
 */
export function getExecutionGroupFromEnv(): ExecutionChainGroup | null {
  const raw = process.env.EXECUTION_CHAIN_GROUP?.toLowerCase().trim();
  if (!raw) return null;
  if (raw === 'fast' || raw === 'l2' || raw === 'premium' || raw === 'solana') {
    return raw;
  }
  return null;
}

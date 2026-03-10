/**
 * Deferred Item Tracking Registry
 *
 * Machine-readable registry of deferred work items — features, deployments,
 * and verifications that are known but not yet actionable due to external
 * blockers (contract deployments, protocol availability, address verification).
 *
 * Each item references the config files it will affect when resolved,
 * making it easy to audit which configs contain stubs or placeholders.
 *
 * @see docs/architecture/CURRENT_STATE.md — System inventory
 */

// =============================================================================
// Types
// =============================================================================

export type DeferredItemStatus = 'deferred' | 'stub' | 'todo' | 'resolved';

export interface DeferredItem {
  /** Unique identifier (e.g., D1-BALANCER-V2-MULTI-CHAIN) */
  id: string;
  /** Human-readable description of what needs to be done */
  description: string;
  /** Current status: deferred (blocked externally), stub (placeholder in code), todo (ready to implement) */
  status: DeferredItemStatus;
  /** What is preventing resolution */
  blocker: string;
  /** Config files affected when this item is resolved (relative to shared/config/src/) */
  files: string[];
}

// =============================================================================
// Registry
// =============================================================================

// NOTE: IDs are non-sequential. D6 and D8 were resolved and removed during config refactoring.
// ID numbering is stable (not renumbered after removal) to preserve git-history references.
export const DEFERRED_ITEMS: readonly DeferredItem[] = [
  {
    id: 'D1-BALANCER-V2-MULTI-CHAIN',
    description: 'Deploy BalancerV2FlashArbitrage.sol to ethereum, polygon, arbitrum, optimism, base',
    status: 'deferred',
    blocker: 'Contract deployment required',
    files: ['service-config.ts', 'flash-loan-availability.ts', 'flash-loan-providers/balancer-v2.ts'],
  },
  {
    id: 'D2-LINEA-SYNCSWAP',
    description: 'Linea SyncSwap flash loans via Vault (EIP-3156)',
    status: 'deferred',
    blocker: 'SyncSwap Vault not deployed to Linea mainnet',
    files: ['addresses.ts', 'service-config.ts', 'flash-loan-providers/syncswap.ts'],
  },
  {
    id: 'D3-BLAST-FLASH-LOAN',
    description: 'Blast-native flash loan provider',
    status: 'deferred',
    blocker: 'No lending protocol on Blast verified',
    files: ['service-config.ts', 'flash-loan-availability.ts'],
  },
  {
    id: 'D4-MULTI-PATH-QUOTER-MAINNET',
    description: 'Deploy MultiPathQuoter to mainnet chains',
    status: 'deferred',
    blocker: 'Contracts not deployed (testnet only)',
    files: ['service-config.ts'],
  },
  {
    id: 'D5-MODE-DEX-VERIFICATION',
    description: 'Verify Mode DEX addresses (supswap, iziswap) via RPC',
    status: 'resolved',
    blocker: 'DEX factories RPC-validated 2026-03-08',
    files: ['dexes/chains/mode.ts'],
  },
  {
    id: 'D7-MORPHO-FLASH-ARBITRAGE',
    description: 'Implement MorphoFlashArbitrage.sol contract',
    status: 'deferred',
    blocker: 'No MorphoFlashArbitrage.sol contract yet',
    files: ['contracts/src/', 'flash-loan-availability.ts', 'flash-loan-providers/morpho.ts'],
  },
  {
    id: 'D9-MANTLE-MODE-PARTITIONS',
    description: 'Finalize Mantle/Mode partition assignment',
    status: 'resolved',
    blocker: 'Added to PARTITIONS 2026-03-10',
    files: ['partitions.ts', 'dexes/chains/mantle.ts', 'dexes/chains/mode.ts'],
  },
] as const;

// =============================================================================
// Public API
// =============================================================================

/**
 * Returns all unresolved deferred items (excludes resolved).
 */
export function getUnresolvedDeferredItems(): readonly DeferredItem[] {
  return DEFERRED_ITEMS.filter(item => item.status !== 'resolved');
}

/**
 * Returns deferred items filtered by status.
 */
export function getDeferredItemsByStatus(status: DeferredItemStatus): readonly DeferredItem[] {
  return DEFERRED_ITEMS.filter(item => item.status === status);
}

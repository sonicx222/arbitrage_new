/**
 * Multi-Provider Flash Loan Registry
 *
 * Provides multiple flash loan providers per chain for the aggregator.
 * The single-provider FLASH_LOAN_PROVIDERS map stays untouched for
 * backward-compatible non-aggregator path.
 *
 * Consumed by FlashLoanStrategy constructor when enableAggregator=true.
 *
 * @see FLASH_LOAN_PROVIDERS — single-provider map (non-aggregator path)
 * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
 */

import type { FlashLoanProtocol } from '@arbitrage/types';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from '../addresses';

export interface FlashLoanProviderEntry {
  /** Flash loan protocol identifier */
  protocol: FlashLoanProtocol;
  /** On-chain contract address (pool or vault) */
  address: string;
  /** Fee in basis points */
  feeBps: number;
  /** Priority hint: lower = preferred when scores are equal */
  priority: number;
}

const EMPTY_PROVIDERS: readonly FlashLoanProviderEntry[] = Object.freeze([]);

/**
 * Multi-provider registry. Each chain maps to an array of providers
 * sorted by feeBps ascending (cheapest first).
 *
 * Multi-provider chains: ethereum, polygon, arbitrum, optimism, base (Aave V3 + Balancer V2),
 * scroll (Aave V3 + SyncSwap).
 *
 * Single-provider chains: bsc, avalanche, fantom, zksync, mantle, mode.
 */
export const FLASH_LOAN_PROVIDER_REGISTRY: Readonly<Record<string, readonly FlashLoanProviderEntry[]>> = Object.freeze({
  // === Multi-provider chains (sorted by feeBps ascending) ===
  ethereum: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.ethereum, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.ethereum, feeBps: 5, priority: 1 },
  ]),
  polygon: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.polygon, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.polygon, feeBps: 5, priority: 1 },
  ]),
  arbitrum: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.arbitrum, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.arbitrum, feeBps: 5, priority: 1 },
  ]),
  optimism: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.optimism, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.optimism, feeBps: 5, priority: 1 },
  ]),
  base: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.base, feeBps: 0, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.base, feeBps: 5, priority: 1 },
  ]),
  scroll: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.scroll, feeBps: 5, priority: 0 },
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.scroll, feeBps: 30, priority: 1 },
  ]),

  // === Single-provider chains ===
  bsc: Object.freeze([
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.bsc, feeBps: 25, priority: 0 },
  ]),
  avalanche: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.avalanche, feeBps: 5, priority: 0 },
  ]),
  fantom: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.fantom, feeBps: 0, priority: 0 },
  ]),
  zksync: Object.freeze([
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.zksync, feeBps: 30, priority: 0 },
  ]),
  mantle: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.mantle, feeBps: 5, priority: 0 },
  ]),
  mode: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.mode, feeBps: 0, priority: 0 },
  ]),
});

/**
 * Get providers for a chain. Returns empty frozen array for unknown chains.
 */
export function getProvidersForChain(chain: string): readonly FlashLoanProviderEntry[] {
  return FLASH_LOAN_PROVIDER_REGISTRY[chain] ?? EMPTY_PROVIDERS;
}

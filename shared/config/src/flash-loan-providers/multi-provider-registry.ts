/**
 * Multi-Provider Flash Loan Registry
 *
 * Provides multiple flash loan providers per chain for the aggregator.
 * The single-provider FLASH_LOAN_PROVIDERS map stays untouched for
 * backward-compatible non-aggregator path.
 *
 * Consumed by FlashLoanStrategy constructor when enableAggregator=true.
 *
 * IMPORTANT: Only list protocols whose availability is TRUE in
 * flash-loan-availability.ts AND whose arbitrage contract is deployed.
 *
 * @see FLASH_LOAN_PROVIDERS — single-provider map (non-aggregator path)
 * @see flash-loan-availability.ts — canonical availability matrix
 * @see docs/superpowers/specs/2026-03-11-flash-loan-aggregator-activation-design.md
 */

import type { FlashLoanProtocol } from '@arbitrage/types';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, DSS_FLASH_ADDRESSES, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from '../addresses';

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
 * Multi-provider chains: ethereum (Aave V3 + DAI Flash Mint),
 * zksync (PancakeSwap V3 + SyncSwap), scroll (Aave V3 + SyncSwap).
 *
 * Single-provider chains: polygon, arbitrum, base, optimism (Aave V3),
 * bsc (PancakeSwap V3), avalanche (Aave V3), fantom (Balancer V2),
 * mantle (Aave V3), linea (PancakeSwap V3).
 *
 * No-provider chains (capital-at-risk only): blast, mode.
 *
 * H-01: Aligned with FLASH_LOAN_AVAILABILITY matrix. Removed balancer_v2
 * entries for chains where the BalancerV2FlashArbitrage contract is not
 * deployed (availability=false). Added dai_flash_mint for Ethereum and
 * PancakeSwap V3 for linea/zksync.
 */
export const FLASH_LOAN_PROVIDER_REGISTRY: Readonly<Record<string, readonly FlashLoanProviderEntry[]>> = Object.freeze({
  // === Multi-provider chains (sorted by feeBps ascending) ===
  ethereum: Object.freeze([
    { protocol: 'dai_flash_mint' as FlashLoanProtocol, address: DSS_FLASH_ADDRESSES.ethereum, feeBps: 1, priority: 0 },
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.ethereum, feeBps: 5, priority: 1 },
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.ethereum, feeBps: 25, priority: 2 },
  ]),
  zksync: Object.freeze([
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.zksync, feeBps: 25, priority: 0 },
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.zksync, feeBps: 30, priority: 1 },
  ]),
  scroll: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.scroll, feeBps: 5, priority: 0 },
    { protocol: 'syncswap' as FlashLoanProtocol, address: SYNCSWAP_VAULTS.scroll, feeBps: 30, priority: 1 },
  ]),

  // === Single-provider chains ===
  polygon: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.polygon, feeBps: 5, priority: 0 },
  ]),
  arbitrum: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.arbitrum, feeBps: 5, priority: 0 },
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.arbitrum, feeBps: 25, priority: 1 },
  ]),
  base: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.base, feeBps: 5, priority: 0 },
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.base, feeBps: 25, priority: 1 },
  ]),
  optimism: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.optimism, feeBps: 5, priority: 0 },
  ]),
  bsc: Object.freeze([
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.bsc, feeBps: 25, priority: 0 },
  ]),
  avalanche: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.avalanche, feeBps: 5, priority: 0 },
  ]),
  fantom: Object.freeze([
    { protocol: 'balancer_v2' as FlashLoanProtocol, address: BALANCER_V2_VAULTS.fantom, feeBps: 0, priority: 0 },
  ]),
  mantle: Object.freeze([
    { protocol: 'aave_v3' as FlashLoanProtocol, address: AAVE_V3_POOLS.mantle, feeBps: 5, priority: 0 },
  ]),
  linea: Object.freeze([
    { protocol: 'pancakeswap_v3' as FlashLoanProtocol, address: PANCAKESWAP_V3_FACTORIES.linea, feeBps: 25, priority: 0 },
  ]),
});

/**
 * Get providers for a chain. Returns empty frozen array for unknown chains.
 */
export function getProvidersForChain(chain: string): readonly FlashLoanProviderEntry[] {
  return FLASH_LOAN_PROVIDER_REGISTRY[chain] ?? EMPTY_PROVIDERS;
}

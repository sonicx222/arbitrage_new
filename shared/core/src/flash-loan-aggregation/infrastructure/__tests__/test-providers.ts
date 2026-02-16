/**
 * Shared Test Provider Factory
 *
 * R5: Centralized test provider definitions for flash loan aggregation tests.
 * Provides factory functions and named constants for all 5 supported protocols.
 *
 * Fee BPS per protocol (from production config):
 * - aave_v3:        9 bps  (0.09%)
 * - balancer_v2:    0 bps  (0.00% - free flash loans)
 * - pancakeswap_v3: 25 bps (0.25%)
 * - syncswap:       30 bps (0.30%)
 * - spookyswap:     20 bps (0.20%)
 *
 * @see shared/config/src/service-config.ts FLASH_LOAN_PROVIDERS
 */

import type { IProviderInfo } from '../../domain';

/**
 * Create a test provider with sensible defaults and optional overrides.
 */
export function createProvider(overrides?: Partial<IProviderInfo>): IProviderInfo {
  return {
    protocol: 'aave_v3',
    chain: 'ethereum',
    feeBps: 9,
    isAvailable: true,
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    ...overrides,
  };
}

// =============================================================================
// Named Provider Constants
// =============================================================================

/** Aave V3 on Ethereum — 9 bps fee */
export const AAVE_PROVIDER: IProviderInfo = createProvider({
  protocol: 'aave_v3',
  chain: 'ethereum',
  feeBps: 9,
  poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
});

/** Balancer V2 on Ethereum — 0 bps fee (free flash loans) */
export const BALANCER_PROVIDER: IProviderInfo = createProvider({
  protocol: 'balancer_v2',
  chain: 'ethereum',
  feeBps: 0,
  poolAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
});

/** PancakeSwap V3 on BSC — 25 bps fee */
export const PANCAKESWAP_PROVIDER: IProviderInfo = createProvider({
  protocol: 'pancakeswap_v3',
  chain: 'bsc',
  feeBps: 25,
  poolAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
});

/** SyncSwap on zkSync — 30 bps fee */
export const SYNCSWAP_PROVIDER: IProviderInfo = createProvider({
  protocol: 'syncswap',
  chain: 'zksync',
  feeBps: 30,
  poolAddress: '0x621425a1Ef6abE91058E9712575dcc4258F8d091',
});

/** SpookySwap on Fantom — 20 bps fee */
export const SPOOKYSWAP_PROVIDER: IProviderInfo = createProvider({
  protocol: 'spookyswap',
  chain: 'fantom',
  feeBps: 20,
  poolAddress: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
});

// =============================================================================
// Multi-protocol helpers
// =============================================================================

/** All 5 protocol providers on their native chains */
export const ALL_PROVIDERS: ReadonlyArray<IProviderInfo> = [
  AAVE_PROVIDER,
  BALANCER_PROVIDER,
  PANCAKESWAP_PROVIDER,
  SYNCSWAP_PROVIDER,
  SPOOKYSWAP_PROVIDER,
];

/**
 * Create providers for a specific chain.
 * Useful for testing multi-provider scenarios on the same chain.
 */
export function createProvidersForChain(
  chain: string,
  protocols: ReadonlyArray<IProviderInfo['protocol']> = ['aave_v3', 'pancakeswap_v3']
): IProviderInfo[] {
  const feeMap: Record<string, number> = {
    aave_v3: 9,
    balancer_v2: 0,
    pancakeswap_v3: 25,
    syncswap: 30,
    spookyswap: 20,
  };

  return protocols.map((protocol, i) =>
    createProvider({
      protocol,
      chain,
      feeBps: feeMap[protocol] ?? 9,
      poolAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    })
  );
}

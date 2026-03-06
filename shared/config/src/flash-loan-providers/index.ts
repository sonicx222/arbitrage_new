/**
 * Flash Loan Providers — Consolidated Configuration
 *
 * Single-object-per-protocol pattern. Each protocol is described by a
 * self-contained descriptor. The availability matrix, provider map, and
 * statistics are all derived from these descriptors.
 *
 * Adding a new protocol: create a new descriptor file, add it to ALL_PROVIDERS.
 *
 * @see flash-loan-availability.ts — backward-compatible re-exports
 * @see ADR-020: Flash loan integration decision
 */
import type { FlashLoanProtocol } from '@arbitrage/types';
import type { FlashLoanProviderDescriptor, FlashLoanProviderStatus } from './types';

// Per-protocol descriptors
import { AAVE_V3_PROVIDER } from './aave-v3';
import { BALANCER_V2_PROVIDER } from './balancer-v2';
import { PANCAKESWAP_V3_PROVIDER } from './pancakeswap-v3';
import { SYNCSWAP_PROVIDER } from './syncswap';
import { DAI_FLASH_MINT_PROVIDER } from './dai-flash-mint';
import { MORPHO_PROVIDER } from './morpho';
import { SPOOKYSWAP_PROVIDER } from './spookyswap';

// Re-export types
export type { FlashLoanProviderDescriptor, FlashLoanProviderStatus } from './types';

// =============================================================================
// Provider Registry
// =============================================================================

/** All flash loan provider descriptors */
export const ALL_PROVIDERS: readonly FlashLoanProviderDescriptor[] = [
  AAVE_V3_PROVIDER,
  BALANCER_V2_PROVIDER,
  PANCAKESWAP_V3_PROVIDER,
  SYNCSWAP_PROVIDER,
  DAI_FLASH_MINT_PROVIDER,
  MORPHO_PROVIDER,
  SPOOKYSWAP_PROVIDER,
];

/** O(1) lookup: protocol name -> descriptor */
export const PROVIDER_BY_PROTOCOL: ReadonlyMap<FlashLoanProtocol, FlashLoanProviderDescriptor> = new Map(
  ALL_PROVIDERS.map(p => [p.protocol, p])
);

/**
 * Get a provider descriptor by protocol name.
 */
export function getProviderDescriptor(protocol: FlashLoanProtocol): FlashLoanProviderDescriptor | undefined {
  return PROVIDER_BY_PROTOCOL.get(protocol);
}

/**
 * Get all active provider descriptors.
 */
export function getActiveProviders(): readonly FlashLoanProviderDescriptor[] {
  return ALL_PROVIDERS.filter(p => p.status === 'active');
}

/**
 * Get providers filtered by status.
 */
export function getProvidersByStatus(status: FlashLoanProviderStatus): readonly FlashLoanProviderDescriptor[] {
  return ALL_PROVIDERS.filter(p => p.status === status);
}

// Re-export individual providers for direct access
export { AAVE_V3_PROVIDER } from './aave-v3';
export { BALANCER_V2_PROVIDER } from './balancer-v2';
export { PANCAKESWAP_V3_PROVIDER } from './pancakeswap-v3';
export { SYNCSWAP_PROVIDER } from './syncswap';
export { DAI_FLASH_MINT_PROVIDER } from './dai-flash-mint';
export { MORPHO_PROVIDER } from './morpho';
export { SPOOKYSWAP_PROVIDER } from './spookyswap';

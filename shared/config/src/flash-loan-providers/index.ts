/**
 * Flash Loan Providers — Consolidated Configuration
 *
 * Single-object-per-protocol pattern. Each protocol is described by a
 * self-contained descriptor. The availability matrix, provider map, and
 * statistics are all derived from these descriptors.
 *
 * Adding a new protocol: create a new descriptor file, add it to ALL_PROVIDERS.
 *
 * M1 FIX: Load-time cross-validation between provider descriptors and
 * FLASH_LOAN_AVAILABILITY matrix. Warns on mismatches to prevent silent drift.
 *
 * @see flash-loan-availability.ts — backward-compatible re-exports
 * @see ADR-020: Flash loan integration decision
 */
import type { FlashLoanProtocol } from '@arbitrage/types';
import type { FlashLoanProviderDescriptor, FlashLoanProviderStatus } from './types';
import { FLASH_LOAN_AVAILABILITY } from '../flash-loan-availability';

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

// Pre-computed active providers to avoid repeated filter calls
const _ACTIVE_PROVIDERS: readonly FlashLoanProviderDescriptor[] = Object.freeze(
  ALL_PROVIDERS.filter(p => p.status === 'active')
);

// Pre-computed providers by status (O(1) lookup by status)
const _PROVIDERS_BY_STATUS = new Map<FlashLoanProviderStatus, FlashLoanProviderDescriptor[]>();
for (const provider of ALL_PROVIDERS) {
  const existing = _PROVIDERS_BY_STATUS.get(provider.status) ?? [];
  existing.push(provider);
  _PROVIDERS_BY_STATUS.set(provider.status, existing);
}

/**
 * Get all active provider descriptors.
 */
export function getActiveProviders(): readonly FlashLoanProviderDescriptor[] {
  return _ACTIVE_PROVIDERS;
}

/**
 * Get providers filtered by status.
 */
export function getProvidersByStatus(status: FlashLoanProviderStatus): readonly FlashLoanProviderDescriptor[] {
  return _PROVIDERS_BY_STATUS.get(status) ?? [];
}

// Re-export individual providers for direct access
export { AAVE_V3_PROVIDER } from './aave-v3';
export { BALANCER_V2_PROVIDER } from './balancer-v2';
export { PANCAKESWAP_V3_PROVIDER } from './pancakeswap-v3';
export { SYNCSWAP_PROVIDER } from './syncswap';
export { DAI_FLASH_MINT_PROVIDER } from './dai-flash-mint';
export { MORPHO_PROVIDER } from './morpho';
export { SPOOKYSWAP_PROVIDER } from './spookyswap';

// =============================================================================
// M1 FIX: Cross-Validation (provider descriptors ↔ availability matrix)
// =============================================================================

/**
 * Cross-validate provider descriptors against FLASH_LOAN_AVAILABILITY matrix.
 * Detects silent drift between the two representations.
 *
 * Runs at module load time (skipped in test/CI). Logs warnings, does not throw.
 */
function crossValidateProviders(): void {
  if (process.env.NODE_ENV === 'test' ||
      process.env.JEST_WORKER_ID ||
      process.env.SKIP_CONFIG_VALIDATION === 'true') {
    return;
  }

  const warnings: string[] = [];

  // 1. For each active provider chain, verify availability matrix agrees
  for (const provider of ALL_PROVIDERS) {
    if (provider.status === 'stub') continue; // Stubs have no chains

    for (const chain of provider.chains) {
      const avail = FLASH_LOAN_AVAILABILITY[chain];
      if (!avail) {
        warnings.push(
          `Provider ${provider.protocol} lists chain "${chain}" but it's not in FLASH_LOAN_AVAILABILITY`
        );
        continue;
      }
      // Only check active providers — deferred providers intentionally list chains
      // where the vault exists but our contract isn't deployed yet
      if (provider.status === 'active' && !avail[provider.protocol]) {
        warnings.push(
          `Provider ${provider.protocol} is active on "${chain}" but FLASH_LOAN_AVAILABILITY says false`
        );
      }
    }
  }

  // 2. For each availability=true entry, verify provider descriptor includes that chain
  for (const [chain, protocols] of Object.entries(FLASH_LOAN_AVAILABILITY)) {
    for (const [protocol, available] of Object.entries(protocols)) {
      if (!available) continue;
      const provider = PROVIDER_BY_PROTOCOL.get(protocol as FlashLoanProtocol);
      if (!provider) {
        warnings.push(
          `FLASH_LOAN_AVAILABILITY has ${chain}.${protocol}=true but no provider descriptor exists`
        );
        continue;
      }
      if (!provider.chains.includes(chain)) {
        warnings.push(
          `FLASH_LOAN_AVAILABILITY has ${chain}.${protocol}=true but provider descriptor doesn't list "${chain}"`
        );
      }
    }
  }

  for (const w of warnings) {
    console.warn(`[FLASH_LOAN_CROSS_VALIDATION] ${w}`);
  }
}

crossValidateProviders();

// Multi-provider registry for aggregator
export {
  FLASH_LOAN_PROVIDER_REGISTRY,
  getProvidersForChain,
  type FlashLoanProviderEntry,
} from './multi-provider-registry';

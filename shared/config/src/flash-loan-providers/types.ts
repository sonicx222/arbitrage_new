/**
 * Flash Loan Provider Descriptor — single-object-per-protocol pattern.
 *
 * Each flash loan protocol is described by a self-contained descriptor
 * that includes addresses, fee, supported chains, and deployment status.
 * The availability matrix and provider map are derived from these descriptors.
 *
 * @see ADR-020: Flash loan integration decision
 */
import type { FlashLoanProtocol } from '@arbitrage/types';

export type FlashLoanProviderStatus = 'active' | 'deferred' | 'stub';

export interface FlashLoanProviderDescriptor {
  /** Protocol identifier matching FlashLoanProtocol union type */
  protocol: FlashLoanProtocol;
  /** Flash loan fee in basis points (e.g., 5 = 0.05%) */
  feeBps: number;
  /** Contract addresses by chain (references from addresses.ts) */
  addresses: Readonly<Record<string, string>>;
  /** Chains where this protocol is available */
  chains: readonly string[];
  /** Deployment status */
  status: FlashLoanProviderStatus;
  /** Reason if status is 'deferred' or 'stub' */
  deferredReason?: string;
}

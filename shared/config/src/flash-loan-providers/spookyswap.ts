/**
 * SpookySwap Flash Loan Provider Descriptor
 *
 * SpookySwap exists on Fantom but flash loans are not implemented.
 * Kept as a stub to satisfy the FlashLoanProtocol union type.
 */
import type { FlashLoanProviderDescriptor } from './types';

export const SPOOKYSWAP_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'spookyswap',
  feeBps: 30, // SpookySwap V2 swap fee — speculative, no flash loan implemented
  addresses: {},
  chains: [],
  status: 'stub',
  deferredReason: 'Flash loans not implemented for SpookySwap',
};

/**
 * SyncSwap Flash Loan Provider Descriptor
 *
 * EIP-3156 compliant flash loans via SyncSwap Vault.
 * 0.3% flash loan fee (30 bps).
 *
 * @see https://syncswap.xyz/
 */
import { SYNCSWAP_VAULTS } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const SYNCSWAP_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'syncswap',
  feeBps: 30,
  addresses: SYNCSWAP_VAULTS,
  chains: ['zksync', 'scroll'],
  status: 'active',
};

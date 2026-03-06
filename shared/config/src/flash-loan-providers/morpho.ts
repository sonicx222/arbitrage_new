/**
 * Morpho Blue Flash Loan Provider Descriptor
 *
 * Zero-fee flash loans via Morpho Blue.
 * Deferred: No MorphoFlashArbitrage.sol contract yet.
 *
 * @see https://docs.morpho.org/morpho/contracts/addresses
 */
import { MORPHO_BLUE_POOLS } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const MORPHO_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'morpho',
  feeBps: 0,
  addresses: MORPHO_BLUE_POOLS,
  chains: ['ethereum', 'base'],
  status: 'deferred',
  deferredReason: 'No MorphoFlashArbitrage.sol contract yet',
};

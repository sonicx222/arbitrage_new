/**
 * DAI Flash Mint (DssFlash) Provider Descriptor
 *
 * Ethereum-only, DAI-only. 0.01% fee (1 bps).
 * MakerDAO DssFlash contract for minting DAI via flash loans.
 *
 * @see https://docs.makerdao.com/smart-contract-modules/flash-mint-module
 */
import { DSS_FLASH_ADDRESSES } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const DAI_FLASH_MINT_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'dai_flash_mint',
  feeBps: 1,
  addresses: DSS_FLASH_ADDRESSES,
  chains: ['ethereum'],
  status: 'active',
};

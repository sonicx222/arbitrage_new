/**
 * DAI Flash Mint (DssFlash) Provider Descriptor
 *
 * Ethereum-only, DAI-only. 0.01% fee (1 bps) — may be 0 bps post-Endgame.
 * MakerDAO DssFlash contract for minting DAI via flash loans.
 * TODO: Verify on-chain via eth_call to DssFlash.toll() — fee may have been
 * reduced to 0 by MakerDAO governance (Endgame migration).
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

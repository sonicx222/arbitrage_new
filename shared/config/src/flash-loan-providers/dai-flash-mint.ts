/**
 * DAI Flash Mint (DssFlash) Provider Descriptor
 *
 * Ethereum-only, DAI-only. 0.01% fee (1 bps) — may be 0 bps post-Endgame.
 * MakerDAO DssFlash contract for minting DAI via flash loans.
 *
 * Fee validation: The `feeBps` value here is a static config default. At runtime,
 * the execution engine should verify the actual fee via:
 *   `eth_call` to DssFlash.toll() at address 0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853
 * If MakerDAO governance has changed the toll (e.g., to 0 post-Endgame), profit
 * calculations using this static 1 bps will be slightly conservative (safe side).
 *
 * @see https://docs.makerdao.com/smart-contract-modules/flash-mint-module
 * @see shared/config/src/addresses.ts DSS_FLASH_ADDRESSES
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

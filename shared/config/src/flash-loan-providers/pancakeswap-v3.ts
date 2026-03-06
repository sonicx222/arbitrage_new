/**
 * PancakeSwap V3 Flash Loan Provider Descriptor
 *
 * Best for BSC and zkSync ecosystems.
 * Flash swap fee equals the pool's fee tier; 25 bps (0.25%) is the most common
 * volatile-pair tier. Actual range: 1–100 bps depending on pool.
 *
 * @see https://docs.pancakeswap.finance/developers/smart-contracts
 */
import { PANCAKESWAP_V3_FACTORIES } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const PANCAKESWAP_V3_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'pancakeswap_v3',
  feeBps: 25,
  addresses: PANCAKESWAP_V3_FACTORIES,
  chains: ['bsc', 'ethereum', 'arbitrum', 'base', 'zksync', 'linea'],
  status: 'active',
};

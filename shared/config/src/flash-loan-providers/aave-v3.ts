/**
 * Aave V3 Flash Loan Provider Descriptor
 *
 * Best coverage on major EVM chains (7 mainnet + 2 testnet).
 * 0.05% flash loan fee (5 bps) since March 2024 governance vote.
 *
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
import { AAVE_V3_POOLS } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const AAVE_V3_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'aave_v3',
  feeBps: 5,
  addresses: AAVE_V3_POOLS,
  chains: [
    'ethereum',
    'polygon',
    'arbitrum',
    'base',
    'optimism',
    'avalanche',
    'scroll',
    'mantle',
    'sepolia',
    'arbitrumSepolia',
    'baseSepolia',
  ],
  status: 'active',
};

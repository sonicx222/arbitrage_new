/**
 * Balancer V2 Flash Loan Provider Descriptor
 *
 * 0% flash loan fee — always preferred when available.
 * Fantom uses Beethoven X (Balancer V2 fork) at a different vault address.
 *
 * Status: active on fantom (Beethoven X), deferred on other chains
 * (requires BalancerV2FlashArbitrage.sol deployment).
 *
 * @see https://docs.balancer.fi/reference/contracts/deployment-addresses/
 */
import { BALANCER_V2_VAULTS } from '../addresses';
import type { FlashLoanProviderDescriptor } from './types';

export const BALANCER_V2_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'balancer_v2',
  feeBps: 0,
  addresses: BALANCER_V2_VAULTS,
  chains: ['ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'fantom'],
  status: 'deferred',
  deferredReason: 'BalancerV2FlashArbitrage.sol only deployed on fantom — see D1-BALANCER-V2-MULTI-CHAIN',
  // chains lists chains where the Balancer V2 Vault exists on-chain.
  // Flash loans are only usable where BalancerV2FlashArbitrage.sol is deployed (fantom only).
};

/**
 * Mode DEX Configurations — 3 DEXes
 * Note: supswap and iziswap have unverified addresses (sequential hex patterns).
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const MODE_DEXES: Dex[] = [
  {
    name: 'kim_exchange',      // [C] - Dominant on Mode
    chain: 'mode',
    factoryAddress: '0x8c5a57ed1d0ef3b87984400b7f707c05151de0d7',
    routerAddress: '0x6A5a77c58Eac94A52Fb8b3F98Fc61dDA9B673b94',
    feeBps: bps(30),
    verified: false,  // Not yet RPC-verified on Mode mainnet
  },
  {
    name: 'supswap',          // [H]
    chain: 'mode',
    factoryAddress: '0x8a4C4e7d05d2798C5bC4b7dA6315E73F5d0fA576',
    routerAddress: '0x6f4e2e69b49f0e3d93c6d4934a0f4e4b2e8f7d10',
    feeBps: bps(30),
    verified: false,  // Addresses have sequential hex patterns — verify on Mode mainnet via RPC
  },
  {
    name: 'iziswap',          // [M]
    chain: 'mode',
    factoryAddress: '0x1c1e07c9147b90c7d9db20d4a7f5e5e4e4b8f9c0',
    routerAddress: '0x2d3bb6c1c8b8e1f2d4a5f6c7e8e9d0c1b2a3d4e0',
    feeBps: bps(30),
    verified: false,  // Addresses have sequential hex patterns — verify on Mode mainnet via RPC
  },
];

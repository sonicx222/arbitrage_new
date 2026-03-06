/**
 * Scroll DEX Configurations — 4 DEXes (RPC-verified 2026-02-26)
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const SCROLL_DEXES: Dex[] = [
  {
    name: 'syncswap',          // [C]
    chain: 'scroll',
    factoryAddress: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
    routerAddress: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
    feeBps: bps(30),
  },
  {
    name: 'uniswap_v3',        // [C]
    chain: 'scroll',
    factoryAddress: '0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919',
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap_v3',      // [H]
    chain: 'scroll',
    factoryAddress: '0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e',
    routerAddress: '0x734583f62Bb6ACe3c9bA9bd5A53143CA2Ce8C55A',
    feeBps: bps(30),
  },
  {
    name: 'ambient',           // [H] - CrocSwap/Ambient (single-contract DEX)
    chain: 'scroll',
    factoryAddress: '0xaaaaAAAACB71BF2C8CaE522EA5fa455571A74106',
    routerAddress: '0xaaaaAAAACB71BF2C8CaE522EA5fa455571A74106',
    feeBps: bps(5),
  },
];

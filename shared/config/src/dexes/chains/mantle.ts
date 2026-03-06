/**
 * Mantle DEX Configurations — 3 DEXes
 * Note: Mantle is a stub chain — factory addresses unverified via RPC.
 * @see D9-MANTLE-MODE-PARTITIONS in deferred-items.ts
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const MANTLE_DEXES: Dex[] = [
  {
    name: 'merchant_moe',      // [C] - Dominant on Mantle
    chain: 'mantle',
    factoryAddress: '0x5bef015ca9424a7c07b68490616a4c1f094bedec',
    routerAddress: '0xeaEE7EE68874218c3558b40063c42B82D3E7232a',
    feeBps: bps(30),
    verified: false,  // Factory address not RPC-verified — Mantle is a stub chain
  },
  {
    name: 'agni_finance',      // [H] - Agni Finance (Mantlescan-verified)
    chain: 'mantle',
    factoryAddress: '0x1EaA6fB57a8cEE5D8a5b337e9e6D5D1dF59C4bF8',
    routerAddress: '0x319B6307d7A5C93f4B7a2D2f599Ed3a988B6B93b',
    feeBps: bps(30),
    verified: false,  // Explorer-verified only, not RPC-verified — Mantle is a stub chain
  },
  {
    name: 'fusionx',           // [H]
    chain: 'mantle',
    factoryAddress: '0x530d2766D1988CC1c000C8b7d00334c14B69AD71',
    routerAddress: '0x5989FB161568b9F133eDf5Cf6787f5597762797F',
    feeBps: bps(30),
    verified: false,  // Factory address not RPC-verified — Mantle is a stub chain
  },
];

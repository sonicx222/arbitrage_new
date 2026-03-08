/**
 * Mantle DEX Configurations — 3 DEXes
 * Updated with RPC-validated factory/router pairs on 2026-03-08.
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
    verified: true,   // RPC-validated (factory code + router.factory() match)
  },
  {
    name: 'agni_finance',      // [H] - Agni V2
    chain: 'mantle',
    factoryAddress: '0xd7D3e1116277a0f8b6f23cc64D5Ea56982822Dde',
    routerAddress: '0x4CBA08a0880c502AB1e10CDC93Dbc74C23524ac7',
    feeBps: bps(30),
    verified: true,   // Official Agni address-config + RPC-validated
  },
  {
    name: 'fusionx',           // [H]
    chain: 'mantle',
    factoryAddress: '0x530d2766D1988CC1c000C8b7d00334c14B69AD71',
    routerAddress: '0x5989FB161568b9F133eDf5Cf6787f5597762797F',
    feeBps: bps(30),
    verified: true,   // Official FusionX docs + RPC-validated
  },
];

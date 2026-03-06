/**
 * Blast DEX Configurations — 4 DEXes (RPC-verified 2026-02-26)
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const BLAST_DEXES: Dex[] = [
  {
    name: 'thruster_v3',       // [C] - Concentrated liquidity
    chain: 'blast',
    factoryAddress: '0x71b08f13B3c3aF35aAdEb3949AFEb1ded1016127',
    routerAddress: '0x337827814155ECBf24D20231fCA4444F530C0555',
    feeBps: bps(30),
  },
  {
    name: 'thruster_v2',       // [C] - V2 AMM
    chain: 'blast',
    factoryAddress: '0xb4A7D971D0ADea1c73198C97d7ab3f9CE4aaFA13',
    routerAddress: '0x98994a9A7a2570367554589189dC9772241650f6',
    feeBps: bps(30),
  },
  {
    name: 'bladeswap',         // [H]
    chain: 'blast',
    factoryAddress: '0x5C346464d33F90bABaf70dB6388507CC889C1070',
    routerAddress: '0x5C346464d33F90bABaf70dB6388507CC889C1070', // Single-contract model (factory===router) — RPC-verified
    feeBps: bps(30),
  },
  {
    name: 'fenix_finance',     // [H] - Solidly fork
    chain: 'blast',
    factoryAddress: '0xa19C51D91891D3DF7C13Ed22a2f89d328A82950f',
    routerAddress: '0xa19C51D91891D3DF7C13Ed22a2f89d328A82950f', // Single-contract model (factory===router) — RPC-verified
    feeBps: bps(30),
  },
];

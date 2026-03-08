/**
 * Mode DEX Configurations — 3 DEXes
 * Updated with RPC-validated factory/router pairs on 2026-03-08.
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const MODE_DEXES: Dex[] = [
  {
    name: 'kim_exchange',      // [C] - Dominant on Mode
    chain: 'mode',
    factoryAddress: '0xc02155946dd8C89D3D3238A6c8A64D04E2CD4500',
    routerAddress: '0x5D61c537393cf21893BE619E36fC94cd73C77DD3',
    feeBps: bps(30),
    verified: true,   // RPC-validated (factory code + router.factory() match)
  },
  {
    name: 'supswap',           // [H]
    chain: 'mode',
    factoryAddress: '0xa0b018Fe0d00ed075fb9b0eEe26d25cf72e1F693',
    routerAddress: '0x016e131C05fb007b5ab286A6D614A5dab99BD415',
    feeBps: bps(30),
    verified: true,   // RPC-validated (factory code + router.factory() match)
  },
  {
    name: 'swapmode',          // [M]
    chain: 'mode',
    factoryAddress: '0xfb926356BAf861c93C3557D7327Dbe8734A71891',
    routerAddress: '0xc1e624c810d297fd70ef53b0e08f44fabe468591',
    feeBps: bps(30),
    verified: true,   // RPC-validated (factory code + router.factory() match)
  },
];

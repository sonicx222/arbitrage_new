/**
 * Solana DEX Configurations — 7 DEXes (Non-EVM, uses Solana program IDs)
 * @see S3.3.2
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const SOLANA_DEXES: Dex[] = [
  {
    name: 'jupiter',          // [C] - Largest aggregator
    chain: 'solana',
    factoryAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    routerAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    feeBps: bps(0),
    type: 'aggregator',
    enabled: false,
  },
  {
    name: 'raydium',          // [C] - Largest AMM
    chain: 'solana',
    factoryAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    routerAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    feeBps: bps(25),
    type: 'amm',
    enabled: true,
  },
  {
    name: 'raydium-clmm',     // [C] - Concentrated Liquidity
    chain: 'solana',
    factoryAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    routerAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    feeBps: bps(25),
    type: 'clmm',
    enabled: true,
  },
  {
    name: 'orca',             // [H] - Whirlpools
    chain: 'solana',
    factoryAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    routerAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    feeBps: bps(30),
    type: 'clmm',
    enabled: true,
  },
  {
    name: 'meteora',          // [H] - Dynamic Liquidity Market Maker
    chain: 'solana',
    factoryAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    routerAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    feeBps: bps(20),
    type: 'dlmm',
    enabled: true,
  },
  {
    name: 'phoenix',          // [H] - On-chain order book
    chain: 'solana',
    factoryAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
    routerAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
    feeBps: bps(10),
    type: 'orderbook',
    enabled: true,
  },
  {
    name: 'lifinity',         // [H] - Proactive market maker
    chain: 'solana',
    factoryAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
    routerAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
    feeBps: bps(20),
    type: 'pmm',
    enabled: true,
  },
];

/**
 * DEX Factory Registry
 *
 * Registry of DEX factory addresses per chain with type classification.
 * Enables factory-level event subscriptions for 40-50x RPC reduction.
 *
 * @see implementation_plan_v2.md Phase 2.1.1
 * @see ARCHITECTURE_V2.md Section 3.2 (Factory Subscriptions)
 *
 * Factory Types:
 * - uniswap_v2: Standard xy=k AMM (SushiSwap, PancakeSwap V2, etc.)
 * - uniswap_v3: Concentrated liquidity (Uniswap V3, PancakeSwap V3)
 * - solidly: ve(3,3) forks (Velodrome, Aerodrome, Thena)
 * - curve: StableSwap AMM (Curve, Ellipsis)
 * - balancer_v2: Vault-based weighted pools (Balancer, Beethoven X)
 * - algebra: Algebra-based concentrated liquidity (QuickSwap V3, Camelot)
 * - trader_joe: Liquidity Book (Trader Joe V2)
 *
 * Note: Solana is excluded as it uses program IDs, not factory contracts.
 */

import { DEXES } from './dexes';
import { CHAINS } from './chains';

// =============================================================================
// Types
// =============================================================================

/**
 * Factory type classification for different AMM architectures.
 * Used to select appropriate ABI and event handlers.
 */
export type FactoryType =
  | 'uniswap_v2'    // Standard xy=k AMM
  | 'uniswap_v3'    // Concentrated liquidity
  | 'solidly'       // ve(3,3) forks with stable/volatile flag
  | 'curve'         // StableSwap multi-asset pools
  | 'balancer_v2'   // Vault-based weighted pools
  | 'algebra'       // Algebra-based (dynamic fee concentrated liquidity)
  | 'trader_joe';   // Liquidity Book (bin-based AMM)

/**
 * Factory configuration for a single DEX factory contract.
 */
export interface FactoryConfig {
  /** Factory contract address (checksummed) */
  address: string;
  /** DEX name matching DEXES config */
  dexName: string;
  /** Factory type for ABI selection */
  type: FactoryType;
  /** Chain identifier */
  chain: string;
  /** Optional: Init code hash for pair address computation */
  initCodeHash?: string;
  /** Optional: Whether factory supports fee tiers (V3-style) */
  hasFeeTiers?: boolean;
  /**
   * Whether this factory supports standard factory events for dynamic pair discovery.
   * Set to false for DEXes that use non-standard architectures:
   * - Vault-model DEXes (GMX, Platypus) use adapters for pool discovery
   * - DEXes with custom event signatures (Maverick) need custom handling
   * Defaults to true if not specified.
   */
  supportsFactoryEvents?: boolean;
}

// =============================================================================
// P2-4: FactoryReference Type (Data Clump Elimination)
// =============================================================================

/**
 * P2-4 FIX: FactoryReference type eliminates the repeated (chain, address) parameter pair.
 * Used by lookup functions to reference a factory by its chain and address.
 * @see docs/research/REFACTORING_IMPLEMENTATION_PLAN.md P2-4
 */
export interface FactoryReference {
  /** Chain identifier (e.g., 'arbitrum', 'bsc') */
  chain: string;
  /** Factory contract address (case-insensitive) */
  address: string;
}

/**
 * Create a FactoryReference from chain and address strings.
 * Helper for callers migrating from separate parameters.
 */
export function createFactoryRef(chain: string, address: string): FactoryReference {
  return { chain, address };
}

// =============================================================================
// P2-1: Consolidated Factory Validation (Composable Validator Pattern)
// =============================================================================

/**
 * P2-1 FIX: Validation severity levels for composable validation.
 * CRITICAL errors prevent startup; WARNING errors are logged but non-blocking.
 */
export type ValidationSeverity = 'critical' | 'warning';

/**
 * P2-1 FIX: Single validation error with severity and context.
 */
export interface FactoryValidationError {
  severity: ValidationSeverity;
  message: string;
  chain: string;
  dexName: string;
}

/**
 * P2-1 FIX: Options for factory registry validation.
 * Allows callers to customize which checks run.
 */
export interface FactoryValidationOptions {
  /** Skip validation entirely (default: false) */
  skip?: boolean;
  /** Check that DEX name exists in DEXES config (default: true) */
  checkDexExists?: boolean;
  /** Check that factory.chain matches registry key (default: true) */
  checkChainMatch?: boolean;
  /** Check Ethereum address format (default: true) */
  checkAddressFormat?: boolean;
  /** Check factory address matches DEXES config (default: true, skipped for vault-model) */
  checkAddressMatchesDexes?: boolean;
  /** Check chain exists in CHAINS config (default: true) */
  checkChainExists?: boolean;
}

// =============================================================================
// Factory ABIs
// =============================================================================

/**
 * Minimal ABI definitions for factory event subscriptions.
 * Only includes events needed for pool discovery.
 */
export const FACTORY_ABIS: Record<FactoryType, readonly object[]> = {
  // UniswapV2-style: PairCreated(token0, token1, pair, pairIndex)
  uniswap_v2: [
    {
      type: 'event',
      name: 'PairCreated',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'token0', type: 'address' },
        { indexed: true, name: 'token1', type: 'address' },
        { indexed: false, name: 'pair', type: 'address' },
        { indexed: false, name: 'pairIndex', type: 'uint256' },
      ],
    },
    {
      type: 'function',
      name: 'allPairsLength',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'allPairs',
      inputs: [{ name: 'index', type: 'uint256' }],
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'getPair',
      inputs: [
        { name: 'tokenA', type: 'address' },
        { name: 'tokenB', type: 'address' },
      ],
      outputs: [{ name: 'pair', type: 'address' }],
      stateMutability: 'view',
    },
  ] as const,

  // UniswapV3-style: PoolCreated(token0, token1, fee, tickSpacing, pool)
  uniswap_v3: [
    {
      type: 'event',
      name: 'PoolCreated',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'token0', type: 'address' },
        { indexed: true, name: 'token1', type: 'address' },
        { indexed: true, name: 'fee', type: 'uint24' },
        { indexed: false, name: 'tickSpacing', type: 'int24' },
        { indexed: false, name: 'pool', type: 'address' },
      ],
    },
    {
      type: 'function',
      name: 'getPool',
      inputs: [
        { name: 'tokenA', type: 'address' },
        { name: 'tokenB', type: 'address' },
        { name: 'fee', type: 'uint24' },
      ],
      outputs: [{ name: 'pool', type: 'address' }],
      stateMutability: 'view',
    },
  ] as const,

  // Solidly-style: PairCreated(token0, token1, stable, pair, pairIndex)
  solidly: [
    {
      type: 'event',
      name: 'PairCreated',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'token0', type: 'address' },
        { indexed: true, name: 'token1', type: 'address' },
        { indexed: false, name: 'stable', type: 'bool' },
        { indexed: false, name: 'pair', type: 'address' },
        { indexed: false, name: 'pairIndex', type: 'uint256' },
      ],
    },
    {
      type: 'function',
      name: 'allPairsLength',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'getPair',
      inputs: [
        { name: 'tokenA', type: 'address' },
        { name: 'tokenB', type: 'address' },
        { name: 'stable', type: 'bool' },
      ],
      outputs: [{ name: 'pair', type: 'address' }],
      stateMutability: 'view',
    },
  ] as const,

  // Curve-style: Uses registry pattern, pools discovered via Registry
  curve: [
    {
      type: 'event',
      name: 'PlainPoolDeployed',
      anonymous: false,
      inputs: [
        { indexed: false, name: 'coins', type: 'address[4]' },
        { indexed: false, name: 'A', type: 'uint256' },
        { indexed: false, name: 'fee', type: 'uint256' },
        { indexed: false, name: 'deployer', type: 'address' },
        { indexed: false, name: 'pool', type: 'address' },
      ],
    },
    {
      type: 'event',
      name: 'MetaPoolDeployed',
      anonymous: false,
      inputs: [
        { indexed: false, name: 'coin', type: 'address' },
        { indexed: false, name: 'base_pool', type: 'address' },
        { indexed: false, name: 'A', type: 'uint256' },
        { indexed: false, name: 'fee', type: 'uint256' },
        { indexed: false, name: 'deployer', type: 'address' },
        { indexed: false, name: 'pool', type: 'address' },
      ],
    },
    {
      type: 'function',
      name: 'pool_count',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'pool_list',
      inputs: [{ name: 'index', type: 'uint256' }],
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
    },
  ] as const,

  // Balancer V2: Uses Vault for pool registration
  balancer_v2: [
    {
      type: 'event',
      name: 'PoolRegistered',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'poolId', type: 'bytes32' },
        { indexed: true, name: 'poolAddress', type: 'address' },
        { indexed: false, name: 'specialization', type: 'uint8' },
      ],
    },
    {
      type: 'event',
      name: 'TokensRegistered',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'poolId', type: 'bytes32' },
        { indexed: false, name: 'tokens', type: 'address[]' },
        { indexed: false, name: 'assetManagers', type: 'address[]' },
      ],
    },
    {
      type: 'function',
      name: 'getPool',
      inputs: [{ name: 'poolId', type: 'bytes32' }],
      outputs: [
        { name: 'pool', type: 'address' },
        { name: 'specialization', type: 'uint8' },
      ],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'getPoolTokens',
      inputs: [{ name: 'poolId', type: 'bytes32' }],
      outputs: [
        { name: 'tokens', type: 'address[]' },
        { name: 'balances', type: 'uint256[]' },
        { name: 'lastChangeBlock', type: 'uint256' },
      ],
      stateMutability: 'view',
    },
  ] as const,

  // Algebra-style (QuickSwap V3, Camelot): Dynamic fee concentrated liquidity
  algebra: [
    {
      type: 'event',
      name: 'Pool',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'token0', type: 'address' },
        { indexed: true, name: 'token1', type: 'address' },
        { indexed: false, name: 'pool', type: 'address' },
      ],
    },
    {
      type: 'function',
      name: 'poolByPair',
      inputs: [
        { name: 'tokenA', type: 'address' },
        { name: 'tokenB', type: 'address' },
      ],
      outputs: [{ name: 'pool', type: 'address' }],
      stateMutability: 'view',
    },
  ] as const,

  // Trader Joe Liquidity Book: Bin-based AMM
  trader_joe: [
    {
      type: 'event',
      name: 'LBPairCreated',
      anonymous: false,
      inputs: [
        { indexed: true, name: 'tokenX', type: 'address' },
        { indexed: true, name: 'tokenY', type: 'address' },
        { indexed: true, name: 'binStep', type: 'uint256' },
        { indexed: false, name: 'LBPair', type: 'address' },
        { indexed: false, name: 'pid', type: 'uint256' },
      ],
    },
    {
      type: 'function',
      name: 'getNumberOfLBPairs',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'getLBPairAtIndex',
      inputs: [{ name: 'index', type: 'uint256' }],
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
    },
    {
      type: 'function',
      name: 'getLBPairInformation',
      inputs: [
        { name: 'tokenX', type: 'address' },
        { name: 'tokenY', type: 'address' },
        { name: 'binStep', type: 'uint256' },
      ],
      outputs: [
        { name: 'LBPair', type: 'address' },
        { name: 'binStep', type: 'uint256' },
        { name: 'createdByOwner', type: 'bool' },
        { name: 'ignoredForRouting', type: 'bool' },
      ],
      stateMutability: 'view',
    },
  ] as const,
};

// =============================================================================
// Factory Registry
// =============================================================================

/**
 * DEX Factory Registry - Maps chains to their factory configurations.
 *
 * Each factory is classified by type to select appropriate ABI and event handlers.
 * Addresses are checksummed for consistency with DEXES config.
 *
 * Note: Solana is excluded as it uses program IDs, not factory contracts.
 */
export const DEX_FACTORY_REGISTRY: Record<string, FactoryConfig[]> = {
  // Arbitrum: 9 factories
  arbitrum: [
    {
      address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      dexName: 'uniswap_v3',
      type: 'uniswap_v3',
      chain: 'arbitrum',
      hasFeeTiers: true,
    },
    {
      address: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B',
      dexName: 'camelot_v3',
      type: 'algebra',
      chain: 'arbitrum',
    },
    {
      address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'arbitrum',
      initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    },
    {
      address: '0x1886D09C9Ade0c5DB822D85D21678Db67B6c2982',
      dexName: 'trader_joe',
      type: 'trader_joe',
      chain: 'arbitrum',
    },
    {
      address: '0xaC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
      dexName: 'zyberswap',
      type: 'uniswap_v2',
      chain: 'arbitrum',
    },
    {
      address: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
      dexName: 'ramses',
      type: 'solidly',
      chain: 'arbitrum',
    },
    {
      address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
      dexName: 'balancer_v2',
      type: 'balancer_v2',
      chain: 'arbitrum',
      // Note: PoolRegistered event parsed, tokens fetched via Vault.getPoolTokens()
    },
    {
      address: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031',
      dexName: 'curve',
      type: 'curve',
      chain: 'arbitrum',
      // Note: Supports PlainPoolDeployed and MetaPoolDeployed events
    },
    {
      address: '0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722',
      dexName: 'chronos',
      type: 'solidly',
      chain: 'arbitrum',
    },
  ],

  // BSC: 8 factories
  bsc: [
    {
      address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      dexName: 'pancakeswap_v3',
      type: 'uniswap_v3',
      chain: 'bsc',
      hasFeeTiers: true,
    },
    {
      address: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      dexName: 'pancakeswap_v2',
      type: 'uniswap_v2',
      chain: 'bsc',
      initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5',
    },
    {
      address: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
      dexName: 'biswap',
      type: 'uniswap_v2',
      chain: 'bsc',
    },
    {
      address: '0xAFD89d21BdB66d00817d4153E055830B1c2B3970',
      dexName: 'thena',
      type: 'solidly',
      chain: 'bsc',
    },
    {
      address: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
      dexName: 'apeswap',
      type: 'uniswap_v2',
      chain: 'bsc',
    },
    {
      address: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
      dexName: 'mdex',
      type: 'uniswap_v2',
      chain: 'bsc',
    },
    {
      address: '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870',
      dexName: 'ellipsis',
      type: 'curve',
      chain: 'bsc',
      // Note: Ellipsis (Curve fork) - supports PlainPoolDeployed and MetaPoolDeployed
    },
    {
      address: '0xD6715A8Be3944Ec72738f0bFdc739571659D8010',
      dexName: 'nomiswap',
      type: 'uniswap_v2',
      chain: 'bsc',
    },
  ],

  // Base: 7 factories
  base: [
    {
      address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      dexName: 'uniswap_v3',
      type: 'uniswap_v3',
      chain: 'base',
      hasFeeTiers: true,
    },
    {
      address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      dexName: 'aerodrome',
      type: 'solidly',
      chain: 'base',
    },
    {
      address: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
      dexName: 'baseswap',
      type: 'uniswap_v2',
      chain: 'base',
    },
    {
      address: '0x71524B4f93c58fcbF659783284E38825f0622859',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'base',
    },
    {
      address: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
      dexName: 'swapbased',
      type: 'uniswap_v2',
      chain: 'base',
    },
    {
      address: '0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e',
      dexName: 'maverick',
      type: 'uniswap_v3', // Maverick uses V3-like concentrated liquidity
      chain: 'base',
      // ARCHITECTURAL NOTE: Maverick uses "boosted positions" with custom PoolCreated event
      // signature that differs from standard V3. Requires custom adapter for pool discovery.
      supportsFactoryEvents: false,
    },
    {
      address: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
      dexName: 'alienbase',
      type: 'uniswap_v2',
      chain: 'base',
    },
  ],

  // Polygon: 4 factories
  polygon: [
    {
      address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      dexName: 'uniswap_v3',
      type: 'uniswap_v3',
      chain: 'polygon',
      hasFeeTiers: true,
    },
    {
      address: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28',
      dexName: 'quickswap_v3',
      type: 'algebra',
      chain: 'polygon',
    },
    {
      address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'polygon',
    },
    {
      address: '0xCf083Be4164828f00cAE704EC15a36D711491284',
      dexName: 'apeswap',
      type: 'uniswap_v2',
      chain: 'polygon',
    },
  ],

  // Optimism: 3 factories
  optimism: [
    {
      address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      dexName: 'uniswap_v3',
      type: 'uniswap_v3',
      chain: 'optimism',
      hasFeeTiers: true,
    },
    {
      address: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746',
      dexName: 'velodrome',
      type: 'solidly',
      chain: 'optimism',
    },
    {
      address: '0xFbc12984689e5f15626Bad03Ad60160Fe98B303C',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'optimism',
    },
  ],

  // Ethereum: 2 factories
  ethereum: [
    {
      address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      dexName: 'uniswap_v3',
      type: 'uniswap_v3',
      chain: 'ethereum',
      hasFeeTiers: true,
    },
    {
      address: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'ethereum',
      initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    },
  ],

  // Avalanche: 6 factories
  avalanche: [
    {
      address: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
      dexName: 'trader_joe_v2',
      type: 'trader_joe',
      chain: 'avalanche',
    },
    {
      address: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
      dexName: 'pangolin',
      type: 'uniswap_v2',
      chain: 'avalanche',
    },
    {
      address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      dexName: 'sushiswap',
      type: 'uniswap_v2',
      chain: 'avalanche',
    },
    {
      address: '0x9ab2De34A33fB459b538c43f251eB825645e8595',
      dexName: 'gmx',
      type: 'balancer_v2', // GMX uses vault model similar to Balancer
      chain: 'avalanche',
      // ARCHITECTURAL NOTE: GMX uses Vault/GLP model with GmxAdapter for pool discovery.
      // Does not emit standard factory events.
      supportsFactoryEvents: false,
    },
    {
      address: '0x66357dCaCe80431aee0A7507e2E361B7e2402370',
      dexName: 'platypus',
      type: 'curve', // Platypus uses Curve-like stableswap model
      chain: 'avalanche',
      // ARCHITECTURAL NOTE: Platypus uses "coverage ratio" model with PlatypusAdapter.
      // Does not emit standard factory events.
      supportsFactoryEvents: false,
    },
    {
      address: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
      dexName: 'kyberswap',
      type: 'uniswap_v3', // KyberSwap Elastic is V3-like
      chain: 'avalanche',
    },
  ],

  // Fantom: 4 factories
  fantom: [
    {
      address: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
      dexName: 'spookyswap',
      type: 'uniswap_v2',
      chain: 'fantom',
    },
    {
      address: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
      dexName: 'spiritswap',
      type: 'uniswap_v2',
      chain: 'fantom',
    },
    {
      address: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a',
      dexName: 'equalizer',
      type: 'solidly',
      chain: 'fantom',
    },
    {
      address: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
      dexName: 'beethoven_x',
      type: 'balancer_v2',
      chain: 'fantom',
      // Note: Beethoven X (Balancer fork) - PoolRegistered event parsed
    },
  ],

  // zkSync Era: 2 factories
  zksync: [
    {
      address: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
      dexName: 'syncswap',
      type: 'uniswap_v2',
      chain: 'zksync',
    },
    {
      address: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
      dexName: 'mute',
      type: 'uniswap_v2',
      chain: 'zksync',
    },
  ],

  // Linea: 2 factories
  linea: [
    {
      address: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
      dexName: 'syncswap',
      type: 'uniswap_v2',
      chain: 'linea',
    },
    {
      address: '0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B',
      dexName: 'velocore',
      type: 'solidly',
      chain: 'linea',
    },
  ],
};

// =============================================================================
// Pre-computed Lookup Maps (Performance Optimization)
// =============================================================================

/**
 * Pre-computed address-to-factory map for O(1) lookups.
 * Keys are lowercase addresses for case-insensitive comparison.
 */
const FACTORY_BY_ADDRESS: Map<string, FactoryConfig> = new Map();

/**
 * Pre-computed factory addresses per chain (cached arrays).
 */
const FACTORY_ADDRESSES_CACHE: Record<string, string[]> = {};

// Initialize lookup maps at module load
for (const [chain, factories] of Object.entries(DEX_FACTORY_REGISTRY)) {
  const addresses: string[] = [];

  for (const factory of factories) {
    const lowerAddress = factory.address.toLowerCase();
    FACTORY_BY_ADDRESS.set(`${chain}:${lowerAddress}`, factory);
    addresses.push(lowerAddress);
  }

  FACTORY_ADDRESSES_CACHE[chain] = addresses;
}

// =============================================================================
// Vault Model DEX Helper (moved before validation to avoid TDZ)
// =============================================================================

/**
 * DEXes that use vault/pool model instead of standard factory pattern.
 * These DEXes have different factory addresses in DEXES config vs the actual
 * vault/pool address used for event subscriptions.
 *
 * - balancer_v2: Uses Vault address for pool registration events
 * - beethoven_x: Balancer V2 fork on Fantom
 * - gmx: Uses Vault address on Avalanche
 * - platypus: Uses Pool address on Avalanche
 */
const VAULT_MODEL_DEXES = new Set(['balancer_v2', 'beethoven_x', 'gmx', 'platypus']);

/**
 * Check if a DEX uses vault/pool model instead of standard factory pattern.
 *
 * @param dexName - DEX identifier
 * @returns true if DEX uses vault model
 */
export function isVaultModelDex(dexName: string): boolean {
  return VAULT_MODEL_DEXES.has(dexName);
}

// =============================================================================
// P2-1: Unified Factory Registry Validation
// Consolidates validateFactoryRegistryAtLoad(), validateFactoryRegistry(),
// and validateFactoryRegistryAtLoadTime() into a single composable validator.
// =============================================================================

/**
 * P2-1 FIX: Unified factory registry validation with composable checks.
 * Replaces three separate validation functions with one configurable implementation.
 *
 * @param options - Validation options to customize which checks run
 * @returns Array of validation errors (empty if valid)
 */
export function validateFactoryRegistryUnified(
  options: FactoryValidationOptions = {}
): FactoryValidationError[] {
  const {
    skip = false,
    checkDexExists = true,
    checkChainMatch = true,
    checkAddressFormat = true,
    checkAddressMatchesDexes = true,
    checkChainExists = true,
  } = options;

  if (skip) {
    return [];
  }

  const errors: FactoryValidationError[] = [];

  for (const [chain, factories] of Object.entries(DEX_FACTORY_REGISTRY)) {
    // Check 1: Chain exists in CHAINS config
    if (checkChainExists && !CHAINS[chain]) {
      errors.push({
        severity: 'critical',
        message: `Factory registry references unknown chain: ${chain}`,
        chain,
        dexName: '*',
      });
      continue; // Can't validate factories for unknown chain
    }

    const chainDexes = DEXES[chain] || [];
    const dexByName = new Map(chainDexes.map(d => [d.name, d]));

    for (const factory of factories) {
      // Check 2: DEX name exists in DEXES config
      const dex = dexByName.get(factory.dexName);
      if (checkDexExists && !dex) {
        errors.push({
          severity: 'critical',
          message: `Factory '${factory.dexName}' not found in DEXES config. ` +
            `Either add DEX to DEXES[${chain}] or remove from DEX_FACTORY_REGISTRY.`,
          chain,
          dexName: factory.dexName,
        });
        continue; // Skip further checks for this factory
      }

      // Check 3: Factory chain field matches registry key
      if (checkChainMatch && factory.chain !== chain) {
        errors.push({
          severity: 'critical',
          message: `Chain mismatch: factory.chain='${factory.chain}' but registry key='${chain}'`,
          chain,
          dexName: factory.dexName,
        });
      }

      // Check 4: Valid Ethereum address format (40 hex chars after 0x)
      if (checkAddressFormat && !/^0x[a-fA-F0-9]{40}$/.test(factory.address)) {
        errors.push({
          severity: 'warning',
          message: `Invalid address format: ${factory.address}`,
          chain,
          dexName: factory.dexName,
        });
      }

      // Check 5: Factory address matches DEXES config (skip for vault-model DEXes)
      if (checkAddressMatchesDexes && dex && !isVaultModelDex(factory.dexName)) {
        if (dex.factoryAddress.toLowerCase() !== factory.address.toLowerCase()) {
          errors.push({
            severity: 'warning',
            message: `Address mismatch: registry=${factory.address}, DEXES=${dex.factoryAddress}`,
            chain,
            dexName: factory.dexName,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * P2-1 FIX: Run validation at module load time.
 * Throws on CRITICAL errors, logs WARNING errors.
 * Private function - called automatically at module load.
 */
function runLoadTimeValidation(): void {
  // Skip in test environment
  if (process.env.NODE_ENV === 'test' ||
      process.env.JEST_WORKER_ID ||
      process.env.SKIP_CONFIG_VALIDATION === 'true') {
    return;
  }

  const errors = validateFactoryRegistryUnified();
  const criticalErrors = errors.filter(e => e.severity === 'critical');
  const warnings = errors.filter(e => e.severity === 'warning');

  // Log warnings (non-blocking)
  for (const warning of warnings) {
    console.warn(`[FACTORY_VALIDATION] Warning: ${warning.message} (${warning.chain}/${warning.dexName})`);
  }

  // Throw on critical errors
  if (criticalErrors.length > 0) {
    const errorMessage = [
      'Factory registry validation failed at load time:',
      ...criticalErrors.map((e, i) => `  ${i + 1}. [${e.chain}/${e.dexName}] ${e.message}`),
      '',
      'Fix these issues to start the service.',
    ].join('\n');

    throw new Error(errorMessage);
  }
}

// Run validation at module load (production only)
runLoadTimeValidation();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get all factory configurations for a chain.
 *
 * @param chain - Chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of FactoryConfig for the chain, empty array if not found
 */
export function getFactoriesForChain(chain: string): FactoryConfig[] {
  return DEX_FACTORY_REGISTRY[chain] || [];
}

/**
 * Get factories that support standard factory events for dynamic pair discovery.
 * Filters out DEXes that use adapters or have non-standard event signatures.
 *
 * ARCHITECTURAL NOTES:
 * - Maverick (Base): Uses custom "boosted positions" event signature
 * - GMX (Avalanche): Uses Vault/GLP model with GmxAdapter
 * - Platypus (Avalanche): Uses "coverage ratio" model with PlatypusAdapter
 *
 * Curve/Ellipsis and Balancer V2/Beethoven X are now fully supported.
 *
 * @param chain - Chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of FactoryConfig for factories that emit parseable events
 */
export function getFactoriesWithEventSupport(chain: string): FactoryConfig[] {
  const factories = getFactoriesForChain(chain);
  return factories.filter(f => f.supportsFactoryEvents !== false);
}

/**
 * Get factory configuration by address.
 * Uses pre-computed map for O(1) lookup.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address (case-insensitive)
 * @returns FactoryConfig if found, undefined otherwise
 */
export function getFactoryByAddress(chain: string, address: string): FactoryConfig | undefined {
  const key = `${chain}:${address.toLowerCase()}`;
  return FACTORY_BY_ADDRESS.get(key);
}

/**
 * Get factory type for an address.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns FactoryType if found, undefined otherwise
 */
export function getFactoryType(chain: string, address: string): FactoryType | undefined {
  return getFactoryByAddress(chain, address)?.type;
}

/**
 * Get ABI for a factory address.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns Factory ABI array if found, undefined otherwise
 */
export function getFactoryAbi(chain: string, address: string): readonly object[] | undefined {
  const factory = getFactoryByAddress(chain, address);
  if (!factory) return undefined;
  return FACTORY_ABIS[factory.type];
}

/**
 * Get all factory addresses for a chain (lowercase).
 * Returns cached array for performance.
 *
 * @param chain - Chain identifier
 * @returns Array of lowercase factory addresses
 */
export function getAllFactoryAddresses(chain: string): string[] {
  return FACTORY_ADDRESSES_CACHE[chain] || [];
}

/**
 * Check if factory uses UniswapV2-style events.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns true if factory is UniswapV2-compatible
 */
export function isUniswapV2Style(chain: string, address: string): boolean {
  const type = getFactoryType(chain, address);
  return type === 'uniswap_v2';
}

// =============================================================================
// P2-15: Factory Type Checker Factory Function
// Eliminates duplicated pattern across isUniswapV2Style, isUniswapV3Style, etc.
// =============================================================================

/**
 * P2-15 FIX: Factory function that creates type checkers for any FactoryType.
 * Eliminates the duplicated pattern where each style checker does the same thing.
 *
 * @param targetType - The FactoryType to check for
 * @returns A function that checks if a factory is of the given type
 *
 * @example
 * const isUniswapV2 = createFactoryTypeChecker('uniswap_v2');
 * if (isUniswapV2('arbitrum', '0x...')) { ... }
 */
export function createFactoryTypeChecker(targetType: FactoryType): (chain: string, address: string) => boolean {
  return (chain: string, address: string): boolean => {
    const type = getFactoryType(chain, address);
    return type === targetType;
  };
}

/**
 * P2-15 FIX: Overloaded version that accepts FactoryReference.
 *
 * @param targetType - The FactoryType to check for
 * @param ref - FactoryReference containing chain and address
 * @returns true if factory matches the target type
 */
export function isFactoryType(targetType: FactoryType, ref: FactoryReference): boolean;
export function isFactoryType(targetType: FactoryType, chain: string, address: string): boolean;
export function isFactoryType(
  targetType: FactoryType,
  chainOrRef: string | FactoryReference,
  address?: string
): boolean {
  if (typeof chainOrRef === 'object') {
    return getFactoryType(chainOrRef.chain, chainOrRef.address) === targetType;
  }
  return getFactoryType(chainOrRef, address!) === targetType;
}

/**
 * Check if factory uses UniswapV3-style events.
 * Note: Algebra-based DEXes have similar concentrated liquidity but different events.
 * Use isAlgebraStyle() for Algebra-specific factories.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns true if factory is UniswapV3-compatible (standard V3 event signature)
 */
export function isUniswapV3Style(chain: string, address: string): boolean {
  return isFactoryType('uniswap_v3', chain, address);
}

/**
 * Check if factory uses Algebra-style events (QuickSwap V3, Camelot).
 * Algebra uses different event signature than standard V3: Pool(token0, token1, pool)
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns true if factory is Algebra-based
 */
export function isAlgebraStyle(chain: string, address: string): boolean {
  return isFactoryType('algebra', chain, address);
}

/**
 * Check if factory uses Solidly/ve(3,3)-style events.
 *
 * @param chain - Chain identifier
 * @param address - Factory contract address
 * @returns true if factory is Solidly-compatible
 */
export function isSolidlyStyle(chain: string, address: string): boolean {
  return isFactoryType('solidly', chain, address);
}

/**
 * Get factories grouped by type for a chain.
 * Useful for batch subscription setup.
 *
 * @param chain - Chain identifier
 * @returns Map of FactoryType to FactoryConfig arrays
 */
export function getFactoriesByType(chain: string): Map<FactoryType, FactoryConfig[]> {
  const factories = getFactoriesForChain(chain);
  const byType = new Map<FactoryType, FactoryConfig[]>();

  for (const factory of factories) {
    const existing = byType.get(factory.type) || [];
    existing.push(factory);
    byType.set(factory.type, existing);
  }

  return byType;
}

/**
 * Validate factory registry consistency with DEXES config.
 * Used for testing and debugging.
 *
 * P2-1 FIX: Now delegates to unified validateFactoryRegistryUnified() for consistency.
 * This is a backward-compatible wrapper that returns string[] format.
 *
 * Validation rules:
 * 1. Each factory must have a corresponding DEX in DEXES config
 * 2. Factory address must be valid Ethereum address format
 * 3. Factory chain field must match the registry key
 * 4. Non-vault DEXes should have matching factory addresses
 *
 * @returns Array of validation errors (empty if valid)
 */
export function validateFactoryRegistry(): string[] {
  // P2-1 FIX: Delegate to unified validator and convert to string[] for backward compatibility
  const structuredErrors = validateFactoryRegistryUnified();
  return structuredErrors.map(e => `[${e.chain}/${e.dexName}] ${e.message}`);
}

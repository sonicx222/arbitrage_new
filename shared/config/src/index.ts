// Shared configuration for the arbitrage system
// Updated: 2025-01-10 - Phase 1 expansion (7 chains, 25 DEXs, 60 tokens)
import { Chain, Dex, Token } from '../../types';

// Validate required environment variables at startup (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  if (!process.env.ETHEREUM_RPC_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_RPC_URL environment variable is required');
  }
  if (!process.env.ETHEREUM_WS_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_WS_URL environment variable is required');
  }
}

// =============================================================================
// CHAIN CONFIGURATIONS - Phase 1: 7 Chains
// Priority: T1 (Arbitrum, BSC, Base), T2 (Polygon, Optimism), T3 (Ethereum)
// =============================================================================
export const CHAINS: Record<string, Chain> = {
  // T1: Highest arbitrage potential
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    wsUrl: process.env.ARBITRUM_WS_URL || 'wss://arb1.arbitrum.io/feed',
    blockTime: 0.25,
    nativeToken: 'ETH'
  },
  bsc: {
    id: 56,
    name: 'BSC',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
    wsUrl: process.env.BSC_WS_URL || 'wss://bsc-ws-node.nariox.org:443',
    blockTime: 3,
    nativeToken: 'BNB'
  },
  base: {
    id: 8453,
    name: 'Base',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    wsUrl: process.env.BASE_WS_URL || 'wss://mainnet.base.org',
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T2: High value, mature ecosystems
  polygon: {
    id: 137,
    name: 'Polygon',
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    wsUrl: process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com',
    blockTime: 2,
    nativeToken: 'MATIC'
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://opt-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_OPTIMISM_KEY || ''),
    wsUrl: process.env.OPTIMISM_WS_URL || 'wss://opt-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_OPTIMISM_KEY || ''),
    wsFallbackUrls: [
      'wss://mainnet.optimism.io',
      'wss://optimism.publicnode.com',
      'wss://optimism-mainnet.public.blastapi.io'
    ],
    rpcFallbackUrls: [
      'https://mainnet.optimism.io',
      'https://optimism.publicnode.com',
      'https://optimism-mainnet.public.blastapi.io'
    ],
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T3: Selective - only large opportunities
  ethereum: {
    id: 1,
    name: 'Ethereum',
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    wsUrl: process.env.ETHEREUM_WS_URL || 'wss://eth.llamarpc.com',
    blockTime: 12,
    nativeToken: 'ETH'
  }
};

// =============================================================================
// DEX CONFIGURATIONS - 33 DEXs (S2.2.1: Arbitrum 6→9, S2.2.2: Base 5→7, S2.2.3: BSC 5→8)
// [C] = Critical, [H] = High Priority, [M] = Medium Priority
// =============================================================================
export const DEXES: Record<string, Dex[]> = {
  // Arbitrum: 9 DEXs (highest fragmentation) - S2.2.1 expanded
  arbitrum: [
    {
      name: 'uniswap_v3',       // [C]
      chain: 'arbitrum',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      fee: 30
    },
    {
      name: 'camelot_v3',       // [C]
      chain: 'arbitrum',
      factoryAddress: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B',
      routerAddress: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
      fee: 30
    },
    {
      name: 'sushiswap',        // [C]
      chain: 'arbitrum',
      factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      fee: 30
    },
    {
      name: 'trader_joe',       // [H]
      chain: 'arbitrum',
      factoryAddress: '0x1886D09C9Ade0c5DB822D85D21678Db67B6c2982',
      routerAddress: '0xbeE5c10Cf6E4F68f831E11C1D9E59B43560B3571',
      fee: 30
    },
    {
      name: 'zyberswap',        // [M]
      chain: 'arbitrum',
      factoryAddress: '0xAC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
      routerAddress: '0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad',
      fee: 30
    },
    {
      name: 'ramses',           // [M]
      chain: 'arbitrum',
      factoryAddress: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
      routerAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
      fee: 30
    },
    // === S2.2.1: New DEXs (6 → 9) ===
    {
      name: 'balancer_v2',      // [H] - Major liquidity protocol
      chain: 'arbitrum',
      factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault
      routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Vault is also router for swaps
      fee: 30  // Variable fees per pool, using default
    },
    {
      name: 'curve',            // [H] - Major stablecoin DEX
      chain: 'arbitrum',
      factoryAddress: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031', // Curve Factory
      routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',  // Curve Router
      fee: 4   // 0.04% typical for stablecoin pools
    },
    {
      name: 'chronos',          // [M] - ve(3,3) DEX
      chain: 'arbitrum',
      factoryAddress: '0xCe9240869391928253Ed9cc9Bcb8cB98CB5B0722', // Chronos Factory
      routerAddress: '0xE708aA9E887980750C040a6A2Cb901c37Aa34f3b',  // Chronos Router
      fee: 30
    }
  ],
  // BSC: 8 DEXs (highest volume) - S2.2.3 expanded from 5 → 8
  bsc: [
    {
      name: 'pancakeswap_v3',   // [C]
      chain: 'bsc',
      factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      routerAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
      fee: 25
    },
    {
      name: 'pancakeswap_v2',   // [C]
      chain: 'bsc',
      factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      fee: 25
    },
    {
      name: 'biswap',           // [C]
      chain: 'bsc',
      factoryAddress: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
      routerAddress: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
      fee: 10
    },
    {
      name: 'thena',            // [H]
      chain: 'bsc',
      factoryAddress: '0xAFD89d21BdB66d00817d4153E055830B1c2B3970',
      routerAddress: '0x20a304a7d126758dfe6B243D0fc515F83bCA8431',
      fee: 20
    },
    {
      name: 'apeswap',          // [H]
      chain: 'bsc',
      factoryAddress: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
      routerAddress: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
      fee: 20
    },
    // === S2.2.3: New DEXs (5 → 8) ===
    {
      name: 'mdex',             // [H] - Major BSC/HECO DEX
      chain: 'bsc',
      factoryAddress: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
      routerAddress: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
      fee: 30
    },
    {
      name: 'ellipsis',         // [H] - Curve fork for stablecoins (low fees)
      chain: 'bsc',
      factoryAddress: '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870',
      routerAddress: '0x160CAed03795365F3A589f10C379FfA7d75d4E76',
      fee: 4   // 0.04% typical for stablecoin pools
    },
    {
      name: 'nomiswap',         // [M] - Competitive fees
      chain: 'bsc',
      factoryAddress: '0xd6715A8be3944ec72738F0BFDC739571659D8010',
      routerAddress: '0xD654953D746f0b114d1F85332Dc43446ac79413d',
      fee: 10  // 0.1% competitive fee
    }
  ],
  // Base: 7 DEXs (fastest growing) - S2.2.2 expanded from 5 → 7
  base: [
    {
      name: 'uniswap_v3',       // [C]
      chain: 'base',
      factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FdFD',
      routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
      fee: 30
    },
    {
      name: 'aerodrome',        // [C]
      chain: 'base',
      factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      routerAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      fee: 30
    },
    {
      name: 'baseswap',         // [C]
      chain: 'base',
      factoryAddress: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
      routerAddress: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
      fee: 30
    },
    {
      name: 'sushiswap',        // [H]
      chain: 'base',
      factoryAddress: '0x71524B4f93c58fcbF659783284E38825f0622859',
      routerAddress: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
      fee: 30
    },
    {
      name: 'swapbased',        // [M]
      chain: 'base',
      factoryAddress: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
      routerAddress: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
      fee: 30
    },
    // S2.2.2: New DEXs added (5 → 7)
    {
      name: 'maverick',         // [H] - Dynamic fee AMM
      chain: 'base',
      factoryAddress: '0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1E',
      routerAddress: '0x32AED3Bce901DA12ca8F29D3E95Fc3cc54A85fd9',
      fee: 1  // 1 bp base fee (dynamic)
    },
    {
      name: 'alienbase',        // [M] - Native Base DEX
      chain: 'base',
      factoryAddress: '0x3E84D913803b02A4a7f027165E8cA42C14c0FDe7',
      routerAddress: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
      fee: 30
    }
  ],
  // Polygon: 4 DEXs (low gas)
  polygon: [
    {
      name: 'uniswap_v3',       // [C]
      chain: 'polygon',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      fee: 30
    },
    {
      name: 'quickswap_v3',     // [C]
      chain: 'polygon',
      factoryAddress: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28',
      routerAddress: '0xf5b509bB0909a69B1c207E495f687a596C168E12',
      fee: 30
    },
    {
      name: 'sushiswap',        // [H]
      chain: 'polygon',
      factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      fee: 30
    },
    {
      name: 'apeswap',          // [M]
      chain: 'polygon',
      factoryAddress: '0xCf083Be4164828f00cAE704EC15a36D711491284',
      routerAddress: '0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',
      fee: 20
    }
  ],
  // Optimism: 3 DEXs (NEW - Phase 1)
  optimism: [
    {
      name: 'uniswap_v3',       // [C]
      chain: 'optimism',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      fee: 30
    },
    {
      name: 'velodrome',        // [C]
      chain: 'optimism',
      factoryAddress: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746',
      routerAddress: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
      fee: 30
    },
    {
      name: 'sushiswap',        // [H]
      chain: 'optimism',
      factoryAddress: '0xFbc12984689e5f15626Bad03Ad60160Fe98B303C',
      routerAddress: '0x4C5D5234f232BD2D76B96aA33F5AE4FCF0E4BFAb',
      fee: 30
    }
  ],
  // Ethereum: 2 DEXs (selective - large arbs only)
  ethereum: [
    {
      name: 'uniswap_v3',       // [C]
      chain: 'ethereum',
      factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      fee: 30
    },
    {
      name: 'sushiswap',        // [C]
      chain: 'ethereum',
      factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      fee: 30
    }
  ]
};

// =============================================================================
// TOKEN CONFIGURATIONS - Phase 1: 60 Tokens
// Categories: Anchor (native, stables), Core DeFi, Chain Governance, High-Volume
// =============================================================================
export const CORE_TOKENS: Record<string, Token[]> = {
  // Arbitrum: 12 tokens
  arbitrum: [
    // Anchor tokens
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18, chainId: 42161 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6, chainId: 42161 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18, chainId: 42161 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8, chainId: 42161 },
    // Chain governance
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18, chainId: 42161 },
    // Core DeFi
    { address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', symbol: 'UNI', decimals: 18, chainId: 42161 },
    { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', symbol: 'LINK', decimals: 18, chainId: 42161 },
    { address: '0x6C2C06790b3E3E3c38e12Ee22F8183b37a13EE55', symbol: 'DPX', decimals: 18, chainId: 42161 },
    { address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342', symbol: 'MAGIC', decimals: 18, chainId: 42161 },
    // High-volume
    { address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', symbol: 'GMX', decimals: 18, chainId: 42161 },
    { address: '0x5979D7b546E38E414F7E9822514be443A4800529', symbol: 'wstETH', decimals: 18, chainId: 42161 }
  ],
  // BSC: 10 tokens
  bsc: [
    // Anchor tokens
    { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18, chainId: 56 },
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18, chainId: 56 },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18, chainId: 56 },
    { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18, chainId: 56 },
    { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB', decimals: 18, chainId: 56 },
    // Bridged ETH
    { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', decimals: 18, chainId: 56 },
    // Core DeFi
    { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE', decimals: 18, chainId: 56 },
    { address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', symbol: 'LINK', decimals: 18, chainId: 56 },
    // High-volume
    { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', symbol: 'XRP', decimals: 18, chainId: 56 },
    { address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', symbol: 'ADA', decimals: 18, chainId: 56 }
  ],
  // Base: 10 tokens
  base: [
    // Anchor tokens
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 8453 },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, chainId: 8453 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18, chainId: 8453 },
    // Bridged BTC
    { address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', symbol: 'tBTC', decimals: 18, chainId: 8453 },
    // LST tokens
    { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', decimals: 18, chainId: 8453 },
    { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', decimals: 18, chainId: 8453 },
    // Core DeFi
    { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', decimals: 18, chainId: 8453 },
    // High-volume meme
    { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', decimals: 18, chainId: 8453 },
    { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI', decimals: 18, chainId: 8453 },
    { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL', decimals: 18, chainId: 8453 }
  ],
  // Polygon: 10 tokens
  polygon: [
    // Anchor tokens
    { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18, chainId: 137 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6, chainId: 137 },
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6, chainId: 137 },
    { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18, chainId: 137 },
    { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', decimals: 8, chainId: 137 },
    // Bridged ETH
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18, chainId: 137 },
    // Core DeFi
    { address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', symbol: 'LINK', decimals: 18, chainId: 137 },
    { address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', symbol: 'AAVE', decimals: 18, chainId: 137 },
    // High-volume
    { address: '0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b', symbol: 'AVAX', decimals: 18, chainId: 137 },
    { address: '0xB0B195aEFA3650A6908f15CdaC7D92F8a5791B0B', symbol: 'BOB', decimals: 18, chainId: 137 }
  ],
  // Optimism: 10 tokens (NEW - Phase 1)
  optimism: [
    // Anchor tokens
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 10 },
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6, chainId: 10 },
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6, chainId: 10 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18, chainId: 10 },
    { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', symbol: 'WBTC', decimals: 8, chainId: 10 },
    // Chain governance
    { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18, chainId: 10 },
    // LST tokens
    { address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', symbol: 'wstETH', decimals: 18, chainId: 10 },
    // Core DeFi
    { address: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', symbol: 'LINK', decimals: 18, chainId: 10 },
    { address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', symbol: 'PERP', decimals: 18, chainId: 10 },
    { address: '0x3c8B650257cFb5f272f799F5e2b4e65093a11a05', symbol: 'VELO', decimals: 18, chainId: 10 }
  ],
  // Ethereum: 8 tokens (selective - large arbs only)
  ethereum: [
    // Anchor tokens
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, chainId: 1 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, chainId: 1 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, chainId: 1 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, chainId: 1 },
    // LST tokens (high volume)
    { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18, chainId: 1 },
    { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18, chainId: 1 },
    // Core DeFi
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18, chainId: 1 },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18, chainId: 1 }
  ]
};

// =============================================================================
// SERVICE CONFIGURATIONS
// =============================================================================
export const SERVICE_CONFIGS = {
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD
  },
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    interval: parseInt(process.env.MONITORING_INTERVAL || '30000'),
    endpoints: (process.env.MONITORING_ENDPOINTS || '').split(',')
  }
};

// =============================================================================
// PERFORMANCE THRESHOLDS
// =============================================================================
export const PERFORMANCE_THRESHOLDS = {
  maxEventLatency: 50, // ms - target for Phase 3
  minCacheHitRate: 0.9, // 90%
  maxMemoryUsage: 400 * 1024 * 1024, // 400MB
  maxCpuUsage: 80, // %
  maxFalsePositiveRate: 0.05 // 5%
};

// =============================================================================
// ARBITRAGE DETECTION PARAMETERS
// =============================================================================
export const ARBITRAGE_CONFIG = {
  minProfitPercentage: 0.003, // 0.3%
  maxGasPrice: 50000000000, // 50 gwei
  confidenceThreshold: 0.75,
  maxTradeSize: '1000000000000000000', // 1 ETH equivalent
  triangularEnabled: true,
  crossChainEnabled: false, // Enable in Phase 2
  predictiveEnabled: false, // Enable in Phase 3
  // Additional config properties for opportunity calculation
  defaultAmount: 1000, // Default trade amount in USD
  estimatedGasCost: 5, // Estimated gas cost in USD
  opportunityTimeoutMs: 30000, // 30 seconds
  minProfitThreshold: 10, // Minimum $10 net profit
  minConfidenceThreshold: 0.7, // Minimum 70% confidence
  feePercentage: 0.003, // 0.3% DEX trading fee
  // Chain-specific minimum profits (due to gas costs)
  chainMinProfits: {
    ethereum: 0.005,   // 0.5% - higher due to gas
    arbitrum: 0.002,   // 0.2% - low gas
    optimism: 0.002,   // 0.2% - low gas
    base: 0.002,       // 0.2% - low gas
    polygon: 0.002,    // 0.2% - low gas
    bsc: 0.003         // 0.3% - moderate gas
  }
};

// =============================================================================
// EVENT MONITORING CONFIGURATION
// =============================================================================
export const EVENT_CONFIG = {
  syncEvents: {
    enabled: true,
    priority: 'high'
  },
  swapEvents: {
    enabled: true,
    priority: 'medium',
    minAmountUSD: 10000,    // $10K minimum for processing
    whaleThreshold: 50000,  // $50K for whale alerts
    samplingRate: 0.01      // 1% sampling for <$10K swaps
  }
};

// =============================================================================
// PARTITION CONFIGURATION
// Aligns with ADR-003 and ADR-008
// =============================================================================
export const PARTITION_CONFIG = {
  P1_ASIA_FAST: ['bsc', 'polygon'],           // Phase 1
  P2_L2_TURBO: ['arbitrum', 'optimism', 'base'], // Phase 1
  P3_HIGH_VALUE: ['ethereum'],                 // Phase 1
  // Future phases
  P1_ASIA_FAST_PHASE2: ['bsc', 'polygon', 'avalanche', 'fantom'],
  P3_HIGH_VALUE_PHASE3: ['ethereum', 'zksync', 'linea']
};

// =============================================================================
// PHASE METRICS
// Track progress against targets from ADR-008
// =============================================================================
export const PHASE_METRICS = {
  current: {
    phase: 1,
    chains: Object.keys(CHAINS).length,
    dexes: Object.values(DEXES).flat().length,
    tokens: Object.values(CORE_TOKENS).flat().length,
    targetOpportunities: 300
  },
  targets: {
    // Phase 1 targets updated after S2.2 DEX expansion:
    // S2.2.1: Arbitrum 6→9 (+3), S2.2.2: Base 5→7 (+2), S2.2.3: BSC 5→8 (+3)
    // Original 25 + 8 = 33 DEXs when S2.2 completes
    phase1: { chains: 7, dexes: 33, tokens: 60, opportunities: 300 },
    phase2: { chains: 9, dexes: 45, tokens: 110, opportunities: 550 },
    phase3: { chains: 10, dexes: 55, tokens: 150, opportunities: 780 }
  }
};

// =============================================================================
// TOKEN METADATA - Chain-specific token addresses and categories
// Used for USD value estimation and price calculations
// =============================================================================
export const TOKEN_METADATA: Record<string, {
  weth: string;
  stablecoins: { address: string; symbol: string; decimals: number }[];
  nativeWrapper: string;
}> = {
  optimism: {
    weth: '0x4200000000000000000000000000000000000006',
    nativeWrapper: '0x4200000000000000000000000000000000000006',
    stablecoins: [
      { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
      { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
      { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
    ]
  },
  arbitrum: {
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    nativeWrapper: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    stablecoins: [
      { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
      { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
      { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
    ]
  },
  bsc: {
    weth: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH on BSC
    nativeWrapper: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    stablecoins: [
      { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
      { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
      { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18 }
    ]
  },
  base: {
    weth: '0x4200000000000000000000000000000000000006',
    nativeWrapper: '0x4200000000000000000000000000000000000006',
    stablecoins: [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', decimals: 6 }, // Bridged USDC
      { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 }
    ]
  },
  polygon: {
    weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    nativeWrapper: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
    stablecoins: [
      { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
      { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
      { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18 }
    ]
  },
  ethereum: {
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    nativeWrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    stablecoins: [
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
    ]
  }
};

// =============================================================================
// EVENT SIGNATURES - Pre-computed for performance
// =============================================================================
export const EVENT_SIGNATURES = {
  // Uniswap V2 / SushiSwap style
  SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  // Alternative signatures for different DEX implementations
  SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
};

// =============================================================================
// DEX HELPER FUNCTIONS
// Standardize DEX access patterns across the codebase
// =============================================================================

/**
 * Get enabled DEXs for a chain.
 * Filters out DEXs with enabled === false (enabled defaults to true if not specified).
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of enabled Dex objects for the chain
 */
export function getEnabledDexes(chainId: string): Dex[] {
  const chainDexes = DEXES[chainId as keyof typeof DEXES];
  if (!chainDexes) return [];
  return chainDexes.filter(dex => dex.enabled !== false);
}

/**
 * Convert DEX fee from basis points to percentage.
 * Config stores fees in basis points (e.g., 30 = 0.30%), calculations use percentage.
 *
 * @param feeBasisPoints - Fee in basis points (e.g., 30 for 0.30%)
 * @returns Fee as a decimal percentage (e.g., 0.003 for 0.30%)
 */
export function dexFeeToPercentage(feeBasisPoints: number): number {
  return feeBasisPoints / 10000;
}

/**
 * Convert percentage to basis points.
 * Inverse of dexFeeToPercentage.
 *
 * @param percentage - Fee as decimal (e.g., 0.003 for 0.30%)
 * @returns Fee in basis points (e.g., 30 for 0.30%)
 */
export function percentageToBasisPoints(percentage: number): number {
  return Math.round(percentage * 10000);
}

// =============================================================================
// DETECTOR CONFIGURATION - Chain-specific detector settings
// Consolidates hardcoded values from individual detector implementations
// =============================================================================
export interface DetectorChainConfig {
  // Batching configuration
  batchSize: number;
  batchTimeout: number;
  healthCheckInterval: number;
  // Arbitrage detection
  confidence: number;           // Opportunity confidence score (0-1)
  expiryMs: number;             // Opportunity expiry in milliseconds
  gasEstimate: number;          // Estimated gas for swap execution
  // Whale detection
  whaleThreshold: number;       // USD value threshold for whale alerts
  // Token metadata key for native token
  nativeTokenKey: 'weth' | 'nativeWrapper';
}

export const DETECTOR_CONFIG: Record<string, DetectorChainConfig> = {
  ethereum: {
    batchSize: 15,              // Lower batch size for 12s blocks
    batchTimeout: 50,
    healthCheckInterval: 30000,
    confidence: 0.75,           // Lower due to higher gas variability
    expiryMs: 15000,            // 15s (longer for slow blocks)
    gasEstimate: 250000,        // Higher gas on mainnet
    whaleThreshold: 100000,     // $100K (higher due to gas costs)
    nativeTokenKey: 'weth'
  },
  arbitrum: {
    batchSize: 30,              // Higher batch size for ultra-fast 250ms blocks
    batchTimeout: 20,           // Lower timeout for faster processing
    healthCheckInterval: 15000, // More frequent health checks
    confidence: 0.85,           // Higher due to ultra-fast processing
    expiryMs: 5000,             // 5s (faster for quick blocks)
    gasEstimate: 50000,         // Very low gas on Arbitrum
    whaleThreshold: 25000,      // $25K (lower threshold for L2)
    nativeTokenKey: 'weth'
  },
  optimism: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 100000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  base: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 100000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  polygon: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 150000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'      // WETH on Polygon, not WMATIC for USD calc
  },
  bsc: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 200000,
    whaleThreshold: 50000,      // $50K (moderate threshold)
    nativeTokenKey: 'nativeWrapper'  // WBNB for USD calc
  }
};

// =============================================================================
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================
export const FLASH_LOAN_PROVIDERS: Record<string, {
  address: string;
  protocol: string;
  fee: number;  // Basis points (100 = 1%)
}> = {
  // Aave V3 Pool addresses - https://docs.aave.com/developers/deployed-contracts
  ethereum: {
    address: '0x87870Bcd2C4c2e84A8c3C3a3FcACC94666c0d6Cf',
    protocol: 'aave_v3',
    fee: 9  // 0.09% flash loan fee
  },
  polygon: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  arbitrum: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  base: {
    address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    protocol: 'aave_v3',
    fee: 9
  },
  optimism: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  // BSC uses Pancakeswap flash loans (no Aave V3)
  bsc: {
    address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',  // PancakeSwap V3 Router
    protocol: 'pancakeswap_v3',
    fee: 25  // 0.25% flash swap fee
  }
};

// =============================================================================
// BRIDGE COST CONFIGURATION (P1-5 FIX)
// =============================================================================

/**
 * P1-5 FIX: Bridge cost configuration to replace hardcoded multipliers.
 * Fees are in basis points (1 bp = 0.01%). Latency in seconds.
 *
 * Data sources:
 * - Stargate: https://stargate.finance/bridge (fees vary by route)
 * - Across: https://across.to/ (dynamic fees)
 * - LayerZero: https://layerzero.network/ (gas-dependent fees)
 *
 * Note: These are baseline estimates. Production should use real-time API data.
 */
export interface BridgeCostConfig {
  bridge: string;
  sourceChain: string;
  targetChain: string;
  feePercentage: number;  // In percentage (e.g., 0.06 = 0.06%)
  minFeeUsd: number;      // Minimum fee in USD
  estimatedLatencySeconds: number;
  reliability: number;    // 0-1 scale
}

export const BRIDGE_COSTS: BridgeCostConfig[] = [
  // Stargate (LayerZero) - Good for stablecoins
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'bsc', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // Across Protocol - Fast with relayer model
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.04, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'optimism', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'base', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },

  // Native bridges (L2 -> L1 are slower)
  { bridge: 'native', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'optimism', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'base', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
];

/**
 * P1-5 FIX: Get bridge cost for a specific route
 */
export function getBridgeCost(
  sourceChain: string,
  targetChain: string,
  bridge?: string
): BridgeCostConfig | undefined {
  const normalizedSource = sourceChain.toLowerCase();
  const normalizedTarget = targetChain.toLowerCase();

  if (bridge) {
    return BRIDGE_COSTS.find(
      b => b.sourceChain === normalizedSource &&
           b.targetChain === normalizedTarget &&
           b.bridge === bridge.toLowerCase()
    );
  }

  // Find best bridge (lowest fee)
  const options = BRIDGE_COSTS.filter(
    b => b.sourceChain === normalizedSource && b.targetChain === normalizedTarget
  );

  if (options.length === 0) return undefined;

  return options.reduce((best, current) =>
    current.feePercentage < best.feePercentage ? current : best
  );
}

/**
 * P1-5 FIX: Calculate bridge cost for a given USD amount
 */
export function calculateBridgeCostUsd(
  sourceChain: string,
  targetChain: string,
  amountUsd: number,
  bridge?: string
): { fee: number; latency: number; bridge: string } | undefined {
  const config = getBridgeCost(sourceChain, targetChain, bridge);
  if (!config) return undefined;

  const percentageFee = amountUsd * (config.feePercentage / 100);
  const fee = Math.max(percentageFee, config.minFeeUsd);

  return {
    fee,
    latency: config.estimatedLatencySeconds,
    bridge: config.bridge
  };
}

// =============================================================================
// SYSTEM CONSTANTS (P2-2-FIX)
// Centralized configuration to eliminate magic numbers across the codebase
// =============================================================================
export const SYSTEM_CONSTANTS = {
  // Redis configuration
  redis: {
    /** Maximum message size in bytes for Redis pub/sub (1MB) */
    maxMessageSize: 1024 * 1024,
    /** Maximum channel name length */
    maxChannelNameLength: 128,
    /** Default SCAN batch size for iterating keys */
    scanBatchSize: 100,
    /** Default TTL for health data in seconds */
    healthDataTtl: 300,
    /** Default TTL for metrics data in seconds */
    metricsDataTtl: 86400,
    /** Maximum rolling metrics entries */
    maxRollingMetrics: 100,
    /** Disconnect timeout in milliseconds */
    disconnectTimeout: 5000,
  },

  // Cache configuration
  cache: {
    /** Average entry size estimate in bytes for L1 capacity calculation */
    averageEntrySize: 1024,
    /** Default L1 cache size in MB */
    defaultL1SizeMb: 64,
    /** Default L2 TTL in seconds */
    defaultL2TtlSeconds: 300,
    /** Auto-demotion threshold in milliseconds */
    demotionThresholdMs: 5 * 60 * 1000,
    /** Minimum access count before demotion */
    minAccessCountBeforeDemotion: 3,
  },

  // Self-healing configuration
  selfHealing: {
    /** Circuit breaker recovery cooldown in milliseconds */
    circuitBreakerCooldownMs: 60000,
    /** Health check failure threshold before recovery */
    healthCheckFailureThreshold: 3,
    /** Graceful degradation failure threshold */
    gracefulDegradationThreshold: 10,
    /** Maximum restart delay in milliseconds */
    maxRestartDelayMs: 300000,
    /** Simulated restart delay for testing in milliseconds */
    simulatedRestartDelayMs: 2000,
    /** Simulated restart failure rate (0-1) */
    simulatedRestartFailureRate: 0.2,
  },

  // WebSocket configuration
  webSocket: {
    /** Default reconnect delay in milliseconds */
    defaultReconnectDelayMs: 1000,
    /** Maximum reconnect delay in milliseconds */
    maxReconnectDelayMs: 30000,
    /** Reconnect backoff multiplier */
    reconnectBackoffMultiplier: 2,
    /** Maximum reconnect attempts */
    maxReconnectAttempts: 10,
    /** Connection timeout in milliseconds */
    connectionTimeoutMs: 10000,
  },

  // Circuit breaker configuration
  circuitBreaker: {
    /** Default failure threshold */
    defaultFailureThreshold: 3,
    /** Default recovery timeout in milliseconds */
    defaultRecoveryTimeoutMs: 30000,
    /** Default monitoring period in milliseconds */
    defaultMonitoringPeriodMs: 60000,
    /** Default success threshold for closing */
    defaultSuccessThreshold: 2,
  },
};

// =============================================================================
// PARTITION EXPORTS (ADR-003)
// =============================================================================
export * from './partitions';

// Named re-exports for ADR-003 compliance tests
export {
  PARTITIONS,
  PartitionConfig,
  getPartition,
  getPartitionFromEnv,
  assignChainToPartition
} from './partitions';

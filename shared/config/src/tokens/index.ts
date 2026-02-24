/**
 * Token Configurations
 *
 * Contains all token configurations per chain including:
 * - CORE_TOKENS: Primary tokens for arbitrage detection
 * - TOKEN_METADATA: Chain-specific token addresses for USD estimation
 *
 * Categories: Anchor (native, stables), Core DeFi, Chain Governance, High-Volume
 * Total: 122 tokens across 15 chains
 *
 * @see S3.1.2: New chain tokens
 * @see S3.2.1: Avalanche token expansion
 * @see S3.3.3: Solana token expansion
 */

import { Token } from '../../../types';

// =============================================================================
// TOKEN CONFIGURATIONS - 122 Tokens
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
    // LST/LRT tokens — Phase 0 Item 2: expanded for LST arbitrage surface
    { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18, chainId: 1 },
    { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18, chainId: 1 },
    { address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', symbol: 'cbETH', decimals: 18, chainId: 1 },
    { address: '0xac3E018457B222d93114458476f3E3416Abbe38F', symbol: 'sfrxETH', decimals: 18, chainId: 1 }, // FIX: Corrected from Fraxtal chain address to Ethereum mainnet sfrxETH
    // Core DeFi
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18, chainId: 1 },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18, chainId: 1 }
  ],
  // =============================================================================
  // S3.1.2: New Chain Tokens for 4-Partition Architecture
  // S3.2.1: Expanded Avalanche Tokens (15 total)
  // =============================================================================
  // Avalanche: 15 tokens
  avalanche: [
    // Anchor tokens
    { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX', decimals: 18, chainId: 43114 },
    { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', decimals: 6, chainId: 43114 },
    { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6, chainId: 43114 },
    { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', symbol: 'DAI', decimals: 18, chainId: 43114 },
    // Bridged BTC
    { address: '0x50b7545627a5162F82A992c33b87aDc75187B218', symbol: 'WBTC.e', decimals: 8, chainId: 43114 },
    // Bridged ETH
    { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', symbol: 'WETH.e', decimals: 18, chainId: 43114 },
    // Core DeFi
    { address: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', symbol: 'JOE', decimals: 18, chainId: 43114 },
    { address: '0x5947BB275c521040051D82396192181b413227A3', symbol: 'LINK', decimals: 18, chainId: 43114 },
    // S3.2.1: New tokens added
    { address: '0x63a72806098Bd3D9520cC43356dD78afe5D386D9', symbol: 'AAVE', decimals: 18, chainId: 43114 },
    { address: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', symbol: 'sAVAX', decimals: 18, chainId: 43114 }, // Staked AVAX (Benqi)
    { address: '0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5', symbol: 'QI', decimals: 18, chainId: 43114 },    // BENQI token
    { address: '0x60781C2586D68229fde47564546784ab3fACA982', symbol: 'PNG', decimals: 18, chainId: 43114 },   // Pangolin token
    { address: '0x22d4002028f537599bE9f666d1c4Fa138522f9c8', symbol: 'PTP', decimals: 18, chainId: 43114 },   // Platypus token
    { address: '0x62edc0692BD897D2295872a9FFCac5425011c661', symbol: 'GMX', decimals: 18, chainId: 43114 },   // GMX token
    { address: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64', symbol: 'FRAX', decimals: 18, chainId: 43114 }   // Frax stablecoin
  ],
  // Fantom: 10 tokens (S3.2.2)
  fantom: [
    // Anchor tokens
    { address: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', symbol: 'WFTM', decimals: 18, chainId: 250 },
    { address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A', symbol: 'fUSDT', decimals: 6, chainId: 250 },
    { address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', symbol: 'USDC', decimals: 6, chainId: 250 },
    { address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', symbol: 'DAI', decimals: 18, chainId: 250 },
    // Bridged tokens
    { address: '0x74b23882a30290451A17c44f4F05243b6b58C76d', symbol: 'WETH', decimals: 18, chainId: 250 },
    { address: '0x321162Cd933E2Be498Cd2267a90534A804051b11', symbol: 'WBTC', decimals: 8, chainId: 250 },
    // DEX governance tokens (S3.2.2)
    { address: '0x841FAD6EAe12c286d1Fd18d1d525DFfA75C7EFFE', symbol: 'BOO', decimals: 18, chainId: 250 },    // SpookySwap
    { address: '0x5Cc61A78F164885776AA610fb0FE1257df78E59B', symbol: 'SPIRIT', decimals: 18, chainId: 250 }, // SpiritSwap
    { address: '0x3Fd3A0c85B70754eFc07aC9Ac0cbBDCe664865A6', symbol: 'EQUAL', decimals: 18, chainId: 250 },  // Equalizer
    { address: '0xF24Bcf4d1e507740041C9cFd2DddB29585aDCe1e', symbol: 'BEETS', decimals: 18, chainId: 250 }   // Beethoven X
  ],
  // zkSync Era: 6 tokens
  zksync: [
    // Anchor tokens
    { address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', symbol: 'WETH', decimals: 18, chainId: 324 },
    { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', symbol: 'USDT', decimals: 6, chainId: 324 },
    { address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', symbol: 'USDC', decimals: 6, chainId: 324 },
    // Core DeFi
    { address: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011', symbol: 'WBTC', decimals: 8, chainId: 324 },
    { address: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E', symbol: 'ZK', decimals: 18, chainId: 324 },
    { address: '0x32fD44Bb4895705dca62f5E22ba9e3A6cd3C8B13', symbol: 'MUTE', decimals: 18, chainId: 324 }
  ],
  // Linea: 6 tokens
  linea: [
    // Anchor tokens
    { address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', symbol: 'WETH', decimals: 18, chainId: 59144 },
    { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', symbol: 'USDT', decimals: 6, chainId: 59144 },
    { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', symbol: 'USDC', decimals: 6, chainId: 59144 },
    { address: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', symbol: 'DAI', decimals: 18, chainId: 59144 },
    // Core DeFi
    { address: '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', symbol: 'WBTC', decimals: 8, chainId: 59144 },
    { address: '0x7d43AABC515C356145049227CeE54B608342c0ad', symbol: 'BUSD', decimals: 18, chainId: 59144 }
  ],
  // =============================================================================
  // Emerging L2s: Blast, Scroll, Mantle, Mode
  // =============================================================================
  // Blast: 2 tokens
  blast: [
    // Anchor tokens
    { address: '0x4300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18, chainId: 81457 },
    // Blast native stablecoin
    { address: '0x4300000000000000000000000000000000000003', symbol: 'USDB', decimals: 18, chainId: 81457 },
  ],
  // Scroll: 3 tokens
  scroll: [
    // Anchor tokens
    { address: '0x5300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18, chainId: 534352 },
    { address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', symbol: 'USDC', decimals: 6, chainId: 534352 },
    { address: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', symbol: 'USDT', decimals: 6, chainId: 534352 },
  ],
  // Mantle: 3 tokens
  mantle: [
    // Anchor tokens
    { address: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', symbol: 'WMNT', decimals: 18, chainId: 5000 },
    { address: '0x09Bc4E0D10F09B1CdA8b8BB72C1e89F10B53BcA6', symbol: 'USDC', decimals: 6, chainId: 5000 },
    { address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', symbol: 'USDT', decimals: 6, chainId: 5000 },
  ],
  // Mode: 2 tokens
  mode: [
    // Anchor tokens
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 34443 },
    { address: '0xd988097fb8612cc24eeC14542bC03424c656005f', symbol: 'USDC', decimals: 6, chainId: 34443 },
  ],
  // S3.3.3: Solana - 15 tokens (non-EVM - uses different address format)
  // Categories: anchor (1), stablecoin (2), defi (3), meme (2), governance (4), LST (3)
  solana: [
    // Anchor tokens - Solana uses base58 addresses
    { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, chainId: 101 },
    // Stablecoins
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, chainId: 101 },
    { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6, chainId: 101 },
    // Core DeFi (DEX governance tokens)
    { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6, chainId: 101 },
    { address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6, chainId: 101 },
    { address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6, chainId: 101 },
    // High-volume meme tokens
    { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5, chainId: 101 },
    { address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6, chainId: 101 },
    // S3.3.3: Governance tokens (ecosystem protocols)
    { address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', decimals: 9, chainId: 101 },   // Jito governance
    { address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6, chainId: 101 },  // Pyth Network oracle
    { address: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W', decimals: 6, chainId: 101 },     // Wormhole governance
    { address: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9, chainId: 101 },  // Marinade governance
    // S3.3.3: Liquid Staking Tokens (LST) - High volume for arbitrage
    { address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9, chainId: 101 },     // Marinade staked SOL
    { address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9, chainId: 101 }, // Jito staked SOL
    { address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'BSOL', decimals: 9, chainId: 101 }      // BlazeStake staked SOL
  ]
};

// =============================================================================
// FALLBACK TOKEN PRICES
// P0-FIX: Extracted from base-detector.ts to configuration for maintainability
// Used for USD value estimation when price oracle is unavailable
// =============================================================================

/**
 * Timestamp when fallback prices were last updated.
 * Used to detect when prices may be stale and need refreshing.
 * Format: ISO 8601 date string
 */
export const FALLBACK_PRICES_LAST_UPDATED = '2026-02-23T00:00:00Z';

/**
 * Number of days after which fallback prices are considered stale.
 * A warning will be logged when using prices older than this threshold.
 */
export const FALLBACK_PRICES_STALENESS_WARNING_DAYS = 7;

/**
 * Check if fallback prices are stale and log a warning if so.
 * Should be called once at service startup to alert operators.
 *
 * @param logger - Optional logger function (defaults to console.warn)
 * @returns true if prices are stale, false otherwise
 */
export function checkFallbackPriceStaleness(
  logger: (message: string, meta?: object) => void = console.warn
): boolean {
  const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
  const now = Date.now();
  const ageMs = now - lastUpdated;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays > FALLBACK_PRICES_STALENESS_WARNING_DAYS) {
    logger(
      `[STALE_FALLBACK_PRICES] Fallback token prices are ${ageDays} days old (last updated: ${FALLBACK_PRICES_LAST_UPDATED}). ` +
      `Consider updating FALLBACK_TOKEN_PRICES in shared/config/src/tokens/index.ts to reflect current market prices.`,
      {
        lastUpdated: FALLBACK_PRICES_LAST_UPDATED,
        ageDays,
        stalenessThresholdDays: FALLBACK_PRICES_STALENESS_WARNING_DAYS
      }
    );
    return true;
  }

  return false;
}

/**
 * Get the age of fallback prices in days.
 * Useful for monitoring dashboards.
 *
 * @returns Age in days since last update
 */
export function getFallbackPriceAgeDays(): number {
  const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
  return Math.floor((Date.now() - lastUpdated) / (1000 * 60 * 60 * 24));
}

/**
 * Fallback token prices for USD estimation when price oracle is unavailable.
 * These prices are approximations and should only be used as fallbacks.
 *
 * @see base-detector.ts estimateSwapUsdValue()
 * @see price-oracle.ts DEFAULT_FALLBACK_PRICES (keep in sync)
 * @see FALLBACK_PRICES_LAST_UPDATED for when these were last updated
 */
export const FALLBACK_TOKEN_PRICES: Record<string, number> = Object.freeze({
  // Native tokens and wrappers (updated 2026-02-23)
  ETH: 3200, WETH: 3200,
  BNB: 650, WBNB: 650,
  MATIC: 0.50, WMATIC: 0.50,
  AVAX: 35, WAVAX: 35,
  FTM: 0.70, WFTM: 0.70,
  SOL: 170, WSOL: 170,
  // L2 tokens
  ARB: 1.20,
  OP: 2.50,
  MNT: 0.80, WMNT: 0.80,
  // Major tokens
  BTC: 95000, WBTC: 95000, BTCB: 95000, tBTC: 95000,
  // Stablecoins (default to 1.00)
  USDT: 1.00, USDC: 1.00, DAI: 1.00, BUSD: 1.00,
  FRAX: 1.00, LUSD: 1.00, TUSD: 1.00, USDP: 1.00, GUSD: 1.00,
  USDbC: 1.00, fUSDT: 1.00, USDB: 1.00, // Bridged stables
  // DeFi tokens
  UNI: 12.00, AAVE: 280.00, LINK: 18.00, CRV: 0.80,
  MKR: 1800.00, COMP: 55.00, SNX: 2.50, SUSHI: 1.20, YFI: 9000.00,
  // Liquid staking
  STETH: 3200, WSTETH: 3700, RETH: 3400, CBETH: 3300,
  stETH: 3200, wstETH: 3700, rETH: 3400, cbETH: 3300, // lowercase variants
  // Solana LSTs
  mSOL: 180, jitoSOL: 180, BSOL: 175,
  // DEX/Protocol tokens
  GMX: 35, CAKE: 2.50, JOE: 0.40, VELO: 0.12, AERO: 1.30,
  RAY: 1.80, ORCA: 2.50, JUP: 0.70,
});

// =============================================================================
// NATIVE TOKEN PRICES BY CHAIN
// Single source of truth for chain native token USD prices
// Used by: gas-price-cache.ts, cross-dex-triangular-arbitrage.ts, multi-leg-path-finder.ts
// Issue 3.2 FIX: Added staleness tracking and validation
// =============================================================================

/**
 * Metadata for native token price tracking.
 * Issue 3.2: Track staleness to prevent using outdated fallback prices.
 */
export const NATIVE_TOKEN_PRICE_METADATA = Object.freeze({
  /** ISO date string of last price update */
  lastUpdated: '2026-02-23',
  /** Maximum age in days before prices are considered stale */
  maxAgeDays: 7,
  /** Update frequency recommendation */
  updateFrequency: 'weekly',
  /** Data source for manual updates */
  dataSource: 'CoinGecko API or market aggregators',
});

/**
 * Check if native token prices are potentially stale.
 * Issue 3.2 FIX: Enables proactive staleness detection.
 *
 * @returns Object with staleness info: { isStale, ageDays, lastUpdated, recommendation }
 */
export function checkNativeTokenPriceStaleness(): {
  isStale: boolean;
  ageDays: number;
  lastUpdated: string;
  recommendation: string;
} {
  const lastUpdatedDate = new Date(NATIVE_TOKEN_PRICE_METADATA.lastUpdated);
  const now = new Date();
  const ageDays = Math.floor((now.getTime() - lastUpdatedDate.getTime()) / (1000 * 60 * 60 * 24));
  const isStale = ageDays > NATIVE_TOKEN_PRICE_METADATA.maxAgeDays;

  return {
    isStale,
    ageDays,
    lastUpdated: NATIVE_TOKEN_PRICE_METADATA.lastUpdated,
    recommendation: isStale
      ? `NATIVE_TOKEN_PRICES are ${ageDays} days old. Update prices in shared/config/src/tokens/index.ts using ${NATIVE_TOKEN_PRICE_METADATA.dataSource}.`
      : `Prices are current (${ageDays} days old, max ${NATIVE_TOKEN_PRICE_METADATA.maxAgeDays} days).`,
  };
}

// Track if staleness warning has been shown (avoid spam)
let _stalenessWarningShown = false;

/**
 * Native token prices by chain name (lowercase).
 * Used for gas cost estimation and USD value calculations.
 *
 * IMPORTANT: These are FALLBACK prices used when real-time price feeds are unavailable.
 * For production arbitrage, always prefer real-time price data from oracles.
 *
 * Last updated: 2026-02-23
 * @see NATIVE_TOKEN_PRICE_METADATA for staleness tracking
 * @see checkNativeTokenPriceStaleness() to verify price freshness
 */
export const NATIVE_TOKEN_PRICES: Record<string, number> = Object.freeze({
  // EVM L1 chains (updated 2026-02-23)
  ethereum: 3200,  // ETH
  bsc: 650,        // BNB
  polygon: 0.50,   // MATIC
  avalanche: 35,   // AVAX
  fantom: 0.70,    // FTM
  // EVM L2 chains (use ETH as native)
  arbitrum: 3200,  // ETH
  optimism: 3200,  // ETH
  base: 3200,      // ETH
  zksync: 3200,    // ETH
  linea: 3200,     // ETH
  // Emerging L2s
  blast: 3200,     // ETH
  scroll: 3200,    // ETH
  mantle: 0.80,    // MNT
  mode: 3200,      // ETH
  // Non-EVM
  solana: 170,     // SOL
});

/**
 * Get native token price for a chain.
 * Returns fallback price of 1000 if chain not found.
 *
 * Issue 3.2 FIX: Now warns once if prices are stale (in non-test environments).
 *
 * @param chain - Chain name (case-insensitive)
 * @param options - Optional settings
 * @param options.suppressWarning - Set to true to suppress staleness warning
 * @returns Native token price in USD
 */
export function getNativeTokenPrice(
  chain: string,
  options?: { suppressWarning?: boolean }
): number {
  // Issue 3.2 FIX: Warn once if prices are stale
  if (!_stalenessWarningShown && !options?.suppressWarning && process.env.NODE_ENV !== 'test') {
    const staleness = checkNativeTokenPriceStaleness();
    if (staleness.isStale) {
      _stalenessWarningShown = true;
      console.warn(
        `[FALLBACK PRICE WARNING] ${staleness.recommendation} ` +
        `Using stale fallback prices may lead to inaccurate gas cost estimates.`
      );
    }
  }

  return NATIVE_TOKEN_PRICES[chain.toLowerCase()] ?? 1000;
}

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
  },
  // =============================================================================
  // S3.1.2: New Chain Token Metadata
  // S3.2.1: Updated Avalanche stablecoins (added FRAX)
  // =============================================================================
  avalanche: {
    weth: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH.e on Avalanche
    nativeWrapper: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
    stablecoins: [
      { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', decimals: 6 },
      { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6 },
      { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', symbol: 'DAI', decimals: 18 },
      { address: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64', symbol: 'FRAX', decimals: 18 } // S3.2.1: Added FRAX
    ]
  },
  fantom: {
    weth: '0x74b23882a30290451A17c44f4F05243b6b58C76d', // WETH on Fantom
    nativeWrapper: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // WFTM
    stablecoins: [
      { address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A', symbol: 'fUSDT', decimals: 6 },
      { address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', symbol: 'USDC', decimals: 6 },
      { address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', symbol: 'DAI', decimals: 18 }
    ]
  },
  zksync: {
    weth: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH on zkSync
    nativeWrapper: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH (native is ETH)
    stablecoins: [
      { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', symbol: 'USDT', decimals: 6 },
      { address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', symbol: 'USDC', decimals: 6 }
    ]
  },
  linea: {
    weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH on Linea
    nativeWrapper: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH (native is ETH)
    stablecoins: [
      { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', symbol: 'USDT', decimals: 6 },
      { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', symbol: 'USDC', decimals: 6 },
      { address: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', symbol: 'DAI', decimals: 18 }
    ]
  },
  // =============================================================================
  // Emerging L2s: Blast, Scroll, Mantle, Mode
  // =============================================================================
  blast: {
    weth: '0x4300000000000000000000000000000000000004',
    nativeWrapper: '0x4300000000000000000000000000000000000004', // WETH (native is ETH)
    stablecoins: [
      { address: '0x4300000000000000000000000000000000000003', symbol: 'USDB', decimals: 18 }
    ]
  },
  scroll: {
    weth: '0x5300000000000000000000000000000000000004',
    nativeWrapper: '0x5300000000000000000000000000000000000004', // WETH (native is ETH)
    stablecoins: [
      { address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', symbol: 'USDC', decimals: 6 },
      { address: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', symbol: 'USDT', decimals: 6 }
    ]
  },
  mantle: {
    weth: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', // WMNT (no bridged WETH standard)
    nativeWrapper: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', // WMNT
    stablecoins: [
      { address: '0x09Bc4E0D10F09B1CdA8b8BB72C1e89F10B53BcA6', symbol: 'USDC', decimals: 6 },
      { address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', symbol: 'USDT', decimals: 6 }
    ]
  },
  mode: {
    weth: '0x4200000000000000000000000000000000000006',
    nativeWrapper: '0x4200000000000000000000000000000000000006', // WETH (native is ETH)
    stablecoins: [
      { address: '0xd988097fb8612cc24eeC14542bC03424c656005f', symbol: 'USDC', decimals: 6 }
    ]
  },
  solana: {
    weth: 'So11111111111111111111111111111111111111112', // Wrapped SOL (native equivalent)
    nativeWrapper: 'So11111111111111111111111111111111111111112', // Wrapped SOL
    stablecoins: [
      { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
      { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 }
    ]
  }
};

// =============================================================================
// TOKEN DECIMALS LOOKUP
// Finding 7.1 Fix: Provide fast token decimals lookup from config
// Used by flash-loan strategy for accurate amount calculations
// =============================================================================

/**
 * Pre-built lookup map for O(1) token decimals lookup.
 * Built once at module load time from CORE_TOKENS and TOKEN_METADATA.
 *
 * Key format: lowercase(chain):lowercase(address)
 */
const TOKEN_DECIMALS_LOOKUP: Map<string, number> = (() => {
  const lookup = new Map<string, number>();

  // Add all tokens from CORE_TOKENS
  for (const [chain, tokens] of Object.entries(CORE_TOKENS)) {
    for (const token of tokens) {
      const key = `${chain.toLowerCase()}:${token.address.toLowerCase()}`;
      lookup.set(key, token.decimals);
    }
  }

  // Add stablecoins from TOKEN_METADATA (may have duplicates, that's ok)
  for (const [chain, metadata] of Object.entries(TOKEN_METADATA)) {
    for (const stable of metadata.stablecoins) {
      const key = `${chain.toLowerCase()}:${stable.address.toLowerCase()}`;
      lookup.set(key, stable.decimals);
    }
  }

  return lookup;
})();

/**
 * Common token decimals by symbol (fallback when address not found).
 * These are well-known standards that rarely change.
 *
 * NOTE: BSC uses 18 decimals for USDT/USDC (BEP-20 variants), unlike the
 * standard 6 decimals on other EVM chains. Use CHAIN_TOKEN_DECIMAL_OVERRIDES
 * for chain-specific exceptions.
 */
const COMMON_TOKEN_DECIMALS: Record<string, number> = {
  // 6-decimal stablecoins
  usdc: 6,
  usdt: 6,
  // 8-decimal tokens
  wbtc: 8,
  btcb: 18,
  // 18-decimal tokens (most ERC-20 default)
  weth: 18,
  eth: 18,
  dai: 18,
};

/**
 * FIX P0-6: Chain-specific token decimal overrides.
 *
 * BSC (BNB Chain) uses 18 decimals for USDT and USDC, unlike the standard
 * 6 decimals on Ethereum, Arbitrum, Polygon, etc. Without this override,
 * getTokenDecimals('bsc', '', 'USDT') would return 6 from COMMON_TOKEN_DECIMALS,
 * causing a 10^12 magnitude error in amount calculations.
 *
 * @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P0-6
 */
const CHAIN_TOKEN_DECIMAL_OVERRIDES: Record<string, Record<string, number>> = {
  bsc: {
    usdt: 18,
    usdc: 18,
    busd: 18,
  },
};

/**
 * Get token decimals from config.
 *
 * Finding 7.1 Fix: Provides fast O(1) token decimals lookup.
 * Uses pre-built lookup map from CORE_TOKENS and TOKEN_METADATA.
 *
 * Resolution order:
 * 1. Exact match by chain:address in lookup map
 * 2. Match by common token symbol (case-insensitive)
 * 3. Default fallback (18 for most ERC-20 tokens)
 *
 * @param chain - Chain name (e.g., 'ethereum', 'arbitrum')
 * @param address - Token contract address
 * @param symbol - Optional token symbol for fallback matching
 * @returns Token decimals (defaults to 18 if not found)
 */
export function getTokenDecimals(
  chain: string,
  address: string,
  symbol?: string
): number {
  // Try exact match first (O(1) lookup)
  const key = `${chain.toLowerCase()}:${address.toLowerCase()}`;
  const exactMatch = TOKEN_DECIMALS_LOOKUP.get(key);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  // Try matching by symbol if provided
  if (symbol) {
    const symbolLower = symbol.toLowerCase();

    // FIX P0-6: Check chain-specific overrides first (e.g., BSC USDT/USDC = 18 decimals)
    // @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P0-6
    const chainOverrides = CHAIN_TOKEN_DECIMAL_OVERRIDES[chain.toLowerCase()];
    if (chainOverrides) {
      const overrideDecimals = chainOverrides[symbolLower];
      if (overrideDecimals !== undefined) {
        return overrideDecimals;
      }
    }

    const commonDecimals = COMMON_TOKEN_DECIMALS[symbolLower];
    if (commonDecimals !== undefined) {
      return commonDecimals;
    }
  }

  // Default to 18 (most common for ERC-20)
  return 18;
}

/**
 * Check if a token's decimals are known in config.
 * Useful for deciding whether to query on-chain.
 *
 * @param chain - Chain name
 * @param address - Token contract address
 * @returns True if decimals are known
 */
export function hasKnownDecimals(chain: string, address: string): boolean {
  const key = `${chain.toLowerCase()}:${address.toLowerCase()}`;
  return TOKEN_DECIMALS_LOOKUP.has(key);
}

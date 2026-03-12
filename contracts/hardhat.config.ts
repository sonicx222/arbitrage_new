import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@nomicfoundation/hardhat-verify';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

// Suppress Node.js version warning
process.removeAllListeners('warning');

/**
 * Load deployment environment variables from project root.
 * Precedence: existing process.env > .env.local > .env.
 */
function loadDeploymentEnv(): void {
  const shellEnvKeys = new Set(Object.keys(process.env));
  const projectRoot = path.resolve(__dirname, '..');
  const rootEnvPath = path.join(projectRoot, '.env');
  const rootEnvLocalPath = path.join(projectRoot, '.env.local');

  if (existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath, quiet: true });
  }

  if (existsSync(rootEnvLocalPath)) {
    const local = dotenv.parse(readFileSync(rootEnvLocalPath));

    for (const [key, value] of Object.entries(local)) {
      // Respect explicit shell exports while still allowing .env.local to override .env.
      if (!shellEnvKeys.has(key)) {
        process.env[key] = value;
      }
    }
  }
}

loadDeploymentEnv();

/**
 * Hardhat Configuration for Flash Loan Arbitrage Contracts
 *
 * Networks configured:
 * - localhost: Local Hardhat node for development
 * - sepolia, arbitrumSepolia, baseSepolia: Ethereum/L2 testnets
 * - polygonAmoy, bscTestnet: Additional testnets
 * - zksync, zksync-testnet: zkSync Era mainnet and testnet
 * - arbitrum, base, optimism: Primary L2 mainnet targets
 * - blast, scroll: Emerging L2 mainnets
 * - bsc, polygon, avalanche, fantom, linea: Additional mainnet chains
 * - ethereum: L1 mainnet (commented out — enable after L2 success)
 *
 * @see implementation_plan_v2.md Task 3.1.1
 */

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.19',
        settings: {
          optimizer: {
            enabled: true,
            // Optimization runs: Higher values optimize for runtime (cheaper execution),
            // lower values optimize for deployment cost. For flash loan arbitrage where
            // functions are called frequently, we optimize for runtime efficiency.
            // Trade-off: ~50% higher deployment cost, ~10-20% cheaper execution
            runs: 10000,
          },
          // viaIR provides advanced optimizations for standard EVM chains
          // Disabled for zkSync Era which uses custom zksolc compiler
          // Set DISABLE_VIA_IR=true for zkSync deployments
          // Also disabled during tests (HARDHAT_TEST=true) for 2-5x faster compilation
          viaIR: process.env.DISABLE_VIA_IR !== 'true' && process.env.HARDHAT_TEST !== 'true',
        },
      },
    ],
  },
  paths: {
    sources: './src',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
        // Fork block configuration:
        // - Default: undefined (latest block) for CI/CD and development
        // - Override: Set FORK_BLOCK_NUMBER=21500000 for reproducible tests
        // - Fixed block useful for debugging specific historical state
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? (process.env.FORK_BLOCK_NUMBER === 'latest'
             ? undefined
             : parseInt(process.env.FORK_BLOCK_NUMBER, 10))
          : undefined, // Default to latest
        enabled: process.env.FORK_ENABLED === 'true',
      },
      chainId: 31337,
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 421614,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 84532,
    },
    // zkSync Era Networks (for SyncSwap flash loan integration)
    zksync: {
      url: process.env.ZKSYNC_RPC_URL || 'https://mainnet.era.zksync.io',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 324,
    },
    'zksync-testnet': {
      url: process.env.ZKSYNC_TESTNET_RPC_URL || 'https://sepolia.era.zksync.dev',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 300,
    },
    // Testnets — additional chains
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 80002,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 97,
    },
    // Production L2 networks — enabled for deployment
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 42161,
    },
    base: {
      url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 8453,
    },
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 10,
    },
    // Emerging L2 networks
    blast: {
      url: process.env.BLAST_RPC_URL || 'https://rpc.blast.io',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 81457,
    },
    scroll: {
      url: process.env.SCROLL_RPC_URL || 'https://rpc.scroll.io',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 534352,
    },
    mantle: {
      url: process.env.MANTLE_RPC_URL || 'https://rpc.mantle.xyz',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 5000,
    },
    mode: {
      url: process.env.MODE_RPC_URL || 'https://mainnet.mode.network',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 34443,
    },
    // Production L1 and additional mainnet chains
    // Fallback URLs intentionally empty — Hardhat will fail if env var is missing,
    // preventing accidental deploys through unreliable public RPCs.
    bsc: {
      url: process.env.BSC_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 56,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 137,
    },
    avalanche: {
      url: process.env.AVALANCHE_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 43114,
    },
    fantom: {
      url: process.env.FANTOM_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 250,
    },
    linea: {
      url: process.env.LINEA_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 59144,
    },
    // Ethereum mainnet — high gas costs, enable only after L2 success
    // ethereum: {
    //   url: process.env.ETHEREUM_RPC_URL || '',
    //   accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    //   chainId: 1,
    // },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    gasPrice: 30,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  etherscan: {
    // Use per-network keys map so custom explorers (e.g. zkSync Sepolia)
    // can use their own API URLs instead of forcing Etherscan v2 endpoint.
    // M-07: Per-chain API keys with fallback to ETHERSCAN_API_KEY.
    // Arbiscan, BSCScan, Polygonscan etc. require separate registration.
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      sepolia: process.env.ETHERSCAN_API_KEY || '',
      arbitrum: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      base: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      baseSepolia: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      optimism: process.env.OPTIMISM_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      polygon: process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      polygonAmoy: process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      bsc: process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      bscTestnet: process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      avalanche: process.env.SNOWTRACE_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      fantom: process.env.FTMSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      linea: process.env.LINEASCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      blast: process.env.BLASTSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      scroll: process.env.SCROLLSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      mantle: process.env.MANTLESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      mode: process.env.MODESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
      'zksync-testnet':
        process.env.ZKSYNC_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || 'verify',
      // L-07: zkSync mainnet uses hardhat-zksync-verify plugin; this entry enables
      // the etherscan fallback for block explorer links.
      zksync:
        process.env.ZKSYNC_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || 'verify',
    },
    customChains: [
      {
        network: 'blast',
        chainId: 81457,
        urls: {
          apiURL: 'https://api.blastscan.io/api',
          browserURL: 'https://blastscan.io',
        },
      },
      {
        network: 'scroll',
        chainId: 534352,
        urls: {
          apiURL: 'https://api.scrollscan.com/api',
          browserURL: 'https://scrollscan.com',
        },
      },
      {
        network: 'mantle',
        chainId: 5000,
        urls: {
          apiURL: 'https://api.mantlescan.xyz/api',
          browserURL: 'https://mantlescan.xyz',
        },
      },
      {
        network: 'mode',
        chainId: 34443,
        urls: {
          apiURL: 'https://explorer.mode.network/api',
          browserURL: 'https://explorer.mode.network',
        },
      },
      {
        network: 'zksync-testnet',
        chainId: 300,
        urls: {
          // zkSync Era Sepolia explorer exposes an Etherscan-compatible POST API.
          apiURL: 'https://explorer.sepolia.era.zksync.dev/contract_verification',
          browserURL: 'https://sepolia.explorer.zksync.io',
        },
      },
    ],
  },
  sourcify: {
    // Keep disabled to avoid informational noise during verification runs.
    enabled: false,
  },
  typechain: {
    outDir: './typechain-types',
    target: 'ethers-v6',
  },
};

export default config;

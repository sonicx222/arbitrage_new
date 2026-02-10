import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@nomicfoundation/hardhat-verify';

// Suppress Node.js version warning
process.removeAllListeners('warning');

/**
 * Hardhat Configuration for Flash Loan Arbitrage Contracts
 *
 * Networks configured:
 * - localhost: Local Hardhat node for development
 * - sepolia: Ethereum testnet for testing
 * - arbitrumSepolia: Arbitrum testnet
 * - mainnet/arbitrum/base/optimism: Production networks (commented out until needed)
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
          viaIR: process.env.DISABLE_VIA_IR !== 'true',
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
             : parseInt(process.env.FORK_BLOCK_NUMBER))
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
    // Production networks - uncomment after security audit
    // TODO: Track deployment progress - create GitHub issue for mainnet deployment
    // Prerequisites before enabling:
    // 1) Security audit completed (contracts/docs/SECURITY_REVIEW.md checklist)
    // 2) Testnet verification (Sepolia, Arbitrum Sepolia, BSC Testnet)
    // 3) Deployment runbook (contracts/docs/DEPLOYMENT.md)
    // 4) Multi-sig wallet configured for contract ownership
    // 5) Router/pool whitelists populated and verified
    // 6) Minimum profit thresholds configured appropriately
    // ethereum: {
    //   url: process.env.ETHEREUM_RPC_URL || '',
    //   accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    //   chainId: 1,
    // },
    // arbitrum: {
    //   url: process.env.ARBITRUM_RPC_URL || '',
    //   accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    //   chainId: 42161,
    // },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    gasPrice: 30,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      sepolia: process.env.ETHERSCAN_API_KEY || '',
      arbitrumOne: process.env.ARBISCAN_API_KEY || '',
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || '',
      // zkSync Era uses its own explorer
      zksync: process.env.ZKSYNC_ETHERSCAN_API_KEY || '',
      'zksync-testnet': process.env.ZKSYNC_ETHERSCAN_API_KEY || '',
    },
  },
  typechain: {
    outDir: './typechain-types',
    target: 'ethers-v6',
  },
};

export default config;

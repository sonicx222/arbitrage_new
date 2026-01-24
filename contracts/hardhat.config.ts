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
            runs: 200,
          },
          viaIR: true,
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
        blockNumber: 19000000, // Fixed block for reproducible tests
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
    // Production networks - uncomment after security audit
    // TODO: Track deployment progress - create GitHub issue for mainnet deployment
    // Prerequisites: 1) Security audit, 2) Testnet verification, 3) Deployment runbook
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
    },
  },
  typechain: {
    outDir: './typechain-types',
    target: 'ethers-v6',
  },
};

export default config;

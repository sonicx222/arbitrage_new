/**
 * Flash Loan Contract Deployment Exports
 *
 * @see implementation_plan_v2.md Task 3.1.3
 */

export {
  // Type-safe chain identifiers
  type TestnetChain,
  type EVMMainnetChain,
  type SupportedChain,
  MAINNET_CHAINS,
  TESTNET_CHAINS,
  isTestnet,
  isMainnet,
  normalizeChainName, // FIX 3.2: Chain name normalization for alias handling

  // Address constants
  AAVE_V3_POOL_ADDRESSES,
  FLASH_LOAN_CONTRACT_ADDRESSES,
  PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES,
  BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES,
  SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES,
  COMMIT_REVEAL_ARBITRAGE_ADDRESSES,
  MULTI_PATH_QUOTER_ADDRESSES,
  APPROVED_ROUTERS,
  TOKEN_ADDRESSES,

  // Helper functions
  hasDeployedContract,
  getContractAddress,
  getAavePoolAddress,
  getApprovedRouters,
  hasApprovedRouters,
  hasDeployedQuoter,
  getQuoterAddress,
  tryGetQuoterAddress, // FIX 4.2: New optional accessor for graceful fallback
} from './addresses';

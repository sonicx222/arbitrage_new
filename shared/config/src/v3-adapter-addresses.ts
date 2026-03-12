/**
 * UniswapV3Adapter contract addresses per chain.
 *
 * These are the on-chain adapter contracts that wrap Uniswap V3's
 * exactInputSingle() behind the V2 IDexRouter interface, enabling
 * BaseFlashArbitrage to route through V3 liquidity.
 *
 * The adapter address is substituted as SwapStep.router for V3 steps
 * in flash loan calldata. The adapter then delegates to the chain's
 * real V3 SwapRouter.
 *
 * Addresses are populated after deployment via `deploy-v3-adapter.ts`.
 * Chains with null have no adapter deployed yet — V3 steps on those
 * chains will fall back to a warning log and skip.
 *
 * @see contracts/src/adapters/UniswapV3Adapter.sol
 * @see contracts/deployments/registry.json (UniswapV3Adapter field)
 */
export const V3_ADAPTER_ADDRESSES: Readonly<Record<string, string | null>> = {
  // Testnets (deployed)
  arbitrumSepolia: '0x1A9838ce19Ae905B4e5941a17891ba180F30F630',

  // Mainnets (null = not yet deployed)
  ethereum: null,
  arbitrum: null,
  base: null,
  optimism: null,
  polygon: null,
  bsc: null,
  avalanche: null,
  fantom: null,
  linea: null,
  zksync: null,
  blast: null,
  scroll: null,
  mantle: null,
  mode: null,
};

/**
 * Get the UniswapV3Adapter contract address for a chain.
 *
 * @param chain - Chain identifier
 * @returns Adapter address or null if not deployed on this chain
 */
export function getV3AdapterAddress(chain: string): string | null {
  return V3_ADAPTER_ADDRESSES[chain] ?? null;
}

/**
 * Check if a chain has a deployed UniswapV3Adapter.
 *
 * @param chain - Chain identifier
 * @returns true if adapter is deployed and configured
 */
export function hasV3Adapter(chain: string): boolean {
  return V3_ADAPTER_ADDRESSES[chain] != null;
}

// =============================================================================
// V3 SwapRouter & Quoter Addresses (for UniswapV3Adapter deployment)
// =============================================================================

/**
 * Uniswap V3 SwapRouter addresses per chain (well-known, deployed via CREATE2).
 * These are the underlying V3 routers that the UniswapV3Adapter delegates to.
 *
 * M-17: Moved from contracts/scripts/deploy-v3-adapter.ts to shared config.
 *
 * @see https://docs.uniswap.org/contracts/v3/reference/deployments
 */
export const V3_SWAP_ROUTERS: Readonly<Record<string, string>> = {
  // Uniswap V3 SwapRouter (same address on most EVM chains via CREATE2)
  ethereum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  polygon: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  base: '0x2626664c2603336E57B271c5C0b26F421741e481',
  // PancakeSwap V3 SmartRouter (compatible exactInputSingle interface)
  bsc: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  linea: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
  // Testnets
  arbitrumSepolia: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  sepolia: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  // Scroll uses SyncSwap — V3 adapter uses Uniswap-compatible interface
  scroll: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
};

/**
 * Uniswap V3 QuoterV2 addresses per chain.
 * Used by the adapter for getAmountsOut/In simulation.
 * address(0) disables quoting on that chain until verified.
 */
export const V3_QUOTERS: Readonly<Record<string, string>> = {
  ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  polygon: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  // PancakeSwap V3 QuoterV2 — address(0) disables until verified
  bsc: '0x0000000000000000000000000000000000000000',
  linea: '0x0000000000000000000000000000000000000000',
  // Testnets — QuoterV2 may not be deployed
  arbitrumSepolia: '0x0000000000000000000000000000000000000000',
  sepolia: '0x0000000000000000000000000000000000000000',
};

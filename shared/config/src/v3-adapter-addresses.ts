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

/**
 * Flash Loan Protocol Availability Matrix
 *
 * Central source of truth for which flash loan protocols are available on each chain.
 * This prevents runtime failures from attempting to use unsupported protocols.
 *
 * ## Protocol Name Convention
 *
 * Uses versioned protocol names (e.g., 'aave_v3' not 'aave') to match the
 * provider type system in execution-engine/flash-loan-providers/types.ts.
 * This ensures type-safe interop between availability checks and provider selection.
 *
 * @see contracts/src/interfaces/* - Interface definitions
 * @see services/execution-engine/src/strategies/flash-loan-providers/types.ts - Provider types
 * @see docs/architecture/adr/ADR-020-flash-loan.md - Flash loan integration decision
 */

/**
 * Supported flash loan protocols (versioned names)
 *
 * Matches the FlashLoanProtocol type in execution-engine/flash-loan-providers/types.ts.
 * Only includes protocols with Solidity interfaces in contracts/src/interfaces/.
 */
export type FlashLoanProtocol =
  | 'aave_v3'
  | 'balancer_v2'
  | 'pancakeswap_v3'
  | 'syncswap';

/**
 * Flash loan protocol availability per chain
 *
 * Key insights:
 * - Aave V3: Best coverage on major EVM chains (8 chains)
 * - Balancer V2: Strong on Ethereum L1 and major L2s (6 chains)
 * - PancakeSwap V3: Best for BSC and zkSync ecosystems (7 chains)
 * - SyncSwap: zkSync Era only (1 chain, Linea planned)
 *
 * Updated: 2026-02-11
 */
export const FLASH_LOAN_AVAILABILITY: Readonly<
  Record<string, Readonly<Record<FlashLoanProtocol, boolean>>>
> = {
  // =========================================================================
  // EVM Mainnets
  // =========================================================================

  ethereum: {
    aave_v3: true, // Aave V3 Pool: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
    balancer_v2: true, // Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
    syncswap: false,
  },

  polygon: {
    aave_v3: true, // Aave V3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    balancer_v2: true, // Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
    pancakeswap_v3: false,
    syncswap: false,
  },

  arbitrum: {
    aave_v3: true, // Aave V3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    balancer_v2: true, // Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
    syncswap: false,
  },

  base: {
    aave_v3: true, // Aave V3 Pool: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
    balancer_v2: true, // Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
    syncswap: false,
  },

  optimism: {
    aave_v3: true, // Aave V3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    balancer_v2: true, // Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
    pancakeswap_v3: false,
    syncswap: false,
  },

  bsc: {
    aave_v3: false, // Aave V3 not deployed on BSC
    balancer_v2: false, // Balancer V2 not on BSC
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
    syncswap: false,
  },

  avalanche: {
    aave_v3: true, // Aave V3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    balancer_v2: false, // Balancer V2 not on Avalanche
    pancakeswap_v3: false,
    syncswap: false,
  },

  fantom: {
    aave_v3: false, // Aave V3 not deployed on Fantom
    balancer_v2: true, // Balancer V2 Vault: 0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce
    pancakeswap_v3: false,
    syncswap: false,
  },

  zksync: {
    aave_v3: false, // Aave V3 not deployed on zkSync Era
    balancer_v2: false, // Balancer V2 not on zkSync Era
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB
    syncswap: true, // SyncSwap Vault: 0x621425a1Ef6abE91058E9712575dcc4258F8d091
  },

  linea: {
    aave_v3: false, // Aave V3 not deployed on Linea
    balancer_v2: false, // Balancer V2 not on Linea
    pancakeswap_v3: true, // PancakeSwap V3 Factory: 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
    syncswap: false, // SyncSwap planned but not yet deployed
  },

  // =========================================================================
  // Non-EVM
  // =========================================================================

  solana: {
    aave_v3: false, // Aave is EVM-only
    balancer_v2: false, // Balancer is EVM-only
    pancakeswap_v3: false, // PancakeSwap is EVM-only
    syncswap: false, // SyncSwap is EVM-only
    // Note: Solana has native flash loan protocols (Solend, Port, Mango)
    // but they use different interfaces and are not covered by these contracts
  },

  // =========================================================================
  // Testnets
  // =========================================================================

  sepolia: {
    aave_v3: true, // Aave V3 Pool: 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951
    balancer_v2: false, // No testnet deployment
    pancakeswap_v3: false, // No testnet deployment
    syncswap: false,
  },

  'arbitrum-sepolia': {
    aave_v3: true, // Aave V3 Pool: 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff
    balancer_v2: false,
    pancakeswap_v3: false,
    syncswap: false,
  },

  'zksync-sepolia': {
    aave_v3: false,
    balancer_v2: false,
    pancakeswap_v3: false,
    syncswap: true, // SyncSwap Vault: 0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8 (Staging)
  },

  'solana-devnet': {
    aave_v3: false,
    balancer_v2: false,
    pancakeswap_v3: false,
    syncswap: false,
  },
} as const;

/**
 * Get all supported flash loan protocols for a chain
 *
 * @param chain - Chain identifier
 * @returns Array of supported protocol names
 *
 * @example
 * ```typescript
 * getSupportedProtocols('ethereum') // ['aave_v3', 'balancer_v2', 'pancakeswap_v3']
 * getSupportedProtocols('bsc')      // ['pancakeswap_v3']
 * getSupportedProtocols('solana')   // []
 * ```
 */
export function getSupportedProtocols(chain: string): FlashLoanProtocol[] {
  const availability = FLASH_LOAN_AVAILABILITY[chain];
  if (!availability) {
    return [];
  }

  return (Object.keys(availability) as FlashLoanProtocol[]).filter(
    (protocol) => availability[protocol]
  );
}

/**
 * Check if a flash loan protocol is supported on a chain
 *
 * @param chain - Chain identifier
 * @param protocol - Flash loan protocol
 * @returns true if protocol is available, false otherwise
 *
 * @example
 * ```typescript
 * isProtocolSupported('ethereum', 'aave_v3')      // true
 * isProtocolSupported('bsc', 'aave_v3')           // false
 * isProtocolSupported('unknown-chain', 'aave_v3') // false
 * ```
 */
export function isProtocolSupported(
  chain: string,
  protocol: FlashLoanProtocol
): boolean {
  return FLASH_LOAN_AVAILABILITY[chain]?.[protocol] ?? false;
}

/**
 * Validate flash loan support and throw detailed error if not available
 *
 * @param chain - Chain identifier
 * @param protocol - Flash loan protocol
 * @throws {FlashLoanNotSupportedError} If protocol is not available on chain
 *
 * @example
 * ```typescript
 * validateFlashLoanSupport('ethereum', 'aave_v3') // OK
 * validateFlashLoanSupport('bsc', 'aave_v3')      // throws FlashLoanNotSupportedError
 * ```
 */
export function validateFlashLoanSupport(
  chain: string,
  protocol: FlashLoanProtocol
): void {
  if (!FLASH_LOAN_AVAILABILITY[chain]) {
    throw new FlashLoanNotSupportedError(
      chain,
      protocol,
      `Unknown chain: ${chain}. Supported chains: ${Object.keys(FLASH_LOAN_AVAILABILITY).join(', ')}`
    );
  }

  if (!isProtocolSupported(chain, protocol)) {
    const supported = getSupportedProtocols(chain);
    const supportedList =
      supported.length > 0 ? supported.join(', ') : 'none';

    throw new FlashLoanNotSupportedError(
      chain,
      protocol,
      `${protocol} flash loans not available on ${chain}. Supported protocols: ${supportedList}`
    );
  }
}

/**
 * Get the best available flash loan protocol for a chain
 *
 * Preference order (by fee, lowest first):
 * 1. Balancer V2 (0% fee)
 * 2. Aave V3 (0.09% fee)
 * 3. PancakeSwap V3 (0.01-1% fee, pool-dependent)
 * 4. SyncSwap (0.3% fee)
 *
 * @param chain - Chain identifier
 * @returns Preferred protocol or null if none available
 *
 * @example
 * ```typescript
 * getPreferredProtocol('ethereum') // 'balancer_v2' (0% fee wins)
 * getPreferredProtocol('bsc')      // 'pancakeswap_v3' (only option)
 * getPreferredProtocol('solana')   // null (no EVM flash loans)
 * ```
 */
export function getPreferredProtocol(chain: string): FlashLoanProtocol | null {
  const preferences: FlashLoanProtocol[] = [
    'balancer_v2', // 0% fee - always best if available
    'aave_v3', // 0.09% fee - second best
    'pancakeswap_v3', // 0.01-1% fee - varies by pool
    'syncswap', // 0.3% fee - higher than Aave
  ];

  for (const protocol of preferences) {
    if (isProtocolSupported(chain, protocol)) {
      return protocol;
    }
  }

  return null;
}

/**
 * Custom error for flash loan protocol not supported
 */
export class FlashLoanNotSupportedError extends Error {
  constructor(
    public readonly chain: string,
    public readonly protocol: FlashLoanProtocol,
    message: string
  ) {
    super(`[ERR_FLASH_LOAN_NOT_SUPPORTED] ${message}`);
    this.name = 'FlashLoanNotSupportedError';
  }
}

/**
 * Flash loan protocol statistics (for monitoring and planning)
 */
export const FLASH_LOAN_STATS = {
  totalChains: Object.keys(FLASH_LOAN_AVAILABILITY).length,
  mainnetChains: 10,
  testnetChains: 4,
  protocolCoverage: {
    aave_v3: getSupportedProtocols('ethereum').includes('aave_v3') ? 8 : 0,
    balancer_v2: getSupportedProtocols('ethereum').includes('balancer_v2') ? 6 : 0,
    pancakeswap_v3: getSupportedProtocols('ethereum').includes('pancakeswap_v3')
      ? 7
      : 0,
    syncswap: getSupportedProtocols('zksync').includes('syncswap') ? 1 : 0,
  },
  chainsWithMultipleProtocols: [
    'ethereum',
    'arbitrum',
    'base',
    'optimism',
    'zksync',
  ].length, // 5 chains
  chainsWithNoProtocols: ['solana', 'solana-devnet'].length, // 2 chains (non-EVM)
} as const;

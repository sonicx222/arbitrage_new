/**
 * Flash Loan Provider Factory
 *
 * Creates and manages flash loan providers for different chains and protocols.
 * Provides a consistent interface for the FlashLoanStrategy to use.
 *
 * Fix 1.1: Resolves architecture mismatch by creating providers based on
 * FLASH_LOAN_PROVIDERS configuration while clearly indicating which
 * protocols are actually implemented.
 *
 * @see service-config.ts FLASH_LOAN_PROVIDERS
 */

import { FLASH_LOAN_PROVIDERS, isValidContractAddress } from '@arbitrage/config';
import type { Logger } from '../../types';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanProviderConfig,
  ProtocolSupportStatus,
} from './types';
import { AaveV3FlashLoanProvider } from './aave-v3.provider';
import { BalancerV2FlashLoanProvider } from './balancer-v2.provider';
import { PancakeSwapV3FlashLoanProvider } from './pancakeswap-v3.provider';
import { SyncSwapFlashLoanProvider } from './syncswap.provider';
import { UnsupportedFlashLoanProvider } from './unsupported.provider';

/**
 * Chains that have fully supported Aave V3 flash loans
 */
const AAVE_V3_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'aave_v3')
    .map(([chain]) => chain)
);

/**
 * Chains that have fully supported PancakeSwap V3 flash loans
 */
const PANCAKESWAP_V3_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'pancakeswap_v3')
    .map(([chain]) => chain)
);

/**
 * Chains that have fully supported Balancer V2 flash loans
 * Task 2.2: Balancer V2 flash loan support across 6 chains
 */
const BALANCER_V2_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'balancer_v2')
    .map(([chain]) => chain)
);

/**
 * Chains that have fully supported SyncSwap flash loans
 * Task 3.4: SyncSwap flash loan support on zkSync Era (Linea planned)
 */
const SYNCSWAP_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'syncswap')
    .map(([chain]) => chain)
);

/**
 * Flash Loan Provider Factory
 *
 * Creates appropriate providers based on chain configuration.
 * Caches providers for reuse across multiple requests.
 */
export class FlashLoanProviderFactory {
  private readonly logger: Logger;
  private readonly config: FlashLoanProviderConfig;
  private readonly providers = new Map<string, IFlashLoanProvider>();

  constructor(logger: Logger, config: FlashLoanProviderConfig) {
    this.logger = logger;
    this.config = config;

    // Validate configuration
    if (Object.keys(config.contractAddresses).length === 0) {
      this.logger.warn('[WARN_CONFIG] No FlashLoanArbitrage contract addresses configured');
    }
  }

  /**
   * Get a flash loan provider for a specific chain
   *
   * @param chain - Chain identifier
   * @returns Flash loan provider (may be unsupported provider if protocol not implemented)
   */
  getProvider(chain: string): IFlashLoanProvider | undefined {
    // Check cache first
    const cached = this.providers.get(chain);
    if (cached) {
      return cached;
    }

    // Get flash loan config for chain
    const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
    if (!flashLoanConfig) {
      this.logger.debug('No flash loan provider configured for chain', { chain });
      return undefined;
    }

    // Create appropriate provider based on protocol
    const provider = this.createProvider(chain, flashLoanConfig);
    if (provider) {
      this.providers.set(chain, provider);
    }

    return provider;
  }

  /**
   * Create a provider instance based on protocol type
   */
  private createProvider(
    chain: string,
    flashLoanConfig: { address: string; protocol: string; fee: number }
  ): IFlashLoanProvider | undefined {
    const protocol = flashLoanConfig.protocol as FlashLoanProtocol;

    if (protocol === 'aave_v3') {
      return this.createAaveV3Provider(chain, flashLoanConfig);
    }

    if (protocol === 'balancer_v2') {
      return this.createBalancerV2Provider(chain, flashLoanConfig);
    }

    if (protocol === 'pancakeswap_v3') {
      return this.createPancakeSwapV3Provider(chain, flashLoanConfig);
    }

    if (protocol === 'syncswap') {
      return this.createSyncSwapProvider(chain, flashLoanConfig);
    }

    // Create unsupported provider for other protocols
    this.logger.info('Creating placeholder provider for unsupported protocol', {
      chain,
      protocol,
      note: 'Only Aave V3, Balancer V2, PancakeSwap V3, and SyncSwap are currently implemented. See flash-loan-providers/unsupported.provider.ts for implementation roadmap.',
    });

    return new UnsupportedFlashLoanProvider({
      protocol,
      chain,
      poolAddress: flashLoanConfig.address,
      feeBps: flashLoanConfig.fee,
    });
  }

  /**
   * Create Aave V3 provider
   */
  private createAaveV3Provider(
    chain: string,
    flashLoanConfig: { address: string; protocol: string; fee: number }
  ): AaveV3FlashLoanProvider | undefined {
    const contractAddress = this.config.contractAddresses[chain];

    // FIX (Issue 1.2): Use centralized validation for both undefined and zero address
    // Zero address will cause all transactions to fail silently at execution time.
    // Better to fail fast during provider creation than during a trade attempt.
    if (!isValidContractAddress(contractAddress)) {
      const isZero = contractAddress === '0x0000000000000000000000000000000000000000';
      const level = isZero ? 'error' : 'warn';
      const message = isZero
        ? '[ERR_CONFIG] Zero contract address is invalid - FlashLoanArbitrage not deployed'
        : 'No FlashLoanArbitrage contract configured for Aave V3 chain';

      this.logger[level](message, {
        chain,
        poolAddress: flashLoanConfig.address,
        contractAddress: contractAddress || 'undefined',
        action: 'Provider not created. Deploy the contract and configure the correct address.',
      });
      return undefined;
    }

    const approvedRouters = this.config.approvedRouters[chain] || [];
    const feeOverride = this.config.feeOverrides?.[chain];

    return new AaveV3FlashLoanProvider({
      chain,
      poolAddress: flashLoanConfig.address,
      contractAddress,
      approvedRouters,
      feeOverride,
    });
  }

  /**
   * Create PancakeSwap V3 provider
   */
  private createPancakeSwapV3Provider(
    chain: string,
    flashLoanConfig: { address: string; protocol: string; fee: number }
  ): PancakeSwapV3FlashLoanProvider | undefined {
    const contractAddress = this.config.contractAddresses[chain];

    // FIX (Issue 1.2): Use centralized validation for both undefined and zero address
    if (!isValidContractAddress(contractAddress)) {
      const isZero = contractAddress === '0x0000000000000000000000000000000000000000';
      const level = isZero ? 'error' : 'warn';
      const message = isZero
        ? '[ERR_CONFIG] Zero contract address is invalid - PancakeSwapFlashArbitrage not deployed'
        : 'No PancakeSwapFlashArbitrage contract configured for PancakeSwap V3 chain';

      this.logger[level](message, {
        chain,
        factoryAddress: flashLoanConfig.address,
        contractAddress: contractAddress || 'undefined',
        action: 'Provider not created. Deploy the contract and configure the correct address.',
      });
      return undefined;
    }

    const approvedRouters = this.config.approvedRouters[chain] || [];
    const feeOverride = this.config.feeOverrides?.[chain] as 100 | 500 | 2500 | 10000 | undefined;

    return new PancakeSwapV3FlashLoanProvider({
      chain,
      poolAddress: flashLoanConfig.address, // Factory address for PancakeSwap V3
      contractAddress,
      approvedRouters,
      feeOverride,
    });
  }

  /**
   * Create Balancer V2 provider
   * Task 2.2: Balancer V2 flash loan support with 0% fees
   */
  private createBalancerV2Provider(
    chain: string,
    flashLoanConfig: { address: string; protocol: string; fee: number }
  ): BalancerV2FlashLoanProvider | undefined {
    const contractAddress = this.config.contractAddresses[chain];

    // FIX (Issue 1.2): Use centralized validation for both undefined and zero address
    if (!isValidContractAddress(contractAddress)) {
      const isZero = contractAddress === '0x0000000000000000000000000000000000000000';
      const level = isZero ? 'error' : 'warn';
      const message = isZero
        ? '[ERR_CONFIG] Zero contract address is invalid - BalancerV2FlashArbitrage not deployed'
        : 'No BalancerV2FlashArbitrage contract configured for Balancer V2 chain';

      this.logger[level](message, {
        chain,
        vaultAddress: flashLoanConfig.address,
        contractAddress: contractAddress || 'undefined',
        action: 'Provider not created. Deploy the contract and configure the correct address.',
      });
      return undefined;
    }

    const approvedRouters = this.config.approvedRouters[chain] || [];
    const feeOverride = this.config.feeOverrides?.[chain];

    return new BalancerV2FlashLoanProvider({
      chain,
      poolAddress: flashLoanConfig.address, // Vault address for Balancer V2
      contractAddress,
      approvedRouters,
      feeOverride,
    });
  }

  /**
   * Create SyncSwap provider
   * Task 3.4: SyncSwap flash loan support on zkSync Era with EIP-3156
   */
  private createSyncSwapProvider(
    chain: string,
    flashLoanConfig: { address: string; protocol: string; fee: number }
  ): SyncSwapFlashLoanProvider | undefined {
    const contractAddress = this.config.contractAddresses[chain];

    // FIX (Issue 1.2): Use centralized validation for both undefined and zero address
    if (!isValidContractAddress(contractAddress)) {
      const isZero = contractAddress === '0x0000000000000000000000000000000000000000';
      const level = isZero ? 'error' : 'warn';
      const message = isZero
        ? '[ERR_CONFIG] Zero contract address is invalid - SyncSwapFlashArbitrage not deployed'
        : 'No SyncSwapFlashArbitrage contract configured for SyncSwap chain';

      this.logger[level](message, {
        chain,
        vaultAddress: flashLoanConfig.address,
        contractAddress: contractAddress || 'undefined',
        note: 'Deploy SyncSwapFlashArbitrage.sol contract to enable SyncSwap flash loans',
        action: 'Provider not created. Deploy the contract and configure the correct address.',
      });
      return undefined;
    }

    const approvedRouters = this.config.approvedRouters[chain] || [];
    const feeOverride = this.config.feeOverrides?.[chain];

    return new SyncSwapFlashLoanProvider({
      chain,
      poolAddress: flashLoanConfig.address, // Vault address for SyncSwap
      contractAddress,
      approvedRouters,
      feeOverride,
    });
  }

  /**
   * Check if a chain has a fully supported flash loan provider
   *
   * @param chain - Chain identifier
   * @returns True if chain has fully implemented flash loan support
   */
  isFullySupported(chain: string): boolean {
    const provider = this.getProvider(chain);
    if (!provider) return false;

    const capabilities = provider.getCapabilities();
    return capabilities.status === 'fully_supported';
  }

  /**
   * Get the protocol for a chain
   *
   * @param chain - Chain identifier
   * @returns Protocol name or undefined
   */
  getProtocol(chain: string): FlashLoanProtocol | undefined {
    return FLASH_LOAN_PROVIDERS[chain]?.protocol as FlashLoanProtocol | undefined;
  }

  /**
   * Get support status for a chain
   *
   * @param chain - Chain identifier
   * @returns Support status
   */
  getSupportStatus(chain: string): ProtocolSupportStatus {
    const provider = this.getProvider(chain);
    if (!provider) return 'not_implemented';

    return provider.getCapabilities().status;
  }

  /**
   * Get list of chains with full flash loan support
   *
   * @returns Array of chain identifiers
   */
  getFullySupportedChains(): string[] {
    // FIX (Issue 1.2): Use centralized validation helper
    const aaveChains = Array.from(AAVE_V3_SUPPORTED_CHAINS).filter(chain => {
      const contractAddress = this.config.contractAddresses[chain];
      return isValidContractAddress(contractAddress);
    });

    const balancerChains = Array.from(BALANCER_V2_SUPPORTED_CHAINS).filter(chain => {
      const contractAddress = this.config.contractAddresses[chain];
      return isValidContractAddress(contractAddress);
    });

    const pancakeSwapChains = Array.from(PANCAKESWAP_V3_SUPPORTED_CHAINS).filter(chain => {
      const contractAddress = this.config.contractAddresses[chain];
      return isValidContractAddress(contractAddress);
    });

    const syncSwapChains = Array.from(SYNCSWAP_SUPPORTED_CHAINS).filter(chain => {
      const contractAddress = this.config.contractAddresses[chain];
      return isValidContractAddress(contractAddress);
    });

    return [...aaveChains, ...balancerChains, ...pancakeSwapChains, ...syncSwapChains];
  }

  /**
   * Get list of chains with any flash loan configuration (including unsupported)
   *
   * @returns Array of chain identifiers
   */
  getAllConfiguredChains(): string[] {
    return Object.keys(FLASH_LOAN_PROVIDERS);
  }

  /**
   * Clear cached providers
   */
  clearCache(): void {
    this.providers.clear();
  }

  /**
   * Get summary of provider support status
   *
   * @returns Object mapping chains to their support status
   */
  getSupportSummary(): Record<string, {
    protocol: string;
    status: ProtocolSupportStatus;
    hasContract: boolean;
  }> {
    const summary: Record<string, {
      protocol: string;
      status: ProtocolSupportStatus;
      hasContract: boolean;
    }> = {};

    for (const chain of Object.keys(FLASH_LOAN_PROVIDERS)) {
      const config = FLASH_LOAN_PROVIDERS[chain];
      const contractAddress = this.config.contractAddresses[chain];
      // FIX (Issue 1.2): Use centralized validation helper
      const hasContract = isValidContractAddress(contractAddress);

      let status: ProtocolSupportStatus;
      if ((config.protocol === 'aave_v3' || config.protocol === 'balancer_v2' || config.protocol === 'pancakeswap_v3' || config.protocol === 'syncswap') && hasContract) {
        status = 'fully_supported';
      } else if (config.protocol === 'aave_v3' || config.protocol === 'balancer_v2' || config.protocol === 'pancakeswap_v3' || config.protocol === 'syncswap') {
        status = 'partial_support'; // Protocol supported but no contract deployed
      } else {
        status = 'not_implemented';
      }

      summary[chain] = {
        protocol: config.protocol,
        status,
        hasContract,
      };
    }

    return summary;
  }
}

/**
 * Create a flash loan provider factory
 *
 * @param logger - Logger instance
 * @param config - Provider configuration
 * @returns Provider factory instance
 */
export function createFlashLoanProviderFactory(
  logger: Logger,
  config: FlashLoanProviderConfig
): FlashLoanProviderFactory {
  return new FlashLoanProviderFactory(logger, config);
}

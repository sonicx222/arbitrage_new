/**
 * Flash Loan Providers
 *
 * Protocol-specific flash loan provider implementations.
 *
 * Fix 1.1: This module resolves the architecture mismatch between
 * FLASH_LOAN_PROVIDERS configuration (which defines multiple protocols)
 * and the previous FlashLoanStrategy implementation (which only supported Aave V3).
 *
 * ## Supported Protocols
 *
 * | Protocol       | Chains                            | Status             |
 * |----------------|-----------------------------------|--------------------||
 * | Aave V3        | ethereum, polygon, arbitrum,      | Fully Supported    |
 * |                | base, optimism, avalanche         |                    |
 * | Balancer V2    | ethereum, polygon, arbitrum,      | Fully Supported    |
 * |                | optimism, base, fantom            |                    |
 * | PancakeSwap V3 | bsc, ethereum, arbitrum, zksync,  | Fully Supported    |
 * |                | base, opbnb, linea                |                    |
 * | SyncSwap       | zksync (linea planned)            | Fully Supported    |
 * | SpookySwap     | fantom                            | Not Implemented    |
 *
 * ## Usage
 *
 * ```typescript
 * import { createFlashLoanProviderFactory } from './flash-loan-providers';
 *
 * const factory = createFlashLoanProviderFactory(logger, {
 *   contractAddresses: { ethereum: '0x...' },
 *   approvedRouters: { ethereum: ['0x...'] },
 * });
 *
 * const provider = factory.getProvider('ethereum');
 * if (provider?.isAvailable()) {
 *   const tx = provider.buildTransaction(request, from);
 *   // Execute transaction...
 * }
 * ```
 *
 * @see service-config.ts FLASH_LOAN_PROVIDERS
 * @see contracts/src/FlashLoanArbitrage.sol
 * @see contracts/src/PancakeSwapFlashArbitrage.sol
 */

// Types
export type {
  FlashLoanProtocol,
  ProtocolSupportStatus,
  FlashLoanRequest,
  FlashLoanSwapStep,
  FlashLoanResult,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
  IFlashLoanProvider,
  FlashLoanProviderConfig,
} from './types';

// Providers
export { AaveV3FlashLoanProvider } from './aave-v3.provider';
export { BalancerV2FlashLoanProvider } from './balancer-v2.provider';
export { PancakeSwapV3FlashLoanProvider } from './pancakeswap-v3.provider';
export { SyncSwapFlashLoanProvider } from './syncswap.provider';
export { UnsupportedFlashLoanProvider } from './unsupported.provider';

// Factory
export {
  FlashLoanProviderFactory,
  createFlashLoanProviderFactory,
} from './provider-factory';

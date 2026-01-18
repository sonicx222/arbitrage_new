/**
 * MEV Protection Module
 *
 * Provides MEV (Maximal Extractable Value) protection for arbitrage transactions
 * across different chains using chain-appropriate strategies:
 *
 * - **Flashbots** (Ethereum): Private bundle submission to Flashbots relay
 * - **BloXroute** (BSC): Private transaction submission via BloXroute
 * - **Fastlane** (Polygon): Polygon's MEV protection service
 * - **Sequencer** (L2s): Direct submission leveraging inherent L2 protection
 * - **Standard** (Others): Gas optimization for faster inclusion
 *
 * ## Usage
 *
 * ```typescript
 * import { MevProviderFactory, createMevProvider } from './mev-protection';
 *
 * // Option 1: Factory for managing multiple chains
 * const factory = new MevProviderFactory({
 *   enabled: true,
 *   flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY,
 *   fallbackToPublic: true,
 * });
 *
 * const provider = factory.createProvider({
 *   chain: 'ethereum',
 *   provider: ethersProvider,
 *   wallet: signer,
 * });
 *
 * const result = await provider.sendProtectedTransaction(tx);
 *
 * // Option 2: Direct provider creation
 * const ethereumProvider = createMevProvider(
 *   'ethereum',
 *   ethersProvider,
 *   signer,
 *   { flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY }
 * );
 * ```
 *
 * @module mev-protection
 */

// =============================================================================
// Main Exports
// =============================================================================

// Factory (primary entry point)
export {
  MevProviderFactory,
  MevGlobalConfig,
  ChainWalletConfig,
  createMevProvider,
  hasMevProtection,
  getRecommendedPriorityFee,
} from './factory';

// Provider implementations
export { FlashbotsProvider, createFlashbotsProvider } from './flashbots-provider';
export {
  L2SequencerProvider,
  createL2SequencerProvider,
  isL2SequencerChain,
  getL2ChainConfig,
} from './l2-sequencer-provider';
export { StandardProvider, createStandardProvider } from './standard-provider';

// Types
export {
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  FlashbotsBundle,
  BundleSimulationResult,
  MevMetrics,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
} from './types';

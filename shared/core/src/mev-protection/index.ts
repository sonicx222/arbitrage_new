/**
 * MEV Protection Module
 *
 * Provides MEV (Maximal Extractable Value) protection for arbitrage transactions
 * across different chains using chain-appropriate strategies:
 *
 * - **Flashbots** (Ethereum): Private bundle submission to Flashbots relay
 * - **Jito** (Solana): Private bundle submission to Jito Block Engine
 * - **BloXroute** (BSC): Private transaction submission via BloXroute
 * - **Fastlane** (Polygon): Polygon's MEV protection service
 * - **Sequencer** (L2s): Direct submission leveraging inherent L2 protection
 * - **Standard** (Others): Gas optimization for faster inclusion
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   MevProviderFactory,
 *   MevRiskAnalyzer,
 *   MempoolRecommendation,
 * } from './mev-protection';
 *
 * // Step 1: Analyze MEV risk before submission
 * const analyzer = new MevRiskAnalyzer();
 * const assessment = analyzer.assessRisk({
 *   chain: 'ethereum',
 *   valueUsd: 10000,
 *   slippageBps: 50,
 *   poolLiquidityUsd: 1_000_000,
 * });
 *
 * // Step 2: Create provider and send based on recommendation
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
 * if (assessment.mempoolRecommendation === MempoolRecommendation.PRIVATE) {
 *   // Use private bundle submission
 *   const result = await provider.sendProtectedTransaction(tx, {
 *     priorityFeeGwei: assessment.recommendedPriorityFeeGwei,
 *   });
 * }
 *
 * // For Solana (uses Solana-specific types)
 * import { createJitoProvider } from './mev-protection';
 *
 * const jitoProvider = createJitoProvider({
 *   chain: 'solana',
 *   connection: solanaConnection,
 *   keypair: solanaKeypair,
 *   enabled: true,
 *   tipLamports: assessment.recommendedTipLamports, // From analyzer
 * });
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

// Base class for custom provider implementations
export { BaseMevProvider } from './base-provider';

// Metrics manager for custom providers (REFACTOR: extracted common logic)
export {
  MevMetricsManager,
  createMevMetricsManager,
} from './metrics-manager';
export type { IncrementableMetricField } from './metrics-manager';

// Provider implementations
export { FlashbotsProvider, createFlashbotsProvider } from './flashbots-provider';
export { MevShareProvider, createMevShareProvider } from './mev-share-provider';
export {
  L2SequencerProvider,
  createL2SequencerProvider,
  isL2SequencerChain,
  getL2ChainConfig,
} from './l2-sequencer-provider';
export { StandardProvider, createStandardProvider } from './standard-provider';

// Jito provider for Solana MEV protection (Phase 1.2)
export {
  JitoProvider,
  createJitoProvider,
  JITO_DEFAULTS,
  JITO_TIP_ACCOUNTS,
} from './jito-provider';
export type {
  JitoProviderConfig,
  SolanaConnection,
  SolanaKeypair,
  SolanaPublicKey,
  SolanaTransaction,
} from './jito-provider';

// MEV Risk Analyzer (Phase 1.2.3)
export {
  MevRiskAnalyzer,
  createMevRiskAnalyzer,
  SandwichRiskLevel,
  MempoolRecommendation,
  MEV_RISK_DEFAULTS,
  // Config synchronization utilities
  validateConfigSync,
  getLocalChainPriorityFees,
} from './mev-risk-analyzer';
export type {
  TransactionContext,
  MevRiskAssessment,
  MevRiskAnalyzerConfig,
  ConfigSyncValidationResult,
  ConfigMismatch,
} from './mev-risk-analyzer';

// Types
export {
  // EVM types
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  FlashbotsBundle,
  BundleSimulationResult,
  MevMetrics,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
  // MEV-Share types
  MevShareHints,
  MevShareOptions,
  MevShareSubmissionResult,
  // Solana types (for type-safe Jito usage)
  ISolanaMevProvider,
  SolanaTransactionLike,
} from './types';

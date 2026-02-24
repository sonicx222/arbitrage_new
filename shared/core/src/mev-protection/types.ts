/**
 * MEV Protection Types and Interfaces
 *
 * Provides abstractions for MEV protection across different chains:
 * - Flashbots for Ethereum mainnet
 * - Jito for Solana (private bundles with validator tips)
 * - BloXroute for BSC
 * - Fastlane for Polygon
 * - Direct sequencer submission for L2s (inherent MEV protection)
 * - Standard submission with optimizations for other chains
 *
 * Architecture:
 * - IMevProvider: Interface for EVM-based chains (ethers.js types)
 * - ISolanaMevProvider: Interface for Solana (Solana-specific types)
 * - MevProviderFactory: Factory for creating EVM providers
 * - JitoProvider: Solana provider (use createJitoProvider directly)
 *
 * @see Phase 2: MEV Protection in implementation plan
 */

import { ethers } from 'ethers';
import type { Keypair } from '@solana/web3.js';

// =============================================================================
// Types
// =============================================================================

/**
 * MEV protection strategy for a specific chain
 */
export type MevStrategy =
  | 'flashbots'          // Ethereum: Flashbots private bundle
  | 'bloxroute'          // BSC: BloXroute private transaction
  | 'fastlane'           // Polygon: Fastlane MEV protection
  | 'sequencer'          // L2s: Direct sequencer (inherent protection)
  | 'jito'               // Solana: Jito private bundles
  | 'timeboost'          // Arbitrum: Timeboost express lane auction
  | 'flashbots_protect'  // Base: Flashbots Protect L2 RPC
  | 'standard';          // Fallback: Standard with gas optimization

/**
 * Result of a protected transaction submission
 */
export interface MevSubmissionResult {
  /** Whether submission was successful */
  success: boolean;
  /** Transaction hash if successful */
  transactionHash?: string;
  /** Bundle hash for Flashbots */
  bundleHash?: string;
  /** Block number where tx was included */
  blockNumber?: number;
  /** Error message if failed */
  error?: string;
  /** Strategy used for submission */
  strategy: MevStrategy;
  /** Time taken for submission in ms */
  latencyMs: number;
  /** Whether fallback was used */
  usedFallback: boolean;
}

/**
 * Configuration for MEV provider
 */
export interface MevProviderConfig {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
  /** Standard JSON RPC provider */
  provider: ethers.JsonRpcProvider;
  /** Wallet for signing transactions */
  wallet: ethers.Wallet;
  /** Whether MEV protection is enabled */
  enabled: boolean;
  /** Flashbots auth signing key (for Ethereum) */
  flashbotsAuthKey?: string;
  /** BloXroute auth header (for BSC) */
  bloxrouteAuthHeader?: string;
  /** Custom Flashbots relay URL */
  flashbotsRelayUrl?: string;
  /** Timeout for protected submission in ms */
  submissionTimeoutMs?: number;
  /** Maximum retries for bundle submission */
  maxRetries?: number;
  /** Whether to fallback to public mempool on failure */
  fallbackToPublic?: boolean;
  /** Chain ID override (fetched from provider if not specified) */
  chainId?: number;
  /**
   * Use MEV-Share for Ethereum (rebate capture).
   *
   * MEV-Share enables capturing 50-90% of MEV value as rebates by allowing
   * searchers to backrun transactions while sharing profits.
   *
   * When enabled:
   * - Transactions submit to MEV-Share endpoint first
   * - Falls back to standard Flashbots if MEV-Share fails
   * - Rebate information tracked in submission result
   *
   * Default: true (MEV-Share enabled for value capture)
   * Set to false to use standard Flashbots without rebates.
   *
   * @see https://docs.flashbots.net/flashbots-mev-share/overview
   */
  useMevShare?: boolean;
  /**
   * Timeboost express lane URL for Arbitrum MEV protection.
   *
   * Timeboost is Arbitrum's express lane auction mechanism that allows
   * transactions to bypass the standard sequencer queue for faster inclusion.
   *
   * @see https://docs.arbitrum.io/timeboost
   */
  timeboostExpressLaneUrl?: string;
  /**
   * Flashbots Protect L2 RPC URL for Base MEV protection.
   *
   * Flashbots Protect provides private transaction submission on Base,
   * preventing frontrunning by hiding transactions from the public mempool.
   *
   * @see https://docs.flashbots.net/flashbots-protect/overview
   */
  flashbotsProtectL2Url?: string;
}

/**
 * Bundle for Flashbots submission
 */
export interface FlashbotsBundle {
  /** Signed transactions in the bundle */
  signedTransactions: string[];
  /** Target block number */
  blockNumber: number;
  /** Minimum timestamp for inclusion */
  minTimestamp?: number;
  /** Maximum timestamp for inclusion */
  maxTimestamp?: number;
}

/**
 * Simulation result for Flashbots bundle
 */
export interface BundleSimulationResult {
  /** Whether simulation was successful */
  success: boolean;
  /** Simulated profit in wei */
  profit?: bigint;
  /** Gas used by bundle */
  gasUsed?: bigint;
  /** Effective gas price */
  effectiveGasPrice?: bigint;
  /** Coinbase transfer amount */
  coinbaseDiff?: bigint;
  /** Error if simulation failed */
  error?: string;
  /** Individual transaction results */
  results?: Array<{
    txHash: string;
    gasUsed: bigint;
    success: boolean;
    revertReason?: string;
  }>;
}

/**
 * MEV-Share hint configuration
 *
 * Controls what transaction information is revealed to searchers.
 * Balance privacy (hiding parameters) with value capture (allowing
 * searchers to identify opportunities).
 *
 * @see https://docs.flashbots.net/flashbots-mev-share/searchers/understanding-bundles
 */
export interface MevShareHints {
  /** Reveal contract address to searchers */
  contractAddress: boolean;
  /** Reveal function selector (first 4 bytes of calldata) */
  functionSelector: boolean;
  /** Reveal event logs */
  logs: boolean;
  /** Reveal full calldata */
  calldata: boolean;
  /** Reveal transaction hash */
  hash: boolean;
  /** Reveal transaction value (ETH amount) */
  txValue: boolean;
}

/**
 * MEV-Share submission options
 */
export interface MevShareOptions {
  /** Hint configuration (what to reveal to searchers) */
  hints?: MevShareHints;
  /** Minimum rebate percentage to accept (0-100) */
  minRebatePercent?: number;
  /** Maximum block number for bundle inclusion */
  maxBlockNumber?: number;
}

/**
 * MEV-Share submission result (extends standard result with rebate info)
 */
export interface MevShareSubmissionResult extends MevSubmissionResult {
  /** Rebate amount in wei (if any) */
  rebateAmount?: bigint;
  /** Rebate percentage (0-100) */
  rebatePercent?: number;
  /** MEV-Share bundle ID for tracking */
  bundleId?: string;
  /** Whether MEV-Share was used (vs standard Flashbots) */
  usedMevShare?: boolean;
}

/**
 * MEV protection metrics
 */
export interface MevMetrics {
  /** Total submissions attempted */
  totalSubmissions: number;
  /** Successful submissions */
  successfulSubmissions: number;
  /** Failed submissions */
  failedSubmissions: number;
  /** Submissions that used fallback */
  fallbackSubmissions: number;
  /** Average latency in ms */
  averageLatencyMs: number;
  /** Bundles included in block (Flashbots) */
  bundlesIncluded: number;
  /** Bundles that reverted (Flashbots) */
  bundlesReverted: number;
  /** MEV-Share rebates received (counter) */
  mevShareRebatesReceived: number;
  /** Total rebate amount in wei (accumulated) */
  totalRebateWei: bigint;
  /** Average rebate percentage (0-100) */
  averageRebatePercent: number;
  /** BloXroute submissions (BSC) - Task 1.3 */
  bloxrouteSubmissions: number;
  /** Fastlane submissions (Polygon) - Task 1.3 */
  fastlaneSubmissions: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Interface for EVM MEV protection providers
 *
 * Implementations handle chain-specific MEV protection strategies:
 * - FlashbotsProvider: Ethereum private bundles
 * - L2SequencerProvider: Direct sequencer submission for L2s
 * - StandardProvider: Optimized standard submission (BSC, Polygon, others)
 *
 * NOTE: For Solana, use ISolanaMevProvider / JitoProvider instead.
 * Solana uses different transaction types (not ethers.TransactionRequest).
 */
export interface IMevProvider {
  /**
   * Get the chain this provider handles
   */
  readonly chain: string;

  /**
   * Get the MEV strategy used
   */
  readonly strategy: MevStrategy;

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean;

  /**
   * Send a transaction with MEV protection
   *
   * @param tx - Transaction request to send
   * @param options - Optional parameters for submission
   * @returns Submission result with transaction details
   */
  sendProtectedTransaction(
    tx: ethers.TransactionRequest,
    options?: {
      /** Target block for bundle (Flashbots) */
      targetBlock?: number;
      /** Whether to simulate before submission */
      simulate?: boolean;
      /** Priority fee override */
      priorityFeeGwei?: number;
    }
  ): Promise<MevSubmissionResult>;

  /**
   * Simulate a transaction/bundle without submitting
   *
   * @param tx - Transaction to simulate
   * @returns Simulation result
   */
  simulateTransaction(
    tx: ethers.TransactionRequest
  ): Promise<BundleSimulationResult>;

  /**
   * Get current metrics for this provider
   */
  getMetrics(): MevMetrics;

  /**
   * Reset metrics
   */
  resetMetrics(): void;

  /**
   * Check connection/health of the MEV provider
   */
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

// =============================================================================
// Chain Configuration
// =============================================================================

/**
 * MEV strategy per chain
 */
export const CHAIN_MEV_STRATEGIES: Record<string, MevStrategy> = {
  // Mainnet chains requiring private bundles
  ethereum: 'flashbots',
  bsc: 'bloxroute',
  polygon: 'fastlane',

  // Solana with Jito MEV protection
  solana: 'jito',

  // L2s with enhanced MEV protection (Batch 5)
  arbitrum: 'timeboost',           // Timeboost express lane auction
  base: 'flashbots_protect',       // Flashbots Protect L2 RPC

  // L2s with sequencer-based ordering (inherent MEV protection)
  optimism: 'sequencer',
  zksync: 'sequencer',
  linea: 'sequencer',

  // Standard chains (limited MEV protection)
  avalanche: 'standard',
  fantom: 'standard',
};

/**
 * Phase 4: Multi-MEV Provider Fallback Stack
 *
 * Fallback strategies per chain for when primary MEV provider fails.
 * Research impact: +2-3% execution success rate through redundancy.
 *
 * Fallback Order (per chain):
 * - Primary provider fails → Try secondary provider
 * - Secondary fails → Try tertiary (if available)
 * - All MEV providers fail → Fall back to public mempool
 *
 * @see ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 2.2 - Multi-Provider MEV Protection Stack
 */
export const CHAIN_MEV_FALLBACK_STRATEGIES: Record<string, MevStrategy[]> = {
  // Ethereum: Flashbots → MEV Blocker (standard) → Public mempool
  ethereum: ['flashbots', 'standard'],

  // BSC: BloXroute → Standard (public mempool with optimizations)
  bsc: ['bloxroute', 'standard'],

  // Polygon: Fastlane → Standard
  polygon: ['fastlane', 'standard'],

  // L2s with enhanced MEV protection (Batch 5)
  // Timeboost → Sequencer → Standard
  arbitrum: ['timeboost', 'sequencer', 'standard'],
  // Flashbots Protect → Sequencer → Standard
  base: ['flashbots_protect', 'sequencer', 'standard'],

  // L2s with sequencer-based ordering (inherent MEV protection)
  optimism: ['sequencer', 'standard'],
  zksync: ['sequencer', 'standard'],
  linea: ['sequencer', 'standard'],

  // Standard chains - no fallback needed (already at lowest level)
  avalanche: ['standard'],
  fantom: ['standard'],

  // Solana - Jito is primary, standard fallback
  solana: ['jito', 'standard'],
};

/**
 * Default configuration values
 */
export const MEV_DEFAULTS = {
  submissionTimeoutMs: 30000,
  maxRetries: 3,
  fallbackToPublic: true,
  flashbotsRelayUrl: 'https://relay.flashbots.net',
  bloxrouteUrl: 'https://mev.api.blxrbdn.com',
  fastlaneUrl: 'https://fastlane-rpc.polygon.technology',
};

// =============================================================================
// Solana Interface
// =============================================================================

/**
 * Generic transaction type for Solana
 *
 * This is a minimal interface - the actual Solana transaction type from
 * @solana/web3.js has more properties, but this captures what JitoProvider needs.
 */
export interface SolanaTransactionLike {
  serialize(): Buffer | Uint8Array;
}

/**
 * Interface for Solana MEV protection providers
 *
 * Separate from IMevProvider because Solana uses fundamentally different
 * transaction and connection types (not ethers.js).
 *
 * Implementations:
 * - JitoProvider: Jito private bundles with validator tips
 */
export interface ISolanaMevProvider {
  /**
   * Get the chain this provider handles (always 'solana')
   */
  readonly chain: string;

  /**
   * Get the MEV strategy used (always 'jito')
   */
  readonly strategy: MevStrategy;

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean;

  /**
   * Send a Solana transaction with Jito MEV protection
   *
   * @param tx - Solana transaction to send
   * @param options - Optional parameters for submission
   * @returns Submission result with transaction details
   */
  sendProtectedTransaction(
    tx: SolanaTransactionLike,
    options?: {
      /** Tip amount in lamports for Jito validators */
      tipLamports?: number;
      /** Whether to simulate before submission */
      simulate?: boolean;
    }
  ): Promise<MevSubmissionResult>;

  /**
   * Simulate a Solana transaction without submitting
   *
   * @param tx - Transaction to simulate
   * @returns Simulation result
   */
  simulateTransaction(
    tx: SolanaTransactionLike
  ): Promise<BundleSimulationResult>;

  /**
   * Get current metrics for this provider
   */
  getMetrics(): MevMetrics;

  /**
   * Reset metrics
   * Note: Sync to match IMevProvider interface. Object assignment is atomic in JS.
   */
  resetMetrics(): void;

  /**
   * Check connection/health of the Jito provider
   */
  healthCheck(): Promise<{ healthy: boolean; message: string }>;

  /**
   * Get the wallet keypair for bundle transaction signing (optional).
   *
   * When available, SolanaExecutionStrategy uses this to build signed
   * bundle transactions via SolanaTransactionBuilder. When absent,
   * the strategy falls back to submitting the raw Jupiter swap tx
   * through sendProtectedTransaction (which handles signing internally).
   *
   * @returns Solana Keypair for signing, or undefined if not available
   */
  getWalletKeypair?(): Keypair | undefined;
}

/**
 * Solana Module
 *
 * Solana blockchain-specific detection and parsing utilities:
 * - SolanaDetector: Base infrastructure for Solana detection (legacy class)
 * - Modular components (ADR-014): pool-manager, connection-pool,
 *   subscription-manager, price-publisher, arbitrage-detector, health-monitor
 * - SolanaSwapParser: DEX swap instruction parsing
 * - SolanaPriceFeed: Real-time price updates from Solana pools
 * - Pool Parsers: Modular per-DEX pool state parsing
 *
 * @module solana
 */

// =============================================================================
// Solana Detector (S3.3.1) — Legacy class, still used by existing consumers
// =============================================================================

export {
  SolanaDetector,
  SOLANA_DEX_PROGRAMS
} from './solana-detector';

export type {
  SolanaDetectorLogger,
  SolanaDetectorPerfLogger,
  SolanaDetectorRedisClient,
  SolanaDetectorStreamsClient,
  SolanaDetectorDeps,
  SolanaDetectorConfig,
  ConnectionPoolConfig,
  ProgramSubscription,
  SolanaTokenInfo,
  SolanaPool,
  SolanaPriceUpdate,
  ConnectionMetrics,
  SolanaDetectorHealth
} from './solana-detector';

// =============================================================================
// Modular Detector Components (ADR-014)
// =============================================================================

// Shared types (canonical source for all module types)
export {
  SOLANA_DEX_PROGRAMS as SOLANA_DEX_PROGRAMS_MODULAR,
  SOLANA_DEFAULT_GAS_ESTIMATE
} from './solana-types';

export type {
  SolanaPriceUpdateBatcher,
  SolanaLifecycleDeps
} from './solana-types';

// Pool Manager
export { createSolanaPoolManager } from './solana-pool-manager';
export type { SolanaPoolManager } from './solana-pool-manager';

// Connection Pool
export { createSolanaConnectionPool } from './solana-connection-pool';
export type { SolanaConnectionPool, ConnectionPoolInitConfig, ConnectionPoolDeps } from './solana-connection-pool';

// Subscription Manager
export { createSolanaSubscriptionManager } from './solana-subscription-manager';
export type { SolanaSubscriptionManager, SubscriptionManagerDeps } from './solana-subscription-manager';

// Price Publisher
export { createSolanaPricePublisher } from './solana-price-publisher';
export type { SolanaPricePublisher } from './solana-price-publisher';

// Arbitrage Detector
export { createSolanaArbitrageDetector } from './solana-arbitrage-detector';
export type { SolanaArbitrageDetectorModule, ArbitrageDetectorConfig, ArbitrageDetectorDeps } from './solana-arbitrage-detector';

// Health Monitor
export { createSolanaHealthMonitor } from './solana-health-monitor';
export type { SolanaHealthMonitor, HealthMonitorConfig, HealthMonitorDeps } from './solana-health-monitor';

// =============================================================================
// Solana Swap Parser (S3.3.4)
// =============================================================================

export {
  SolanaSwapParser,
  getSolanaSwapParser,
  resetSolanaSwapParser,
  SOLANA_DEX_PROGRAM_IDS,
  PROGRAM_ID_TO_DEX,
  SWAP_DISCRIMINATORS,
  DISABLED_DEXES
} from './solana-swap-parser';

export type {
  InstructionAccount,
  SolanaInstruction,
  SolanaTransaction,
  TokenBalance,
  ParsedSolanaSwap,
  SwapParserConfig,
  ParserStats
} from './solana-swap-parser';

// =============================================================================
// Solana Price Feed (S3.3.5)
// =============================================================================

export {
  SolanaPriceFeed,
  RAYDIUM_AMM_LAYOUT,
  RAYDIUM_CLMM_LAYOUT,
  ORCA_WHIRLPOOL_LAYOUT,
  SOLANA_DEX_PROGRAMS as SOLANA_DEX_PROGRAMS_PRICE_FEED
} from './solana-price-feed';

export type {
  SolanaPriceFeedLogger,
  SolanaPriceFeedConfig,
  SolanaPriceFeedDeps,
  RaydiumAmmPoolState,
  RaydiumClmmPoolState,
  OrcaWhirlpoolState,
  SolanaPriceUpdate as SolanaPriceUpdateFromFeed,
  PoolSubscription,
  SupportedDex
} from './solana-price-feed';

// =============================================================================
// Pool Parsers (R11 - Modular extraction)
// =============================================================================

export {
  // Shared utilities
  readU128LE,
  readPubkey,
  safeInversePrice,
  calculateClmmPriceFromSqrt,
  tickToPrice,
  priceToTick,
  // Raydium AMM
  parseRaydiumAmmState,
  calculateAmmPrice,
  parseRaydiumAmmPriceUpdate,
  // Raydium CLMM
  parseRaydiumClmmState,
  calculateClmmPrice,
  parseRaydiumClmmPriceUpdate,
  // Orca Whirlpool
  parseOrcaWhirlpoolState,
  calculateWhirlpoolPrice,
  parseOrcaWhirlpoolPriceUpdate
} from './pricing/pool-parsers';

export type {
  PoolParserLogger,
  BaseParsedPoolState,
  ParsedPriceData,
  PoolParser
} from './pricing/pool-parsers';

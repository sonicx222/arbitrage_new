/**
 * Analytics Module
 *
 * Price intelligence and market analysis utilities including:
 * - PriceMomentum: T2.7 momentum detection
 * - MLOpportunityScorer: T2.8 ML-based opportunity scoring
 * - WhaleActivityTracker: T3.12 enhanced whale detection
 * - LiquidityDepthAnalyzer: T3.15 slippage estimation
 * - SwapEventFilter: Volume filtering and whale alerts
 * - PerformanceAnalytics: Strategy attribution analysis
 * - ProfessionalQualityMonitor: AD-PQS scoring system
 * - PriceOracle: Centralized price source with fallbacks
 * - PairActivityTracker: Volatility-based pair prioritization
 * - CexDexSpreadCalculator: CEX vs DEX spread detection
 *
 * @module analytics
 */

// Price Momentum (T2.7)
export {
  PriceMomentumTracker,
  getPriceMomentumTracker,
  resetPriceMomentumTracker
} from './price-momentum';
export type {
  MomentumSignal,
  MomentumConfig,
  PairStats
} from './price-momentum';

// ML Opportunity Scorer (T2.8)
export {
  MLOpportunityScorer,
  getMLOpportunityScorer,
  resetMLOpportunityScorer,
  toOrderflowSignal
} from './ml-opportunity-scorer';
export type {
  MLPrediction,
  MLScorerConfig,
  OpportunityScoreInput,
  OpportunityWithMomentum,
  OpportunityWithOrderflow,
  OpportunityWithAllSignals,
  EnhancedScore,
  EnhancedScoreWithOrderflow,
  ScorerStats,
  OrderflowSignal,
  OrderflowPredictionInput
} from './ml-opportunity-scorer';

// Whale Activity Tracker (T3.12)
export {
  WhaleActivityTracker,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from './whale-activity-tracker';
export type {
  WhaleTrackerConfig,
  TrackedWhaleTransaction,
  WalletProfile,
  WalletPattern,
  WhaleSignal,
  WhaleActivitySummary,
  WhaleTrackerStats
} from './whale-activity-tracker';

// Liquidity Depth Analyzer (T3.15)
export {
  LiquidityDepthAnalyzer,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from './liquidity-depth-analyzer';
export type {
  AmmType,
  LiquidityDepthConfig,
  PoolLiquidity,
  LiquidityLevel,
  DepthAnalysis,
  SlippageEstimate,
  LiquidityAnalyzerStats
} from './liquidity-depth-analyzer';

// Swap Event Filter
export {
  SwapEventFilter,
  getSwapEventFilter,
  resetSwapEventFilter
} from './swap-event-filter';
export type {
  SwapEventFilterConfig,
  FilterResult,
  FilterReason,
  VolumeAggregate,
  WhaleAlert,
  FilterStats,
  BatchResult
} from './swap-event-filter';

// Performance Analytics
export {
  PerformanceAnalyticsEngine
} from './performance-analytics';
export type {
  TradeRecord,
  PerformanceReport,
  PerformanceMetrics,
  StrategyPerformance,
  AssetPerformance,
  TimePerformance,
  BenchmarkComparison,
  AttributionAnalysis
} from './performance-analytics';

// Professional Quality Monitor (AD-PQS)
export {
  ProfessionalQualityMonitor
} from './professional-quality-monitor';
export type {
  DetectionResult,
  ProfessionalQualityScore,
  QualityMetrics,
  QualityMonitorDeps,
  QualityMonitorRedis
} from './professional-quality-monitor';

// Price Oracle
export {
  PriceOracle,
  getPriceOracle,
  resetPriceOracle,
  getDefaultPrice,
  hasDefaultPrice
} from './price-oracle';
export type {
  TokenPrice,
  PriceOracleConfig,
  PriceBatchRequest
} from './price-oracle';

// Pair Activity Tracker (Volatility-based prioritization)
export {
  PairActivityTracker,
  getPairActivityTracker,
  resetPairActivityTracker
} from './pair-activity-tracker';
export type {
  ActivityTrackerConfig,
  PairActivityMetrics,
  ActivityTrackerStats
} from './pair-activity-tracker';

// Orderflow Pipeline Consumer (Fix 5)
export {
  OrderflowPipelineConsumer,
  getOrderflowPipelineConsumer,
  resetOrderflowPipelineConsumer
} from './orderflow-pipeline-consumer';
export type {
  OrderflowPipelineConsumerConfig,
  OrderflowPipelineConsumerDeps
} from './orderflow-pipeline-consumer';

// Pair Correlation Tracker (Statistical Arbitrage)
export {
  PairCorrelationTracker
} from './pair-correlation-tracker';
export type {
  CorrelationConfig
} from './pair-correlation-tracker';

// Spread Tracker with Bollinger Bands (Statistical Arbitrage)
export {
  SpreadTracker
} from './spread-tracker';
export type {
  SpreadSignal,
  SpreadConfig,
  BollingerBands
} from './spread-tracker';

// Regime Detector - Hurst Exponent (Statistical Arbitrage)
export {
  RegimeDetector
} from './regime-detector';
export type {
  Regime,
  RegimeConfig
} from './regime-detector';

// CEX-DEX Spread Calculator (CEX Price Signals)
export {
  CexDexSpreadCalculator
} from './cex-dex-spread';
export type {
  SpreadAlert,
  CexDexSpreadConfig,
  SpreadHistoryPoint
} from './cex-dex-spread';

// Known Router Addresses (whale alert false-positive filtering)
export {
  getKnownRouterAddresses,
  _resetKnownRouterCache
} from './known-router-addresses';

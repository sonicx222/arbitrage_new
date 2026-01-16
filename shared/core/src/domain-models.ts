// Domain Models - Clean Architecture Foundation
// Extracted from monolithic services for better maintainability
//
// P1-3 FIX (2026-01-16): Type Consolidation
// IMPORTANT: These types are intentionally prefixed with "Rich" to distinguish them
// from the simpler types in shared/types/index.ts:
// - shared/types/index.ts: Used by detectors, publishers, and message passing (simple, flat)
// - domain-models.ts: Used by repositories and execution engine (rich, nested objects)
//
// The "Rich" prefix indicates these types have full object references (Token, Dex, Chain)
// rather than string identifiers. Use the appropriate type for your context:
// - For Redis Streams messages: import from @arbitrage/types
// - For database operations: import from ./domain-models

/**
 * Rich trading pair with full object references.
 * Use Pair from @arbitrage/types for message passing.
 */
export interface RichTradingPair {
  id: string;
  baseToken: RichToken;
  quoteToken: RichToken;
  dex: RichDex;
  address: string;
  liquidity: string;
  fee: number; // in basis points
}

/**
 * @deprecated Use ArbitrageOpportunity from @arbitrage/types for new code.
 * This type is kept for backward compatibility with repositories.
 */
export interface RichArbitrageOpportunity {
  id: string;
  pair: RichTradingPair;
  profitPercentage: number;
  buyPrice: number;
  sellPrice: number;
  buyDex: RichDex;
  sellDex: RichDex;
  gasEstimate: number;
  estimatedProfit: string; // in wei/ether
  confidence: number;
  timestamp: Date;
  chain: RichChain;
  route: ArbitrageRoute;
  metadata: OpportunityMetadata;
}

// Legacy aliases for backward compatibility with repositories.ts
// TODO: Migrate repositories.ts to use RichArbitrageOpportunity directly
export type TradingPair = RichTradingPair;
export type ArbitrageOpportunity = RichArbitrageOpportunity;

export interface ArbitrageRoute {
  steps: ArbitrageStep[];
  totalGas: number;
  estimatedTime: number;
  risk: ArbitrageRisk;
}

export interface ArbitrageStep {
  type: 'buy' | 'sell' | 'bridge';
  dex?: Dex;
  tokenIn: Token;
  tokenOut: Token;
  amount: string;
  expectedPrice: number;
}

export interface ArbitrageRisk {
  impermanentLoss: number;
  slippage: number;
  executionFailure: number;
  sandwichAttack: number;
  overall: number;
}

export interface OpportunityMetadata {
  source: 'websocket' | 'mempool' | 'api';
  detectionLatency: number;
  marketConditions: MarketConditions;
  whaleActivity?: WhaleActivity;
}

export interface MarketConditions {
  volatility: number;
  liquidity: number;
  gasPrice: number;
  networkCongestion: number;
}

export interface WhaleActivity {
  address: string;
  amount: string;
  impact: number;
  timestamp: Date;
}

export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  executedAt: Date;
  gasUsed: number;
  gasPrice: number;
  actualProfit: string;
  transactionHash?: string;
  error?: ExecutionFailure;
  metadata: ExecutionMetadata;
}

export interface ExecutionFailure {
  type: 'slippage' | 'gas' | 'network' | 'insufficient_funds' | 'timeout';
  message: string;
  details: any;
  recoverable: boolean;
}

export interface ExecutionMetadata {
  executionTime: number;
  retryCount: number;
  flashLoanUsed: boolean;
  gasStrategy: 'aggressive' | 'normal' | 'conservative';
}

// Value Objects
// P1-3 FIX: Prefixed with "Rich" to avoid conflicts with shared/types
/**
 * Rich token with extended metadata.
 * Use Token from @arbitrage/types for message passing.
 */
export interface RichToken {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  chainId: number;
  coingeckoId?: string;
}

/**
 * Rich DEX with chain reference and version.
 * Use Dex from @arbitrage/types for message passing.
 */
export interface RichDex {
  id: string;
  name: string;
  factory: string;
  router: string;
  fee: number; // in basis points
  version: 'v2' | 'v3';
  chain: RichChain;
}

/**
 * Rich chain with explorer configuration.
 * Use Chain from @arbitrage/types for message passing.
 */
export interface RichChain {
  id: number;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  blockTime: number;
  nativeToken: RichToken;
  explorers: ChainExplorer[];
}

// Legacy aliases for backward compatibility
export type Token = RichToken;
export type Dex = RichDex;
export type Chain = RichChain;

export interface ChainExplorer {
  name: string;
  url: string;
  apiUrl?: string;
}

// Events
export interface MarketEvent {
  id: string;
  type: 'swap' | 'liquidity_add' | 'liquidity_remove' | 'price_update';
  chain: Chain;
  timestamp: Date;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface SwapEvent extends MarketEvent {
  type: 'swap';
  pair: TradingPair;
  sender: string;
  recipient: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  price: number;
  priceImpact: number;
}

export interface LiquidityEvent extends MarketEvent {
  pair: TradingPair;
  sender: string;
  amount0: string;
  amount1: string;
  liquidity: string;
}

export interface PriceUpdateEvent extends MarketEvent {
  type: 'price_update';
  pair: TradingPair;
  price: number;
  volume24h: string;
  liquidity: string;
}

// Configuration
export interface ArbitrageConfig {
  minProfitPercentage: number;
  maxSlippage: number;
  maxGasPrice: number;
  flashLoanEnabled: boolean;
  crossChainEnabled: boolean;
  triangularArbitrageEnabled: boolean;
  statisticalArbitrageEnabled: boolean;
  maxConcurrentExecutions: number;
  executionTimeout: number;
  riskManagement: RiskConfig;
}

export interface RiskConfig {
  maxPortfolioAllocation: number;
  maxSingleTrade: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
  maxDrawdown: number;
  volatilityThreshold: number;
}

// Service Interfaces
export interface IArbitrageDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
  getActiveOpportunities(): Promise<ArbitrageOpportunity[]>;
  processEvent(event: MarketEvent): Promise<void>;
  on(event: string, callback: (...args: any[]) => void): void;
  off(event: string, callback: (...args: any[]) => void): void;
}

export interface IArbitrageExecutor {
  execute(opportunity: ArbitrageOpportunity): Promise<ExecutionResult>;
  estimateGas(opportunity: ArbitrageOpportunity): Promise<number>;
  validateExecution(opportunity: ArbitrageOpportunity): Promise<boolean>;
}

export interface IPriceFeed {
  getPrice(pair: TradingPair): Promise<number>;
  subscribeToPrice(pair: TradingPair, callback: (price: number) => void): string;
  unsubscribe(subscriptionId: string): void;
}

export interface IArbitrageRepository {
  save(opportunity: ArbitrageOpportunity): Promise<void>;
  findById(id: string): Promise<ArbitrageOpportunity | null>;
  findActive(): Promise<ArbitrageOpportunity[]>;
  findByChain(chain: Chain): Promise<ArbitrageOpportunity[]>;
  updateStatus(id: string, status: 'active' | 'executed' | 'expired'): Promise<void>;
  deleteExpired(olderThan: Date): Promise<number>;
}

export interface IExecutionRepository {
  save(result: ExecutionResult): Promise<void>;
  getByOpportunityId(opportunityId: string): Promise<ExecutionResult | null>;
  getRecentExecutions(limit: number): Promise<ExecutionResult[]>;
  getSuccessRate(timeRange: number): Promise<number>;
}

// Factory Interfaces
export interface IDetectorFactory {
  createDetector(chain: Chain, config: ArbitrageConfig): IArbitrageDetector;
}

export interface IExecutorFactory {
  createExecutor(chain: Chain, config: ArbitrageConfig): IArbitrageExecutor;
}

// Error Classes
export class ArbitrageError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = 'ArbitrageError';
  }
}

export class ExecutionError extends ArbitrageError {
  constructor(
    code: string,
    message: string,
    public opportunityId: string,
    details?: any
  ) {
    super(code, message, details, false);
    this.name = 'ExecutionError';
  }
}

export class ConfigurationError extends Error {
  constructor(
    public key: string,
    message: string,
    public defaultValue?: any
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// Utility Types
export type ChainId = 1 | 56 | 137 | 42161 | 8453 | 10; // Ethereum, BSC, Polygon, Arbitrum, Base, Optimism
export type DexName = 'uniswap_v2' | 'uniswap_v3' | 'pancake' | 'sushiswap' | 'quickswap';
export type ArbitrageStrategy = 'simple' | 'triangular' | 'cross_chain' | 'statistical';

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
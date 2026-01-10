// Shared types for the arbitrage detection system

export interface Chain {
  id: number;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  blockTime: number;
  nativeToken: string;
}

export interface Dex {
  name: string;
  chain: string;
  factoryAddress: string;
  routerAddress: string;
  fee: number; // in basis points (e.g., 25 = 0.25%)
  enabled?: boolean; // Optional: defaults to true if not specified
}

export interface Token {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

// Base Pair interface for detector services (uses string references)
export interface Pair {
  name?: string;
  address: string;
  token0: string; // Token address
  token1: string; // Token address
  dex: string;    // DEX name
  fee?: number;   // Fee in basis points
  reserve0?: string;
  reserve1?: string;
  blockNumber?: number;
  lastUpdate?: number;
}

// Full Pair interface with complete token/dex objects (for analysis)
export interface PairFull {
  address: string;
  token0: Token;
  token1: Token;
  dex: Dex;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

export interface PriceUpdate {
  pairKey: string;
  dex: string;
  chain: string;
  token0: string;
  token1: string;
  price: number; // token1 per token0
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
  latency: number;
}

export interface ArbitrageOpportunity {
  id: string;
  type: 'simple' | 'cross-dex' | 'triangular' | 'cross-chain' | 'predictive';
  chain?: string;        // Single chain for same-chain arbitrage
  buyDex: string;
  sellDex: string;
  buyChain?: string;     // Optional for same-chain arbitrage
  sellChain?: string;
  buyPair?: string;      // Pair address for buy side
  sellPair?: string;     // Pair address for sell side
  token0?: string;       // Token addresses (alternative to tokenIn/tokenOut)
  token1?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  buyPrice?: number;     // Price on buy DEX
  sellPrice?: number;    // Price on sell DEX
  expectedProfit?: number;
  estimatedProfit?: number;
  profitPercentage: number;
  gasEstimate: number | string; // Support both number and string (wei)
  confidence: number;
  timestamp: number;
  blockNumber?: number;
  expiresAt?: number;    // Opportunity expiration timestamp
  status?: 'pending' | 'executing' | 'completed' | 'failed' | 'expired';
  path?: string[];       // For triangular arbitrage
  bridgeRequired?: boolean;
  bridgeCost?: number;
}

export interface SwapEvent {
  pairAddress: string;
  sender: string;
  recipient: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  to: string;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
  dex: string;
  chain: string;
  usdValue?: number;
}

export interface WhaleTransaction {
  transactionHash: string;
  address: string;
  token: string;
  amount: number;
  usdValue: number;
  direction: 'buy' | 'sell';
  dex: string;
  chain: string;
  timestamp: number;
  impact: number; // Price impact percentage
}

export interface MessageEvent {
  type: string;
  data: any;
  timestamp: number;
  source: string;
  correlationId?: string;
}

export interface ServiceHealth {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  lastHeartbeat: number;
  error?: string;
}

export interface PerformanceMetrics {
  eventLatency: number;
  detectionLatency: number;
  cacheHitRate: number;
  opportunitiesDetected: number;
  opportunitiesExecuted: number;
  successRate: number;
  timestamp: number;
}

export interface PredictionResult {
  type: 'price' | 'pattern' | 'orderbook' | 'crosschain';
  direction: number; // -1 (down), 0 (neutral), 1 (up)
  confidence: number; // 0-1
  magnitude?: number;
  timeHorizon: number; // milliseconds
  timestamp: number;
}

export interface MLModelMetrics {
  modelName: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  trainingTime: number;
  lastRetrained: number;
}

// Configuration types
export interface ServiceConfig {
  name: string;
  version: string;
  environment: 'development' | 'staging' | 'production';
  chains: Chain[];
  dexes: Dex[];
  tokens: Token[];
  redis: {
    url: string;
    password?: string;
  };
  monitoring: {
    enabled: boolean;
    interval: number;
    endpoints: string[];
  };
}

export interface DetectorConfig extends ServiceConfig {
  batchSize: number;
  batchTimeout: number;
  eventFilters: {
    minUsdValue: number;
    samplingRate: number;
  };
  cache: {
    ttl: number;
    maxSize: number;
  };
}

export interface ExecutionConfig extends ServiceConfig {
  wallet: {
    encryptedKey: string;
    address: string;
  };
  gas: {
    maxGasPrice: number;
    priorityFee: number;
  };
  mev: {
    enabled: boolean;
    flashbotsUrl?: string;
  };
}

// Error types
export class ArbitrageError extends Error {
  constructor(
    message: string,
    public code: string,
    public service: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'ArbitrageError';
  }
}

export class NetworkError extends ArbitrageError {
  constructor(message: string, service: string) {
    super(message, 'NETWORK_ERROR', service, true);
    this.name = 'NetworkError';
  }
}

export class ValidationError extends ArbitrageError {
  constructor(message: string, service: string, public field: string) {
    super(message, 'VALIDATION_ERROR', service, false);
    this.name = 'ValidationError';
  }
}
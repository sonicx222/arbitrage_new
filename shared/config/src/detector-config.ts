/**
 * Detector Configuration
 *
 * Chain-specific detector settings for arbitrage detection.
 * Consolidates hardcoded values from individual detector implementations.
 *
 * @see S3.1.2: New chain detector configurations
 */

// =============================================================================
// DETECTOR CONFIGURATION - Chain-specific detector settings
// =============================================================================
export interface DetectorChainConfig {
  // Batching configuration
  batchSize: number;
  batchTimeout: number;
  healthCheckInterval: number;
  // Arbitrage detection
  confidence: number;           // Opportunity confidence score (0-1)
  expiryMs: number;             // Opportunity expiry in milliseconds
  gasEstimate: number;          // Estimated gas for swap execution
  // Whale detection
  whaleThreshold: number;       // USD value threshold for whale alerts
  // Token metadata key for native token
  nativeTokenKey: 'weth' | 'nativeWrapper';
}

export const DETECTOR_CONFIG: Record<string, DetectorChainConfig> = {
  ethereum: {
    batchSize: 15,              // Lower batch size for 12s blocks
    batchTimeout: 50,
    healthCheckInterval: 30000,
    confidence: 0.75,           // Lower due to higher gas variability
    expiryMs: 15000,            // 15s (longer for slow blocks)
    gasEstimate: 250000,        // Higher gas on mainnet
    whaleThreshold: 100000,     // $100K (higher due to gas costs)
    nativeTokenKey: 'weth'
  },
  arbitrum: {
    batchSize: 30,              // Higher batch size for ultra-fast 250ms blocks
    batchTimeout: 20,           // Lower timeout for faster processing
    healthCheckInterval: 15000, // More frequent health checks
    confidence: 0.85,           // Higher due to ultra-fast processing
    expiryMs: 5000,             // 5s (faster for quick blocks)
    gasEstimate: 50000,         // Very low gas on Arbitrum
    whaleThreshold: 25000,      // $25K (lower threshold for L2)
    nativeTokenKey: 'weth'
  },
  optimism: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 100000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  base: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 100000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  polygon: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 150000,
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'      // WETH on Polygon, not WMATIC for USD calc
  },
  bsc: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 200000,
    whaleThreshold: 50000,      // $50K (moderate threshold)
    nativeTokenKey: 'nativeWrapper'  // WBNB for USD calc
  },
  // =============================================================================
  // S3.1.2: New Chain Detector Configurations
  // =============================================================================
  avalanche: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s (2s block time)
    gasEstimate: 150000,        // Moderate gas on C-Chain
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'nativeWrapper'  // WAVAX for USD calc
  },
  fantom: {
    batchSize: 25,              // Higher batch for 1s blocks
    batchTimeout: 25,           // Faster timeout for quick blocks
    healthCheckInterval: 20000, // More frequent health checks
    confidence: 0.82,
    expiryMs: 8000,             // 8s (faster for 1s blocks)
    gasEstimate: 100000,        // Low gas on Fantom
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'nativeWrapper'  // WFTM for USD calc
  },
  zksync: {
    batchSize: 25,              // Higher batch for fast ZK rollup
    batchTimeout: 25,
    healthCheckInterval: 20000,
    confidence: 0.82,
    expiryMs: 8000,             // 8s
    gasEstimate: 80000,         // Low gas on zkSync (ZK proofs)
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  linea: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s
    gasEstimate: 100000,        // Moderate gas on Linea
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  // =============================================================================
  // New L2 Chains (FIX C2: Previously missing — fell back to Ethereum defaults)
  // =============================================================================
  blast: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 8000,             // 8s (2s block time)
    gasEstimate: 100000,        // Low gas on L2
    whaleThreshold: 25000,      // $25K (L2 threshold)
    nativeTokenKey: 'weth'
  },
  scroll: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 10000,            // 10s (3s block time)
    gasEstimate: 100000,        // Low gas on L2
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  mantle: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 8000,             // 8s (2s block time)
    gasEstimate: 100000,        // Low gas on L2
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'nativeWrapper'  // MNT native token
  },
  mode: {
    batchSize: 20,
    batchTimeout: 30,
    healthCheckInterval: 30000,
    confidence: 0.80,
    expiryMs: 8000,             // 8s (2s block time)
    gasEstimate: 100000,        // Low gas on L2
    whaleThreshold: 25000,      // $25K
    nativeTokenKey: 'weth'
  },
  solana: {
    batchSize: 50,              // Very high batch for 400ms blocks
    batchTimeout: 10,           // Very fast timeout
    healthCheckInterval: 10000, // Frequent health checks
    confidence: 0.85,           // High confidence for fast chain
    expiryMs: 5000,             // 5s (very fast blocks)
    gasEstimate: 5000,          // Compute units (not gas) — Solana uses ~5K CU per swap, ~200K CU budget
    whaleThreshold: 50000,      // $50K (high activity chain)
    nativeTokenKey: 'nativeWrapper'  // Wrapped SOL for USD calc
  }
};

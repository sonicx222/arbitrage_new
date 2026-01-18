/**
 * Service Configuration
 *
 * Service configs, flash loan providers, and bridge costs.
 *
 * @see P1-4: Flash loan provider configuration
 * @see P1-5: Bridge cost configuration
 */

// =============================================================================
// SERVICE CONFIGURATIONS
// =============================================================================
export const SERVICE_CONFIGS = {
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD
  },
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    interval: parseInt(process.env.MONITORING_INTERVAL || '30000'),
    endpoints: (process.env.MONITORING_ENDPOINTS || '').split(',')
  }
};

// =============================================================================
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================
export const FLASH_LOAN_PROVIDERS: Record<string, {
  address: string;
  protocol: string;
  fee: number;  // Basis points (100 = 1%)
}> = {
  // Aave V3 Pool addresses - https://docs.aave.com/developers/deployed-contracts
  ethereum: {
    address: '0x87870BcD2C4C2e84a8c3C3a3fcACc94666C0d6CF',
    protocol: 'aave_v3',
    fee: 9  // 0.09% flash loan fee
  },
  polygon: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  arbitrum: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  base: {
    address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    protocol: 'aave_v3',
    fee: 9
  },
  optimism: {
    address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol: 'aave_v3',
    fee: 9
  },
  // BSC uses Pancakeswap flash loans (no Aave V3)
  bsc: {
    address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',  // PancakeSwap V3 Router
    protocol: 'pancakeswap_v3',
    fee: 25  // 0.25% flash swap fee
  }
};

// =============================================================================
// BRIDGE COST CONFIGURATION (P1-5 FIX)
// =============================================================================

/**
 * P1-5 FIX: Bridge cost configuration to replace hardcoded multipliers.
 * Fees are in basis points (1 bp = 0.01%). Latency in seconds.
 *
 * Data sources:
 * - Stargate: https://stargate.finance/bridge (fees vary by route)
 * - Across: https://across.to/ (dynamic fees)
 * - LayerZero: https://layerzero.network/ (gas-dependent fees)
 *
 * Note: These are baseline estimates. Production should use real-time API data.
 */
export interface BridgeCostConfig {
  bridge: string;
  sourceChain: string;
  targetChain: string;
  feePercentage: number;  // In percentage (e.g., 0.06 = 0.06%)
  minFeeUsd: number;      // Minimum fee in USD
  estimatedLatencySeconds: number;
  reliability: number;    // 0-1 scale
}

export const BRIDGE_COSTS: BridgeCostConfig[] = [
  // Stargate (LayerZero) - Good for stablecoins
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'bsc', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // Across Protocol - Fast with relayer model
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.04, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'optimism', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'base', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },

  // Native bridges (L2 -> L1 are slower)
  { bridge: 'native', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'optimism', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'base', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
];

/**
 * P1-5 FIX: Get bridge cost for a specific route
 */
export function getBridgeCost(
  sourceChain: string,
  targetChain: string,
  bridge?: string
): BridgeCostConfig | undefined {
  const normalizedSource = sourceChain.toLowerCase();
  const normalizedTarget = targetChain.toLowerCase();

  if (bridge) {
    return BRIDGE_COSTS.find(
      b => b.sourceChain === normalizedSource &&
           b.targetChain === normalizedTarget &&
           b.bridge === bridge.toLowerCase()
    );
  }

  // Find best bridge (lowest fee)
  const options = BRIDGE_COSTS.filter(
    b => b.sourceChain === normalizedSource && b.targetChain === normalizedTarget
  );

  if (options.length === 0) return undefined;

  return options.reduce((best, current) =>
    current.feePercentage < best.feePercentage ? current : best
  );
}

/**
 * P1-5 FIX: Calculate bridge cost for a given USD amount
 */
export function calculateBridgeCostUsd(
  sourceChain: string,
  targetChain: string,
  amountUsd: number,
  bridge?: string
): { fee: number; latency: number; bridge: string } | undefined {
  const config = getBridgeCost(sourceChain, targetChain, bridge);
  if (!config) return undefined;

  const percentageFee = amountUsd * (config.feePercentage / 100);
  const fee = Math.max(percentageFee, config.minFeeUsd);

  return {
    fee,
    latency: config.estimatedLatencySeconds,
    bridge: config.bridge
  };
}

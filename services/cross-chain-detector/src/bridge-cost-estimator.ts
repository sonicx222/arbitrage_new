/**
 * Bridge Cost Estimator Module
 *
 * Responsible for estimating cross-chain bridge costs for arbitrage opportunities.
 * Uses BridgeLatencyPredictor for ML-based predictions and falls back to
 * configured costs when predictions are unavailable.
 *
 * @see ADR-014: Modular Detector Components
 */

import { calculateBridgeCostUsd } from '@arbitrage/config';
import { PriceUpdate } from '@arbitrage/types';
import { BridgeLatencyPredictor } from './bridge-predictor';
// FIX 6.1: Use consistent Logger alias (Logger = ModuleLogger in types.ts)
import { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

export interface BridgeCostEstimatorConfig {
  /** Bridge predictor instance for ML-based cost predictions */
  bridgePredictor: BridgeLatencyPredictor;
  /** Logger instance - FIX 6.1: Use Logger for consistency */
  logger: Logger;
  /**
   * Cached ETH price in USD for cost conversion.
   * Should be updated periodically by caller from PriceOracle.
   * Default: 3000 (conservative estimate)
   */
  cachedEthPriceUsd?: number;
  /** Default trade size in USD for cost estimation (default: 1000) */
  defaultTradeSizeUsd?: number;
  /** Minimum confidence required for predictor results (default: 0.3) */
  minPredictionConfidence?: number;
  /** Minimum fee in USD for fallback estimation (default: 2.0) */
  minFallbackFeeUsd?: number;
  /** Base fee percentage for fallback estimation (default: 0.1%) */
  baseFallbackFeePercentage?: number;
}

export interface BridgeCostEstimate {
  /** Estimated cost in USD */
  costUsd: number;
  /** Source of the estimate */
  source: 'predictor' | 'config' | 'fallback';
  /** Confidence score (0-1) if from predictor */
  confidence?: number;
  /** Bridge name if known */
  bridge?: string;
  /** Estimated latency in seconds if known */
  latencySeconds?: number;
}

export interface BridgeCostEstimator {
  /**
   * Estimate the cost of bridging tokens between chains.
   *
   * @param sourceChain - Chain to bridge from
   * @param targetChain - Chain to bridge to
   * @param tokenUpdate - Price update containing token information
   * @returns Estimated bridge cost in token units (relative to token price)
   */
  estimateBridgeCost(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): number;

  /**
   * Get detailed bridge cost estimate with metadata.
   *
   * @param sourceChain - Chain to bridge from
   * @param targetChain - Chain to bridge to
   * @param tokenUpdate - Price update containing token information
   * @returns Detailed cost estimate with source and confidence
   */
  getDetailedEstimate(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): BridgeCostEstimate;

  /**
   * Calculate token amount for a given USD trade size.
   *
   * @param tokenUpdate - Price update containing token price
   * @param tradeSizeUsd - Optional override for trade size in USD
   * @returns Number of tokens equivalent to trade size
   */
  extractTokenAmount(tokenUpdate: PriceUpdate, tradeSizeUsd?: number): number;

  /**
   * FIX 1.2: Update the cached ETH price for cost conversions.
   * Should be called periodically from PriceOracle to maintain accuracy.
   *
   * @param priceUsd - Current ETH price in USD
   */
  updateEthPrice(priceUsd: number): void;

  /**
   * Get the current cached ETH price.
   *
   * @returns Current ETH price in USD
   */
  getEthPrice(): number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG = {
  cachedEthPriceUsd: 3000, // Conservative ETH price fallback
  defaultTradeSizeUsd: 1000,
  minPredictionConfidence: 0.3,
  minFallbackFeeUsd: 2.0,
  baseFallbackFeePercentage: 0.1, // 0.1%
};

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a BridgeCostEstimator instance.
 *
 * @param config - Configuration options
 * @returns BridgeCostEstimator instance
 */
export function createBridgeCostEstimator(config: BridgeCostEstimatorConfig): BridgeCostEstimator {
  const {
    bridgePredictor,
    logger,
    cachedEthPriceUsd: initialEthPriceUsd = DEFAULT_CONFIG.cachedEthPriceUsd,
    defaultTradeSizeUsd = DEFAULT_CONFIG.defaultTradeSizeUsd,
    minPredictionConfidence = DEFAULT_CONFIG.minPredictionConfidence,
    minFallbackFeeUsd = DEFAULT_CONFIG.minFallbackFeeUsd,
    baseFallbackFeePercentage = DEFAULT_CONFIG.baseFallbackFeePercentage,
  } = config;

  // FIX 1.2: Make ETH price mutable so it can be updated by caller
  let currentEthPriceUsd = initialEthPriceUsd;

  // ===========================================================================
  // Internal Helper Functions
  // ===========================================================================

  /**
   * Get fallback bridge cost using centralized configuration or estimation.
   */
  function getFallbackBridgeCost(sourceChain: string, targetChain: string, tradeSizeUsd: number): BridgeCostEstimate {
    // Try centralized bridge cost configuration first
    const bridgeCostResult = calculateBridgeCostUsd(sourceChain, targetChain, tradeSizeUsd);

    if (bridgeCostResult) {
      logger.debug('Using configured bridge cost', {
        sourceChain,
        targetChain,
        bridge: bridgeCostResult.bridge,
        feeUsd: bridgeCostResult.fee,
        latency: bridgeCostResult.latency,
      });

      return {
        costUsd: bridgeCostResult.fee,
        source: 'config',
        bridge: bridgeCostResult.bridge,
        latencySeconds: bridgeCostResult.latency,
      };
    }

    // Fallback: Estimate cost if no configuration exists
    logger.debug('No bridge cost config, using fallback estimate', {
      sourceChain,
      targetChain,
    });

    // Base cost as percentage of trade size
    const percentageFee = tradeSizeUsd * (baseFallbackFeePercentage / 100);
    const fallbackFee = Math.max(percentageFee, minFallbackFeeUsd);

    return {
      costUsd: fallbackFee,
      source: 'fallback',
    };
  }

  /**
   * Convert USD cost to token units based on token price.
   */
  function convertUsdToTokenUnits(costUsd: number, tokenPrice: number): number {
    if (tokenPrice <= 0 || !Number.isFinite(tokenPrice)) {
      return costUsd; // Fallback: assume 1:1 if price invalid
    }
    return costUsd / tokenPrice;
  }

  // ===========================================================================
  // Public Interface
  // ===========================================================================

  function extractTokenAmount(tokenUpdate: PriceUpdate, tradeSizeUsd?: number): number {
    const tradeSize = tradeSizeUsd ?? defaultTradeSizeUsd;
    const price = tokenUpdate.price;

    if (price <= 0) {
      logger.warn('Invalid token price for amount extraction', {
        pairKey: tokenUpdate.pairKey,
        price,
      });
      return 1.0; // Fallback to 1 token
    }

    // Calculate tokens worth tradeSizeUsd
    // If price is $3000/ETH, then $1000 = 0.333 ETH
    // If price is $0.01/token, then $1000 = 100,000 tokens
    const tokenAmount = tradeSize / price;

    // FIX #15: Add bounds checking to prevent unreasonable amounts for micro-cap tokens
    const MAX_TOKEN_AMOUNT = 1e12; // 1 trillion tokens max
    const MIN_TOKEN_AMOUNT = 1e-18; // Minimum practical amount

    if (tokenAmount > MAX_TOKEN_AMOUNT) {
      logger.warn('Token amount exceeds maximum, capping', {
        pairKey: tokenUpdate.pairKey,
        calculatedAmount: tokenAmount,
        cappedAmount: MAX_TOKEN_AMOUNT,
      });
      return MAX_TOKEN_AMOUNT;
    }

    if (tokenAmount < MIN_TOKEN_AMOUNT) {
      logger.warn('Token amount below minimum, using floor', {
        pairKey: tokenUpdate.pairKey,
        calculatedAmount: tokenAmount,
        floorAmount: MIN_TOKEN_AMOUNT,
      });
      return MIN_TOKEN_AMOUNT;
    }

    logger.debug('Extracted token amount for bridge estimation', {
      pairKey: tokenUpdate.pairKey,
      price,
      usdValue: tradeSize,
      tokenAmount,
    });

    return tokenAmount;
  }

  function getDetailedEstimate(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): BridgeCostEstimate {
    // Check for ML-predicted routes
    const availableBridges = bridgePredictor.getAvailableRoutes(sourceChain, targetChain);

    if (availableBridges.length > 0) {
      // Get the best bridge prediction
      const tokenAmount = extractTokenAmount(tokenUpdate);
      const prediction = bridgePredictor.predictOptimalBridge(
        sourceChain,
        targetChain,
        tokenAmount,
        'medium' // Default urgency
      );

      if (prediction && prediction.confidence > minPredictionConfidence) {
        // Convert from wei to USD (assumes ETH-like cost structure)
        const costWei = prediction.estimatedCost;
        const costEth = costWei / 1e18;

        // FIX 1.2: Use mutable ETH price (should be updated periodically by caller)
        // This keeps the function synchronous for hot-path performance
        const costUsd = costEth * currentEthPriceUsd;

        return {
          costUsd,
          source: 'predictor',
          confidence: prediction.confidence,
          bridge: prediction.bridgeName,
          latencySeconds: prediction.estimatedLatency,
        };
      }
    }

    // Fallback to configured or estimated cost
    return getFallbackBridgeCost(sourceChain, targetChain, defaultTradeSizeUsd);
  }

  function estimateBridgeCost(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): number {
    const estimate = getDetailedEstimate(sourceChain, targetChain, tokenUpdate);

    // Convert USD cost to token units for comparison with token prices
    return convertUsdToTokenUnits(estimate.costUsd, tokenUpdate.price);
  }

  // FIX 1.2: Add methods to update and get ETH price
  function updateEthPrice(priceUsd: number): void {
    if (priceUsd > 0 && Number.isFinite(priceUsd)) {
      const previousPrice = currentEthPriceUsd;
      currentEthPriceUsd = priceUsd;
      logger.debug('ETH price updated', { previousPrice, newPrice: priceUsd });
    } else {
      logger.warn('Invalid ETH price provided, keeping current value', {
        providedPrice: priceUsd,
        currentPrice: currentEthPriceUsd,
      });
    }
  }

  function getEthPrice(): number {
    return currentEthPriceUsd;
  }

  // Return public interface
  return {
    estimateBridgeCost,
    getDetailedEstimate,
    extractTokenAmount,
    updateEthPrice,
    getEthPrice,
  };
}

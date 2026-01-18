/**
 * Event Configuration
 *
 * Event monitoring settings and pre-computed event signatures.
 *
 * @see S3.3: Event processing configuration
 */

// =============================================================================
// EVENT MONITORING CONFIGURATION
// =============================================================================
export const EVENT_CONFIG = {
  syncEvents: {
    enabled: true,
    priority: 'high'
  },
  swapEvents: {
    enabled: true,
    priority: 'medium',
    minAmountUSD: 10000,    // $10K minimum for processing
    whaleThreshold: 50000,  // $50K for whale alerts
    samplingRate: 0.01      // 1% sampling for <$10K swaps
  }
};

// =============================================================================
// EVENT SIGNATURES - Pre-computed for performance
// =============================================================================
export const EVENT_SIGNATURES = {
  // Uniswap V2 / SushiSwap style
  SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  // Alternative signatures for different DEX implementations
  SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
};

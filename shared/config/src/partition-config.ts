/**
 * Partition Configuration
 *
 * S3.1.2: 4-Partition Architecture configuration and metrics.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-008: Phase metrics and targets
 */

import { CHAINS } from './chains';
import { DEXES } from './dexes';
import { CORE_TOKENS } from './tokens';

// =============================================================================
// PARTITION CONFIGURATION
// S3.1.2: 4-Partition Architecture - Aligns with ADR-003 and ADR-008
// =============================================================================

/**
 * Partition chain assignments - S3.1.2 configuration
 * Use getChainsForPartition() from partitions.ts for runtime access.
 */
export const PARTITION_CONFIG = {
  // P1: Asia-Fast - EVM high-throughput chains
  P1_ASIA_FAST: ['bsc', 'polygon', 'avalanche', 'fantom'] as const,
  // P2: L2-Turbo - Ethereum L2 rollups
  P2_L2_TURBO: ['arbitrum', 'optimism', 'base'] as const,
  // P3: High-Value - Ethereum mainnet + ZK rollups
  P3_HIGH_VALUE: ['ethereum', 'zksync', 'linea'] as const,
  // P4: Solana-Native - Non-EVM chains
  P4_SOLANA_NATIVE: ['solana'] as const
};

// =============================================================================
// PHASE METRICS
// Track progress against targets from ADR-008
// S3.1.2: Updated for 4-partition architecture (11 chains, 44 DEXes, 94 tokens)
// S3.2.2: Updated for Fantom expansion (11 chains, 46 DEXes, 98 tokens)
// S3.3.3: Updated for Solana token expansion (11 chains, 49 DEXes, 112 tokens)
// Phase 1 Adapters: Added vault-model DEX adapters (GMX, Platypus, Beethoven X)
// =============================================================================
export const PHASE_METRICS = {
  current: {
    phase: 1,
    chains: Object.keys(CHAINS).length,
    dexes: Object.values(DEXES).flat().length,
    tokens: Object.values(CORE_TOKENS).flat().length,
    targetOpportunities: 500  // Increased with more chains/DEXes
  },
  targets: {
    // Phase 1 with vault-model adapters:
    // - 11 chains (original 6 + avalanche, fantom, zksync, linea, solana)
    // - 49 DEXes (46 + 3 newly enabled: GMX, Platypus, Beethoven X with adapters)
    // - 112 tokens breakdown:
    //   Original 6 chains: 60 (arb:12 + bsc:10 + base:10 + poly:10 + opt:10 + eth:8)
    //   S3.1.2 new chains: 12 (zksync:6 + linea:6)
    //   S3.2.1 Avalanche: 15, S3.2.2 Fantom: 10, S3.3.3 Solana: 15
    phase1: { chains: 11, dexes: 49, tokens: 112, opportunities: 500 },
    phase2: { chains: 15, dexes: 60, tokens: 145, opportunities: 750 },
    phase3: { chains: 20, dexes: 80, tokens: 200, opportunities: 1000 }
  }
};

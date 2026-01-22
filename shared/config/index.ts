/**
 * Shared Configuration for the Arbitrage System
 *
 * IMPORTANT: This file re-exports all configurations from src/index.ts
 * Do NOT add new configurations directly here - add them to the appropriate
 * submodule in src/ and export from src/index.ts.
 *
 * Migration Note (2025-01-22):
 * Previously this file contained duplicate configurations that were out of sync
 * with the modular src/ configurations. It has been refactored to re-export
 * from src/index.ts to ensure a single source of truth.
 *
 * Fixed issues:
 * - Invalid BiSwap factory address (41 chars instead of 42)
 * - Duplicate USDT/USDC addresses for Ethereum
 * - Stale chain count (5 vs 11 actual)
 * - Stale DEX count (10 vs 49 actual)
 * - Stale token count (23 vs 112 actual)
 * - Conflicting EVENT_CONFIG values
 *
 * Module Structure:
 * - src/chains/: Blockchain configurations (11 mainnet + devnet)
 * - src/dexes/: DEX configurations (49 DEXes)
 * - src/tokens/: Token configurations (112 tokens)
 * - src/thresholds.ts: Performance and arbitrage thresholds
 * - src/mev-config.ts: MEV protection settings
 * - src/event-config.ts: Event monitoring settings
 * - src/detector-config.ts: Chain-specific detector settings
 * - src/service-config.ts: Service configs, flash loans, bridges
 * - src/cross-chain.ts: Cross-chain token normalization
 * - src/system-constants.ts: System-wide constants
 * - src/partitions.ts: Partition configurations (ADR-003)
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-008: Phase metrics and targets
 */

// Re-export everything from the modular src/index.ts
// This ensures a single source of truth for all configurations
export * from './src/index';

/**
 * Tests for Thresholds Configuration
 *
 * Covers:
 * - Chain-specific profit thresholds
 * - Performance thresholds
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
    getMinProfitThreshold,
    PERFORMANCE_THRESHOLDS,
    ARBITRAGE_CONFIG,
    getOpportunityTimeoutMs,
    getGasSpikeMultiplier,
    getConfidenceMaxAgeMs,
    getEstimatedGasCostUsd,
    chainOpportunityTimeoutMs,
    chainGasSpikeMultiplier,
    chainEstimatedGasCostUsd,
    chainConfidenceMaxAgeMs
} from '../../src/thresholds';

describe('Thresholds Configuration', () => {
    describe('getMinProfitThreshold', () => {
        it('should return correct threshold for Ethereum (T3)', () => {
            // Ethereum has higher threshold due to gas costs
            const ethThreshold = getMinProfitThreshold('ethereum');
            expect(ethThreshold).toBeGreaterThan(0);
            expect(ethThreshold).toBe(ARBITRAGE_CONFIG.chainMinProfits.ethereum);
        });

        it('should return correct threshold for Arbitrum (T1)', () => {
            // L2s should have lower thresholds
            const arbThreshold = getMinProfitThreshold('arbitrum');
            // Should be less than or equal to default min profit
            expect(arbThreshold).toBeLessThanOrEqual(ARBITRAGE_CONFIG.minProfitPercentage);
        });

        it('should return default minimal threshold for unconfigured chain', () => {
            const unknownThreshold = getMinProfitThreshold('unknown-chain');
            expect(unknownThreshold).toBe(ARBITRAGE_CONFIG.minProfitPercentage);
        });

        it('should handle uppercase chain names', () => {
            const threshold = getMinProfitThreshold('ETHEREUM');
            expect(threshold).toBe(ARBITRAGE_CONFIG.chainMinProfits.ethereum);
        });
    });

    describe('Performance Thresholds', () => {
        it('should define reasonable latency targets', () => {
            // Target should be under 100ms for high-frequency arb
            expect(PERFORMANCE_THRESHOLDS.maxEventLatency).toBeLessThan(100);
        });

        it('should define cache hit rate target', () => {
            expect(PERFORMANCE_THRESHOLDS.minCacheHitRate).toBeGreaterThan(0.8);
        });
    });

    describe('getOpportunityTimeoutMs', () => {
        it('should return correct timeout for Ethereum', () => {
            const timeout = getOpportunityTimeoutMs('ethereum');
            expect(timeout).toBe(30000); // 30s for 12s blocks
            expect(timeout).toBeGreaterThan(0);
        });

        it('should return correct timeout for Arbitrum (fast L2)', () => {
            const timeout = getOpportunityTimeoutMs('arbitrum');
            expect(timeout).toBe(2000); // 2s for 0.25s blocks
            expect(timeout).toBeGreaterThan(0);
        });

        it('should return correct timeout for Solana (very fast)', () => {
            const timeout = getOpportunityTimeoutMs('solana');
            expect(timeout).toBe(1000); // 1s for 400ms blocks
            expect(timeout).toBeGreaterThan(0);
        });

        it('should return correct timeout for Blast (emerging L2)', () => {
            const timeout = getOpportunityTimeoutMs('blast');
            expect(timeout).toBe(4000); // 4s for 2s blocks
            expect(timeout).toBeGreaterThan(0);
        });

        it('should return correct timeout for Scroll (emerging L2)', () => {
            const timeout = getOpportunityTimeoutMs('scroll');
            expect(timeout).toBe(6000); // 6s for 3s blocks
            expect(timeout).toBeGreaterThan(0);
        });

        it('should return global fallback for unknown chain', () => {
            const timeout = getOpportunityTimeoutMs('unknown-chain');
            expect(timeout).toBe(ARBITRAGE_CONFIG.opportunityTimeoutMs);
            expect(timeout).toBe(30000);
        });

        it('should handle uppercase chain names', () => {
            const timeout = getOpportunityTimeoutMs('ETHEREUM');
            expect(timeout).toBe(30000);
        });

        it('should handle mixed case chain names', () => {
            const timeout = getOpportunityTimeoutMs('Arbitrum');
            expect(timeout).toBe(2000);
        });
    });

    describe('chainOpportunityTimeoutMs Map', () => {
        it('should contain all 15 chains', () => {
            const expectedChains = [
                'ethereum', 'bsc', 'arbitrum', 'optimism', 'base', 'polygon',
                'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll',
                'mantle', 'mode', 'solana'
            ];

            expectedChains.forEach(chain => {
                expect(chainOpportunityTimeoutMs[chain]).toBeDefined();
                expect(chainOpportunityTimeoutMs[chain]).toBeGreaterThan(0);
            });
        });

        it('should have faster timeouts for fast chains', () => {
            // Solana (400ms blocks) should be fastest
            expect(chainOpportunityTimeoutMs.solana).toBeLessThan(chainOpportunityTimeoutMs.ethereum);

            // Arbitrum (0.25s blocks) should be faster than Ethereum (12s blocks)
            expect(chainOpportunityTimeoutMs.arbitrum).toBeLessThan(chainOpportunityTimeoutMs.ethereum);

            // L2s should generally be faster than L1
            expect(chainOpportunityTimeoutMs.base).toBeLessThan(chainOpportunityTimeoutMs.ethereum);
        });

        it('should have all values within reasonable range', () => {
            Object.values(chainOpportunityTimeoutMs).forEach(timeout => {
                expect(timeout).toBeGreaterThan(0);
                expect(timeout).toBeLessThanOrEqual(30000); // Max 30s (Ethereum)
            });
        });
    });

    describe('getGasSpikeMultiplier', () => {
        it('should return correct multiplier for Ethereum (high volatility)', () => {
            const multiplier = getGasSpikeMultiplier('ethereum');
            expect(multiplier).toBe(5.0); // Mainnet has 5-10x spikes
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return correct multiplier for Arbitrum (L2 stability)', () => {
            const multiplier = getGasSpikeMultiplier('arbitrum');
            expect(multiplier).toBe(2.0); // L2s more stable
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return correct multiplier for Solana (priority fees)', () => {
            const multiplier = getGasSpikeMultiplier('solana');
            expect(multiplier).toBe(1.5); // Lowest spike threshold
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return correct multiplier for BSC (moderate volatility)', () => {
            const multiplier = getGasSpikeMultiplier('bsc');
            expect(multiplier).toBe(3.0); // Alt-L1 moderate spikes
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return correct multiplier for Blast (emerging L2)', () => {
            const multiplier = getGasSpikeMultiplier('blast');
            expect(multiplier).toBe(2.0);
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return correct multiplier for Mantle (stub chain)', () => {
            const multiplier = getGasSpikeMultiplier('mantle');
            expect(multiplier).toBe(2.0);
            expect(multiplier).toBeGreaterThan(1.0);
        });

        it('should return global fallback for unknown chain', () => {
            const multiplier = getGasSpikeMultiplier('unknown-chain');
            expect(multiplier).toBe(ARBITRAGE_CONFIG.gasPriceSpikeMultiplier);
            expect(multiplier).toBe(2.0);
        });

        it('should handle uppercase chain names', () => {
            const multiplier = getGasSpikeMultiplier('ETHEREUM');
            expect(multiplier).toBe(5.0);
        });

        it('should handle mixed case chain names', () => {
            const multiplier = getGasSpikeMultiplier('Solana');
            expect(multiplier).toBe(1.5);
        });
    });

    describe('chainGasSpikeMultiplier Map', () => {
        it('should contain all 15 chains', () => {
            const expectedChains = [
                'ethereum', 'bsc', 'arbitrum', 'optimism', 'base', 'polygon',
                'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll',
                'mantle', 'mode', 'solana'
            ];

            expectedChains.forEach(chain => {
                expect(chainGasSpikeMultiplier[chain]).toBeDefined();
                expect(chainGasSpikeMultiplier[chain]).toBeGreaterThan(1.0);
            });
        });

        it('should have higher multipliers for L1 chains', () => {
            // Ethereum should have highest multiplier (most volatile)
            expect(chainGasSpikeMultiplier.ethereum).toBeGreaterThan(chainGasSpikeMultiplier.arbitrum);
            expect(chainGasSpikeMultiplier.ethereum).toBeGreaterThan(chainGasSpikeMultiplier.solana);

            // Alt-L1s (BSC, Polygon) should be higher than L2s
            expect(chainGasSpikeMultiplier.bsc).toBeGreaterThan(chainGasSpikeMultiplier.base);
        });

        it('should have all values within reasonable range', () => {
            Object.values(chainGasSpikeMultiplier).forEach(multiplier => {
                expect(multiplier).toBeGreaterThan(1.0); // Must allow some spike
                expect(multiplier).toBeLessThanOrEqual(5.0); // Max 5x (Ethereum)
            });
        });
    });

    describe('getEstimatedGasCostUsd', () => {
        it('should return correct cost for Ethereum (expensive L1)', () => {
            const cost = getEstimatedGasCostUsd('ethereum');
            expect(cost).toBe(15.0); // $15 median mainnet gas
            expect(cost).toBeGreaterThan(0);
        });

        it('should return correct cost for Arbitrum (cheap L2)', () => {
            const cost = getEstimatedGasCostUsd('arbitrum');
            expect(cost).toBe(0.10); // ~$0.10 L2 gas
            expect(cost).toBeGreaterThan(0);
            expect(cost).toBeLessThan(15.0); // Much cheaper than mainnet
        });

        it('should return correct cost for Solana (very cheap)', () => {
            const cost = getEstimatedGasCostUsd('solana');
            expect(cost).toBe(0.005); // ~$0.005 Solana fees
            expect(cost).toBeGreaterThan(0);
            expect(cost).toBeLessThan(0.10);
        });

        it('should return correct cost for BSC (moderate)', () => {
            const cost = getEstimatedGasCostUsd('bsc');
            expect(cost).toBe(0.30); // ~$0.30 BSC gas
            expect(cost).toBeGreaterThan(0);
        });

        it('should return correct cost for Blast (emerging L2)', () => {
            const cost = getEstimatedGasCostUsd('blast');
            expect(cost).toBe(0.05);
            expect(cost).toBeGreaterThan(0);
        });

        it('should return correct cost for Scroll (emerging L2)', () => {
            const cost = getEstimatedGasCostUsd('scroll');
            expect(cost).toBe(0.10);
            expect(cost).toBeGreaterThan(0);
        });

        it('should return global fallback for unknown chain', () => {
            const cost = getEstimatedGasCostUsd('unknown-chain');
            expect(cost).toBe(ARBITRAGE_CONFIG.estimatedGasCost);
            expect(cost).toBe(15); // Global mainnet-oriented default
        });

        it('should handle uppercase chain names', () => {
            const cost = getEstimatedGasCostUsd('ETHEREUM');
            expect(cost).toBe(15.0);
        });

        it('should handle mixed case chain names', () => {
            const cost = getEstimatedGasCostUsd('Solana');
            expect(cost).toBe(0.005);
        });
    });

    describe('chainEstimatedGasCostUsd Map', () => {
        it('should contain all 15 chains', () => {
            const expectedChains = [
                'ethereum', 'bsc', 'arbitrum', 'optimism', 'base', 'polygon',
                'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll',
                'mantle', 'mode', 'solana'
            ];

            expectedChains.forEach(chain => {
                expect(chainEstimatedGasCostUsd[chain]).toBeDefined();
                expect(chainEstimatedGasCostUsd[chain]).toBeGreaterThan(0);
            });
        });

        it('should have higher costs for L1 chains', () => {
            // Ethereum should be most expensive
            expect(chainEstimatedGasCostUsd.ethereum).toBeGreaterThan(chainEstimatedGasCostUsd.arbitrum);
            expect(chainEstimatedGasCostUsd.ethereum).toBeGreaterThan(chainEstimatedGasCostUsd.bsc);
            expect(chainEstimatedGasCostUsd.ethereum).toBeGreaterThan(chainEstimatedGasCostUsd.solana);

            // L2s should be cheaper than L1
            expect(chainEstimatedGasCostUsd.base).toBeLessThan(chainEstimatedGasCostUsd.ethereum);
            expect(chainEstimatedGasCostUsd.optimism).toBeLessThan(chainEstimatedGasCostUsd.ethereum);
        });

        it('should have all values within reasonable range', () => {
            Object.values(chainEstimatedGasCostUsd).forEach(cost => {
                expect(cost).toBeGreaterThan(0);
                expect(cost).toBeLessThanOrEqual(15.0); // Max $15 (Ethereum)
            });
        });

        it('should have Solana as cheapest chain', () => {
            const solanaCost = chainEstimatedGasCostUsd.solana;
            Object.entries(chainEstimatedGasCostUsd).forEach(([chain, cost]) => {
                if (chain !== 'solana') {
                    expect(cost).toBeGreaterThanOrEqual(solanaCost);
                }
            });
        });
    });

    describe('getConfidenceMaxAgeMs', () => {
        it('should return correct maxAge for Ethereum', () => {
            const maxAge = getConfidenceMaxAgeMs('ethereum');
            expect(maxAge).toBe(30000); // 30s for 12s blocks
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return correct maxAge for Arbitrum', () => {
            const maxAge = getConfidenceMaxAgeMs('arbitrum');
            expect(maxAge).toBe(4000); // 4s (conservative for sequencer)
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return correct maxAge for Solana', () => {
            const maxAge = getConfidenceMaxAgeMs('solana');
            expect(maxAge).toBe(3000); // 3s for 400ms blocks (accounts for WS latency)
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return correct maxAge for BSC', () => {
            const maxAge = getConfidenceMaxAgeMs('bsc');
            expect(maxAge).toBe(9000); // 9s for 3s blocks
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return correct maxAge for Blast (emerging L2)', () => {
            const maxAge = getConfidenceMaxAgeMs('blast');
            expect(maxAge).toBe(6000);
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return correct maxAge for Scroll (emerging L2)', () => {
            const maxAge = getConfidenceMaxAgeMs('scroll');
            expect(maxAge).toBe(9000);
            expect(maxAge).toBeGreaterThan(0);
        });

        it('should return global fallback for unknown chain', () => {
            const maxAge = getConfidenceMaxAgeMs('unknown-chain');
            expect(maxAge).toBe(10000); // 10s global default
        });

        it('should handle uppercase chain names', () => {
            const maxAge = getConfidenceMaxAgeMs('ETHEREUM');
            expect(maxAge).toBe(30000);
        });

        it('should handle mixed case chain names', () => {
            const maxAge = getConfidenceMaxAgeMs('Solana');
            expect(maxAge).toBe(3000);
        });
    });

    describe('chainConfidenceMaxAgeMs Map', () => {
        it('should contain all 15 chains', () => {
            const expectedChains = [
                'ethereum', 'bsc', 'arbitrum', 'optimism', 'base', 'polygon',
                'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll',
                'mantle', 'mode', 'solana'
            ];

            expectedChains.forEach(chain => {
                expect(chainConfidenceMaxAgeMs[chain]).toBeDefined();
                expect(chainConfidenceMaxAgeMs[chain]).toBeGreaterThan(0);
            });
        });

        it('should have shorter maxAge for fast chains', () => {
            // Faster chains (shorter block times) need shorter confidence windows
            expect(chainConfidenceMaxAgeMs.fantom).toBeLessThan(chainConfidenceMaxAgeMs.ethereum);
            expect(chainConfidenceMaxAgeMs.solana).toBeLessThan(chainConfidenceMaxAgeMs.ethereum);

            // Arbitrum (0.25s blocks) should have shorter window than Ethereum (12s blocks)
            expect(chainConfidenceMaxAgeMs.arbitrum).toBeLessThan(chainConfidenceMaxAgeMs.ethereum);
        });

        it('should have all values within reasonable range', () => {
            Object.values(chainConfidenceMaxAgeMs).forEach(maxAge => {
                expect(maxAge).toBeGreaterThan(0);
                expect(maxAge).toBeLessThanOrEqual(30000); // Max 30s (Ethereum)
            });
        });

        it('should correlate with block times (faster blocks = shorter maxAge)', () => {
            // Solana (400ms) should have shorter maxAge than BSC (3s)
            expect(chainConfidenceMaxAgeMs.solana).toBeLessThan(chainConfidenceMaxAgeMs.bsc);

            // BSC (3s) should have shorter maxAge than Ethereum (12s)
            expect(chainConfidenceMaxAgeMs.bsc).toBeLessThan(chainConfidenceMaxAgeMs.ethereum);
        });
    });
});

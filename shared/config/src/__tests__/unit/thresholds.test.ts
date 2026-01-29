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
    ARBITRAGE_CONFIG
} from '../../thresholds';

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
});

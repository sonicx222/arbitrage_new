/**
 * MEV Risk Analyzer Unit Tests
 *
 * Tests for Task 1.2.3: MEV Risk Scoring
 * - Analyze transaction for sandwich vulnerability
 * - Calculate optimal tip/priority fee
 * - Recommend private vs public mempool
 */

import {
  MevRiskAnalyzer,
  MevRiskAssessment,
  TransactionContext,
  SandwichRiskLevel,
  MempoolRecommendation,
  MEV_RISK_DEFAULTS,
  validateConfigSync,
  getLocalChainPriorityFees,
} from '../../src/mev-protection/mev-risk-analyzer';
import { MEV_CONFIG } from '@arbitrage/config';
import { ethers } from 'ethers';

// =============================================================================
// Test Data
// =============================================================================

const createTransactionContext = (overrides?: Partial<TransactionContext>): TransactionContext => ({
  chain: 'ethereum',
  valueUsd: 1000,
  tokenSymbol: 'WETH',
  dexProtocol: 'uniswap_v2',
  slippageBps: 50, // 0.5%
  poolLiquidityUsd: 1_000_000,
  isStablePair: false,
  gasPrice: ethers.parseUnits('30', 'gwei'),
  ...overrides,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('MevRiskAnalyzer', () => {
  let analyzer: MevRiskAnalyzer;

  beforeEach(() => {
    analyzer = new MevRiskAnalyzer();
  });

  // ===========================================================================
  // Constructor and Configuration Tests
  // ===========================================================================

  describe('Configuration', () => {
    it('should create analyzer with default configuration', async () => {
      expect(analyzer).toBeDefined();
    });

    it('should accept custom configuration', async () => {
      const customAnalyzer = new MevRiskAnalyzer({
        highValueThresholdUsd: 5000,
        sandwichRiskThresholdBps: 100,
        minLiquidityRatioForSafety: 0.05,
      });
      expect(customAnalyzer).toBeDefined();
    });

    it('should use custom sandwichRiskThresholdBps for slippage scoring', async () => {
      // Create analyzer with higher slippage threshold (200 bps = 2%)
      const customAnalyzer = new MevRiskAnalyzer({
        sandwichRiskThresholdBps: 200,
      });

      // 150 bps slippage - below custom threshold (200), above default (100)
      const context = createTransactionContext({
        valueUsd: 1000,
        poolLiquidityUsd: 10_000_000,
        slippageBps: 150,
      });

      const defaultAssessment = await await analyzer.assessRisk(context);
      const customAssessment = await customAnalyzer.assessRisk(context);

      // Default analyzer (threshold 100): 150 bps >= 100, triggers high_slippage_tolerance
      expect(defaultAssessment.riskFactors).toContain('high_slippage_tolerance');

      // Custom analyzer (threshold 200): 150 bps >= 100 (half of 200), triggers moderate_slippage_tolerance
      expect(customAssessment.riskFactors).toContain('moderate_slippage_tolerance');

      // Custom should have lower score due to moderate vs high slippage
      expect(customAssessment.sandwichRiskScore).toBeLessThan(defaultAssessment.sandwichRiskScore);
    });
  });

  // ===========================================================================
  // Sandwich Vulnerability Analysis Tests
  // ===========================================================================

  describe('Sandwich Vulnerability Analysis', () => {
    describe('Risk Level Classification', () => {
      it('should classify low risk for small transactions', async () => {
        const context = createTransactionContext({
          valueUsd: 100,
          poolLiquidityUsd: 10_000_000,
        });

        const assessment = await await analyzer.assessRisk(context);

        expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.LOW);
        expect(assessment.sandwichRiskScore).toBeLessThan(30);
      });

      it('should classify medium risk for moderate transactions', async () => {
        const context = createTransactionContext({
          valueUsd: 5000,
          poolLiquidityUsd: 500_000,
          slippageBps: 100, // 1%
        });

        const assessment = await await analyzer.assessRisk(context);

        expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.MEDIUM);
        expect(assessment.sandwichRiskScore).toBeGreaterThanOrEqual(30);
        expect(assessment.sandwichRiskScore).toBeLessThan(70);
      });

      it('should classify high risk for large transactions with moderate slippage', async () => {
        // Parameters chosen to hit HIGH risk (score 70-89):
        // - 30k/300k = 10% liquidity ratio -> 40 points (critical)
        // - 100 bps slippage -> 25 points
        // - 30k value -> 15 points (high value)
        // Total: 80 points -> HIGH risk
        const context = createTransactionContext({
          valueUsd: 30000,
          poolLiquidityUsd: 300_000,
          slippageBps: 100, // 1% - moderate slippage
        });

        const assessment = await await analyzer.assessRisk(context);

        expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.HIGH);
        expect(assessment.sandwichRiskScore).toBeGreaterThanOrEqual(70);
        expect(assessment.sandwichRiskScore).toBeLessThan(90);
      });

      it('should classify critical risk for very large transactions in low liquidity pools', async () => {
        const context = createTransactionContext({
          valueUsd: 100_000,
          poolLiquidityUsd: 100_000, // Same as trade size
          slippageBps: 300, // 3%
        });

        const assessment = await await analyzer.assessRisk(context);

        expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.CRITICAL);
        expect(assessment.sandwichRiskScore).toBeGreaterThanOrEqual(90);
      });
    });

    describe('Risk Factors', () => {
      it('should increase risk for higher value-to-liquidity ratio', async () => {
        const lowRatioContext = createTransactionContext({
          valueUsd: 1000,
          poolLiquidityUsd: 10_000_000, // 0.01% ratio
        });

        const highRatioContext = createTransactionContext({
          valueUsd: 1000,
          poolLiquidityUsd: 10_000, // 10% ratio
        });

        const lowRatioAssessment = await analyzer.assessRisk(lowRatioContext);
        const highRatioAssessment = await analyzer.assessRisk(highRatioContext);

        expect(highRatioAssessment.sandwichRiskScore).toBeGreaterThan(
          lowRatioAssessment.sandwichRiskScore
        );
      });

      it('should increase risk for higher slippage tolerance', async () => {
        const lowSlippageContext = createTransactionContext({
          slippageBps: 10, // 0.1%
        });

        const highSlippageContext = createTransactionContext({
          slippageBps: 300, // 3%
        });

        const lowSlippageAssessment = await analyzer.assessRisk(lowSlippageContext);
        const highSlippageAssessment = await analyzer.assessRisk(highSlippageContext);

        expect(highSlippageAssessment.sandwichRiskScore).toBeGreaterThan(
          lowSlippageAssessment.sandwichRiskScore
        );
      });

      it('should reduce risk for stable pairs', async () => {
        const volatileContext = createTransactionContext({
          isStablePair: false,
          valueUsd: 10000,
        });

        const stableContext = createTransactionContext({
          isStablePair: true,
          valueUsd: 10000,
        });

        const volatileAssessment = await analyzer.assessRisk(volatileContext);
        const stableAssessment = await analyzer.assessRisk(stableContext);

        expect(stableAssessment.sandwichRiskScore).toBeLessThan(
          volatileAssessment.sandwichRiskScore
        );
      });
    });

    describe('Chain-Specific Adjustments', () => {
      it('should return lower risk for L2 chains with sequencer', async () => {
        const ethereumContext = createTransactionContext({
          chain: 'ethereum',
          valueUsd: 10000,
        });

        const arbitrumContext = createTransactionContext({
          chain: 'arbitrum',
          valueUsd: 10000,
        });

        const ethereumAssessment = await analyzer.assessRisk(ethereumContext);
        const arbitrumAssessment = await analyzer.assessRisk(arbitrumContext);

        // L2s have inherent MEV protection
        expect(arbitrumAssessment.sandwichRiskScore).toBeLessThan(
          ethereumAssessment.sandwichRiskScore
        );
      });

      it('should handle Solana chain appropriately', async () => {
        const solanaContext = createTransactionContext({
          chain: 'solana',
          valueUsd: 10000,
        });

        const assessment = await analyzer.assessRisk(solanaContext);

        // Solana with Jito has some MEV protection
        expect(assessment).toBeDefined();
        expect(assessment.recommendedStrategy).toBeDefined();
      });
    });
  });

  // ===========================================================================
  // Optimal Tip/Priority Fee Calculation Tests
  // ===========================================================================

  describe('Optimal Tip Calculation', () => {
    it('should recommend higher tip for high-risk transactions', async () => {
      const lowRiskContext = createTransactionContext({
        valueUsd: 100,
        poolLiquidityUsd: 10_000_000,
      });

      const highRiskContext = createTransactionContext({
        valueUsd: 50000,
        poolLiquidityUsd: 100_000,
        slippageBps: 200,
      });

      const lowRiskAssessment = await analyzer.assessRisk(lowRiskContext);
      const highRiskAssessment = await analyzer.assessRisk(highRiskContext);

      expect(highRiskAssessment.recommendedPriorityFeeGwei).toBeGreaterThan(
        lowRiskAssessment.recommendedPriorityFeeGwei
      );
    });

    it('should recommend tip based on expected profit', async () => {
      const context = createTransactionContext({
        valueUsd: 10000,
        expectedProfitUsd: 100,
      });

      const assessment = await await analyzer.assessRisk(context);

      // Tip should be a reasonable fraction of expected profit
      // (tip in gwei, so we check it's non-zero and sensible)
      expect(assessment.recommendedPriorityFeeGwei).toBeGreaterThan(0);
      expect(assessment.recommendedPriorityFeeGwei).toBeLessThan(1000); // Reasonable upper bound
    });

    it('should cap priority fee at 10% of expected profit', async () => {
      // Test the profit-capping logic
      // With a small expected profit, the fee should be capped
      const context = createTransactionContext({
        chain: 'ethereum',
        valueUsd: 100000,          // High value to trigger high risk (3x multiplier)
        poolLiquidityUsd: 100_000, // 100% ratio = critical
        slippageBps: 300,          // Critical slippage
        expectedProfitUsd: 0.01,   // Very small profit ($0.01)
      });

      const assessment = await await analyzer.assessRisk(context);

      // Max fee = 0.01 * 0.1 * 1000 = 1 gwei
      // Without capping, high-risk Ethereum would be 2 * 3 = 6 gwei
      // So fee should be capped at the smaller value
      expect(assessment.recommendedPriorityFeeGwei).toBeLessThanOrEqual(1);
    });

    it('should return chain-specific minimum tip for low-risk transactions', async () => {
      const context = createTransactionContext({
        chain: 'ethereum',
        valueUsd: 50,
        poolLiquidityUsd: 100_000_000,
      });

      const assessment = await await analyzer.assessRisk(context);

      // Should use Ethereum minimum (typically 1-2 gwei)
      expect(assessment.recommendedPriorityFeeGwei).toBeGreaterThanOrEqual(1);
    });

    it('should return appropriate tip for L2 chains', async () => {
      const context = createTransactionContext({
        chain: 'arbitrum',
        valueUsd: 1000,
      });

      const assessment = await await analyzer.assessRisk(context);

      // L2 tips are typically very low (cheap gas)
      expect(assessment.recommendedPriorityFeeGwei).toBeLessThan(1);
    });

    it('should return 0 for Solana (uses lamports instead)', async () => {
      const context = createTransactionContext({
        chain: 'solana',
        valueUsd: 1000,
      });

      const assessment = await await analyzer.assessRisk(context);

      // Solana uses tipLamports, not gwei
      expect(assessment.recommendedPriorityFeeGwei).toBe(0);
      expect(assessment.recommendedTipLamports).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Mempool Recommendation Tests
  // ===========================================================================

  describe('Mempool Recommendation', () => {
    it('should recommend private mempool for high-risk Ethereum transactions', async () => {
      const context = createTransactionContext({
        chain: 'ethereum',
        valueUsd: 50000,
        poolLiquidityUsd: 200_000,
        slippageBps: 200,
      });

      const assessment = await await analyzer.assessRisk(context);

      expect(assessment.mempoolRecommendation).toBe(MempoolRecommendation.PRIVATE);
    });

    it('should recommend public mempool for low-risk transactions', async () => {
      const context = createTransactionContext({
        chain: 'ethereum',
        valueUsd: 100,
        poolLiquidityUsd: 10_000_000,
        slippageBps: 30,
      });

      const assessment = await await analyzer.assessRisk(context);

      expect(assessment.mempoolRecommendation).toBe(MempoolRecommendation.PUBLIC);
    });

    it('should recommend private for medium-risk valuable transactions', async () => {
      const context = createTransactionContext({
        chain: 'ethereum',
        valueUsd: 10000,
        poolLiquidityUsd: 1_000_000,
        slippageBps: 100,
      });

      const assessment = await await analyzer.assessRisk(context);

      // Medium risk but valuable - better safe than sorry
      expect([MempoolRecommendation.PRIVATE, MempoolRecommendation.CONDITIONAL]).toContain(
        assessment.mempoolRecommendation
      );
    });

    it('should recommend public for L2 chains (inherent protection)', async () => {
      const context = createTransactionContext({
        chain: 'optimism',
        valueUsd: 10000,
        poolLiquidityUsd: 500_000,
      });

      const assessment = await await analyzer.assessRisk(context);

      // L2s have sequencer protection, so public is usually fine
      expect([MempoolRecommendation.PUBLIC, MempoolRecommendation.CONDITIONAL]).toContain(
        assessment.mempoolRecommendation
      );
    });

    it('should return recommended strategy based on chain', async () => {
      const contexts = [
        { chain: 'ethereum', expected: 'flashbots' },
        { chain: 'bsc', expected: 'bloxroute' },
        { chain: 'polygon', expected: 'fastlane' },
        { chain: 'arbitrum', expected: 'sequencer' },
        { chain: 'solana', expected: 'jito' },
      ];

      for (const { chain, expected } of contexts) {
        const context = createTransactionContext({ chain, valueUsd: 10000 });
        const assessment = await await analyzer.assessRisk(context);
        expect(assessment.recommendedStrategy).toBe(expected);
      }
    });
  });

  // ===========================================================================
  // Assessment Output Tests
  // ===========================================================================

  describe('Assessment Output', () => {
    it('should return complete assessment object', async () => {
      const context = createTransactionContext();
      const assessment = await await analyzer.assessRisk(context);

      expect(assessment).toHaveProperty('sandwichRisk');
      expect(assessment).toHaveProperty('sandwichRiskScore');
      expect(assessment).toHaveProperty('recommendedPriorityFeeGwei');
      expect(assessment).toHaveProperty('mempoolRecommendation');
      expect(assessment).toHaveProperty('recommendedStrategy');
      expect(assessment).toHaveProperty('riskFactors');
      expect(assessment).toHaveProperty('estimatedMevExposureUsd');
    });

    it('should include detailed risk factors', async () => {
      const context = createTransactionContext({
        valueUsd: 50000,
        poolLiquidityUsd: 200_000, // 25% ratio = critical
        slippageBps: 200, // >= 200 bps = critical
      });

      const assessment = await await analyzer.assessRisk(context);

      // 25% liquidity ratio triggers critical, 200 bps slippage triggers critical
      expect(assessment.riskFactors).toContain('critical_value_to_liquidity_ratio');
      expect(assessment.riskFactors).toContain('critical_slippage_tolerance');
    });

    it('should include high (not critical) risk factors at appropriate thresholds', async () => {
      const context = createTransactionContext({
        valueUsd: 10000,
        poolLiquidityUsd: 200_000, // 5% ratio = high
        slippageBps: 100, // >= 100 bps (threshold) = high
      });

      const assessment = await await analyzer.assessRisk(context);

      // 5% liquidity ratio triggers high, 100 bps slippage triggers high
      expect(assessment.riskFactors).toContain('high_value_to_liquidity_ratio');
      expect(assessment.riskFactors).toContain('high_slippage_tolerance');
    });

    it('should estimate MEV exposure in USD', async () => {
      const context = createTransactionContext({
        valueUsd: 10000,
        slippageBps: 100,
      });

      const assessment = await await analyzer.assessRisk(context);

      // MEV exposure should be some fraction of value based on slippage
      expect(assessment.estimatedMevExposureUsd).toBeGreaterThan(0);
      expect(assessment.estimatedMevExposureUsd).toBeLessThanOrEqual(context.valueUsd);
    });
  });

  // ===========================================================================
  // Edge Cases Tests
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle zero value transactions', async () => {
      const context = createTransactionContext({
        valueUsd: 0,
      });

      const assessment = await await analyzer.assessRisk(context);

      expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.LOW);
      expect(assessment.sandwichRiskScore).toBe(0);
    });

    it('should handle very large transactions', async () => {
      const context = createTransactionContext({
        valueUsd: 10_000_000,
        poolLiquidityUsd: 1_000_000,
        slippageBps: 200, // Add high slippage to push into critical
      });

      const assessment = await await analyzer.assessRisk(context);

      // With 10x value-to-liquidity + high slippage = CRITICAL
      expect(assessment.sandwichRisk).toBe(SandwichRiskLevel.CRITICAL);
      expect(assessment.mempoolRecommendation).toBe(MempoolRecommendation.PRIVATE);
    });

    it('should handle unknown chain gracefully', async () => {
      const context = createTransactionContext({
        chain: 'unknown_chain',
      });

      const assessment = await await analyzer.assessRisk(context);

      expect(assessment).toBeDefined();
      expect(assessment.recommendedStrategy).toBe('standard');
    });

    it('should handle missing optional fields', async () => {
      const minimalContext: TransactionContext = {
        chain: 'ethereum',
        valueUsd: 1000,
        slippageBps: 50,
      };

      const assessment = await analyzer.assessRisk(minimalContext);

      expect(assessment).toBeDefined();
      expect(assessment.sandwichRisk).toBeDefined();
    });
  });

  // ===========================================================================
  // Performance Tests
  // ===========================================================================

  describe('Performance', () => {
    it('should assess risk quickly (hot path)', async () => {
      const context = createTransactionContext();

      const startTime = Date.now();
      for (let i = 0; i < 1000; i++) {
        await analyzer.assessRisk(context);
      }
      const elapsed = Date.now() - startTime;

      // Should be able to do 1000 assessments in under 100ms
      expect(elapsed).toBeLessThan(100);
    });
  });

  // ===========================================================================
  // MEV_RISK_DEFAULTS Tests
  // ===========================================================================

  describe('MEV_RISK_DEFAULTS', () => {
    it('should have sensible default values', async () => {
      expect(MEV_RISK_DEFAULTS.highValueThresholdUsd).toBeGreaterThan(0);
      expect(MEV_RISK_DEFAULTS.sandwichRiskThresholdBps).toBeGreaterThan(0);
      expect(MEV_RISK_DEFAULTS.minLiquidityRatioForSafety).toBeGreaterThan(0);
      expect(MEV_RISK_DEFAULTS.minLiquidityRatioForSafety).toBeLessThan(1);
    });
  });

  // ===========================================================================
  // Config Synchronization Validation Tests
  // ===========================================================================

  describe('Config Synchronization', () => {
    it('should have chainBasePriorityFees synchronized with MEV_CONFIG', async () => {
      // Convert MEV_CONFIG chainSettings to the format expected by validateConfigSync
      const externalChainConfig = Object.entries(MEV_CONFIG.chainSettings).map(
        ([chain, settings]) => ({
          chain,
          priorityFeeGwei: settings.priorityFeeGwei,
        })
      );

      const result = validateConfigSync(externalChainConfig);

      // If there are mismatches, log them for debugging
      if (!result.valid) {
        console.warn('Config mismatches found:', result.mismatches);
      }

      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('should return local chain priority fees correctly', async () => {
      const localFees = getLocalChainPriorityFees();

      // Should have all expected chains
      expect(localFees.ethereum).toBe(2);
      expect(localFees.bsc).toBe(3);
      expect(localFees.polygon).toBe(30);
      expect(localFees.arbitrum).toBe(0.01);
      expect(localFees.solana).toBe(0); // Solana uses lamports, not gwei
    });

    it('should detect mismatches when configs differ', async () => {
      // Test with intentionally mismatched config
      const mismatchedConfig = [
        { chain: 'ethereum', priorityFeeGwei: 999 }, // Wrong value
      ];

      const result = validateConfigSync(mismatchedConfig);

      expect(result.valid).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
      expect(result.mismatches[0].chain).toBe('ethereum');
    });

    it('should handle chains in local config but not in external config', async () => {
      // Empty external config should flag all local chains as missing
      const result = validateConfigSync([]);

      // All local chains should be flagged as missing from external config
      expect(result.valid).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });
  });
});

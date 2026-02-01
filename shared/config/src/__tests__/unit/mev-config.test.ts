/**
 * Tests for MEV Protection Configuration
 *
 * @see mev-config.ts
 */

import {
  MEV_CONFIG,
  MEV_PRIORITY_FEE_SUMMARY,
  getMevChainConfigForValidation,
} from '../../mev-config';

describe('MEV Configuration', () => {
  describe('MEV_CONFIG', () => {
    it('should have valid defaults for all chains', () => {
      const chains = Object.keys(MEV_CONFIG.chainSettings);
      expect(chains.length).toBeGreaterThanOrEqual(11);

      // All supported chains should be present
      const expectedChains = [
        'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism',
        'base', 'zksync', 'linea', 'avalanche', 'fantom', 'solana'
      ];

      for (const chain of expectedChains) {
        expect(MEV_CONFIG.chainSettings[chain]).toBeDefined();
      }
    });

    it('should have valid strategy types for each chain', () => {
      const validStrategies = ['flashbots', 'bloxroute', 'fastlane', 'sequencer', 'standard', 'jito'];

      for (const [chain, settings] of Object.entries(MEV_CONFIG.chainSettings)) {
        expect(validStrategies).toContain(settings.strategy);
      }
    });

    it('should have non-negative priority fees', () => {
      for (const [chain, settings] of Object.entries(MEV_CONFIG.chainSettings)) {
        expect(settings.priorityFeeGwei).toBeGreaterThanOrEqual(0);
      }
    });

    it('should have non-negative minProfitForProtection', () => {
      for (const [chain, settings] of Object.entries(MEV_CONFIG.chainSettings)) {
        expect(settings.minProfitForProtection).toBeGreaterThanOrEqual(0);
      }
    });

    it('should use Flashbots for Ethereum', () => {
      expect(MEV_CONFIG.chainSettings.ethereum.strategy).toBe('flashbots');
    });

    it('should use BloXroute for BSC', () => {
      expect(MEV_CONFIG.chainSettings.bsc.strategy).toBe('bloxroute');
    });

    it('should use Fastlane for Polygon', () => {
      expect(MEV_CONFIG.chainSettings.polygon.strategy).toBe('fastlane');
    });

    it('should use sequencer strategy for L2 rollups', () => {
      const l2Chains = ['arbitrum', 'optimism', 'base', 'zksync', 'linea'];
      for (const chain of l2Chains) {
        expect(MEV_CONFIG.chainSettings[chain].strategy).toBe('sequencer');
      }
    });

    it('should use Jito for Solana', () => {
      expect(MEV_CONFIG.chainSettings.solana.strategy).toBe('jito');
    });
  });

  describe('MEV_PRIORITY_FEE_SUMMARY', () => {
    it('should have entries for all supported chains', () => {
      const expectedChains = [
        'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism',
        'base', 'zksync', 'linea', 'avalanche', 'fantom', 'solana'
      ];

      for (const chain of expectedChains) {
        expect(MEV_PRIORITY_FEE_SUMMARY[chain as keyof typeof MEV_PRIORITY_FEE_SUMMARY]).toBeDefined();
      }
    });

    it('should match chainSettings priority fees', () => {
      for (const [chain, fee] of Object.entries(MEV_PRIORITY_FEE_SUMMARY)) {
        const chainSetting = MEV_CONFIG.chainSettings[chain];
        if (chainSetting) {
          expect(chainSetting.priorityFeeGwei).toBe(fee);
        }
      }
    });
  });

  describe('getMevChainConfigForValidation', () => {
    it('should return array with all chain configs', () => {
      const configs = getMevChainConfigForValidation();
      expect(Array.isArray(configs)).toBe(true);
      expect(configs.length).toBe(Object.keys(MEV_CONFIG.chainSettings).length);
    });

    it('should include chain name and priority fee for each entry', () => {
      const configs = getMevChainConfigForValidation();

      for (const config of configs) {
        expect(config).toHaveProperty('chain');
        expect(config).toHaveProperty('priorityFeeGwei');
        expect(typeof config.chain).toBe('string');
        expect(typeof config.priorityFeeGwei).toBe('number');
      }
    });

    it('should have Ethereum with correct priority fee', () => {
      const configs = getMevChainConfigForValidation();
      const ethConfig = configs.find(c => c.chain === 'ethereum');

      expect(ethConfig).toBeDefined();
      expect(ethConfig?.priorityFeeGwei).toBe(2.0);
    });
  });

  describe('Global MEV Config Defaults', () => {
    it('should have reasonable submission timeout', () => {
      expect(MEV_CONFIG.submissionTimeoutMs).toBeGreaterThanOrEqual(10000);
      expect(MEV_CONFIG.submissionTimeoutMs).toBeLessThanOrEqual(60000);
    });

    it('should have reasonable max retries', () => {
      expect(MEV_CONFIG.maxRetries).toBeGreaterThanOrEqual(1);
      expect(MEV_CONFIG.maxRetries).toBeLessThanOrEqual(10);
    });

    it('should have valid relay URLs', () => {
      expect(MEV_CONFIG.flashbotsRelayUrl).toMatch(/^https?:\/\//);
      expect(MEV_CONFIG.bloxrouteUrl).toMatch(/^https?:\/\//);
      expect(MEV_CONFIG.fastlaneUrl).toMatch(/^https?:\/\//);
    });
  });
});

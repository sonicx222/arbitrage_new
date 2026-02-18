/**
 * Unit Tests for MEV Config Synchronization Validator
 *
 * Tests validateConfigSync() and getLocalChainPriorityFees() from
 * shared/core/src/mev-protection/config-validator.ts.
 *
 * @see config-validator.ts (source module)
 * @see mev-risk-analyzer.ts (only caller via mev-risk-analyzer)
 */

import {
  validateConfigSync,
  getLocalChainPriorityFees,
  type ConfigSyncValidationResult,
} from '../../../src/mev-protection/config-validator';
import { MEV_RISK_DEFAULTS } from '../../../src/mev-protection/mev-risk-analyzer.types';

describe('MEV Config Validator', () => {
  describe('validateConfigSync', () => {
    it('should return valid=true when configs match exactly', () => {
      // Build external config that matches all local chains
      const externalConfig = Object.entries(MEV_RISK_DEFAULTS.chainBasePriorityFees).map(
        ([chain, priorityFeeGwei]) => ({ chain, priorityFeeGwei })
      );

      const result = validateConfigSync(externalConfig);

      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('should return valid=false when priority fees are mismatched', () => {
      const externalConfig = Object.entries(MEV_RISK_DEFAULTS.chainBasePriorityFees).map(
        ([chain, priorityFeeGwei]) => ({ chain, priorityFeeGwei })
      );

      // Introduce a mismatch for ethereum
      const ethEntry = externalConfig.find((c) => c.chain === 'ethereum');
      if (ethEntry) {
        ethEntry.priorityFeeGwei = 999;
      }

      const result = validateConfigSync(externalConfig);

      expect(result.valid).toBe(false);
      expect(result.mismatches.length).toBeGreaterThanOrEqual(1);

      const ethMismatch = result.mismatches.find((m) => m.chain === 'ethereum');
      expect(ethMismatch).toBeDefined();
      expect(ethMismatch!.field).toBe('priorityFeeGwei');
      expect(ethMismatch!.riskAnalyzerValue).toBe(MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum']);
      expect(ethMismatch!.externalConfigValue).toBe(999);
      expect(ethMismatch!.message).toContain('ethereum');
    });

    it('should report missing chains that are in local but not external config', () => {
      // Provide only a subset of chains
      const externalConfig = [
        { chain: 'ethereum', priorityFeeGwei: MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum'] },
      ];

      const result = validateConfigSync(externalConfig);

      expect(result.valid).toBe(false);

      // Every chain except ethereum should be reported as missing
      const localChains = Object.keys(MEV_RISK_DEFAULTS.chainBasePriorityFees);
      const missingChains = result.mismatches.filter((m) => m.field === 'chain');
      expect(missingChains.length).toBe(localChains.length - 1);

      for (const mismatch of missingChains) {
        expect(mismatch.chain).not.toBe('ethereum');
        expect(mismatch.message).toContain('not in external config');
      }
    });

    it('should skip chains that are in external config but not in local config', () => {
      // Include all matching chains plus an extra unknown chain
      const externalConfig = Object.entries(MEV_RISK_DEFAULTS.chainBasePriorityFees).map(
        ([chain, priorityFeeGwei]) => ({ chain, priorityFeeGwei })
      );
      externalConfig.push({ chain: 'unknown_chain_xyz', priorityFeeGwei: 42 });

      const result = validateConfigSync(externalConfig);

      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('should treat empty external config as all local chains missing', () => {
      const result = validateConfigSync([]);

      expect(result.valid).toBe(false);

      const localChainCount = Object.keys(MEV_RISK_DEFAULTS.chainBasePriorityFees).length;
      expect(result.mismatches).toHaveLength(localChainCount);
      for (const mismatch of result.mismatches) {
        expect(mismatch.field).toBe('chain');
      }
    });

    it('should allow floating point differences within 0.001 tolerance', () => {
      const localFee = MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum'];
      const externalConfig = Object.entries(MEV_RISK_DEFAULTS.chainBasePriorityFees).map(
        ([chain, priorityFeeGwei]) => ({ chain, priorityFeeGwei })
      );

      // Introduce a tiny difference within tolerance
      const ethEntry = externalConfig.find((c) => c.chain === 'ethereum');
      if (ethEntry) {
        ethEntry.priorityFeeGwei = localFee + 0.0005; // Within 0.001 tolerance
      }

      const result = validateConfigSync(externalConfig);

      // Should not report ethereum as mismatched
      const ethMismatch = result.mismatches.find(
        (m) => m.chain === 'ethereum' && m.field === 'priorityFeeGwei'
      );
      expect(ethMismatch).toBeUndefined();
    });

    it('should detect floating point differences beyond 0.001 tolerance', () => {
      const localFee = MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum'];
      const externalConfig = Object.entries(MEV_RISK_DEFAULTS.chainBasePriorityFees).map(
        ([chain, priorityFeeGwei]) => ({ chain, priorityFeeGwei })
      );

      // Introduce a difference beyond tolerance
      const ethEntry = externalConfig.find((c) => c.chain === 'ethereum');
      if (ethEntry) {
        ethEntry.priorityFeeGwei = localFee + 0.01; // Beyond 0.001 tolerance
      }

      const result = validateConfigSync(externalConfig);

      const ethMismatch = result.mismatches.find(
        (m) => m.chain === 'ethereum' && m.field === 'priorityFeeGwei'
      );
      expect(ethMismatch).toBeDefined();
    });

    it('should handle multiple mismatches in a single call', () => {
      const externalConfig = [
        { chain: 'ethereum', priorityFeeGwei: 999 },
        { chain: 'bsc', priorityFeeGwei: 888 },
      ];

      const result = validateConfigSync(externalConfig);

      expect(result.valid).toBe(false);
      // At least 2 fee mismatches + all missing chains
      const feeMismatches = result.mismatches.filter((m) => m.field === 'priorityFeeGwei');
      expect(feeMismatches.length).toBe(2);
    });
  });

  describe('getLocalChainPriorityFees', () => {
    it('should return all chains from MEV_RISK_DEFAULTS', () => {
      const fees = getLocalChainPriorityFees();
      const expectedChains = Object.keys(MEV_RISK_DEFAULTS.chainBasePriorityFees);

      expect(Object.keys(fees)).toEqual(expect.arrayContaining(expectedChains));
      expect(Object.keys(fees)).toHaveLength(expectedChains.length);
    });

    it('should return correct values for known chains', () => {
      const fees = getLocalChainPriorityFees();

      expect(fees['ethereum']).toBe(MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum']);
      expect(fees['bsc']).toBe(MEV_RISK_DEFAULTS.chainBasePriorityFees['bsc']);
      expect(fees['solana']).toBe(0); // Solana uses lamports, gwei fee is 0
    });

    it('should return a defensive copy (not a reference to the original)', () => {
      const fees1 = getLocalChainPriorityFees();
      const fees2 = getLocalChainPriorityFees();

      // Should be equal in value
      expect(fees1).toEqual(fees2);

      // But modifying one should not affect the other or the original
      fees1['ethereum'] = 9999;
      const fees3 = getLocalChainPriorityFees();
      expect(fees3['ethereum']).toBe(MEV_RISK_DEFAULTS.chainBasePriorityFees['ethereum']);
    });
  });
});

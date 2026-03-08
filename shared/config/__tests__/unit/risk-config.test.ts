/**
 * Tests for Risk Configuration
 *
 * Covers:
 * - Environment variable parsing
 * - Configuration validation
 * - Production safeguards
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RISK_CONFIG, validateRiskConfig, getRiskConfigWithCapital } from '../../src/risk-config';

// Store original env vars
const originalEnv = { ...process.env };

describe('Risk Configuration', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('Validation', () => {
        it('should pass validation with default values', () => {
            expect(() => validateRiskConfig()).not.toThrow();
        });

        it('should throw when defaultWinProbability is below minWinProbability', () => {
            // validateRiskConfig reads RISK_CONFIG which is computed at module load.
            // Re-require the module with env vars that trigger the cross-validation error.
            process.env.RISK_DEFAULT_WIN_PROBABILITY = '0.20';
            process.env.RISK_MIN_WIN_PROBABILITY = '0.60';

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { validateRiskConfig: validate } = require('../../src/risk-config');
            expect(() => validate()).toThrow('RISK_DEFAULT_WIN_PROBABILITY');
        });

        it('should require TOTAL_CAPITAL in production', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.RISK_TOTAL_CAPITAL;

            expect(() => validateRiskConfig()).toThrow('RISK_TOTAL_CAPITAL must be explicitly set');
        });

        it('should NOT require TOTAL_CAPITAL in development', () => {
            process.env.NODE_ENV = 'development';
            delete process.env.RISK_TOTAL_CAPITAL;

            expect(() => validateRiskConfig()).not.toThrow();
        });

        // FIX P2-8: Gas-budget validation tests
        it('should throw when gas-budget mode has maxGasPerTrade > dailyGasBudget', () => {
            process.env.RISK_GAS_BUDGET_MODE = 'true';
            process.env.RISK_MAX_GAS_PER_TRADE = '2000000000000000000'; // 2 ETH
            process.env.RISK_DAILY_GAS_BUDGET = '1000000000000000000'; // 1 ETH

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { validateRiskConfig: validate } = require('../../src/risk-config');
            expect(() => validate()).toThrow('RISK_MAX_GAS_PER_TRADE');
        });

        it('should NOT validate gas-budget fields when gas-budget mode is disabled', () => {
            // Default: RISK_GAS_BUDGET_MODE is unset (false)
            process.env.RISK_MAX_GAS_PER_TRADE = '2000000000000000000'; // 2 ETH > daily
            process.env.RISK_DAILY_GAS_BUDGET = '1000000000000000000'; // 1 ETH

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { validateRiskConfig: validate } = require('../../src/risk-config');
            expect(() => validate()).not.toThrow();
        });
    });

    describe('Per-Chain EV Threshold Overrides', () => {
        it('should parse RISK_CHAIN_EV_THRESHOLDS JSON into chainMinEVThresholds', () => {
            process.env.RISK_CHAIN_EV_THRESHOLDS = '{"base":"100000000000000","arbitrum":"300000000000000"}';

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { RISK_CONFIG: config } = require('../../src/risk-config');
            expect(config.ev.chainMinEVThresholds).toEqual({
                base: 100000000000000n,
                arbitrum: 300000000000000n,
            });
        });

        it('should return undefined when RISK_CHAIN_EV_THRESHOLDS is not set', () => {
            delete process.env.RISK_CHAIN_EV_THRESHOLDS;

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { RISK_CONFIG: config } = require('../../src/risk-config');
            expect(config.ev.chainMinEVThresholds).toBeUndefined();
        });

        it('should ignore invalid JSON in RISK_CHAIN_EV_THRESHOLDS', () => {
            process.env.RISK_CHAIN_EV_THRESHOLDS = 'not-json';

            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { RISK_CONFIG: config } = require('../../src/risk-config');
            expect(config.ev.chainMinEVThresholds).toBeUndefined();
        });
    });

    describe('Configuration Getters', () => {
        it('getRiskConfigWithCapital should override totalCapital', () => {
            const newCapital = BigInt('5000000000000000000'); // 5 ETH
            const config = getRiskConfigWithCapital(newCapital);

            expect(config.totalCapital).toBe(newCapital);
            expect(config.drawdown.enabled).toBe(RISK_CONFIG.drawdown.enabled);
        });
    });
});

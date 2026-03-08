import {
  isTestnetExecutionMode,
  isSimulationMode,
  isExecutionSimulationMode,
  isHybridExecutionMode,
  getSimulationModeSummary,
  getSimulationRealismLevel,
} from '../../../src/simulation/mode-utils';

describe('mode-utils', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TESTNET_EXECUTION_MODE;
    delete process.env.SIMULATION_MODE;
    delete process.env.EXECUTION_SIMULATION_MODE;
    delete process.env.EXECUTION_HYBRID_MODE;
    delete process.env.SIMULATION_REALISM_LEVEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isTestnetExecutionMode', () => {
    it('returns false when env var is not set', () => {
      expect(isTestnetExecutionMode()).toBe(false);
    });

    it('returns true when env var is "true"', () => {
      process.env.TESTNET_EXECUTION_MODE = 'true';
      expect(isTestnetExecutionMode()).toBe(true);
    });

    it('returns false when env var is "false"', () => {
      process.env.TESTNET_EXECUTION_MODE = 'false';
      expect(isTestnetExecutionMode()).toBe(false);
    });

    it('returns false when env var is empty string', () => {
      process.env.TESTNET_EXECUTION_MODE = '';
      expect(isTestnetExecutionMode()).toBe(false);
    });
  });

  describe('isSimulationMode', () => {
    it('returns true when SIMULATION_MODE=true', () => {
      process.env.SIMULATION_MODE = 'true';
      expect(isSimulationMode()).toBe(true);
    });

    it('returns false when not set', () => {
      expect(isSimulationMode()).toBe(false);
    });
  });

  describe('isExecutionSimulationMode', () => {
    it('returns true when EXECUTION_SIMULATION_MODE=true', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      expect(isExecutionSimulationMode()).toBe(true);
    });

    it('returns false when not set', () => {
      expect(isExecutionSimulationMode()).toBe(false);
    });
  });

  describe('isHybridExecutionMode', () => {
    it('returns true when EXECUTION_HYBRID_MODE=true', () => {
      process.env.EXECUTION_HYBRID_MODE = 'true';
      expect(isHybridExecutionMode()).toBe(true);
    });

    it('returns false when not set', () => {
      expect(isHybridExecutionMode()).toBe(false);
    });
  });

  describe('getSimulationRealismLevel', () => {
    it('defaults to medium when not set', () => {
      expect(getSimulationRealismLevel()).toBe('medium');
    });

    it('returns low when set', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'low';
      expect(getSimulationRealismLevel()).toBe('low');
    });

    it('returns high when set', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'high';
      expect(getSimulationRealismLevel()).toBe('high');
    });

    it('is case-insensitive', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'HIGH';
      expect(getSimulationRealismLevel()).toBe('high');
    });

    it('defaults to medium for invalid values', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'invalid';
      expect(getSimulationRealismLevel()).toBe('medium');
    });
  });

  describe('getSimulationModeSummary', () => {
    it('returns production mode by default', () => {
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('production');
      expect(summary.simulationMode).toBe(false);
      expect(summary.executionSimulation).toBe(false);
      expect(summary.hybridMode).toBe(false);
      expect(summary.testnetExecution).toBe(false);
    });

    it('returns simulation mode when SIMULATION_MODE=true', () => {
      process.env.SIMULATION_MODE = 'true';
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('simulation');
      expect(summary.simulationMode).toBe(true);
    });

    it('returns simulation mode when EXECUTION_SIMULATION_MODE=true', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('simulation');
    });

    it('returns hybrid mode when EXECUTION_HYBRID_MODE=true', () => {
      process.env.EXECUTION_HYBRID_MODE = 'true';
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('hybrid');
    });

    it('returns testnet-live when TESTNET_EXECUTION_MODE=true and EXECUTION_SIMULATION_MODE is off', () => {
      process.env.TESTNET_EXECUTION_MODE = 'true';
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('testnet-live');
      expect(summary.testnetExecution).toBe(true);
    });

    it('returns simulation when TESTNET_EXECUTION_MODE=true but EXECUTION_SIMULATION_MODE=true (M-01)', () => {
      process.env.TESTNET_EXECUTION_MODE = 'true';
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      const summary = getSimulationModeSummary();
      // M-01 FIX: SimulationStrategy intercepts, so not actually testnet-live
      expect(summary.effectiveMode).toBe('simulation');
      expect(summary.testnetExecution).toBe(true);
      expect(summary.executionSimulation).toBe(true);
    });

    it('testnet-live takes precedence over hybrid and simulation', () => {
      process.env.TESTNET_EXECUTION_MODE = 'true';
      process.env.EXECUTION_HYBRID_MODE = 'true';
      process.env.SIMULATION_MODE = 'true';
      const summary = getSimulationModeSummary();
      expect(summary.effectiveMode).toBe('testnet-live');
    });
  });
});

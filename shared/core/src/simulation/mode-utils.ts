/**
 * Simulation Mode Utilities
 *
 * Environment-based mode detection functions.
 *
 * @module simulation
 */

export function isSimulationMode(): boolean {
  return process.env.SIMULATION_MODE === 'true';
}

/**
 * Check if execution simulation mode is enabled.
 * This mode simulates transaction execution (dry-run) without real blockchain transactions.
 */
export function isExecutionSimulationMode(): boolean {
  return process.env.EXECUTION_SIMULATION_MODE === 'true';
}

/**
 * Check if hybrid execution mode is enabled.
 *
 * Hybrid mode enables:
 * - Real strategy selection logic (not SimulationStrategy override)
 * - Real pre-execution validation and checks
 * - Mocked transaction submission (no real blockchain transactions)
 *
 * This allows testing the full execution pipeline including strategy routing
 * for all opportunity types (intra-chain, cross-chain, flash-loan, triangular,
 * quadrilateral) without making actual transactions.
 *
 * Set via: EXECUTION_HYBRID_MODE=true
 *
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S4
 */
export function isHybridExecutionMode(): boolean {
  return process.env.EXECUTION_HYBRID_MODE === 'true';
}

/**
 * Check if testnet execution mode is enabled.
 *
 * Testnet execution mode uses simulated prices (SIMULATION_MODE=true) but
 * submits real transactions to testnet chains (EXECUTION_SIMULATION_MODE=false).
 * Relaxes price verification thresholds since testnet tokens have no real value.
 *
 * Also enables:
 * - Chain name normalization (ethereum -> sepolia, arbitrum -> arbitrumSepolia)
 * - Token address mapping (mainnet -> testnet addresses)
 * - Router/contract address resolution for testnet deployments
 *
 * Set via: TESTNET_EXECUTION_MODE=true
 */
export function isTestnetExecutionMode(): boolean {
  return process.env.TESTNET_EXECUTION_MODE === 'true';
}

/**
 * Get simulation mode summary for logging/debugging.
 */
export function getSimulationModeSummary(): {
  simulationMode: boolean;
  executionSimulation: boolean;
  hybridMode: boolean;
  testnetExecution: boolean;
  effectiveMode: 'production' | 'simulation' | 'hybrid' | 'testnet-live';
} {
  const simulationMode = isSimulationMode();
  const executionSimulation = isExecutionSimulationMode();
  const hybridMode = isHybridExecutionMode();
  const testnetExecution = isTestnetExecutionMode();

  let effectiveMode: 'production' | 'simulation' | 'hybrid' | 'testnet-live' = 'production';
  // M-01 FIX: Only report 'testnet-live' when execution simulation is off.
  // When EXECUTION_SIMULATION_MODE=true, SimulationStrategy intercepts all executions
  // so no real testnet transactions occur despite the TESTNET_EXECUTION_MODE flag.
  if (testnetExecution && !executionSimulation) {
    effectiveMode = 'testnet-live';
  } else if (hybridMode) {
    effectiveMode = 'hybrid';
  } else if (simulationMode || executionSimulation) {
    effectiveMode = 'simulation';
  }

  return {
    simulationMode,
    executionSimulation,
    hybridMode,
    testnetExecution,
    effectiveMode,
  };
}

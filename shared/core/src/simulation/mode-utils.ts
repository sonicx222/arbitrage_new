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
 * Get simulation mode summary for logging/debugging.
 */
export function getSimulationModeSummary(): {
  simulationMode: boolean;
  executionSimulation: boolean;
  hybridMode: boolean;
  effectiveMode: 'production' | 'simulation' | 'hybrid';
} {
  const simulationMode = isSimulationMode();
  const executionSimulation = isExecutionSimulationMode();
  const hybridMode = isHybridExecutionMode();

  let effectiveMode: 'production' | 'simulation' | 'hybrid' = 'production';
  if (hybridMode) {
    effectiveMode = 'hybrid';
  } else if (simulationMode || executionSimulation) {
    effectiveMode = 'simulation';
  }

  return {
    simulationMode,
    executionSimulation,
    hybridMode,
    effectiveMode,
  };
}

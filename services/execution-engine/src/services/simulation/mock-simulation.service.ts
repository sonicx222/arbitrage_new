/**
 * Mock Simulation Service for dev/monitor mode.
 *
 * RT-009 FIX: When EXECUTION_SIMULATION_MODE=true, the real simulation service
 * was skipped entirely (strategy-initializer.ts line 435), leaving
 * txSimulationService as null. This caused /stats to report "no simulation
 * providers" — a false negative that obscured whether the simulation pipeline
 * path was correctly wired.
 *
 * This mock implements ISimulationService and always returns success,
 * exercising the full simulation→execution pipeline in dev/monitor mode.
 *
 * @see strategy-initializer.ts (consumer)
 * @see types.ts (ISimulationService interface)
 */

import type {
  ISimulationService,
  SimulationRequest,
  SimulationResult,
  SimulationMetrics,
  SimulationProviderType,
  SimulationProviderHealth,
  SimulationTier,
} from './types';

/**
 * No-op simulation service that always returns successful results.
 * Used in simulation/dev mode to exercise the full pipeline without
 * requiring external simulation provider credentials.
 */
export class MockSimulationService implements ISimulationService {
  private metrics: SimulationMetrics = {
    totalSimulations: 0,
    successfulSimulations: 0,
    failedSimulations: 0,
    predictedReverts: 0,
    averageLatencyMs: 0,
    fallbackUsed: 0,
    cacheHits: 0,
    lastUpdated: Date.now(),
  };

  async initialize(): Promise<void> {
    // No-op: mock provider needs no initialization
  }

  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    this.metrics.totalSimulations++;
    this.metrics.successfulSimulations++;
    this.metrics.lastUpdated = Date.now();

    return {
      success: true,
      wouldRevert: false,
      gasUsed: 250_000n,
      provider: 'local',
      latencyMs: 1,
    };
  }

  shouldSimulate(_expectedProfit: number, _opportunityAge: number): boolean {
    return true;
  }

  getSimulationTier(_expectedProfit: number, _opportunityAge: number): SimulationTier {
    return 'light';
  }

  getAggregatedMetrics(): SimulationMetrics {
    return { ...this.metrics };
  }

  getProvidersHealth(): Map<SimulationProviderType, SimulationProviderHealth> {
    const health: SimulationProviderHealth = {
      healthy: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      averageLatencyMs: 1,
      successRate: 1,
    };
    return new Map([['local', health]]);
  }

  stop(): void {
    // No-op: nothing to clean up
  }
}

/**
 * Base Simulation Provider
 *
 * Abstract base class that provides common functionality for all simulation providers.
 * This reduces code duplication and ensures consistent behavior across:
 * - TenderlyProvider
 * - AlchemySimulationProvider
 * - LocalSimulationProvider
 *
 * Common functionality includes:
 * - Metrics tracking (total, successful, failed simulations)
 * - Health status management (consecutive failures, success rate)
 * - Rolling window for success rate calculation
 * - Average latency tracking
 *
 * @see Phase 1.1: Transaction Simulation Integration
 */

import {
  ISimulationProvider,
  SimulationProviderConfig,
  SimulationProviderHealth,
  SimulationMetrics,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  SimulationLogger,
  SIMULATION_DEFAULTS,
  CircularBuffer,
  getSimulationErrorMessage,
  updateRollingAverage,
  createConsoleLogger,
} from './types';

// =============================================================================
// Base Provider Implementation
// =============================================================================

/**
 * Abstract base class for simulation providers.
 *
 * Subclasses must implement:
 * - `executeSimulation()`: Provider-specific simulation logic
 * - `healthCheck()`: Provider-specific health check
 *
 * @example
 * class MyProvider extends BaseSimulationProvider {
 *   readonly type: SimulationProviderType = 'local';
 *
 *   protected async executeSimulation(request: SimulationRequest, startTime: number): Promise<SimulationResult> {
 *     // Provider-specific implementation
 *   }
 *
 *   async healthCheck(): Promise<{ healthy: boolean; message: string }> {
 *     // Provider-specific health check
 *   }
 * }
 */
export abstract class BaseSimulationProvider implements ISimulationProvider {
  /**
   * Provider type identifier. Must be set by subclass.
   */
  abstract readonly type: SimulationProviderType;

  /**
   * Chain this provider is configured for.
   */
  readonly chain: string;

  /**
   * Provider configuration.
   */
  protected readonly config: SimulationProviderConfig;

  /**
   * Timeout for simulation requests in milliseconds.
   */
  protected readonly timeoutMs: number;

  /**
   * Current metrics for this provider.
   */
  protected metrics: SimulationMetrics;

  /**
   * Current health status for this provider.
   */
  protected health: SimulationProviderHealth;

  /**
   * Rolling window for success rate calculation.
   * Uses O(1) circular buffer with configurable size.
   */
  protected readonly recentResults: CircularBuffer<boolean>;

  /**
   * Size of the rolling window for success rate calculation.
   * Default: 100 recent results.
   */
  protected readonly rollingWindowSize: number;

  /**
   * Fix 6.1: Logger instance for structured logging.
   * Uses console-based fallback if not provided in config.
   */
  protected readonly logger: SimulationLogger;

  constructor(config: SimulationProviderConfig, rollingWindowSize = 100) {
    this.config = config;
    this.chain = config.chain;
    this.timeoutMs = config.timeoutMs || SIMULATION_DEFAULTS.timeoutMs;
    this.rollingWindowSize = rollingWindowSize;

    // Fix 6.1: Initialize logger from config or use console fallback
    this.logger = config.logger ?? createConsoleLogger(config.type);

    this.metrics = this.createEmptyMetrics();
    this.health = this.createInitialHealth();
    this.recentResults = new CircularBuffer<boolean>(this.rollingWindowSize);
  }

  // ===========================================================================
  // ISimulationProvider Interface Implementation
  // ===========================================================================

  /**
   * Check if provider is available and enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Simulate a transaction using this provider.
   *
   * Common flow:
   * 1. Check if enabled
   * 2. Execute provider-specific simulation
   * 3. Update metrics and health based on result
   */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    const startTime = Date.now();
    this.metrics.totalSimulations++;

    if (!this.isEnabled()) {
      return this.createErrorResult(startTime, `${this.type} provider is disabled`);
    }

    try {
      const result = await this.executeSimulation(request, startTime);

      // Update health and metrics based on result
      if (result.success) {
        this.recordSuccess(startTime);
        if (result.wouldRevert) {
          this.metrics.predictedReverts++;
        }
      } else {
        this.recordFailure(result.error);
      }

      return result;
    } catch (error) {
      const errorMessage = getSimulationErrorMessage(error);
      this.recordFailure(errorMessage);
      return this.createErrorResult(startTime, errorMessage);
    }
  }

  /**
   * Get current health status (returns a copy).
   */
  getHealth(): SimulationProviderHealth {
    return { ...this.health };
  }

  /**
   * Get current metrics (returns a copy).
   */
  getMetrics(): SimulationMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics to initial state.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
    this.recentResults.clear();
  }

  /**
   * Perform a health check. Must be implemented by subclass.
   */
  abstract healthCheck(): Promise<{ healthy: boolean; message: string }>;

  // ===========================================================================
  // Abstract Methods (must be implemented by subclass)
  // ===========================================================================

  /**
   * Execute the provider-specific simulation.
   * Must be implemented by subclass.
   *
   * @param request - Simulation request
   * @param startTime - Start time for latency calculation
   * @returns Simulation result
   */
  protected abstract executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult>;

  // ===========================================================================
  // Protected Methods (common functionality)
  // ===========================================================================

  /**
   * Create an error result.
   */
  protected createErrorResult(startTime: number, error: string): SimulationResult {
    return {
      success: false,
      wouldRevert: false,
      error,
      provider: this.type,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Fix 9.1: Helper for fetch operations with timeout and proper cancellation.
   * Uses AbortController for true HTTP request cancellation.
   *
   * @param url - URL to fetch
   * @param options - Fetch options (method, headers, body)
   * @param timeoutMs - Timeout in milliseconds (defaults to this.timeoutMs)
   * @returns Fetch Response or throws on timeout/error
   */
  protected async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = this.timeoutMs
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create an empty metrics object.
   */
  protected createEmptyMetrics(): SimulationMetrics {
    return {
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      predictedReverts: 0,
      averageLatencyMs: 0,
      fallbackUsed: 0,
      cacheHits: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Create initial health status.
   *
   * Starts with unknown state (healthy: false, successRate: 0)
   * until first successful request validates the provider.
   * This prevents optimistic selection of untested providers.
   */
  protected createInitialHealth(): SimulationProviderHealth {
    return {
      healthy: false, // Unknown until first successful request
      lastCheck: 0, // No check performed yet
      consecutiveFailures: 0,
      averageLatencyMs: 0,
      successRate: 0, // Unknown until first request
    };
  }

  /**
   * Record a successful simulation.
   */
  protected recordSuccess(startTime: number): void {
    const latency = Date.now() - startTime;

    this.metrics.successfulSimulations++;
    this.updateAverageLatency(latency);

    this.health.consecutiveFailures = 0;
    this.health.healthy = true;
    this.health.lastCheck = Date.now();

    this.recentResults.pushOverwrite(true);
    this.updateSuccessRate();
  }

  /**
   * Record a failed simulation.
   */
  protected recordFailure(error?: string): void {
    this.metrics.failedSimulations++;

    this.health.consecutiveFailures++;
    this.health.lastError = error;
    this.health.lastCheck = Date.now();

    if (this.health.consecutiveFailures >= SIMULATION_DEFAULTS.maxConsecutiveFailures) {
      this.health.healthy = false;
    }

    this.recentResults.pushOverwrite(false);
    this.updateSuccessRate();
  }

  /**
   * Update average latency using rolling average.
   */
  protected updateAverageLatency(latency: number): void {
    const total = this.metrics.successfulSimulations;
    this.metrics.averageLatencyMs = updateRollingAverage(
      this.metrics.averageLatencyMs,
      latency,
      total
    );
    this.health.averageLatencyMs = this.metrics.averageLatencyMs;
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Update success rate from recent results.
   */
  protected updateSuccessRate(): void {
    if (this.recentResults.length === 0) {
      this.health.successRate = 0; // Unknown
      return;
    }

    const successes = this.recentResults.countWhere((r) => r);
    this.health.successRate = successes / this.recentResults.length;
  }
}

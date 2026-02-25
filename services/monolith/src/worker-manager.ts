/**
 * Worker Manager — Spawns and manages service worker threads
 *
 * Manages the lifecycle of all arbitrage services running as Node.js
 * worker threads within a single process. Provides:
 *
 * - Service spawning with SharedArrayBuffer for price matrix
 * - Health monitoring via inter-thread messaging
 * - Automatic respawn on worker crash (with backoff)
 * - Graceful shutdown with configurable drain timeout
 * - Memory usage monitoring across all workers
 *
 * ## Thread Architecture
 *
 * Main Thread:
 *   - WorkerManager (this module)
 *   - Unified health server (aggregated from all workers)
 *   - SharedArrayBuffer allocation for PriceMatrix
 *
 * Worker Threads:
 *   - P1 (asia-fast): BSC, Polygon, Avalanche, Fantom
 *   - P2 (l2-turbo): Arbitrum, Optimism, Base
 *   - P3 (high-value): Ethereum, zkSync, Linea
 *   - P4 (solana): Solana
 *   - Coordinator: Leader election, opportunity routing
 *   - Execution Engine: Trade execution
 *   - Cross-Chain Detector: Cross-chain opportunity detection
 *
 * ## SharedArrayBuffer Usage
 *
 * The main thread allocates a SharedArrayBuffer for the PriceMatrix
 * (ADR-005) and passes it to all worker threads via workerData.
 * This enables zero-copy price reads across all services.
 *
 * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 3.1
 * @see ADR-005: L1 Price Matrix with SharedArrayBuffer
 */

import { Worker, type WorkerOptions } from 'worker_threads';
import { EventEmitter } from 'events';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('worker-manager');

// =============================================================================
// Types
// =============================================================================

export interface ServiceWorkerConfig {
  /** Unique service name */
  name: string;
  /** Path to the service entry point (compiled JS) */
  scriptPath: string;
  /** Environment variables for this worker */
  env?: Record<string, string>;
  /** Whether to auto-restart on crash */
  autoRestart?: boolean;
  /** Maximum restart attempts before giving up */
  maxRestarts?: number;
  /** Restart backoff base in milliseconds */
  restartBackoffMs?: number;
}

export interface WorkerManagerConfig {
  /** Service definitions to spawn */
  services: ServiceWorkerConfig[];
  /** SharedArrayBuffer for PriceMatrix (passed to all workers) */
  priceMatrixBuffer?: SharedArrayBuffer;
  /** Graceful shutdown timeout in milliseconds */
  shutdownTimeoutMs?: number;
}

interface ManagedWorker {
  config: ServiceWorkerConfig;
  worker: Worker | null;
  restartCount: number;
  lastStartTime: number;
  healthy: boolean;
  exitCode: number | null;
  /** Fix #55: Timestamp of last health response for staleness detection */
  lastHealthResponseAt: number;
}

// Health message protocol between main and worker threads
interface HealthRequest {
  type: 'health_request';
  requestId: string;
}

interface HealthResponse {
  type: 'health_response';
  requestId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  details: Record<string, unknown>;
}

type WorkerMessage = HealthRequest | HealthResponse | { type: string; [key: string]: unknown };

// =============================================================================
// Worker Manager Implementation
// =============================================================================

export class WorkerManager extends EventEmitter {
  private readonly workers: Map<string, ManagedWorker> = new Map();
  private readonly shutdownTimeoutMs: number;
  private readonly priceMatrixBuffer?: SharedArrayBuffer;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: WorkerManagerConfig) {
    super();
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30_000;
    this.priceMatrixBuffer = config.priceMatrixBuffer;

    for (const svc of config.services) {
      this.workers.set(svc.name, {
        config: svc,
        worker: null,
        restartCount: 0,
        lastStartTime: 0,
        healthy: false,
        exitCode: null,
        lastHealthResponseAt: 0,
      });
    }
  }

  /**
   * Start all service workers.
   */
  async start(): Promise<void> {
    logger.info('Starting all service workers', {
      services: Array.from(this.workers.keys()),
      hasPriceMatrix: !!this.priceMatrixBuffer,
    });

    const startPromises: Promise<void>[] = [];

    for (const [name, managed] of this.workers) {
      startPromises.push(this.spawnWorker(name, managed));
    }

    await Promise.all(startPromises);

    // Start health monitoring
    this.healthCheckInterval = setInterval(() => {
      this.checkAllHealth();
    }, 10_000);

    logger.info('All service workers started', {
      count: this.workers.size,
    });
  }

  /**
   * Gracefully stop all workers.
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    logger.info('Stopping all service workers', {
      count: this.workers.size,
      timeoutMs: this.shutdownTimeoutMs,
    });

    const stopPromises = Array.from(this.workers.entries()).map(
      ([name, managed]) => this.stopWorker(name, managed)
    );

    await Promise.allSettled(stopPromises);

    logger.info('All service workers stopped');
  }

  /**
   * Get aggregated health status from all workers.
   */
  getHealth(): {
    overall: 'healthy' | 'degraded' | 'unhealthy';
    services: Record<string, { healthy: boolean; restarts: number; uptime: number }>;
  } {
    const services: Record<string, { healthy: boolean; restarts: number; uptime: number }> = {};
    let unhealthyCount = 0;

    for (const [name, managed] of this.workers) {
      const uptime = managed.lastStartTime > 0 ? Date.now() - managed.lastStartTime : 0;
      services[name] = {
        healthy: managed.healthy,
        restarts: managed.restartCount,
        uptime,
      };
      if (!managed.healthy) unhealthyCount++;
    }

    const total = this.workers.size;
    const overall = unhealthyCount === 0 ? 'healthy' :
      unhealthyCount < total ? 'degraded' : 'unhealthy';

    return { overall, services };
  }

  // ===========================================================================
  // Worker Lifecycle
  // ===========================================================================

  /**
   * Fix #19: Sensitive env var patterns that should be stripped from non-execution workers.
   * Only the execution-engine worker needs signing-related secrets.
   */
  // FIX 1: Removed /^STREAM_SIGNING_KEY$/i from sensitive patterns.
  // STREAM_SIGNING_KEY is used for HMAC message integrity verification on Redis Streams
  // and ALL services need it to verify signed messages, not just execution-engine.
  private static readonly SENSITIVE_ENV_PATTERNS = [
    /^.*_PRIVATE_KEY$/i,
    /^WALLET_MNEMONIC$/i,
    /^FLASHBOTS_AUTH_KEY$/i,
    /^KMS_KEY_ID/i,
    /^AWS_SECRET/i,
  ];

  /**
   * Filter sensitive env vars from the environment for workers that don't need them.
   * The execution-engine worker gets the full environment since it needs signing keys.
   */
  private static filterEnvForWorker(
    env: NodeJS.ProcessEnv,
    serviceName: string
  ): NodeJS.ProcessEnv {
    // Execution engine needs all secrets for transaction signing
    if (serviceName === 'execution-engine') {
      return { ...env };
    }

    const filtered: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      const isSensitive = WorkerManager.SENSITIVE_ENV_PATTERNS.some(
        (pattern) => pattern.test(key)
      );
      if (!isSensitive) {
        filtered[key] = value;
      }
    }
    return filtered as NodeJS.ProcessEnv;
  }

  private async spawnWorker(name: string, managed: ManagedWorker): Promise<void> {
    const { config } = managed;

    const workerOptions: WorkerOptions = {
      // Pass SharedArrayBuffer and service name via workerData
      workerData: {
        serviceName: name,
        priceMatrixBuffer: this.priceMatrixBuffer,
      },
      // Fix #19: Filter sensitive env vars for non-execution workers
      env: {
        ...WorkerManager.filterEnvForWorker(process.env, name),
        ...config.env,
        MONOLITH_MODE: 'true',
        WORKER_SERVICE_NAME: name,
      } as NodeJS.ProcessEnv,
    };

    try {
      const worker = new Worker(config.scriptPath, workerOptions);
      managed.worker = worker;
      managed.lastStartTime = Date.now();
      managed.healthy = true;
      managed.exitCode = null;

      // Handle messages from worker
      worker.on('message', (msg: WorkerMessage) => {
        this.handleWorkerMessage(name, msg);
      });

      // Handle worker errors
      worker.on('error', (error: Error) => {
        logger.error(`Worker error: ${name}`, {
          error: error.message,
          stack: error.stack,
        });
        managed.healthy = false;
        this.emit('workerError', { name, error });
      });

      // Handle worker exit
      worker.on('exit', (code: number) => {
        managed.exitCode = code;
        managed.healthy = false;
        managed.worker = null;

        if (code !== 0 && !this.isShuttingDown) {
          logger.warn(`Worker exited unexpectedly: ${name}`, {
            exitCode: code,
            restartCount: managed.restartCount,
            maxRestarts: config.maxRestarts ?? 5,
          });

          // Auto-restart with backoff
          if (config.autoRestart !== false && managed.restartCount < (config.maxRestarts ?? 5)) {
            const backoff = (config.restartBackoffMs ?? 1000) * Math.pow(2, managed.restartCount);
            managed.restartCount++;

            logger.info(`Scheduling worker restart: ${name}`, {
              attempt: managed.restartCount,
              backoffMs: backoff,
            });

            setTimeout(() => {
              if (!this.isShuttingDown) {
                this.spawnWorker(name, managed).catch((err) => {
                  logger.error(`Failed to restart worker: ${name}`, {
                    error: getErrorMessage(err),
                  });
                });
              }
            }, backoff);
          } else {
            logger.error(`Worker exhausted restart attempts: ${name}`, {
              restartCount: managed.restartCount,
            });
            this.emit('workerFailed', { name, restartCount: managed.restartCount });
          }
        } else {
          logger.info(`Worker exited cleanly: ${name}`, { exitCode: code });
        }
      });

      logger.info(`Worker spawned: ${name}`, {
        scriptPath: config.scriptPath,
        threadId: worker.threadId,
      });
    } catch (error) {
      logger.error(`Failed to spawn worker: ${name}`, {
        scriptPath: config.scriptPath,
        error: getErrorMessage(error),
      });
      managed.healthy = false;
      throw error;
    }
  }

  private async stopWorker(name: string, managed: ManagedWorker): Promise<void> {
    const { worker } = managed;
    if (!worker) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`Force-terminating worker: ${name}`);
        worker.terminate().then(() => resolve()).catch(() => resolve());
      }, this.shutdownTimeoutMs);

      // Request graceful shutdown via message
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        // Worker may already be terminated
      }

      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  /** Fix #55: Maximum time to wait for a health response before marking worker as unhealthy */
  private static readonly HEALTH_STALENESS_MS = 15_000;

  private checkAllHealth(): void {
    if (this.isShuttingDown) return;

    for (const [name, managed] of this.workers) {
      if (managed.worker) {
        // Fix #55: Mark worker unhealthy if no health response within staleness threshold
        if (managed.lastHealthResponseAt > 0) {
          const staleness = Date.now() - managed.lastHealthResponseAt;
          if (staleness > WorkerManager.HEALTH_STALENESS_MS) {
            managed.healthy = false;
            logger.debug(`Worker health stale: ${name}`, {
              stalenessMs: staleness,
              thresholdMs: WorkerManager.HEALTH_STALENESS_MS,
            });
          }
        }

        try {
          managed.worker.postMessage({
            type: 'health_request',
            requestId: `health-${name}-${Date.now()}`,
          });
        } catch {
          logger.debug(`Worker health check failed: ${name}`);
          managed.healthy = false;
        }
      }
    }
  }

  private handleWorkerMessage(name: string, msg: WorkerMessage): void {
    if (msg.type === 'health_response') {
      const managed = this.workers.get(name);
      if (managed) {
        managed.healthy = (msg as HealthResponse).status !== 'unhealthy';
        // Fix #55: Track health response timestamp for staleness detection
        managed.lastHealthResponseAt = Date.now();
      }
    }

    // Forward all messages to listeners
    this.emit('workerMessage', { name, message: msg });
  }
}

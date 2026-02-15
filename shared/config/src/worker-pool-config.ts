/**
 * Worker Pool Configuration
 *
 * Platform-aware defaults for the EventProcessingWorkerPool.
 * Extracted from shared/core/src/async/worker-pool.ts (Finding #14).
 *
 * Environment variable overrides:
 * - WORKER_POOL_SIZE: Number of worker threads (default: platform-aware 2-4)
 * - WORKER_POOL_MAX_QUEUE_SIZE: Maximum task queue size (default: platform-aware 300-1000)
 * - WORKER_POOL_TASK_TIMEOUT_MS: Task timeout in milliseconds (default: 30000)
 * - CONSTRAINED_MEMORY: Set to 'true' to force constrained-host defaults
 *
 * @see shared/core/src/async/worker-pool.ts - WorkerPool implementation
 * @see docs/reports/ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 5.3
 */

// =============================================================================
// Platform Detection
// =============================================================================

/**
 * Detect if running on memory-constrained hosting platforms.
 * - Fly.io: 256MB free tier
 * - Railway: 512MB free tier
 * - Render: 512MB free tier
 */
export const IS_FLY_IO = process.env.FLY_APP_NAME !== undefined;
export const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT !== undefined;
export const IS_RENDER = process.env.RENDER_SERVICE_NAME !== undefined;
export const IS_CONSTRAINED_HOST = IS_FLY_IO || IS_RAILWAY || IS_RENDER ||
  process.env.CONSTRAINED_MEMORY === 'true';

/**
 * Human-readable platform name for logging.
 */
export const PLATFORM_NAME = IS_FLY_IO ? 'fly.io'
  : IS_RAILWAY ? 'railway'
  : IS_RENDER ? 'render'
  : IS_CONSTRAINED_HOST ? 'constrained'
  : 'standard';

// =============================================================================
// Worker Pool Configuration
// =============================================================================

export interface WorkerPoolConfig {
  /** Number of worker threads */
  poolSize: number;
  /** Maximum task queue size */
  maxQueueSize: number;
  /** Task timeout in milliseconds */
  taskTimeout: number;
}

/**
 * Platform-aware default configuration.
 *
 * Constrained hosts (256-512MB): 2-3 workers, 300 queue size
 * - Reduces memory footprint by ~20MB (2 fewer worker threads)
 * - Still provides parallelism for CPU-intensive tasks
 *
 * Standard hosts (1GB+): 4 workers, 1000 queue size
 * - Full parallelism for path finding and JSON parsing
 *
 * All values can be overridden via environment variables.
 */
function resolvePoolSize(): number {
  const envValue = parseInt(process.env.WORKER_POOL_SIZE ?? '', 10);
  if (envValue > 0) return envValue;
  return IS_FLY_IO ? 2 : IS_CONSTRAINED_HOST ? 3 : 4;
}

function resolveMaxQueueSize(): number {
  const envValue = parseInt(process.env.WORKER_POOL_MAX_QUEUE_SIZE ?? '', 10);
  if (envValue > 0) return envValue;
  return IS_CONSTRAINED_HOST ? 300 : 1000;
}

function resolveTaskTimeout(): number {
  const envValue = parseInt(process.env.WORKER_POOL_TASK_TIMEOUT_MS ?? '', 10);
  if (envValue > 0) return envValue;
  return 30000;
}

export const WORKER_POOL_CONFIG: WorkerPoolConfig = {
  poolSize: resolvePoolSize(),
  maxQueueSize: resolveMaxQueueSize(),
  taskTimeout: resolveTaskTimeout(),
};

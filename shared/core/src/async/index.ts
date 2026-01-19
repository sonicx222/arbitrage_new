/**
 * Async Module
 *
 * Concurrency and async utilities including:
 * - AsyncSingleton: Singleton factory pattern (P1-3-FIX)
 * - AsyncMutex: Named mutual exclusion (P2-2-FIX)
 * - AsyncUtils: Timeout, retry, concurrent mapping (REF-4/ARCH-3)
 * - WorkerPool: Priority queue with worker threads
 *
 * @module async
 */

// Async Singleton (P1-3-FIX)
export {
  createAsyncSingleton,
  createSingleton,
  singleton
} from './async-singleton';

// Async Mutex (P2-2-FIX)
export {
  AsyncMutex,
  namedMutex,
  clearNamedMutex,
  clearAllNamedMutexes
} from './async-mutex';
export type { MutexStats } from './async-mutex';

// Async Utils (REF-4/ARCH-3)
export {
  TimeoutError,
  withTimeout,
  withTimeoutDefault,
  withTimeoutSafe,
  withRetry,
  sleep,
  createDeferred,
  mapConcurrent,
  mapSequential,
  debounceAsync,
  throttleAsync,
  gracefulShutdown,
  waitWithTimeouts
} from './async-utils';
export type {
  RetryConfig,
  Deferred
} from './async-utils';

// Worker Pool
export {
  EventProcessingWorkerPool,
  getWorkerPool,
  PriorityQueue
} from './worker-pool';
export type {
  Task,
  TaskResult
} from './worker-pool';

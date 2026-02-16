/**
 * T4.3 Fix 3.2: TensorFlow Backend Selection
 *
 * Provides environment-aware TensorFlow.js backend selection.
 *
 * FIX 1.3, 2.3, 3.1: Clarified backend selection documentation.
 *
 * Backend options (all JavaScript-based for Node.js compatibility):
 * - 'cpu': Pure JavaScript CPU backend (default, most compatible)
 * - 'wasm': WebAssembly backend (faster than pure JS, good for production)
 * - 'tensorflow': Native TensorFlow bindings via @tensorflow/tfjs-node (fastest, requires native dependencies)
 * - 'webgl': WebGL backend (browser-oriented, NOT recommended for Node.js server)
 *
 * For Node.js production servers, prefer:
 * 1. 'tensorflow' (fastest, but requires @tensorflow/tfjs-node)
 * 2. 'wasm' (good performance, no native dependencies)
 * 3. 'cpu' (fallback, always works)
 *
 * Usage:
 * - Import this module BEFORE importing @tensorflow/tfjs in any ML code
 * - Call initializeTensorFlow() at application startup
 * - Use getTensorFlowBackend() to check which backend is active
 *
 * Environment variables:
 * - NODE_ENV: 'production' | 'development' | 'test'
 * - TF_FORCE_BACKEND: Force a specific backend ('cpu' | 'wasm' | 'tensorflow')
 * - TF_ENABLE_NATIVE: 'true' to try native 'tensorflow' backend in production
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

import * as tf from '@tensorflow/tfjs';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('tf-backend');

// =============================================================================
// Types
// =============================================================================

/**
 * Supported TensorFlow.js backends.
 */
export type TFBackend = 'cpu' | 'webgl' | 'wasm' | 'tensorflow';

/**
 * Backend initialization result.
 */
export interface BackendInitResult {
  success: boolean;
  backend: TFBackend;
  error?: Error;
  isNative: boolean;
}

/**
 * Backend configuration.
 */
export interface BackendConfig {
  /** Preferred backend (optional, auto-detected if not specified) */
  preferredBackend?: TFBackend;
  /** Whether to enable GPU if available (default: false) */
  enableGpu?: boolean;
  /** Whether to log backend info (default: true) */
  logInfo?: boolean;
  /** Timeout for backend initialization in ms (default: 10000) */
  initTimeoutMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: Required<BackendConfig> = {
  preferredBackend: 'cpu',
  enableGpu: false,
  logInfo: true,
  initTimeoutMs: 10000
};

// Track initialization state
let isInitialized = false;
let currentBackend: TFBackend = 'cpu';
let initializationPromise: Promise<BackendInitResult> | null = null;

// =============================================================================
// Backend Selection Logic
// =============================================================================

/** Valid backend names for validation */
const VALID_BACKENDS: readonly TFBackend[] = ['cpu', 'webgl', 'wasm', 'tensorflow'] as const;

/**
 * FIX 3.2: Validate and log environment variable for backend selection.
 */
function validateAndGetEnvBackend(): TFBackend | null {
  const forcedBackend = process.env.TF_FORCE_BACKEND;
  if (!forcedBackend) {
    return null;
  }

  if (isValidBackend(forcedBackend)) {
    logger.info('Using forced backend from TF_FORCE_BACKEND', { backend: forcedBackend });
    return forcedBackend;
  }

  // FIX 3.2: Log warning for invalid environment variable
  logger.warn('Invalid TF_FORCE_BACKEND value, ignoring', {
    value: forcedBackend,
    validOptions: VALID_BACKENDS
  });
  return null;
}

/**
 * Determine the optimal backend based on environment.
 *
 * FIX 1.3, 2.3, 3.1: Updated selection logic with accurate comments.
 * FIX P0-2: Accept optional flag indicating if preferredBackend was explicitly specified
 *
 * @param config - Full backend configuration
 * @param explicitBackend - True if preferredBackend was explicitly provided by caller
 */
function selectBackend(config: Required<BackendConfig>, explicitBackend: boolean): TFBackend {
  // FIX 3.2: Check for forced backend via environment variable with validation
  const forcedBackend = validateAndGetEnvBackend();
  if (forcedBackend) {
    return forcedBackend;
  }

  // FIX P0-2: Only use config.preferredBackend if explicitly specified by caller
  // This allows environment-based auto-selection when caller doesn't specify a backend
  if (explicitBackend && config.preferredBackend) {
    return config.preferredBackend;
  }

  // Auto-select based on environment
  // P2-9 fix: Use ?? instead of || so empty string is preserved as valid value.
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  switch (nodeEnv) {
    case 'production':
      // FIX 1.3, 2.3, 3.1: In production, prefer native TensorFlow or WASM for Node.js
      // Note: @tensorflow/tfjs-node provides the 'tensorflow' backend (fastest)
      // WASM is a good alternative if native deps are not available
      if (config.enableGpu || process.env.TF_ENABLE_NATIVE === 'true') {
        // Try native TensorFlow backend (requires @tensorflow/tfjs-node)
        return 'tensorflow';
      }
      // Default to WASM for better performance than pure JS CPU
      return 'wasm';

    case 'test':
      // In tests, use pure JS for consistency and no native dependencies
      return 'cpu';

    case 'development':
    default:
      // In development, use CPU (faster startup, no native deps needed)
      return 'cpu';
  }
}

/**
 * Check if a backend name is valid.
 */
function isValidBackend(backend: string): backend is TFBackend {
  return VALID_BACKENDS.includes(backend as TFBackend);
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize TensorFlow.js with the appropriate backend.
 * This should be called once at application startup.
 *
 * @param config - Backend configuration
 * @returns Initialization result
 */
export async function initializeTensorFlow(
  config: BackendConfig = {}
): Promise<BackendInitResult> {
  // Return existing promise if initialization is in progress
  if (initializationPromise) {
    return initializationPromise;
  }

  // Return cached result if already initialized
  if (isInitialized) {
    return {
      success: true,
      backend: currentBackend,
      isNative: currentBackend === 'tensorflow'
    };
  }

  // FIX P0-2: Track whether preferredBackend was explicitly specified by caller
  // This enables environment-based auto-selection when not specified
  const explicitBackend = config.preferredBackend !== undefined;

  // Start initialization
  initializationPromise = doInitialize({ ...DEFAULT_CONFIG, ...config }, explicitBackend);
  return initializationPromise;
}

/**
 * FIX 3.3, 4.4: Helper to wrap a promise with a timeout.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * FIX 3.3, 4.4: Initialize backend with timeout protection.
 */
async function initBackendWithTimeout(
  backend: TFBackend,
  timeoutMs: number
): Promise<void> {
  await withTimeout(
    (async () => {
      await tf.setBackend(backend);
      await tf.ready();
    })(),
    timeoutMs,
    `TensorFlow backend '${backend}' initialization timed out after ${timeoutMs}ms`
  );
}

async function doInitialize(
  config: Required<BackendConfig>,
  explicitBackend: boolean
): Promise<BackendInitResult> {
  const selectedBackend = selectBackend(config, explicitBackend);

  try {
    if (config.logInfo) {
      logger.info('Initializing TensorFlow.js backend', {
        selected: selectedBackend,
        nodeEnv: process.env.NODE_ENV,
        timeoutMs: config.initTimeoutMs
      });
    }

    // FIX 3.3, 4.4: Apply initialization timeout
    await initBackendWithTimeout(selectedBackend, config.initTimeoutMs);

    currentBackend = selectedBackend;
    isInitialized = true;

    // Log memory info
    if (config.logInfo) {
      const memInfo = tf.memory();
      logger.info('TensorFlow.js backend initialized', {
        backend: selectedBackend,
        numTensors: memInfo.numTensors,
        numDataBuffers: memInfo.numDataBuffers
      });
    }

    return {
      success: true,
      backend: currentBackend,
      isNative: currentBackend === 'tensorflow'
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // If preferred backend fails, try falling back to 'cpu'
    if (selectedBackend !== 'cpu') {
      logger.warn(`Failed to initialize ${selectedBackend} backend, falling back to CPU`, {
        error: err.message
      });

      try {
        // FIX 3.3, 4.4: Apply timeout to fallback as well
        await initBackendWithTimeout('cpu', config.initTimeoutMs);

        currentBackend = 'cpu';
        isInitialized = true;

        return {
          success: true,
          backend: 'cpu',
          isNative: false
        };
      } catch (fallbackError) {
        const fallbackErr = fallbackError instanceof Error
          ? fallbackError
          : new Error(String(fallbackError));

        logger.error('Failed to initialize fallback CPU backend', {
          error: fallbackErr.message
        });

        return {
          success: false,
          backend: 'cpu',
          error: fallbackErr,
          isNative: false
        };
      }
    }

    logger.error('Failed to initialize TensorFlow.js backend', {
      backend: selectedBackend,
      error: err.message
    });

    return {
      success: false,
      backend: selectedBackend,
      error: err,
      isNative: false
    };
  }
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get the currently active TensorFlow.js backend.
 */
export function getTensorFlowBackend(): TFBackend {
  return currentBackend;
}

/**
 * Check if TensorFlow.js has been initialized.
 */
export function isTensorFlowInitialized(): boolean {
  return isInitialized;
}

/**
 * Check if using native TensorFlow bindings.
 */
export function isNativeBackend(): boolean {
  return currentBackend === 'tensorflow';
}

/**
 * Get TensorFlow.js memory information.
 */
export function getTensorFlowMemory(): tf.MemoryInfo {
  return tf.memory();
}

/**
 * Get TensorFlow.js engine information.
 */
export function getTensorFlowInfo(): {
  backend: string;
  memory: tf.MemoryInfo;
} {
  return {
    backend: tf.getBackend() || 'unknown',
    memory: tf.memory()
  };
}

// =============================================================================
// Memory Management
// =============================================================================

/**
 * Dispose all tensors in memory.
 * Use with caution - this will invalidate all existing tensors.
 */
export function disposeAllTensors(): void {
  const numTensors = tf.memory().numTensors;
  if (numTensors > 0) {
    logger.warn(`Disposing ${numTensors} tensors from memory`);
  }
  tf.disposeVariables();
}

/**
 * Run a function with automatic tensor cleanup.
 * All tensors created inside the function will be disposed after it completes.
 */
export function withTensorCleanup<T extends tf.TensorContainer>(fn: () => T): T {
  return tf.tidy(fn);
}

/**
 * P2-2 fix: Renamed from withTensorCleanupAsync to withTensorMonitorAsync.
 *
 * Monitors tensor creation during an async operation. Since tf.tidy()
 * doesn't support async functions, this wrapper tracks tensor counts
 * before/after and logs potential leaks. It does NOT automatically
 * dispose tensors — the caller must handle cleanup within fn().
 *
 * @param fn - Async function to monitor
 * @returns The result from fn()
 */
export async function withTensorMonitorAsync<T extends tf.TensorContainer>(
  fn: () => Promise<T>
): Promise<T> {
  // Track tensors before execution
  const tensorsBefore = tf.memory().numTensors;

  // Execute the async function
  const result = await fn();

  // Count tensors created (excluding the result)
  const tensorsAfter = tf.memory().numTensors;
  const tensorsCreated = tensorsAfter - tensorsBefore;

  // Log if we created tensors (helps identify potential leaks)
  if (tensorsCreated > 10) {
    logger.debug('withTensorMonitorAsync: many tensors created during execution', {
      tensorsBefore,
      tensorsAfter,
      tensorsCreated
    });
  }

  // Note: We can't automatically dispose intermediate tensors without
  // knowing which ones are "intermediate" vs "result". The caller must
  // use tf.tidy() within their async function where possible, or
  // manually dispose tensors they create.
  //
  // This function now serves as a monitoring wrapper and documentation
  // that cleanup should be handled within the async function.

  return result;
}

/**
 * P2-2 fix: Renamed from withTrackedTensorCleanup to withTrackedTensorMonitor.
 *
 * Monitors tensor lifecycle during an async operation. If keepTensors
 * is provided, logs how many tensors are being preserved. Does NOT
 * automatically dispose tensors — this is a limitation of tf.js where
 * there's no clean way to track intermediate tensors in async code.
 *
 * @param fn - Async function that may create tensors
 * @param keepTensors - Function to extract tensors to keep from result
 * @returns The result from fn()
 */
export async function withTrackedTensorMonitor<T>(
  fn: () => Promise<T>,
  keepTensors?: (result: T) => tf.Tensor[]
): Promise<T> {
  // Get all current tensors before
  const tensorIdsBefore = new Set<number>();
  // Note: tf.engine().state.registeredVariables tracks variables, not all tensors
  // For proper tracking, we'd need to use tf.engine() internals or a custom solution

  const result = await fn();

  // If keepTensors is provided, we know which to keep
  // Otherwise, we can't safely dispose anything
  if (keepTensors) {
    const toKeep = new Set(keepTensors(result).map(t => t.id));
    // Dispose would happen here if we had tensor tracking
    // This is a limitation of tfjs - there's no clean way to track intermediate tensors
    logger.debug('Tracked monitor completed', { keepCount: toKeep.size });
  }

  return result;
}

// =============================================================================
// P2-2: Deprecated aliases (remove after callers are updated)
// =============================================================================

/** @deprecated Use withTensorMonitorAsync instead */
export const withTensorCleanupAsync = withTensorMonitorAsync;

/** @deprecated Use withTrackedTensorMonitor instead */
export const withTrackedTensorCleanup = withTrackedTensorMonitor;

// =============================================================================
// Reset (for testing)
// =============================================================================

/**
 * Reset the backend initialization state.
 * Use for testing only.
 */
export function resetTensorFlowBackend(): void {
  isInitialized = false;
  initializationPromise = null;
  currentBackend = 'cpu';
}

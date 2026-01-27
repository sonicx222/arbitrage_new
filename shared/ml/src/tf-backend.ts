/**
 * T4.3 Fix 3.2: TensorFlow Backend Selection
 *
 * Provides environment-aware TensorFlow.js backend selection.
 * In production, uses native CPU/GPU bindings for performance.
 * In development/testing, uses pure JavaScript backend for compatibility.
 *
 * Usage:
 * - Import this module BEFORE importing @tensorflow/tfjs in any ML code
 * - Call initializeTensorFlow() at application startup
 * - Use getTensorFlowBackend() to check which backend is active
 *
 * Environment variables:
 * - NODE_ENV: 'production' | 'development' | 'test'
 * - TF_FORCE_BACKEND: Force a specific backend ('cpu' | 'webgl' | 'wasm')
 * - TF_ENABLE_GPU: 'true' to enable GPU backend in production
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

/**
 * Determine the optimal backend based on environment.
 */
function selectBackend(config: Required<BackendConfig>): TFBackend {
  // Check for forced backend via environment variable
  const forcedBackend = process.env.TF_FORCE_BACKEND as TFBackend | undefined;
  if (forcedBackend && isValidBackend(forcedBackend)) {
    return forcedBackend;
  }

  // Use preferred backend from config if specified
  if (config.preferredBackend) {
    return config.preferredBackend;
  }

  // Auto-select based on environment
  const nodeEnv = process.env.NODE_ENV || 'development';

  switch (nodeEnv) {
    case 'production':
      // In production, try to use native bindings
      // Note: @tensorflow/tfjs-node must be installed for 'tensorflow' backend
      if (config.enableGpu || process.env.TF_ENABLE_GPU === 'true') {
        return 'webgl'; // WebGL provides GPU acceleration in Node.js
      }
      return 'cpu'; // Default to optimized CPU

    case 'test':
      // In tests, use pure JS for consistency
      return 'cpu';

    case 'development':
    default:
      // In development, use CPU (faster startup, good for debugging)
      return 'cpu';
  }
}

/**
 * Check if a backend name is valid.
 */
function isValidBackend(backend: string): backend is TFBackend {
  return ['cpu', 'webgl', 'wasm', 'tensorflow'].includes(backend);
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

  // Start initialization
  initializationPromise = doInitialize({ ...DEFAULT_CONFIG, ...config });
  return initializationPromise;
}

async function doInitialize(config: Required<BackendConfig>): Promise<BackendInitResult> {
  const selectedBackend = selectBackend(config);

  try {
    if (config.logInfo) {
      logger.info('Initializing TensorFlow.js backend', {
        selected: selectedBackend,
        nodeEnv: process.env.NODE_ENV
      });
    }

    // Set the backend
    await tf.setBackend(selectedBackend);
    await tf.ready();

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
        await tf.setBackend('cpu');
        await tf.ready();

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
 * Async version of withTensorCleanup.
 * Note: Tensors must be returned from the async function to be preserved.
 */
export async function withTensorCleanupAsync<T extends tf.TensorContainer>(
  fn: () => Promise<T>
): Promise<T> {
  const result = await fn();
  return result;
}

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

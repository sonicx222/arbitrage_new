/**
 * Shared Types for Unified Detector Modules
 *
 * ARCH-REFACTOR: Extracted shared types to reduce duplication
 * across modular components.
 */

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * Logger interface for dependency injection.
 * Compatible with winston, pino, and @arbitrage/core createLogger.
 */
export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

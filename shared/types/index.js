"use strict";
// Shared types for the arbitrage detection system
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeoutError = exports.ValidationError = exports.NetworkError = exports.ArbitrageError = void 0;
exports.parseGasEstimate = parseGasEstimate;
// =============================================================================
// Error Types (SPRINT 3 CONSOLIDATION)
// =============================================================================
// CANONICAL error type definitions for the arbitrage system.
// All new code should import from @arbitrage/types.
//
// Legacy locations (maintained for backward compatibility):
// - shared/core/src/domain-models.ts (ArbitrageError) - re-exports from here
// - shared/core/src/resilience/error-handling.ts (ArbitrageError) - re-exports from here
// - shared/core/src/async/async-utils.ts (TimeoutError) - use local version for async-specific features
// - services/execution-engine/src/types.ts (TimeoutError) - execution-specific version
//
// Migration:
// - OLD: import { ArbitrageError } from '@arbitrage/core'
// - NEW: import { ArbitrageError, TimeoutError } from '@arbitrage/types'
// =============================================================================
/**
 * Base error class for arbitrage system errors.
 * Use this for errors that need to be caught and handled specifically.
 *
 * @example
 * ```typescript
 * throw new ArbitrageError(
 *   'Failed to connect to DEX',
 *   'DEX_CONNECTION_ERROR',
 *   'execution-engine',
 *   true // retryable
 * );
 * ```
 */
class ArbitrageError extends Error {
    constructor(message, code, service, retryable = false) {
        super(message);
        this.code = code;
        this.service = service;
        this.retryable = retryable;
        this.name = 'ArbitrageError';
        // Ensure instanceof works correctly across module boundaries
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.ArbitrageError = ArbitrageError;
/**
 * Network-related errors (connection failures, timeouts, etc.)
 * These are generally retryable.
 */
class NetworkError extends ArbitrageError {
    constructor(message, service) {
        super(message, 'NETWORK_ERROR', service, true);
        this.name = 'NetworkError';
    }
}
exports.NetworkError = NetworkError;
/**
 * Validation errors for invalid input data.
 * These are not retryable without fixing the input.
 */
class ValidationError extends ArbitrageError {
    constructor(message, service, field) {
        super(message, 'VALIDATION_ERROR', service, false);
        this.field = field;
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
/**
 * Timeout error for async operations that exceed their time limit.
 * CANONICAL definition - use this for new code.
 *
 * @example
 * ```typescript
 * throw new TimeoutError('Bridge polling', 60000, 'cross-chain.strategy');
 * ```
 */
class TimeoutError extends Error {
    constructor(
    /** What operation timed out */
    operation, 
    /** The timeout duration in milliseconds */
    timeoutMs, 
    /** Optional service name for context */
    service) {
        super(`Timeout: ${operation} exceeded ${timeoutMs}ms${service ? ` in ${service}` : ''}`);
        this.operation = operation;
        this.timeoutMs = timeoutMs;
        this.service = service;
        this.name = 'TimeoutError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.TimeoutError = TimeoutError;
// =============================================================================
// Execution Types (consolidated from services/execution-engine)
// =============================================================================
__exportStar(require("./execution"), exports);
// =============================================================================
// Common Types (consolidated from scattered definitions)
// =============================================================================
__exportStar(require("./common"), exports);
// =============================================================================
// Utility Functions
// =============================================================================
/**
 * Parse gas estimate from various input types to bigint.
 * Handles string, number, bigint, and undefined inputs safely.
 *
 * @param value - The gas estimate value to parse
 * @returns The gas estimate as a bigint (0n if undefined or invalid)
 */
function parseGasEstimate(value) {
    if (value === undefined || value === null) {
        return 0n;
    }
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number') {
        return BigInt(Math.floor(value));
    }
    // string case
    try {
        return BigInt(value);
    }
    catch {
        return 0n;
    }
}
// =============================================================================
// Test Support Types
// =============================================================================
__exportStar(require("./src/test-support"), exports);
//# sourceMappingURL=index.js.map
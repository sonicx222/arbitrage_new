"use strict";
// Shared types for the arbitrage detection system
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = exports.NetworkError = exports.ArbitrageError = void 0;
exports.parseGasEstimate = parseGasEstimate;
// Error types
class ArbitrageError extends Error {
    constructor(message, code, service, retryable = false) {
        super(message);
        this.code = code;
        this.service = service;
        this.retryable = retryable;
        this.name = 'ArbitrageError';
    }
}
exports.ArbitrageError = ArbitrageError;
class NetworkError extends ArbitrageError {
    constructor(message, service) {
        super(message, 'NETWORK_ERROR', service, true);
        this.name = 'NetworkError';
    }
}
exports.NetworkError = NetworkError;
class ValidationError extends ArbitrageError {
    constructor(message, service, field) {
        super(message, 'VALIDATION_ERROR', service, false);
        this.field = field;
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
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
//# sourceMappingURL=index.js.map
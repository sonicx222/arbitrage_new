"use strict";
// Shared types for the arbitrage detection system
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = exports.NetworkError = exports.ArbitrageError = void 0;
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
//# sourceMappingURL=index.js.map
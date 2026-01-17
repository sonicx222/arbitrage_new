"use strict";
// Domain Models - Clean Architecture Foundation
// Extracted from monolithic services for better maintainability
//
// P1-3 FIX (2026-01-16): Type Consolidation
// IMPORTANT: These types are intentionally prefixed with "Rich" to distinguish them
// from the simpler types in shared/types/index.ts:
// - shared/types/index.ts: Used by detectors, publishers, and message passing (simple, flat)
// - domain-models.ts: Used by repositories and execution engine (rich, nested objects)
//
// The "Rich" prefix indicates these types have full object references (Token, Dex, Chain)
// rather than string identifiers. Use the appropriate type for your context:
// - For Redis Streams messages: import from @arbitrage/types
// - For database operations: import from ./domain-models
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigurationError = exports.ExecutionError = exports.ArbitrageError = void 0;
// Error Classes
class ArbitrageError extends Error {
    constructor(code, message, details, recoverable = false) {
        super(message);
        this.code = code;
        this.details = details;
        this.recoverable = recoverable;
        this.name = 'ArbitrageError';
    }
}
exports.ArbitrageError = ArbitrageError;
class ExecutionError extends ArbitrageError {
    constructor(code, message, opportunityId, details) {
        super(code, message, details, false);
        this.opportunityId = opportunityId;
        this.name = 'ExecutionError';
    }
}
exports.ExecutionError = ExecutionError;
class ConfigurationError extends Error {
    constructor(key, message, defaultValue) {
        super(message);
        this.key = key;
        this.defaultValue = defaultValue;
        this.name = 'ConfigurationError';
    }
}
exports.ConfigurationError = ConfigurationError;
//# sourceMappingURL=domain-models.js.map
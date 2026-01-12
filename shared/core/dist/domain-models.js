"use strict";
// Domain Models - Clean Architecture Foundation
// Extracted from monolithic services for better maintainability
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
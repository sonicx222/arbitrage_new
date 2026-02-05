"use strict";
/**
 * Execution-related types
 *
 * Consolidated from services/execution-engine/src/types.ts
 * These types are used across multiple services.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionErrorCode = void 0;
exports.createErrorResult = createErrorResult;
exports.createSuccessResult = createSuccessResult;
exports.createSkippedResult = createSkippedResult;
exports.formatExecutionError = formatExecutionError;
exports.extractErrorCode = extractErrorCode;
/**
 * Standardized error codes for execution.
 * Provides consistent error reporting across services.
 */
var ExecutionErrorCode;
(function (ExecutionErrorCode) {
    // Chain/Provider errors
    ExecutionErrorCode["NO_CHAIN"] = "[ERR_NO_CHAIN] No chain specified for opportunity";
    ExecutionErrorCode["NO_WALLET"] = "[ERR_NO_WALLET] No wallet available for chain";
    ExecutionErrorCode["NO_PROVIDER"] = "[ERR_NO_PROVIDER] No provider available for chain";
    ExecutionErrorCode["NO_BRIDGE"] = "[ERR_NO_BRIDGE] Bridge router not initialized";
    ExecutionErrorCode["NO_ROUTE"] = "[ERR_NO_ROUTE] No bridge route available";
    // Configuration errors
    ExecutionErrorCode["CONFIG_ERROR"] = "[ERR_CONFIG] Configuration error";
    ExecutionErrorCode["ZERO_ADDRESS"] = "[ERR_ZERO_ADDRESS] Zero address is invalid";
    // Validation errors
    ExecutionErrorCode["INVALID_OPPORTUNITY"] = "[ERR_INVALID_OPPORTUNITY] Invalid opportunity format";
    ExecutionErrorCode["CROSS_CHAIN_MISMATCH"] = "[ERR_CROSS_CHAIN] Strategy mismatch for cross-chain opportunity";
    ExecutionErrorCode["SAME_CHAIN"] = "[ERR_SAME_CHAIN] Cross-chain arbitrage requires different chains";
    ExecutionErrorCode["PRICE_VERIFICATION"] = "[ERR_PRICE_VERIFICATION] Price verification failed";
    // Transaction errors
    ExecutionErrorCode["NONCE_ERROR"] = "[ERR_NONCE] Failed to get nonce";
    ExecutionErrorCode["GAS_SPIKE"] = "[ERR_GAS_SPIKE] Gas price spike detected";
    ExecutionErrorCode["APPROVAL_FAILED"] = "[ERR_APPROVAL] Token approval failed";
    ExecutionErrorCode["SIMULATION_REVERT"] = "[ERR_SIMULATION_REVERT] Simulation predicted revert";
    // Bridge errors
    ExecutionErrorCode["BRIDGE_QUOTE"] = "[ERR_BRIDGE_QUOTE] Bridge quote failed";
    ExecutionErrorCode["BRIDGE_EXEC"] = "[ERR_BRIDGE_EXEC] Bridge execution failed";
    ExecutionErrorCode["BRIDGE_FAILED"] = "[ERR_BRIDGE_FAILED] Bridge failed";
    ExecutionErrorCode["BRIDGE_TIMEOUT"] = "[ERR_BRIDGE_TIMEOUT] Bridge timeout";
    ExecutionErrorCode["QUOTE_EXPIRED"] = "[ERR_QUOTE_EXPIRED] Quote expired before execution";
    // Execution errors
    ExecutionErrorCode["EXECUTION_ERROR"] = "[ERR_EXECUTION] Execution error";
    ExecutionErrorCode["SELL_FAILED"] = "[ERR_SELL_FAILED] Sell transaction failed";
    ExecutionErrorCode["HIGH_FEES"] = "[ERR_HIGH_FEES] Fees exceed expected profit";
    ExecutionErrorCode["SHUTDOWN"] = "[ERR_SHUTDOWN] Execution interrupted by shutdown";
    // Flash loan errors
    ExecutionErrorCode["NO_STRATEGY"] = "[ERR_NO_STRATEGY] Required strategy not registered";
    ExecutionErrorCode["FLASH_LOAN_ERROR"] = "[ERR_FLASH_LOAN] Flash loan error";
    ExecutionErrorCode["UNSUPPORTED_PROTOCOL"] = "[ERR_UNSUPPORTED_PROTOCOL] Protocol not implemented";
    // Risk management errors
    ExecutionErrorCode["LOW_EV"] = "[ERR_LOW_EV] Expected value below threshold";
    ExecutionErrorCode["POSITION_SIZE"] = "[ERR_POSITION_SIZE] Position size below minimum";
    ExecutionErrorCode["DRAWDOWN_HALT"] = "[ERR_DRAWDOWN_HALT] Trading halted due to drawdown";
    ExecutionErrorCode["DRAWDOWN_BLOCKED"] = "[ERR_DRAWDOWN_BLOCKED] Trade blocked by risk controls";
})(ExecutionErrorCode || (exports.ExecutionErrorCode = ExecutionErrorCode = {}));
/**
 * Create a failed ExecutionResult.
 */
function createErrorResult(opportunityId, error, chain, dex, transactionHash) {
    return {
        opportunityId,
        success: false,
        error,
        timestamp: Date.now(),
        chain,
        dex,
        transactionHash,
    };
}
/**
 * Create a successful ExecutionResult.
 */
function createSuccessResult(opportunityId, transactionHash, chain, dex, options) {
    return {
        opportunityId,
        success: true,
        transactionHash,
        actualProfit: options?.actualProfit,
        gasUsed: options?.gasUsed,
        gasCost: options?.gasCost,
        latencyMs: options?.latencyMs,
        usedMevProtection: options?.usedMevProtection,
        timestamp: Date.now(),
        chain,
        dex,
    };
}
/**
 * Create a skipped ExecutionResult (not executed due to risk controls).
 */
function createSkippedResult(opportunityId, reason, chain, dex) {
    return {
        opportunityId,
        success: false,
        error: reason,
        timestamp: Date.now(),
        chain,
        dex,
    };
}
/**
 * Format error code with optional details.
 */
function formatExecutionError(code, details) {
    if (!details) {
        return code;
    }
    return `${code}: ${details}`;
}
/**
 * Extract the error code identifier from a formatted error message.
 * @returns The error code identifier (e.g., "ERR_NO_WALLET") or null if not found
 */
function extractErrorCode(errorMessage) {
    const match = errorMessage.match(/\[ERR_([A-Z_]+)\]/);
    return match ? `ERR_${match[1]}` : null;
}
//# sourceMappingURL=execution.js.map
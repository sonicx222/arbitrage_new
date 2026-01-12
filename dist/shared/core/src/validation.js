"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationSchemas = exports.ValidationMiddleware = void 0;
// Comprehensive input validation utilities for security
const joi_1 = __importDefault(require("joi"));
class ValidationMiddleware {
}
exports.ValidationMiddleware = ValidationMiddleware;
// Arbitrage opportunity validation
ValidationMiddleware.validateArbitrageOpportunity = (req, res, next) => {
    const schema = joi_1.default.object({
        pairKey: joi_1.default.string().pattern(/^[A-Z0-9_-]+$/).min(1).max(50).required()
            .messages({
            'string.pattern.base': 'pairKey must contain only uppercase letters, numbers, underscores, and hyphens',
            'string.min': 'pairKey must be at least 1 character',
            'string.max': 'pairKey must be at most 50 characters'
        }),
        profit: joi_1.default.number().min(0).max(1000).precision(8).required()
            .messages({
            'number.min': 'profit must be non-negative',
            'number.max': 'profit must be at most 1000%'
        }),
        buyPrice: joi_1.default.number().positive().precision(18).required()
            .messages({
            'number.positive': 'buyPrice must be positive'
        }),
        sellPrice: joi_1.default.number().positive().precision(18).required()
            .messages({
            'number.positive': 'sellPrice must be positive'
        }),
        buyDex: joi_1.default.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(30).required(),
        sellDex: joi_1.default.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(30).required(),
        timestamp: joi_1.default.number().integer().min(1609459200000).max(Date.now() + 300000).required() // Between 2021 and 5min in future
            .messages({
            'number.min': 'timestamp is too old',
            'number.max': 'timestamp is too far in the future'
        }),
        chain: joi_1.default.string().valid('ethereum', 'bsc', 'arbitrum', 'polygon', 'base').required(),
        gasEstimate: joi_1.default.number().integer().min(0).max(10000000).optional() // Max 10M gas
    });
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            details: error.details.map((detail) => ({
                field: detail.path.join('.'),
                message: detail.message,
                value: detail.context?.value
            }))
        });
    }
    // Sanitize and store validated data
    req.validatedData = value;
    next();
};
// Health check validation (less strict)
ValidationMiddleware.validateHealthCheck = (req, res, next) => {
    const schema = joi_1.default.object({
        service: joi_1.default.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(50).optional(),
        detailed: joi_1.default.boolean().optional()
    });
    const { error, value } = schema.validate(req.query);
    if (error) {
        return res.status(400).json({
            error: 'Invalid query parameters',
            details: error.details.map((detail) => detail.message)
        });
    }
    req.validatedQuery = value;
    next();
};
// API key validation for future use
ValidationMiddleware.validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!apiKey) {
        return res.status(401).json({
            error: 'API key required',
            message: 'Please provide an API key in X-API-Key header or Authorization header'
        });
    }
    // Basic format validation
    if (!/^[a-zA-Z0-9\-_\.]{20,}$/.test(apiKey)) {
        return res.status(401).json({
            error: 'Invalid API key format'
        });
    }
    req.apiKey = apiKey;
    next();
};
// Generic sanitization utilities
ValidationMiddleware.sanitizeString = (input, maxLength = 1000) => {
    if (typeof input !== 'string')
        return '';
    // Remove null bytes and control characters
    let sanitized = input.replace(/[\x00-\x1F\x7F]/g, '');
    // Limit length
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }
    // Basic XSS prevention (remove script tags)
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    sanitized = sanitized.replace(/<[^>]*>/g, ''); // Remove all HTML tags
    return sanitized.trim();
};
ValidationMiddleware.sanitizeNumber = (input, min, max) => {
    const num = Number(input);
    if (isNaN(num))
        return null;
    if (min !== undefined && num < min)
        return null;
    if (max !== undefined && num > max)
        return null;
    return num;
};
// Export validation schemas for reuse
exports.ValidationSchemas = {
    arbitrageOpportunity: joi_1.default.object({
        pairKey: joi_1.default.string().pattern(/^[A-Z0-9_-]+$/).required(),
        profit: joi_1.default.number().min(0).max(1000).required(),
        buyPrice: joi_1.default.number().positive().required(),
        sellPrice: joi_1.default.number().positive().required(),
        buyDex: joi_1.default.string().required(),
        sellDex: joi_1.default.string().required(),
        timestamp: joi_1.default.number().integer().required(),
        chain: joi_1.default.string().required()
    }),
    serviceHealth: joi_1.default.object({
        service: joi_1.default.string().required(),
        status: joi_1.default.string().valid('healthy', 'unhealthy', 'unknown').required(),
        timestamp: joi_1.default.number().integer().required(),
        metrics: joi_1.default.object().optional()
    }),
    tradeExecution: joi_1.default.object({
        opportunityId: joi_1.default.string().required(),
        amount: joi_1.default.number().positive().required(),
        slippage: joi_1.default.number().min(0).max(50).required(),
        gasPrice: joi_1.default.number().positive().required()
    })
};
//# sourceMappingURL=validation.js.map
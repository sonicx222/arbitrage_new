"use strict";
// Input validation middleware using Joi
// Comprehensive validation for all API endpoints
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimitRule = exports.sanitizeInput = exports.validateWebhookRequest = exports.validateRegisterRequest = exports.validateLoginRequest = exports.validateConfigUpdate = exports.validateMetricsRequest = exports.validateHealthRequest = exports.validateArbitrageRequest = void 0;
const joi_1 = __importDefault(require("joi"));
const logger_1 = require("../../core/src/logger");
const logger = (0, logger_1.createLogger)('validation');
// Arbitrage opportunity validation
const validateArbitrageRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        sourceChain: joi_1.default.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon').required(),
        targetChain: joi_1.default.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon').required(),
        sourceDex: joi_1.default.string().min(1).max(50).required(),
        targetDex: joi_1.default.string().min(1).max(50).required(),
        tokenAddress: joi_1.default.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
        amount: joi_1.default.number().min(0.000001).max(1000000).required(),
        slippage: joi_1.default.number().min(0).max(50).default(1.0),
        gasPrice: joi_1.default.number().min(1).max(1000).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
        logger.warn('Arbitrage request validation failed', {
            error: error.details[0].message,
            body: req.body
        });
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message,
            field: error.details[0].path.join('.')
        });
    }
    req.body = value; // Use validated/sanitized data
    next();
};
exports.validateArbitrageRequest = validateArbitrageRequest;
// Health check validation
const validateHealthRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        service: joi_1.default.string().min(1).max(100).optional(),
        detailed: joi_1.default.boolean().default(false)
    });
    const { error, value } = schema.validate(req.query);
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message
        });
    }
    req.query = value;
    next();
};
exports.validateHealthRequest = validateHealthRequest;
// Metrics request validation
const validateMetricsRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        service: joi_1.default.string().min(1).max(100).required(),
        startTime: joi_1.default.date().iso().optional(),
        endTime: joi_1.default.date().iso().when('startTime', {
            is: joi_1.default.exist(),
            then: joi_1.default.date().greater(joi_1.default.ref('startTime'))
        }).optional(),
        limit: joi_1.default.number().integer().min(1).max(1000).default(100)
    });
    const { error, value } = schema.validate(req.query);
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message
        });
    }
    req.query = value;
    next();
};
exports.validateMetricsRequest = validateMetricsRequest;
// Configuration update validation
const validateConfigUpdate = (req, res, next) => {
    const schema = joi_1.default.object({
        service: joi_1.default.string().min(1).max(100).required(),
        config: joi_1.default.object({
            enabled: joi_1.default.boolean().optional(),
            threshold: joi_1.default.number().min(0).max(100).optional(),
            interval: joi_1.default.number().integer().min(1000).max(3600000).optional(), // 1s to 1h
            chains: joi_1.default.array().items(joi_1.default.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon')).optional()
        }).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
        logger.warn('Config update validation failed', {
            error: error.details[0].message,
            body: req.body
        });
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};
exports.validateConfigUpdate = validateConfigUpdate;
// Authentication request validation
const validateLoginRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        username: joi_1.default.string().min(3).max(50).required(),
        password: joi_1.default.string().min(1).required() // Length check done in service
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};
exports.validateLoginRequest = validateLoginRequest;
const validateRegisterRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        username: joi_1.default.string().min(3).max(50).required(),
        email: joi_1.default.string().email().required(),
        password: joi_1.default.string().min(8).required() // Strength check done in service
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};
exports.validateRegisterRequest = validateRegisterRequest;
// Webhook validation for external integrations
const validateWebhookRequest = (req, res, next) => {
    const schema = joi_1.default.object({
        event: joi_1.default.string().valid('arbitrage_opportunity', 'price_update', 'error').required(),
        data: joi_1.default.object().required(),
        timestamp: joi_1.default.date().iso().required(),
        signature: joi_1.default.string().pattern(/^[a-fA-F0-9]{64}$/).optional() // SHA256 signature
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
        logger.warn('Webhook validation failed', {
            error: error.details[0].message,
            ip: req.ip
        });
        return res.status(400).json({
            error: 'Invalid webhook payload',
            message: error.details[0].message
        });
    }
    // Verify webhook signature if provided
    if (value.signature) {
        const expectedSignature = generateWebhookSignature(value, process.env.WEBHOOK_SECRET || '');
        if (expectedSignature !== value.signature) {
            logger.warn('Webhook signature verification failed', { ip: req.ip });
            return res.status(401).json({
                error: 'Invalid webhook signature'
            });
        }
    }
    req.body = value;
    next();
};
exports.validateWebhookRequest = validateWebhookRequest;
// Generic object sanitization
const sanitizeInput = (req, res, next) => {
    // Remove any potential XSS payloads
    const sanitizeString = (str) => {
        return str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
    };
    const sanitizeObject = (obj) => {
        if (typeof obj === 'string') {
            return sanitizeString(obj);
        }
        else if (Array.isArray(obj)) {
            return obj.map(sanitizeObject);
        }
        else if (obj && typeof obj === 'object') {
            const sanitized = {};
            for (const [key, value] of Object.entries(obj)) {
                sanitized[key] = sanitizeObject(value);
            }
            return sanitized;
        }
        return obj;
    };
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeObject(req.body);
    }
    if (req.query && typeof req.query === 'object') {
        req.query = sanitizeObject(req.query);
    }
    next();
};
exports.sanitizeInput = sanitizeInput;
// Utility function for webhook signature verification
function generateWebhookSignature(payload, secret) {
    const crypto = require('crypto');
    const payloadStr = JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
}
// Rate limiting helper
const createRateLimitRule = (windowMs, maxRequests, message) => {
    return {
        windowMs,
        max: maxRequests,
        message: message || `Too many requests, please try again later.`,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                method: req.method
            });
            res.status(429).json({
                error: 'Too many requests',
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
    };
};
exports.createRateLimitRule = createRateLimitRule;
//# sourceMappingURL=validation.js.map
// Comprehensive input validation utilities for security
import Joi from 'joi';

export class ValidationMiddleware {
  // Arbitrage opportunity validation
  static validateArbitrageOpportunity = (req: any, res: any, next: any) => {
    const schema = Joi.object({
      pairKey: Joi.string().pattern(/^[A-Z0-9_-]+$/).min(1).max(50).required()
        .messages({
          'string.pattern.base': 'pairKey must contain only uppercase letters, numbers, underscores, and hyphens',
          'string.min': 'pairKey must be at least 1 character',
          'string.max': 'pairKey must be at most 50 characters'
        }),
      profit: Joi.number().min(0).max(1000).precision(8).required()
        .messages({
          'number.min': 'profit must be non-negative',
          'number.max': 'profit must be at most 1000%'
        }),
      buyPrice: Joi.number().positive().precision(18).required()
        .messages({
          'number.positive': 'buyPrice must be positive'
        }),
      sellPrice: Joi.number().positive().precision(18).required()
        .messages({
          'number.positive': 'sellPrice must be positive'
        }),
      buyDex: Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(30).required(),
      sellDex: Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(30).required(),
      timestamp: Joi.number().integer().min(1609459200000).max(Date.now() + 300000).required() // Between 2021 and 5min in future
        .messages({
          'number.min': 'timestamp is too old',
          'number.max': 'timestamp is too far in the future'
        }),
      chain: Joi.string().valid('ethereum', 'bsc', 'arbitrum', 'polygon', 'base').required(),
      gasEstimate: Joi.number().integer().min(0).max(10000000).optional() // Max 10M gas
    });

    const { error, value } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map((detail: any) => ({
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
  static validateHealthCheck = (req: any, res: any, next: any) => {
    const schema = Joi.object({
      service: Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(1).max(50).optional(),
      detailed: Joi.boolean().optional()
    });

    const { error, value } = schema.validate(req.query);

    if (error) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: error.details.map((detail: any) => detail.message)
      });
    }

    req.validatedQuery = value;
    next();
  };

  // API key validation for future use
  static validateApiKey = (req: any, res: any, next: any) => {
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
  static sanitizeString = (input: string, maxLength: number = 1000): string => {
    if (typeof input !== 'string') return '';

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

  static sanitizeNumber = (input: any, min?: number, max?: number): number | null => {
    const num = Number(input);
    if (isNaN(num)) return null;

    if (min !== undefined && num < min) return null;
    if (max !== undefined && num > max) return null;

    return num;
  };
}

// Export validation schemas for reuse
export const ValidationSchemas = {
  arbitrageOpportunity: Joi.object({
    pairKey: Joi.string().pattern(/^[A-Z0-9_-]+$/).required(),
    profit: Joi.number().min(0).max(1000).required(),
    buyPrice: Joi.number().positive().required(),
    sellPrice: Joi.number().positive().required(),
    buyDex: Joi.string().required(),
    sellDex: Joi.string().required(),
    timestamp: Joi.number().integer().required(),
    chain: Joi.string().required()
  }),

  serviceHealth: Joi.object({
    service: Joi.string().required(),
    status: Joi.string().valid('healthy', 'unhealthy', 'unknown').required(),
    timestamp: Joi.number().integer().required(),
    metrics: Joi.object().optional()
  }),

  tradeExecution: Joi.object({
    opportunityId: Joi.string().required(),
    amount: Joi.number().positive().required(),
    slippage: Joi.number().min(0).max(50).required(),
    gasPrice: Joi.number().positive().required()
  })
};
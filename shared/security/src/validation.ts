// Input validation middleware using Joi
// Comprehensive validation for all API endpoints

import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../core/src/logger';

const logger = createLogger('validation');

// Arbitrage opportunity validation
export const validateArbitrageRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    sourceChain: Joi.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon').required(),
    targetChain: Joi.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon').required(),
    sourceDex: Joi.string().min(1).max(50).required(),
    targetDex: Joi.string().min(1).max(50).required(),
    tokenAddress: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
    amount: Joi.number().min(0.000001).max(1000000).required(),
    slippage: Joi.number().min(0).max(50).default(1.0),
    gasPrice: Joi.number().min(1).max(1000).optional()
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

// Health check validation
export const validateHealthRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    service: Joi.string().min(1).max(100).optional(),
    detailed: Joi.boolean().default(false)
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

// Metrics request validation
export const validateMetricsRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    service: Joi.string().min(1).max(100).required(),
    startTime: Joi.date().iso().optional(),
    endTime: Joi.date().iso().when('startTime', {
      is: Joi.exist(),
      then: Joi.date().greater(Joi.ref('startTime'))
    }).optional(),
    limit: Joi.number().integer().min(1).max(1000).default(100)
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

// Configuration update validation
export const validateConfigUpdate = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    service: Joi.string().min(1).max(100).required(),
    config: Joi.object({
      enabled: Joi.boolean().optional(),
      threshold: Joi.number().min(0).max(100).optional(),
      interval: Joi.number().integer().min(1000).max(3600000).optional(), // 1s to 1h
      chains: Joi.array().items(
        Joi.string().valid('ethereum', 'bsc', 'arbitrum', 'base', 'polygon')
      ).optional()
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

// Authentication request validation
export const validateLoginRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    username: Joi.string().min(3).max(50).required(),
    password: Joi.string().min(1).required() // Length check done in service
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

export const validateRegisterRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    username: Joi.string().min(3).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required() // Strength check done in service
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

// Webhook validation for external integrations
export const validateWebhookRequest = (req: Request, res: Response, next: NextFunction) => {
  const schema = Joi.object({
    event: Joi.string().valid('arbitrage_opportunity', 'price_update', 'error').required(),
    data: Joi.object().required(),
    timestamp: Joi.date().iso().required(),
    signature: Joi.string().pattern(/^[a-fA-F0-9]{64}$/).optional() // SHA256 signature
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

// Generic object sanitization
export const sanitizeInput = (req: Request, res: Response, next: NextFunction) => {
  // Remove any potential XSS payloads
  const sanitizeString = (str: string): string => {
    return str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
               .replace(/javascript:/gi, '')
               .replace(/on\w+\s*=/gi, '');
  };

  const sanitizeObject = (obj: any): any => {
    if (typeof obj === 'string') {
      return sanitizeString(obj);
    } else if (Array.isArray(obj)) {
      return obj.map(sanitizeObject);
    } else if (obj && typeof obj === 'object') {
      const sanitized: any = {};
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

// Utility function for webhook signature verification
function generateWebhookSignature(payload: any, secret: string): string {
  const crypto = require('crypto');
  const payloadStr = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
}

// Rate limiting helper
export const createRateLimitRule = (windowMs: number, maxRequests: number, message?: string) => {
  return {
    windowMs,
    max: maxRequests,
    message: message || `Too many requests, please try again later.`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
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
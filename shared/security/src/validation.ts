// Input validation middleware using Joi
// Comprehensive validation for all API endpoints
//
// P0-4 FIX: Added 'optimism' to valid chains list
// P2-1 FIX: Created centralized SUPPORTED_CHAINS constant

import Joi from 'joi';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('validation');

// P2-1 FIX: Centralized supported chains list for consistency
// When adding new chains, only update this array
const SUPPORTED_CHAINS = ['ethereum', 'bsc', 'arbitrum', 'base', 'polygon', 'optimism', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'] as const;
type SupportedChain = typeof SUPPORTED_CHAINS[number];

// Arbitrage opportunity validation
export const validateArbitrageRequest = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    // P0-4 FIX: Use centralized SUPPORTED_CHAINS
    sourceChain: Joi.string().valid(...SUPPORTED_CHAINS).required(),
    targetChain: Joi.string().valid(...SUPPORTED_CHAINS).required(),
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
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message,
      field: error.details[0].path.join('.')
    });
    return;
  }

  req.body = value; // Use validated/sanitized data
  next();
};

// Health check validation
export const validateHealthRequest = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    service: Joi.string().min(1).max(100).optional(),
    detailed: Joi.boolean().default(false)
  });

  const { error, value } = schema.validate(req.query);

  if (error) {
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message
    });
    return;
  }

  req.query = value;
  next();
};

// Metrics request validation
export const validateMetricsRequest = (req: Request, res: Response, next: NextFunction): void => {
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
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message
    });
    return;
  }

  req.query = value;
  next();
};

// Configuration update validation
export const validateConfigUpdate = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    service: Joi.string().min(1).max(100).required(),
    config: Joi.object({
      enabled: Joi.boolean().optional(),
      threshold: Joi.number().min(0).max(100).optional(),
      interval: Joi.number().integer().min(1000).max(3600000).optional(), // 1s to 1h
      // P0-4 FIX: Use centralized SUPPORTED_CHAINS
      chains: Joi.array().items(
        Joi.string().valid(...SUPPORTED_CHAINS)
      ).optional()
    }).required()
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    logger.warn('Config update validation failed', {
      error: error.details[0].message,
      body: req.body
    });
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message
    });
    return;
  }

  req.body = value;
  next();
};

// Authentication request validation
export const validateLoginRequest = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    username: Joi.string().min(3).max(50).required(),
    password: Joi.string().min(1).required() // Length check done in service
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message
    });
    return;
  }

  req.body = value;
  next();
};

export const validateRegisterRequest = (req: Request, res: Response, next: NextFunction): void => {
  const schema = Joi.object({
    username: Joi.string().min(3).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required() // Strength check done in service
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    res.status(400).json({
      error: 'Validation failed',
      message: error.details[0].message
    });
    return;
  }

  req.body = value;
  next();
};

// Webhook validation for external integrations
export const validateWebhookRequest = (req: Request, res: Response, next: NextFunction): void => {
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
    res.status(400).json({
      error: 'Invalid webhook payload',
      message: error.details[0].message
    });
    return;
  }

  // Verify webhook signature
  // FIX #6: When WEBHOOK_SECRET is configured, signature is required.
  // When WEBHOOK_SECRET is not set, allow unsigned requests (backward compatible).
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    if (!value.signature) {
      logger.warn('Webhook request missing required signature', { ip: req.ip });
      res.status(401).json({
        error: 'Webhook signature is required'
      });
      return;
    }
    // Strip signature from payload before computing HMAC - the sender computes
    // HMAC over the payload without the signature field
    const { signature: _sig, ...payloadWithoutSignature } = value;
    const expectedSignature = generateWebhookSignature(payloadWithoutSignature, webhookSecret);
    if (!timingSafeSignatureEqual(expectedSignature, value.signature)) {
      logger.warn('Webhook signature verification failed', { ip: req.ip });
      res.status(401).json({
        error: 'Invalid webhook signature'
      });
      return;
    }
  } else if (value.signature) {
    // Signature provided but no secret configured - cannot verify
    logger.warn('Webhook signature provided but WEBHOOK_SECRET not configured', { ip: req.ip });
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

/**
 * Timing-safe comparison for HMAC signatures.
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 * Handles different-length strings safely (timingSafeEqual requires equal lengths).
 */
function timingSafeSignatureEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');

  // If lengths differ, the signature is invalid. Still perform a constant-time
  // comparison against the expected value to avoid leaking length information.
  if (expectedBuf.length !== actualBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Utility function for webhook signature verification
// FIX: Use module-level crypto import instead of require()
function generateWebhookSignature(payload: unknown, secret: string): string {
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
/**
 * Middleware Configuration
 *
 * Configures Express middleware for security, CORS, parsing, and logging.
 *
 * @see coordinator.ts (main service)
 */

import { Application, Request, Response, NextFunction } from 'express';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { RouteLogger } from '../types';

/**
 * Configure all middleware on an Express application.
 *
 * @param app - Express application
 * @param logger - Logger for request logging
 */
export function configureMiddleware(app: Application, logger: RouteLogger): void {
  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }));

  // CORS configuration
  app.use(configureCors);

  // JSON parsing with limits
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.static('public'));

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests', retryAfter: 900 },
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use(limiter);

  // Request logging
  app.use(createRequestLogger(logger));
}

/**
 * CORS middleware handler.
 */
function configureCors(req: Request, res: Response, next: NextFunction): void {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'];

  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }

  next();
}

/**
 * Create request logging middleware.
 */
function createRequestLogger(logger: RouteLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('API Request', {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        ip: clientIP
      });
    });

    next();
  };
}

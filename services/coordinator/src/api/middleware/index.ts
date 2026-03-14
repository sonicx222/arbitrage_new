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
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import type { MinimalLogger } from '../types';
import { RedisRateLimitStore } from './redis-rate-limit-store';

/** P2-2 FIX: Module-level store reference for shutdown cleanup. */
let _rateLimitStore: RedisRateLimitStore | null = null;

/**
 * P2-2 FIX: Shut down the Redis rate-limit store's ioredis connection.
 * Called from coordinator.stop() to prevent leaked connections blocking clean exit.
 */
export async function shutdownRateLimitStore(): Promise<void> {
  if (_rateLimitStore) {
    await _rateLimitStore.shutdown();
    _rateLimitStore = null;
  }
}

/**
 * Configure all middleware on an Express application.
 *
 * S-12 FIX: Throws at startup if NODE_ENV=production and ALLOWED_ORIGINS is not set,
 * preventing accidental use of localhost CORS defaults in production.
 *
 * @param app - Express application
 * @param logger - Logger for request logging
 * @throws Error if in production without ALLOWED_ORIGINS configured
 */
export function configureMiddleware(app: Application, logger: MinimalLogger): void {
  // SEC-H-01 FIX: Configure trust proxy so express-rate-limit uses X-Forwarded-For
  // instead of socket IP. Without this, all clients behind a reverse proxy (Fly.io,
  // nginx) share one rate-limit bucket. Configurable via TRUST_PROXY env var.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    // Support numeric hop count (e.g., "1") or string values (e.g., "loopback")
    const numeric = parseInt(trustProxy, 10);
    app.set('trust proxy', isNaN(numeric) ? trustProxy : numeric);
  }

  // S-12 FIX: Prevent localhost CORS defaults in production
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) {
    throw new Error(
      'CORS MISCONFIGURATION: ALLOWED_ORIGINS environment variable is required in production. ' +
      'Without it, CORS defaults to localhost origins which is insecure. ' +
      'Set ALLOWED_ORIGINS to a comma-separated list of allowed origins (e.g., "https://dashboard.example.com").'
    );
  }
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
  // NOTE: express.static('public') removed - no static files are served (API-only service)

  // OP-23 FIX: Configurable rate limits via env vars (previously hardcoded)
  // FIX SA-010: Use parseEnvIntSafe instead of raw parseInt
  const rateLimitWindowMs = parseEnvIntSafe('API_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 1000);
  const rateLimitMax = parseEnvIntSafe('API_RATE_LIMIT_MAX', 100, 1);

  // FIX #3: Use Redis-backed store for multi-instance rate limiting.
  // Opt-in via RATE_LIMIT_STORE=redis (requires REDIS_URL).
  // Falls back to in-memory store (single-instance only) when not configured.
  const useRedisStore = process.env.RATE_LIMIT_STORE === 'redis' && process.env.REDIS_URL;
  // P2-1 FIX: Pass structured logger to store for OTEL transport + log-level filtering.
  const store = useRedisStore
    ? new RedisRateLimitStore(process.env.REDIS_URL!, 'coordinator:rl:', logger)
    : undefined; // undefined = express-rate-limit default MemoryStore
  // P2-2 FIX: Store reference for shutdown (ioredis connection cleanup).
  _rateLimitStore = store ?? null;

  if (!useRedisStore && process.env.NODE_ENV === 'production') {
    logger.warn('Rate limiter using in-memory store. Set RATE_LIMIT_STORE=redis for multi-instance deployment.');
  }

  const limiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    message: { error: 'Too many requests', retryAfter: Math.ceil(rateLimitWindowMs / 1000) },
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
  });
  app.use(limiter);

  // Request logging
  app.use(createRequestLogger(logger));
}

/**
 * CORS middleware handler.
 * FIX: Case-insensitive origin comparison per RFC 3986.
 */
function configureCors(req: Request, res: Response, next: NextFunction): void {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().toLowerCase())
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

  const origin = req.headers.origin;
  // FIX: Compare origins case-insensitively (RFC 3986 - scheme and host are case-insensitive)
  if (origin && allowedOrigins.includes(origin.toLowerCase())) {
    // Return the original origin (preserve case for the response)
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key');
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
function createRequestLogger(logger: MinimalLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('API Request', {
        method: req.method,
        url: req.url.split('?')[0],
        status: res.statusCode,
        duration,
        ip: clientIP
      });
    });

    next();
  };
}

/**
 * Admin Routes
 *
 * Protected endpoints for administrative actions.
 * Requires authentication with write permissions and strict rate limiting.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { apiAuth, apiAuthorize } from '@shared/security';
import type { CoordinatorStateProvider } from '../types';

// Allowed services for restart operations
const ALLOWED_SERVICES = [
  'bsc-detector',
  'ethereum-detector',
  'arbitrum-detector',
  'polygon-detector',
  'optimism-detector',
  'base-detector',
  'execution-engine'
];

/**
 * Create admin router.
 *
 * @param state - Coordinator state provider
 * @returns Express router with admin endpoints
 */
export function createAdminRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  // Strict rate limiting for admin actions
  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per window
    message: { error: 'Too many control actions', retryAfter: 900 }
  });

  // Authentication middleware (required: true is the default)
  const writeAuth = apiAuth();

  /**
   * Validate service restart request.
   */
  function validateServiceRestart(req: Request, res: Response, next: NextFunction): void {
    const { service } = req.params;

    if (!service || typeof service !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(service)) {
      res.status(400).json({ error: 'Invalid service name' });
      return;
    }

    if (!ALLOWED_SERVICES.includes(service)) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

    // Only leader can restart services
    if (!state.getIsLeader()) {
      res.status(403).json({ error: 'Only leader can restart services' });
      return;
    }

    next();
  }

  /**
   * Validate alert acknowledge request.
   */
  function validateAlertAcknowledge(req: Request, res: Response, next: NextFunction): void {
    const { alert } = req.params;

    if (!alert || typeof alert !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(alert)) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }

    next();
  }

  /**
   * POST /api/services/:service/restart
   * Request service restart (leader only).
   */
  router.post(
    '/services/:service/restart',
    strictLimiter,
    writeAuth,
    apiAuthorize('services', 'write'),
    validateServiceRestart,
    async (req: Request, res: Response) => {
      const { service } = req.params;
      const logger = state.getLogger();

      try {
        logger.info(`Restarting service: ${service}`);
        // In production, implement service restart logic via orchestration
        res.json({ success: true, message: `Restart requested for ${service}` });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    }
  );

  /**
   * POST /api/alerts/:alert/acknowledge
   * Acknowledge an alert (clears cooldown).
   */
  router.post(
    '/alerts/:alert/acknowledge',
    strictLimiter,
    writeAuth,
    apiAuthorize('alerts', 'write'),
    validateAlertAcknowledge,
    (req: Request, res: Response) => {
      const { alert } = req.params;

      // Alert cooldown keys are stored as `${type}_${service}`, e.g., "SERVICE_UNHEALTHY_bsc-detector"
      // The alert param can be either the full key or just the type
      // Try exact match first, then try with _system suffix for system alerts
      let deleted = state.deleteAlertCooldown(alert);
      if (!deleted) {
        // Try with _system suffix (for alerts without service)
        deleted = state.deleteAlertCooldown(`${alert}_system`);
      }

      res.json({
        success: deleted,
        message: deleted ? 'Alert acknowledged' : 'Alert not found in cooldowns'
      });
    }
  );

  return router;
}

/**
 * Dashboard Routes
 *
 * HTML dashboard for visual system monitoring.
 * Public endpoint - no authentication required.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import type { CoordinatorStateProvider } from '../types';

/**
 * Escape HTML special characters to prevent XSS.
 * Defense-in-depth for values interpolated into HTML.
 */
function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
}

// FIX: Cache interface moved inside factory for instance-scoping
interface DashboardCache {
  html: string;
  timestamp: number;
}

const CACHE_TTL_MS = 1000; // 1 second cache - dashboard auto-refreshes every 10s anyway

/**
 * Create dashboard router.
 * FIX: Cache is now instance-scoped (per router) instead of module-level.
 * This prevents cache sharing between tests or multiple coordinator instances.
 *
 * @param state - Coordinator state provider
 * @returns Express router with dashboard endpoint
 */
export function createDashboardRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  // FIX: Instance-scoped cache (was module-level, could cause issues in tests)
  let dashboardCache: DashboardCache | null = null;

  /**
   * GET /
   * Returns HTML dashboard with system status.
   * FIX: Added caching to reduce CPU usage for high-frequency polling.
   */
  router.get('/', (_req: Request, res: Response) => {
    const now = Date.now();

    // Return cached HTML if still fresh
    if (dashboardCache && (now - dashboardCache.timestamp) < CACHE_TTL_MS) {
      res.send(dashboardCache.html);
      return;
    }
    const isLeader = state.getIsLeader();
    const metrics = state.getSystemMetrics();
    const serviceHealth = state.getServiceHealthMap();
    const instanceId = state.getInstanceId();

    const leaderBadge = isLeader
      ? '<span style="background:green;color:white;padding:2px 8px;border-radius:3px;">LEADER</span>'
      : '<span style="background:orange;color:white;padding:2px 8px;border-radius:3px;">STANDBY</span>';

    // Build HTML string
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Arbitrage System Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
          .metric { background: #16213e; padding: 15px; margin: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
          .healthy { color: #00ff88; }
          .unhealthy { color: #ff4444; }
          .degraded { color: #ffaa00; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
          h1 { color: #00ff88; }
          h3 { color: #4da6ff; margin-bottom: 10px; }
          .leader-status { margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <h1>🏦 Professional Arbitrage System Dashboard</h1>
        <div class="leader-status">Status: ${leaderBadge}</div>

        <div class="grid">
          <div class="metric">
            <h3>System Health</h3>
            <div class="${metrics.systemHealth > 80 ? 'healthy' : metrics.systemHealth > 50 ? 'degraded' : 'unhealthy'}">
              ${metrics.systemHealth.toFixed(1)}%
            </div>
            <small>${metrics.activeServices} services active</small>
          </div>

          <div class="metric">
            <h3>Opportunities</h3>
            <div>Detected: ${metrics.totalOpportunities}</div>
            <div>Pending: ${metrics.pendingOpportunities}</div>
            <div>Whale Alerts: ${metrics.whaleAlerts}</div>
          </div>

          <div class="metric">
            <h3>Trading Performance</h3>
            <div>Executions: ${metrics.totalExecutions}</div>
            <div>Success Rate: ${metrics.totalExecutions > 0 ?
              ((metrics.successfulExecutions / metrics.totalExecutions) * 100).toFixed(1) : 0}%</div>
            <div>Total Profit: $${metrics.totalProfit.toFixed(2)}</div>
          </div>

          <div class="metric">
            <h3>Service Status</h3>
            ${Array.from(serviceHealth.entries()).map(([name, health]) =>
              `<div class="${health.status === 'healthy' ? 'healthy' : health.status === 'degraded' ? 'degraded' : 'unhealthy'}">
                ${escapeHtml(name)}: ${escapeHtml(health.status)}
              </div>`
            ).join('') || '<div>No services reporting</div>'}
          </div>
        </div>

        <div class="metric">
          <h3>System Information</h3>
          <div>Instance: ${escapeHtml(instanceId)}</div>
          <div>Last Update: ${new Date(metrics.lastUpdate).toLocaleString()}</div>
          <div>Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m</div>
        </div>

        <script>
          // Auto-refresh every 10 seconds
          setTimeout(() => window.location.reload(), 10000);
        </script>
      </body>
      </html>
    `;

    // FIX: Cache the HTML for subsequent requests
    dashboardCache = { html, timestamp: now };
    res.send(html);
  });

  return router;
}

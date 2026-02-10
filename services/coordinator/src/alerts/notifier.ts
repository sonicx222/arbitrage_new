/**
 * Alert Notification Service
 *
 * Sends alerts to external channels (Discord, Slack, email).
 * Implements the TODO from coordinator.ts for production alert delivery.
 *
 * FIX: Added circuit breaker pattern to prevent repeated failed requests
 * and allow graceful recovery when webhooks become available again.
 *
 * Environment Variables:
 * - DISCORD_WEBHOOK_URL: Discord webhook for alerts
 * - SLACK_WEBHOOK_URL: Slack webhook for alerts
 * - ALERT_EMAIL: Email address for critical alerts (via SendGrid/SES)
 *
 * @see coordinator.ts sendAlert()
 */

// FIX: Import Alert from consolidated type definition (single source of truth)
import type { RouteLogger, Alert, AlertSeverity } from '../api/types';

// Re-export for consumers that import from this module
export type { Alert, AlertSeverity };

/**
 * Circuit breaker state for a notification channel.
 */
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  lastAttempt: number;
}

/**
 * Circuit breaker configuration.
 */
interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms before attempting to close circuit (half-open state) */
  resetTimeoutMs: number;
  /** Time in ms before resetting failure count after success */
  successResetMs: number;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000, // 1 minute
  successResetMs: 30000  // 30 seconds
};

/**
 * Notification channel interface.
 */
export interface NotificationChannel {
  name: string;
  send(alert: Alert): Promise<boolean>;
  isConfigured(): boolean;
}

/**
 * Discord notification channel.
 */
export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord';
  private webhookUrl: string | undefined;
  private logger: RouteLogger;

  constructor(logger: RouteLogger) {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.logger = logger;
  }

  isConfigured(): boolean {
    return !!this.webhookUrl;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!this.webhookUrl) return false;

    try {
      const color = this.getSeverityColor(alert.severity);
      const payload = {
        embeds: [{
          title: `🚨 ${alert.type}`,
          description: alert.message || 'No message provided',
          color,
          fields: [
            { name: 'Severity', value: alert.severity || 'unknown', inline: true },
            { name: 'Service', value: alert.service || 'system', inline: true },
            { name: 'Timestamp', value: new Date(alert.timestamp).toISOString(), inline: true }
          ],
          footer: {
            text: 'Arbitrage System Alert'
          }
        }]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        this.logger.error('Discord webhook failed', {
          status: response.status,
          statusText: response.statusText
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Discord notification error', { error: (error as Error).message });
      return false;
    }
  }

  private getSeverityColor(severity?: AlertSeverity): number {
    switch (severity) {
      case 'critical': return 0xFF0000; // Red
      case 'high': return 0xFFA500;     // Orange
      case 'low': return 0xFFFF00;      // Yellow
      default: return 0x808080;          // Gray
    }
  }
}

/**
 * Slack notification channel.
 */
export class SlackChannel implements NotificationChannel {
  readonly name = 'slack';
  private webhookUrl: string | undefined;
  private logger: RouteLogger;

  constructor(logger: RouteLogger) {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL;
    this.logger = logger;
  }

  isConfigured(): boolean {
    return !!this.webhookUrl;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!this.webhookUrl) return false;

    try {
      const emoji = this.getSeverityEmoji(alert.severity);
      const payload = {
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${emoji} ${alert.type}`,
              emoji: true
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: alert.message || 'No message provided'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `*Severity:* ${alert.severity || 'unknown'} | *Service:* ${alert.service || 'system'} | *Time:* ${new Date(alert.timestamp).toISOString()}`
              }
            ]
          }
        ]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        this.logger.error('Slack webhook failed', {
          status: response.status,
          statusText: response.statusText
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Slack notification error', { error: (error as Error).message });
      return false;
    }
  }

  private getSeverityEmoji(severity?: AlertSeverity): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'low': return '🟡';
      default: return '⚪';
    }
  }
}

/**
 * Alert Notifier Service
 *
 * Manages multiple notification channels and sends alerts to all configured channels.
 * FIX: Uses circular buffer for O(1) alert history operations instead of O(n) shift()
 * FIX: Added circuit breaker pattern to prevent hammering failed webhooks
 */
export class AlertNotifier {
  private channels: NotificationChannel[] = [];
  private logger: RouteLogger;

  // FIX: Circuit breaker state per channel
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private circuitConfig: CircuitBreakerConfig;

  // FIX: Circular buffer implementation for O(1) operations
  // Previous implementation used array.shift() which is O(n) for each removal
  private alertHistoryBuffer: Alert[] = [];
  private alertHistoryHead = 0;  // Points to the oldest entry (next to be overwritten)
  private alertHistoryCount = 0; // Current number of entries
  private readonly maxHistorySize: number;

  // FIX: Track dropped alerts due to circuit breaker
  private droppedAlerts = 0;

  constructor(
    logger: RouteLogger,
    maxHistorySize: number = 1000,
    circuitConfig?: Partial<CircuitBreakerConfig>
  ) {
    this.logger = logger;
    this.maxHistorySize = maxHistorySize;
    this.circuitConfig = { ...DEFAULT_CIRCUIT_CONFIG, ...circuitConfig };
    // Pre-allocate buffer for better memory locality
    this.alertHistoryBuffer = new Array(maxHistorySize);

    // Initialize channels
    this.channels.push(new DiscordChannel(logger));
    this.channels.push(new SlackChannel(logger));

    // Initialize circuit breakers for each channel
    for (const channel of this.channels) {
      this.circuitBreakers.set(channel.name, {
        failures: 0,
        lastFailure: 0,
        isOpen: false,
        lastAttempt: 0
      });
    }

    // Log configured channels (defensive - logger may be undefined in tests)
    if (this.logger) {
      const configured = this.channels.filter(c => c.isConfigured()).map(c => c.name);
      if (configured.length > 0) {
        this.logger.info?.('Alert notification channels configured', { channels: configured });
      } else {
        this.logger.warn?.('No alert notification channels configured. Set DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL for production alerts.');
      }
    }
  }

  /**
   * Check if circuit is open for a channel.
   * If open, check if reset timeout has passed (half-open state).
   */
  private isCircuitOpen(channelName: string): boolean {
    const state = this.circuitBreakers.get(channelName);
    if (!state || !state.isOpen) return false;

    const now = Date.now();
    // Check if we should try again (half-open state)
    if (now - state.lastFailure >= this.circuitConfig.resetTimeoutMs) {
      // Allow one attempt (half-open)
      return false;
    }

    return true;
  }

  /**
   * Record a failure for a channel's circuit breaker.
   */
  private recordFailure(channelName: string): void {
    const state = this.circuitBreakers.get(channelName);
    if (!state) return;

    const now = Date.now();
    state.failures++;
    state.lastFailure = now;
    state.lastAttempt = now;

    if (state.failures >= this.circuitConfig.failureThreshold && !state.isOpen) {
      state.isOpen = true;
      this.logger.warn('Circuit breaker opened for notification channel', {
        channel: channelName,
        failures: state.failures,
        resetTimeoutMs: this.circuitConfig.resetTimeoutMs
      });
    }
  }

  /**
   * Record a success for a channel's circuit breaker.
   */
  private recordSuccess(channelName: string): void {
    const state = this.circuitBreakers.get(channelName);
    if (!state) return;

    const wasOpen = state.isOpen;
    state.failures = 0;
    state.isOpen = false;
    state.lastAttempt = Date.now();

    if (wasOpen) {
      this.logger.info('Circuit breaker closed - channel recovered', {
        channel: channelName
      });
    }
  }

  /**
   * Send an alert to all configured notification channels.
   * Also stores the alert in history for the /api/alerts endpoint.
   *
   * FIX: Implements circuit breaker pattern to prevent hammering failed webhooks.
   */
  async notify(alert: Alert): Promise<void> {
    // FIX: O(1) circular buffer insertion instead of O(n) shift()
    if (this.alertHistoryCount < this.maxHistorySize) {
      // Buffer not full yet - append at the tail
      this.alertHistoryBuffer[this.alertHistoryCount] = alert;
      this.alertHistoryCount++;
    } else {
      // Buffer full - overwrite oldest at head position
      this.alertHistoryBuffer[this.alertHistoryHead] = alert;
      this.alertHistoryHead = (this.alertHistoryHead + 1) % this.maxHistorySize;
    }

    // Send to all configured channels
    const configuredChannels = this.channels.filter(c => c.isConfigured());

    if (configuredChannels.length === 0) {
      // No channels configured - just log
      this.logger.warn('Alert triggered (no notification channels)', alert);
      return;
    }

    // FIX: Check circuit breakers before sending
    const channelsToSend = configuredChannels.filter(channel => {
      const isOpen = this.isCircuitOpen(channel.name);
      if (isOpen) {
        this.droppedAlerts++;
        this.logger.debug?.('Alert skipped due to open circuit breaker', {
          channel: channel.name,
          alertType: alert.type,
          droppedTotal: this.droppedAlerts
        });
      }
      return !isOpen;
    });

    if (channelsToSend.length === 0) {
      this.logger.warn('All notification channels have open circuit breakers', {
        alert: alert.type,
        droppedAlerts: this.droppedAlerts
      });
      return;
    }

    // Send to channels with closed circuits in parallel
    const results = await Promise.allSettled(
      channelsToSend.map(async channel => {
        const success = await channel.send(alert);
        return { channel: channel.name, success };
      })
    );

    // Process results and update circuit breakers
    results.forEach((result) => {
      if (result.status === 'rejected') {
        const channelName = channelsToSend[results.indexOf(result)]?.name || 'unknown';
        this.recordFailure(channelName);
        this.logger.error('Alert notification failed', {
          channel: channelName,
          error: result.reason
        });
      } else if (result.value.success) {
        this.recordSuccess(result.value.channel);
      } else {
        this.recordFailure(result.value.channel);
        this.logger.warn('Alert notification returned false', {
          channel: result.value.channel
        });
      }
    });
  }

  /**
   * Get alert history for the /api/alerts endpoint.
   * Returns the most recent alerts, sorted by timestamp descending.
   * FIX: Updated to work with circular buffer
   *
   * @param limit Maximum number of alerts to return (default: 100)
   */
  getAlertHistory(limit: number = 100): Alert[] {
    // Extract alerts from circular buffer
    const alerts: Alert[] = [];
    const count = Math.min(limit, this.alertHistoryCount);

    if (this.alertHistoryCount < this.maxHistorySize) {
      // Buffer not full - alerts are at indices 0 to alertHistoryCount-1
      // Take the most recent 'count' alerts (newest are at the end)
      const start = Math.max(0, this.alertHistoryCount - count);
      for (let i = this.alertHistoryCount - 1; i >= start; i--) {
        alerts.push(this.alertHistoryBuffer[i]);
      }
    } else {
      // Buffer full - use circular logic
      // Newest is at (head - 1 + maxSize) % maxSize, oldest is at head
      let idx = (this.alertHistoryHead - 1 + this.maxHistorySize) % this.maxHistorySize;
      for (let i = 0; i < count; i++) {
        alerts.push(this.alertHistoryBuffer[idx]);
        idx = (idx - 1 + this.maxHistorySize) % this.maxHistorySize;
      }
    }

    // P2-003 FIX: Return as-is - already in descending order by construction
    // Tests verify this invariant (notifier.test.ts:240-256)
    return alerts;
  }

  /**
   * Clear alert history.
   * FIX: Updated to reset circular buffer state
   */
  clearHistory(): void {
    this.alertHistoryBuffer = new Array(this.maxHistorySize);
    this.alertHistoryHead = 0;
    this.alertHistoryCount = 0;
  }

  /**
   * Check if any notification channels are configured.
   */
  hasConfiguredChannels(): boolean {
    return this.channels.some(c => c.isConfigured());
  }

  /**
   * Get the number of alerts dropped due to circuit breaker.
   */
  getDroppedAlerts(): number {
    return this.droppedAlerts;
  }

  /**
   * Get circuit breaker status for all channels.
   */
  getCircuitStatus(): Record<string, { isOpen: boolean; failures: number }> {
    const status: Record<string, { isOpen: boolean; failures: number }> = {};
    for (const [name, state] of this.circuitBreakers) {
      status[name] = {
        isOpen: this.isCircuitOpen(name),
        failures: state.failures
      };
    }
    return status;
  }

  /**
   * Reset circuit breaker for a specific channel (manual override).
   */
  resetCircuit(channelName: string): boolean {
    const state = this.circuitBreakers.get(channelName);
    if (!state) return false;

    state.failures = 0;
    state.isOpen = false;
    state.lastFailure = 0;

    this.logger.info('Circuit breaker manually reset', { channel: channelName });
    return true;
  }
}

/**
 * Alert Notification Service
 *
 * Sends alerts to external channels (Discord, Slack, email).
 * Implements the TODO from coordinator.ts for production alert delivery.
 *
 * Environment Variables:
 * - DISCORD_WEBHOOK_URL: Discord webhook for alerts
 * - SLACK_WEBHOOK_URL: Slack webhook for alerts
 * - ALERT_EMAIL: Email address for critical alerts (via SendGrid/SES)
 *
 * @see coordinator.ts sendAlert()
 */

import type { RouteLogger } from '../api/types';

/**
 * Alert severity levels.
 */
export type AlertSeverity = 'low' | 'high' | 'critical';

/**
 * Alert structure for notifications.
 */
export interface Alert {
  type: string;
  service?: string;
  message?: string;
  severity?: AlertSeverity;
  data?: Record<string, unknown>;
  timestamp: number;
}

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
 */
export class AlertNotifier {
  private channels: NotificationChannel[] = [];
  private logger: RouteLogger;
  private alertHistory: Alert[] = [];
  private readonly maxHistorySize: number;

  constructor(logger: RouteLogger, maxHistorySize: number = 1000) {
    this.logger = logger;
    this.maxHistorySize = maxHistorySize;

    // Initialize channels
    this.channels.push(new DiscordChannel(logger));
    this.channels.push(new SlackChannel(logger));

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
   * Send an alert to all configured notification channels.
   * Also stores the alert in history for the /api/alerts endpoint.
   */
  async notify(alert: Alert): Promise<void> {
    // Store in history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift(); // Remove oldest
    }

    // Send to all configured channels
    const configuredChannels = this.channels.filter(c => c.isConfigured());

    if (configuredChannels.length === 0) {
      // No channels configured - just log
      this.logger.warn('Alert triggered (no notification channels)', alert);
      return;
    }

    // Send to all channels in parallel
    const results = await Promise.allSettled(
      configuredChannels.map(channel => channel.send(alert))
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error('Alert notification failed', {
          channel: configuredChannels[index].name,
          error: result.reason
        });
      } else if (!result.value) {
        this.logger.warn('Alert notification returned false', {
          channel: configuredChannels[index].name
        });
      }
    });
  }

  /**
   * Get alert history for the /api/alerts endpoint.
   * Returns the most recent alerts, sorted by timestamp descending.
   *
   * @param limit Maximum number of alerts to return (default: 100)
   */
  getAlertHistory(limit: number = 100): Alert[] {
    return this.alertHistory
      .slice(-limit)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Clear alert history.
   */
  clearHistory(): void {
    this.alertHistory = [];
  }

  /**
   * Check if any notification channels are configured.
   */
  hasConfiguredChannels(): boolean {
    return this.channels.some(c => c.isConfigured());
  }
}

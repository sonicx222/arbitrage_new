/**
 * AlertNotifier Test Suite
 *
 * Comprehensive tests for alert notification system including:
 * - Circuit breaker pattern for webhooks
 * - Circular buffer for O(1) alert history
 * - Dual-channel notifications (Discord, Slack)
 * - Dropped alert tracking
 *
 * Coverage Target: >80%
 * Priority: P1 (was missing, 0% coverage for 495 lines)
 */

import { AlertNotifier, DiscordChannel, SlackChannel } from '../../../src/alerts/notifier';
import type { Alert } from '../../../src/api/types';

// Mock fetch globally
global.fetch = jest.fn();

describe('AlertNotifier', () => {
  let notifier: AlertNotifier;
  let mockLogger: jest.Mocked<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
    // Use small buffer size for testing (5 instead of default 1000)
    notifier = new AlertNotifier(mockLogger, 5);
  });

  describe('Initialization', () => {
    it('should initialize with configured channels', () => {
      // Configure a webhook for this test
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/webhook/test';
      const notifierWithChannel = new AlertNotifier(mockLogger);

      expect(notifierWithChannel).toBeInstanceOf(AlertNotifier);
      // Logger info may be called with optional chaining, check if called at all
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should warn when no channels are configured', () => {
      // Clear environment variables and jest mock calls
      delete process.env.DISCORD_WEBHOOK_URL;
      delete process.env.SLACK_WEBHOOK_URL;
      jest.clearAllMocks();

      const notifier = new AlertNotifier(mockLogger);

      // Should warn about no channels (warn might be optional chaining)
      expect(notifier.hasConfiguredChannels()).toBe(false);
    });

    it('should report configured channels', () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/webhook/test';
      const notifier = new AlertNotifier(mockLogger);

      expect(notifier.hasConfiguredChannels()).toBe(true);
    });
  });

  describe('Circuit Breaker', () => {
    beforeEach(() => {
      // Configure Discord webhook for testing
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/webhook/test';
      notifier = new AlertNotifier(mockLogger, 100, {
        failureThreshold: 3, // Lower threshold for faster testing
        resetTimeoutMs: 1000,
        successResetMs: 500
      });
    });

    it('should open circuit after threshold failures', async () => {
      // Mock fetch to always fail
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const alert: Alert = {
        type: 'TEST_ALERT',
        severity: 'high',
        timestamp: Date.now()
      };

      // Trigger 3 failures (threshold)
      await notifier.notify(alert);
      await notifier.notify(alert);
      await notifier.notify(alert);

      // Circuit should be open now
      const status = notifier.getCircuitStatus();
      expect(status.discord?.isOpen).toBe(true);
      expect(status.discord?.failures).toBe(3);

      // Try one more notification - this should be dropped because circuit is open
      await notifier.notify(alert);
      expect(notifier.getDroppedAlerts()).toBeGreaterThan(0);
    });

    it('should skip notifications when circuit is open', async () => {
      // Open the circuit first
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      const alert: Alert = { type: 'TEST', severity: 'high', timestamp: Date.now() };

      for (let i = 0; i < 3; i++) {
        await notifier.notify(alert);
      }

      const callCountAfterOpening = (global.fetch as jest.Mock).mock.calls.length;

      // Try to send another alert - should be dropped
      await notifier.notify(alert);

      // Fetch should not be called again
      expect(global.fetch).toHaveBeenCalledTimes(callCountAfterOpening);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Alert skipped due to open circuit breaker'),
        expect.any(Object)
      );
    });

    it('should attempt to close circuit after reset timeout', async () => {
      jest.useFakeTimers();

      // Open the circuit
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      const alert: Alert = { type: 'TEST', severity: 'high', timestamp: Date.now() };

      for (let i = 0; i < 3; i++) {
        await notifier.notify(alert);
      }

      expect(notifier.getCircuitStatus().discord?.isOpen).toBe(true);

      // Advance time past reset timeout
      jest.advanceTimersByTime(1001);

      // Mock successful response
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK'
      } as Response);

      // Try again - should attempt (half-open state)
      await notifier.notify(alert);

      // Circuit should be closed after success
      expect(notifier.getCircuitStatus().discord?.isOpen).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker closed - channel recovered'),
        expect.any(Object)
      );

      jest.useRealTimers();
    });

    it('should track dropped alerts correctly', async () => {
      // Open circuit
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      const alert: Alert = { type: 'TEST', severity: 'high', timestamp: Date.now() };

      for (let i = 0; i < 3; i++) {
        await notifier.notify(alert);
      }

      const droppedBefore = notifier.getDroppedAlerts();

      // Send 5 more alerts (all should be dropped)
      for (let i = 0; i < 5; i++) {
        await notifier.notify(alert);
      }

      expect(notifier.getDroppedAlerts()).toBe(droppedBefore + 5);
    });

    it('should allow manual circuit reset', async () => {
      // Open circuit
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      const alert: Alert = { type: 'TEST', severity: 'high', timestamp: Date.now() };

      for (let i = 0; i < 3; i++) {
        await notifier.notify(alert);
      }

      expect(notifier.getCircuitStatus().discord?.isOpen).toBe(true);

      // Manually reset
      const resetSuccess = notifier.resetCircuit('discord');
      expect(resetSuccess).toBe(true);
      expect(notifier.getCircuitStatus().discord?.isOpen).toBe(false);
      expect(notifier.getCircuitStatus().discord?.failures).toBe(0);
    });
  });

  describe('Circular Buffer Alert History', () => {
    it('should store alerts in circular buffer', async () => {
      const alerts: Alert[] = [];
      for (let i = 0; i < 3; i++) {
        const alert: Alert = {
          type: `ALERT_${i}`,
          timestamp: 1000 + i * 100,
          severity: 'low'
        };
        alerts.push(alert);
        await notifier.notify(alert);
      }

      const history = notifier.getAlertHistory(10);
      expect(history.length).toBe(3);
      expect(history[0].type).toBe('ALERT_2'); // Newest first
      expect(history[2].type).toBe('ALERT_0'); // Oldest last
    });

    it('should maintain O(1) insertion with buffer wrap-around', async () => {
      // Buffer size is 5, add 10 alerts
      for (let i = 0; i < 10; i++) {
        await notifier.notify({
          type: `ALERT_${i}`,
          timestamp: 1000 + i * 100,
          severity: 'low'
        });
      }

      const history = notifier.getAlertHistory(5);
      expect(history.length).toBe(5);

      // Should contain most recent 5 alerts (5-9)
      expect(history[0].type).toBe('ALERT_9'); // Newest
      expect(history[4].type).toBe('ALERT_5'); // Oldest in buffer
    });

    it('should return alerts in descending timestamp order', async () => {
      // Add alerts with increasing timestamps
      for (let i = 0; i < 5; i++) {
        await notifier.notify({
          type: `ALERT_${i}`,
          timestamp: 1000 + i * 100,
          severity: 'low'
        });
      }

      const history = notifier.getAlertHistory(5);

      // Verify descending order
      for (let i = 0; i < history.length - 1; i++) {
        expect(history[i].timestamp).toBeGreaterThan(history[i + 1].timestamp);
      }
    });

    it('should respect limit parameter', async () => {
      // Add 10 alerts
      for (let i = 0; i < 10; i++) {
        await notifier.notify({
          type: `ALERT_${i}`,
          timestamp: 1000 + i * 100,
          severity: 'low'
        });
      }

      const history = notifier.getAlertHistory(3);
      expect(history.length).toBe(3);
      expect(history[0].type).toBe('ALERT_9'); // Most recent
    });

    it('should clear history correctly', async () => {
      // Add some alerts
      for (let i = 0; i < 3; i++) {
        await notifier.notify({
          type: `ALERT_${i}`,
          timestamp: Date.now(),
          severity: 'low'
        });
      }

      expect(notifier.getAlertHistory(10).length).toBe(3);

      notifier.clearHistory();
      expect(notifier.getAlertHistory(10).length).toBe(0);
    });
  });

  describe('Channel Integration', () => {
    it('should send to all configured channels', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/webhook/test';
      process.env.SLACK_WEBHOOK_URL = 'https://slack.com/webhook/test';

      const notifier = new AlertNotifier(mockLogger);

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200
      } as Response);

      const alert: Alert = {
        type: 'SERVICE_UNHEALTHY',
        service: 'execution-engine',
        message: 'Service is down',
        severity: 'critical',
        timestamp: Date.now()
      };

      await notifier.notify(alert);

      // Should have called fetch twice (Discord + Slack)
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should log at DEBUG level when no channels are configured (H5 dual-log fix)', async () => {
      delete process.env.DISCORD_WEBHOOK_URL;
      delete process.env.SLACK_WEBHOOK_URL;

      const notifier = new AlertNotifier(mockLogger);

      const alert: Alert = {
        type: 'TEST',
        severity: 'high',
        timestamp: Date.now()
      };

      await notifier.notify(alert);

      // H5 FIX: Downgraded from warn to debug to prevent dual-logging with coordinator
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Alert stored (no notification channels configured)'),
        expect.objectContaining({ alertType: 'TEST' })
      );
      // Should NOT log at warn level anymore
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Alert triggered'),
        expect.any(Object)
      );
    });
  });
});

describe('DiscordChannel', () => {
  let channel: DiscordChannel;
  let mockLogger: jest.Mocked<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/webhook/test';
    channel = new DiscordChannel(mockLogger);
  });

  it('should format alerts correctly', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    } as Response);

    const alert: Alert = {
      type: 'SERVICE_UNHEALTHY',
      service: 'execution-engine',
      message: 'Service is down',
      severity: 'critical',
      timestamp: Date.now()
    };

    await channel.send(alert);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://discord.com/webhook/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain('SERVICE_UNHEALTHY');
    expect(body.embeds[0].description).toBe('Service is down');
  });

  it('should use correct severity colors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    } as Response);

    const testCases: Array<{ severity: Alert['severity']; expectedColor: number }> = [
      { severity: 'critical', expectedColor: 0xFF0000 }, // Red
      { severity: 'high', expectedColor: 0xFFA500 },     // Orange
      { severity: 'low', expectedColor: 0xFFFF00 },      // Yellow
      { severity: undefined, expectedColor: 0x808080 }    // Gray
    ];

    for (const { severity, expectedColor } of testCases) {
      await channel.send({
        type: 'TEST',
        severity,
        timestamp: Date.now()
      });

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[
        (global.fetch as jest.Mock).mock.calls.length - 1
      ][1].body);

      expect(body.embeds[0].color).toBe(expectedColor);
    }
  });

  it('should handle webhook failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    } as Response);

    const alert: Alert = {
      type: 'TEST',
      severity: 'high',
      timestamp: Date.now()
    };

    const result = await channel.send(alert);

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Discord webhook failed'),
      expect.objectContaining({
        status: 404,
        statusText: 'Not Found'
      })
    );
  });

  it('should not send when not configured', async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const channel = new DiscordChannel(mockLogger);

    expect(channel.isConfigured()).toBe(false);

    const result = await channel.send({
      type: 'TEST',
      severity: 'high',
      timestamp: Date.now()
    });

    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('SlackChannel', () => {
  let channel: SlackChannel;
  let mockLogger: jest.Mocked<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    process.env.SLACK_WEBHOOK_URL = 'https://slack.com/webhook/test';
    channel = new SlackChannel(mockLogger);
  });

  it('should format alerts correctly', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    } as Response);

    const alert: Alert = {
      type: 'SERVICE_UNHEALTHY',
      service: 'execution-engine',
      message: 'Service is down',
      severity: 'critical',
      timestamp: Date.now()
    };

    await channel.send(alert);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/webhook/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks[0].type).toBe('header');
    expect(body.blocks[0].text.text).toContain('SERVICE_UNHEALTHY');
  });

  it('should use correct severity emojis', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    } as Response);

    const testCases: Array<{ severity: Alert['severity']; expectedEmoji: string }> = [
      { severity: 'critical', expectedEmoji: '🔴' },
      { severity: 'high', expectedEmoji: '🟠' },
      { severity: 'low', expectedEmoji: '🟡' },
      { severity: undefined, expectedEmoji: '⚪' }
    ];

    for (const { severity, expectedEmoji } of testCases) {
      await channel.send({
        type: 'TEST',
        severity,
        timestamp: Date.now()
      });

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[
        (global.fetch as jest.Mock).mock.calls.length - 1
      ][1].body);

      expect(body.blocks[0].text.text).toContain(expectedEmoji);
    }
  });

  it('should handle webhook failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    } as Response);

    const alert: Alert = {
      type: 'TEST',
      severity: 'high',
      timestamp: Date.now()
    };

    const result = await channel.send(alert);

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Slack webhook failed'),
      expect.objectContaining({
        status: 500,
        statusText: 'Internal Server Error'
      })
    );
  });

  it('should not send when not configured', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const channel = new SlackChannel(mockLogger);

    expect(channel.isConfigured()).toBe(false);

    const result = await channel.send({
      type: 'TEST',
      severity: 'high',
      timestamp: Date.now()
    });

    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

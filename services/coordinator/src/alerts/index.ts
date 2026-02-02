/**
 * Alerts Module
 *
 * Re-exports alert notification and cooldown management components.
 */

export {
  AlertNotifier,
  DiscordChannel,
  SlackChannel,
  type Alert,
  type AlertSeverity,
  type NotificationChannel
} from './notifier';

export {
  AlertCooldownManager,
  type CooldownDelegate,
  type CooldownManagerLogger,
  type AlertCooldownManagerConfig
} from './cooldown-manager';

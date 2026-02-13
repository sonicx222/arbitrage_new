/**
 * Subscription Module
 *
 * Exports for WebSocket and event subscription management.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * @see Finding #8 in .agent-reports/unified-detector-deep-analysis.md
 * @see Task 2.1.3 - Factory Subscription Migration
 */

export {
  SubscriptionManager,
  createSubscriptionManager,
} from './subscription-manager';

export type {
  SubscriptionManagerConfig,
  SubscriptionCallbacks,
  SubscriptionStats,
  SubscriptionResult,
} from './subscription-manager';

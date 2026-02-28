/**
 * Opportunity Publisher (re-export from shared/core)
 *
 * F4 FIX: OpportunityPublisher has been moved to @arbitrage/core/publishers
 * for use across all partition services (both dev-mode and Docker).
 * This file re-exports from shared/core for backward compatibility.
 *
 * @see @arbitrage/core/publishers/opportunity-publisher.ts (canonical source)
 * @see ADR-002: Redis Streams over Pub/Sub
 */

export {
  OpportunityPublisher,
} from '@arbitrage/core/publishers';

export type {
  OpportunityPublisherConfig,
  OpportunityPublisherStats,
} from '@arbitrage/core/publishers';

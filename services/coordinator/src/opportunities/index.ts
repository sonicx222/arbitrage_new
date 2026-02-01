/**
 * Opportunities Module
 *
 * Manages arbitrage opportunity lifecycle:
 * - Storage with size limits
 * - Duplicate detection
 * - Expiry cleanup
 * - Forwarding to execution engine
 *
 * @see R2 - Coordinator Subsystems extraction
 */

export { OpportunityRouter } from './opportunity-router';

export type {
  OpportunityRouterLogger,
  OpportunityStreamsClient,
  CircuitBreaker,
  OpportunityAlert,
  OpportunityRouterConfig,
} from './opportunity-router';

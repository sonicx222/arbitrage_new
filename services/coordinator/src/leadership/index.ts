/**
 * Leadership Election Module
 *
 * Provides distributed leadership election using Redis locks.
 *
 * @see P2-SERVICE from refactoring-roadmap.md
 * @see ADR-007: Cross-Region Failover
 */

export {
  LeadershipElectionService,
  type LeadershipElectionConfig,
  type LeadershipElectionOptions,
  type LeadershipRedisClient,
  type LeadershipAlert,
} from './leadership-election-service';

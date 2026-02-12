/**
 * Tracking Module
 *
 * Provides tracking utilities for the coordinator:
 * - Active pairs tracking with TTL and emergency eviction
 *
 * @see P1-2 - Coordinator god class extraction
 */

export { ActivePairsTracker } from './active-pairs-tracker';
export type {
  ActivePairsTrackerConfig,
  ActivePairInfo,
  ActivePairsLogger,
} from './active-pairs-tracker';

/**
 * Detector Module
 *
 * Exports for detector connection management.
 * Extracted from base-detector.ts for single-responsibility principle.
 *
 * @see ADR-002: Redis Streams Architecture
 */

// Connection manager
export {
  initializeDetectorConnections,
  disconnectDetectorConnections,
} from './detector-connection-manager';

// Types
export type {
  DetectorConnectionConfig,
  DetectorConnectionResources,
  EventFilterHandlers,
} from './types';

export {
  DEFAULT_BATCHER_CONFIG,
  DEFAULT_SWAP_FILTER_CONFIG,
} from './types';

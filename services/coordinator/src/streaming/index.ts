/**
 * Streaming Module
 *
 * Provides stream consumer management utilities:
 * - Rate limiting to prevent DoS attacks
 * - Deferred ACK with DLQ support for message safety
 * - Error tracking with alerting
 *
 * @see R2 - Coordinator Subsystems extraction
 * @see ADR-002 - Redis Streams over Pub/Sub
 */

// Rate limiter
export {
  StreamRateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from './rate-limiter';
export type { RateLimiterConfig } from './rate-limiter';

// Stream consumer manager
export {
  StreamConsumerManager,
} from './stream-consumer-manager';
export type {
  StreamManagerLogger,
  StreamMessage,
  ConsumerGroupConfig,
  StreamsClient,
  StreamAlert,
  StreamConsumerManagerConfig,
} from './stream-consumer-manager';

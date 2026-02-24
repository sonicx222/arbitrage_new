/**
 * P2-17 FIX: Shared dual-publish utility for Redis Streams + Pub/Sub.
 *
 * Follows the ADR-002 migration pattern: publish to Redis Streams (primary)
 * and Pub/Sub (secondary/fallback) for backwards compatibility.
 * Previously duplicated across dead-letter-queue.ts, graceful-degradation.ts,
 * and self-healing-manager.ts (~23 lines each = 69 lines total).
 */

import { createLogger } from '../logger';
import type { RedisStreamsClient } from '../redis/streams';

const logger = createLogger('dual-publish');

/**
 * Publish a message to both Redis Streams and Pub/Sub channels.
 *
 * @param streamsClient - Redis Streams client (may be null if not initialized)
 * @param redis - Resolved Redis client for Pub/Sub
 * @param streamName - Redis Stream name (e.g., 'stream:failure-events')
 * @param pubsubChannel - Pub/Sub channel name (e.g., 'system:failures')
 * @param message - Message payload to publish
 */
export async function dualPublish(
  streamsClient: RedisStreamsClient | null,
  redis: { publish: (channel: string, message: any) => Promise<any> },
  streamName: string,
  pubsubChannel: string,
  message: Record<string, any>
): Promise<void> {
  // Primary: Redis Streams (ADR-002 compliant)
  if (streamsClient) {
    try {
      await streamsClient.xadd(streamName, message);
    } catch (error) {
      logger.error('Failed to publish to Redis Stream', { error, streamName });
    }
  }

  // Secondary: Pub/Sub (backwards compatibility)
  try {
    await redis.publish(pubsubChannel, message as any);
  } catch (error) {
    logger.error('Failed to publish to Pub/Sub', { error, pubsubChannel });
  }
}

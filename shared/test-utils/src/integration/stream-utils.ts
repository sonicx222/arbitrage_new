/**
 * Redis Stream Testing Utilities
 */

import { IsolatedRedisClient } from './redis-pool';
import { getErrorMessage } from '@arbitrage/core/resilience';

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

export async function waitForMessages(
  redis: IsolatedRedisClient,
  stream: string,
  count: number,
  options: { timeout?: number; initialInterval?: number; maxInterval?: number } = {}
): Promise<StreamMessage[]> {
  const { timeout = 10000, initialInterval = 10, maxInterval = 100 } = options;
  const startTime = Date.now();
  const messages: StreamMessage[] = [];
  const seenIds = new Set<string>(); // Track seen message IDs to prevent duplicates
  let lastId = '0'; // Track last read position for incremental reads
  let pollInterval = initialInterval;

  while (messages.length < count && Date.now() - startTime < timeout) {
    // Read from lastId position to avoid re-reading same messages
    const result = await redis.xread('COUNT', count - messages.length, 'STREAMS', stream, lastId) as
      | [string, [string, string[]][]][]
      | null;

    if (result && result.length > 0) {
      const [, streamMessages] = result[0];
      for (const [id, fields] of streamMessages) {
        // Only process messages we haven't seen before
        if (!seenIds.has(id)) {
          seenIds.add(id);
          lastId = id; // Update read position
          const parsedFields: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            parsedFields[fields[i]] = fields[i + 1];
          }
          messages.push({ id, fields: parsedFields });
        }
      }
    }

    if (messages.length < count) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollInterval = Math.min(pollInterval * 2, maxInterval);
    }
  }

  if (messages.length < count) {
    throw new Error(`Timeout waiting for ${count} messages, only received ${messages.length}`);
  }

  return messages;
}

export interface PublishBatchOptions {
  /** Whether to throw an error if some messages fail to publish (default: true) */
  throwOnPartialFailure?: boolean;
}

export interface PublishBatchResult {
  /** IDs of successfully published messages */
  ids: string[];
  /** Number of messages that failed to publish */
  failureCount: number;
  /** Error messages for failed publishes */
  errors: string[];
}

export async function publishBatch(
  redis: IsolatedRedisClient,
  stream: string,
  messages: Record<string, string | number>[],
  options: PublishBatchOptions = {}
): Promise<string[]> {
  const { throwOnPartialFailure = true } = options;
  const ids: string[] = [];
  const errors: string[] = [];
  const client = redis.getClient();
  const pipeline = client.pipeline();

  for (const msg of messages) {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(msg)) {
      fields.push(key, String(value));
    }
    pipeline.xadd(stream, '*', ...fields);
  }

  const results = await pipeline.exec();
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, result] = results[i];
      if (err) {
        errors.push(`Message ${i}: ${err.message}`);
      } else if (result) {
        ids.push(result as string);
      }
    }
  }

  // Throw error if partial failure occurred and throwOnPartialFailure is enabled
  if (throwOnPartialFailure && errors.length > 0) {
    throw new Error(
      `${errors.length}/${messages.length} messages failed to publish to stream '${stream}': ${errors[0]}`
    );
  }

  return ids;
}

/**
 * Publish batch with detailed result including failure information
 */
export async function publishBatchWithResult(
  redis: IsolatedRedisClient,
  stream: string,
  messages: Record<string, string | number>[]
): Promise<PublishBatchResult> {
  const ids: string[] = [];
  const errors: string[] = [];
  const client = redis.getClient();
  const pipeline = client.pipeline();

  for (const msg of messages) {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(msg)) {
      fields.push(key, String(value));
    }
    pipeline.xadd(stream, '*', ...fields);
  }

  const results = await pipeline.exec();
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, result] = results[i];
      if (err) {
        errors.push(`Message ${i}: ${err.message}`);
      } else if (result) {
        ids.push(result as string);
      }
    }
  }

  return {
    ids,
    failureCount: errors.length,
    errors,
  };
}

export class StreamCollector {
  private messages: StreamMessage[] = [];
  private running = false;
  private pollPromise: Promise<void> | null = null;

  constructor(
    private redis: IsolatedRedisClient,
    private stream: string,
    private group: string,
    private consumer: string
  ) {}

  async start(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (e: unknown) {
      const errorMessage = getErrorMessage(e);
      if (!errorMessage.includes('BUSYGROUP')) throw e;
    }

    this.running = true;
    this.pollPromise = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  getMessages(): StreamMessage[] {
    return [...this.messages];
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.xreadgroup(
          'GROUP', this.group, this.consumer,
          'COUNT', '10',
          'BLOCK', '100',
          'STREAMS', this.stream, '>'
        ) as [string, [string, string[]][]][] | null;

        if (result && result.length > 0) {
          const [, streamMessages] = result[0];
          for (const [id, fields] of streamMessages) {
            const parsedFields: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              parsedFields[fields[i]] = fields[i + 1];
            }
            this.messages.push({ id, fields: parsedFields });
            await this.redis.xack(this.stream, this.group, id);
          }
        }
      } catch (e) {
        if (this.running) {
          console.warn('Stream collector error:', e);
        }
      }
    }
  }
}

export function createStreamCollector(
  redis: IsolatedRedisClient,
  stream: string,
  group: string,
  consumer: string
): StreamCollector {
  return new StreamCollector(redis, stream, group, consumer);
}

export async function assertStreamContains(
  redis: IsolatedRedisClient,
  stream: string,
  predicates: ((msg: StreamMessage) => boolean)[],
  options: { timeout?: number } = {}
): Promise<void> {
  const messages = await waitForMessages(redis, stream, predicates.length, options);

  for (let i = 0; i < predicates.length; i++) {
    const predicate = predicates[i];
    const matchingMessage = messages.find(predicate);
    if (!matchingMessage) {
      throw new Error(`No message matching predicate at index ${i}`);
    }
  }
}

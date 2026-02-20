/**
 * Thin coordinator forwarder for pipeline integration tests.
 * Mimics OpportunityRouter: reads from stream:opportunities,
 * validates, serializes with coordinator metadata, and forwards
 * to stream:execution-requests.
 */
import Redis from 'ioredis';
import { RedisStreams } from '@arbitrage/types';

export class TestCoordinatorForwarder {
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private readonly groupName = 'test-coordinator-group';
  private readonly consumerName: string;

  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string = `test-coordinator-${Date.now()}`
  ) {
    this.consumerName = this.instanceId;
  }

  async createConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        '0',
        'MKSTREAM'
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) throw e;
    }
  }

  async start(): Promise<void> {
    await this.createConsumerGroup();
    this.running = true;
    this.pollPromise = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.xreadgroup(
          'GROUP', this.groupName, this.consumerName,
          'COUNT', '10',
          'BLOCK', '100',
          'STREAMS', RedisStreams.OPPORTUNITIES, '>'
        ) as [string, [string, string[]][]][] | null;

        if (result && result.length > 0) {
          const [, messages] = result[0];
          for (const [messageId, fields] of messages) {
            await this.forwardMessage(messageId, fields);
          }
        }
      } catch (e) {
        if (this.running) {
          // Brief pause on error to avoid tight loop
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }
  }

  private async forwardMessage(
    sourceMessageId: string,
    fields: string[]
  ): Promise<void> {
    // Parse fields array into object
    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      fieldObj[fields[i]] = fields[i + 1];
    }

    // Validate minimum required field
    const data = fieldObj.data;
    if (!data) {
      // ACK invalid messages (no DLQ in test helper)
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    // Enrich with coordinator metadata (mimics OpportunityRouter)
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    if (!parsed.id) {
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    parsed.forwardedBy = this.instanceId;
    parsed.forwardedAt = Date.now();
    if (parsed.pipelineTimestamps && typeof parsed.pipelineTimestamps === 'object') {
      (parsed.pipelineTimestamps as Record<string, unknown>).coordinatorAt = Date.now();
    }

    // Forward to execution-requests stream
    await this.redis.xadd(
      RedisStreams.EXECUTION_REQUESTS,
      '*',
      'data', JSON.stringify(parsed)
    );

    // ACK source message
    await this.redis.xack(
      RedisStreams.OPPORTUNITIES,
      this.groupName,
      sourceMessageId
    );
  }
}

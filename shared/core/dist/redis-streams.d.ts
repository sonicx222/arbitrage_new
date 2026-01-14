/**
 * Redis Streams Client
 *
 * High-performance Redis Streams implementation for event-driven arbitrage system.
 * Provides persistent message queues with consumer groups, batching, and backpressure.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 *
 * Key Features:
 * - XADD for publishing messages with automatic ID generation
 * - XREAD/XREADGROUP for consuming messages
 * - Consumer groups for distributed processing
 * - Batching for reduced Redis command usage (50:1 ratio target)
 * - Automatic stream trimming to manage memory
 */
export interface StreamMessage<T = Record<string, unknown>> {
    id: string;
    data: T;
}
export interface ConsumerGroupConfig {
    streamName: string;
    groupName: string;
    consumerName: string;
    startId?: string;
}
export interface XReadOptions {
    count?: number;
    block?: number;
    /**
     * P1-8 FIX: Maximum block time in milliseconds to prevent indefinite blocking.
     * If block > maxBlockMs, it will be capped to maxBlockMs.
     * Default: 30000ms (30 seconds). Set to 0 to disable cap (not recommended).
     */
    maxBlockMs?: number;
}
export interface XReadGroupOptions extends XReadOptions {
    startId?: string;
    noAck?: boolean;
}
export interface XTrimOptions {
    maxLen?: number;
    minId?: string;
    exact?: boolean;
}
export interface XAddOptions {
    retry?: boolean;
    maxRetries?: number;
    /** P1-3 fix: Maximum stream length to prevent unbounded growth */
    maxLen?: number;
    /** Use approximate (~) trimming for better performance (default: true) */
    approximate?: boolean;
}
export interface StreamInfo {
    length: number;
    radixTreeKeys: number;
    radixTreeNodes: number;
    lastGeneratedId: string;
    groups: number;
    firstEntry?: StreamMessage;
    lastEntry?: StreamMessage;
}
export interface PendingInfo {
    total: number;
    smallestId: string;
    largestId: string;
    consumers: Array<{
        name: string;
        pending: number;
    }>;
}
export interface BatcherConfig {
    maxBatchSize: number;
    maxWaitMs: number;
    compress?: boolean;
}
export interface BatcherStats {
    currentQueueSize: number;
    totalMessagesQueued: number;
    batchesSent: number;
    totalMessagesSent: number;
    compressionRatio: number;
    averageBatchSize: number;
}
export declare class StreamBatcher<T = Record<string, unknown>> {
    private client;
    private streamName;
    private config;
    private logger;
    private queue;
    private timer;
    private flushing;
    private flushLock;
    private destroyed;
    private stats;
    constructor(client: RedisStreamsClient, streamName: string, config: BatcherConfig, logger: any);
    add(message: T): void;
    flush(): Promise<void>;
    getStats(): BatcherStats;
    destroy(): Promise<void>;
}
export declare class RedisStreamsClient {
    private client;
    private logger;
    private batchers;
    static readonly STREAMS: {
        readonly PRICE_UPDATES: "stream:price-updates";
        readonly SWAP_EVENTS: "stream:swap-events";
        readonly OPPORTUNITIES: "stream:opportunities";
        readonly WHALE_ALERTS: "stream:whale-alerts";
        readonly VOLUME_AGGREGATES: "stream:volume-aggregates";
        readonly HEALTH: "stream:health";
    };
    /**
     * P1-3 fix: Recommended MAXLEN values to prevent unbounded stream growth.
     * These are approximate (~) limits for performance.
     */
    static readonly STREAM_MAX_LENGTHS: Record<string, number>;
    constructor(url: string, password?: string);
    private setupEventHandlers;
    xadd<T = Record<string, unknown>>(streamName: string, message: T, id?: string, options?: XAddOptions): Promise<string>;
    /**
     * P1-3 fix: Add message with automatic MAXLEN based on stream type.
     * Uses recommended limits from STREAM_MAX_LENGTHS.
     */
    xaddWithLimit<T = Record<string, unknown>>(streamName: string, message: T, options?: Omit<XAddOptions, 'maxLen'>): Promise<string>;
    xread(streamName: string, lastId: string, options?: XReadOptions): Promise<StreamMessage[]>;
    createConsumerGroup(config: ConsumerGroupConfig): Promise<void>;
    xreadgroup(config: ConsumerGroupConfig, options?: XReadGroupOptions): Promise<StreamMessage[]>;
    xack(streamName: string, groupName: string, ...messageIds: string[]): Promise<number>;
    xlen(streamName: string): Promise<number>;
    xinfo(streamName: string): Promise<StreamInfo>;
    xpending(streamName: string, groupName: string): Promise<PendingInfo>;
    xtrim(streamName: string, options: XTrimOptions): Promise<number>;
    createBatcher<T = Record<string, unknown>>(streamName: string, config: BatcherConfig): StreamBatcher<T>;
    ping(): Promise<boolean>;
    disconnect(): Promise<void>;
    private validateStreamName;
    private parseStreamResult;
    private parseStreamInfo;
    private sleep;
}
export interface StreamConsumerConfig {
    /** Consumer group configuration */
    config: ConsumerGroupConfig;
    /** Handler function for each message */
    handler: (message: StreamMessage) => Promise<void>;
    /** Number of messages to fetch per read (default: 10) */
    batchSize?: number;
    /** Block time in ms (default: 1000, 0 = non-blocking) */
    blockMs?: number;
    /** Whether to auto-acknowledge after handler completes (default: true) */
    autoAck?: boolean;
    /** Logger instance for error logging */
    logger?: {
        error: (msg: string, ctx?: any) => void;
        debug?: (msg: string, ctx?: any) => void;
    };
}
export interface StreamConsumerStats {
    messagesProcessed: number;
    messagesFailed: number;
    lastProcessedAt: number | null;
    isRunning: boolean;
}
/**
 * P2-1 FIX: Reusable stream consumer that encapsulates the common pattern of:
 * 1. Reading from consumer group
 * 2. Processing each message with a handler
 * 3. Acknowledging processed messages
 * 4. Handling errors gracefully
 *
 * Usage:
 * ```ts
 * const consumer = new StreamConsumer(streamsClient, {
 *   config: { streamName: 'stream:opportunities', groupName: 'coordinator', consumerName: 'worker-1' },
 *   handler: async (msg) => { console.log(msg.data); },
 *   batchSize: 10,
 *   blockMs: 1000
 * });
 * consumer.start();
 * // ... later
 * await consumer.stop();
 * ```
 */
export declare class StreamConsumer {
    private client;
    private config;
    private running;
    private pollTimer;
    private stats;
    constructor(client: RedisStreamsClient, config: StreamConsumerConfig);
    /**
     * Start consuming messages from the stream.
     * Runs in a polling loop until stop() is called.
     */
    start(): void;
    /**
     * Stop consuming messages.
     * Waits for any in-flight processing to complete.
     */
    stop(): Promise<void>;
    /**
     * Get consumer statistics.
     */
    getStats(): StreamConsumerStats;
    private poll;
}
export declare function getRedisStreamsClient(url?: string, password?: string): Promise<RedisStreamsClient>;
export declare function resetRedisStreamsInstance(): Promise<void>;
//# sourceMappingURL=redis-streams.d.ts.map
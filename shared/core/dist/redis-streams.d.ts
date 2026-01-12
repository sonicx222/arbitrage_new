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
export declare function getRedisStreamsClient(url?: string, password?: string): Promise<RedisStreamsClient>;
export declare function resetRedisStreamsInstance(): Promise<void>;
//# sourceMappingURL=redis-streams.d.ts.map
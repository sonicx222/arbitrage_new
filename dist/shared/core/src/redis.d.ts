import { MessageEvent, ServiceHealth, PerformanceMetrics } from '../../types';
export declare class RedisClient {
    private client;
    private pubClient;
    private subClient;
    private logger;
    constructor(url: string, password?: string);
    private parseHost;
    private parsePort;
    private setupEventHandlers;
    publish(channel: string, message: MessageEvent): Promise<number>;
    private subscriptions;
    subscribe(channel: string, callback: (message: MessageEvent) => void): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    set(key: string, value: any, ttl?: number): Promise<void>;
    get<T = any>(key: string): Promise<T | null>;
    del(key: string): Promise<number>;
    exists(key: string): Promise<boolean>;
    hset(key: string, field: string, value: any): Promise<number>;
    hget<T = any>(key: string, field: string): Promise<T | null>;
    hgetall<T = any>(key: string): Promise<Record<string, T> | null>;
    updateServiceHealth(serviceName: string, health: ServiceHealth): Promise<void>;
    getServiceHealth(serviceName: string): Promise<ServiceHealth | null>;
    getAllServiceHealth(): Promise<Record<string, ServiceHealth>>;
    recordMetrics(serviceName: string, metrics: PerformanceMetrics): Promise<void>;
    getRecentMetrics(serviceName: string, count?: number): Promise<PerformanceMetrics[]>;
    disconnect(): Promise<void>;
    ping(): Promise<boolean>;
}
export declare function getRedisClient(url?: string, password?: string): Promise<RedisClient>;
export declare function getRedisClientSync(): RedisClient | null;
export declare function checkRedisHealth(url?: string, password?: string): Promise<boolean>;
export declare function resetRedisInstance(): void;
//# sourceMappingURL=redis.d.ts.map
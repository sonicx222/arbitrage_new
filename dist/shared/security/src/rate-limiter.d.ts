export interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
    keyPrefix?: string;
    skipSuccessfulRequests?: boolean;
    skipFailedRequests?: boolean;
}
export interface RateLimitInfo {
    remaining: number;
    resetTime: number;
    total: number;
    exceeded: boolean;
}
export declare class RateLimiter {
    private redis;
    private config;
    private keyPrefix;
    constructor(config: RateLimitConfig);
    checkLimit(identifier: string, additionalConfig?: Partial<RateLimitConfig>): Promise<RateLimitInfo>;
    resetLimit(identifier: string): Promise<void>;
    middleware(config?: Partial<RateLimitConfig>): (req: any, res: any, next: any) => Promise<any>;
    private getIdentifier;
    getLimitStatus(identifier: string): Promise<RateLimitInfo | null>;
    cleanup(maxAge?: number): Promise<void>;
}
export declare function createApiRateLimiter(): RateLimiter;
export declare function createArbitrageRateLimiter(): RateLimiter;
export declare function createAuthRateLimiter(): RateLimiter;
export declare function createCriticalRateLimiter(): RateLimiter;
//# sourceMappingURL=rate-limiter.d.ts.map
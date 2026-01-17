import { RedisClient } from './redis';
import { Logger } from 'winston';
import { ArbitrageOpportunity, ExecutionResult, IArbitrageRepository, IExecutionRepository } from './domain-models';
export declare class RedisArbitrageRepository implements IArbitrageRepository {
    private readonly redis;
    private readonly logger;
    private readonly OPPORTUNITIES_KEY;
    private readonly EXPIRY_SECONDS;
    constructor(redis: RedisClient, logger: Logger);
    save(opportunity: ArbitrageOpportunity): Promise<void>;
    findById(id: string): Promise<ArbitrageOpportunity | null>;
    findActive(): Promise<ArbitrageOpportunity[]>;
    findByChain(chain: any): Promise<ArbitrageOpportunity[]>;
    updateStatus(id: string, status: 'active' | 'executed' | 'expired'): Promise<void>;
    deleteExpired(olderThan: Date): Promise<number>;
}
export declare class RedisExecutionRepository implements IExecutionRepository {
    private readonly redis;
    private readonly logger;
    private readonly EXECUTIONS_KEY;
    private readonly RETENTION_DAYS;
    constructor(redis: RedisClient, logger: Logger);
    save(result: ExecutionResult): Promise<void>;
    getByOpportunityId(opportunityId: string): Promise<ExecutionResult | null>;
    getRecentExecutions(limit?: number): Promise<ExecutionResult[]>;
    getSuccessRate(timeRangeMs?: number): Promise<number>;
}
export declare function createArbitrageRepository(redis: RedisClient, logger: Logger): IArbitrageRepository;
export declare function createExecutionRepository(redis: RedisClient, logger: Logger): IExecutionRepository;
//# sourceMappingURL=repositories.d.ts.map
// Repository Pattern Implementation
// Clean separation of data access logic

import { RedisClient } from './redis';
import { StructuredLogger } from './logger';
import {
  ArbitrageOpportunity,
  ExecutionResult,
  IArbitrageRepository,
  IExecutionRepository,
  ArbitrageError
} from './domain-models';

export class RedisArbitrageRepository implements IArbitrageRepository {
  private readonly OPPORTUNITIES_KEY = 'arbitrage:opportunities';
  private readonly EXPIRY_SECONDS = 300; // 5 minutes

  constructor(
    private readonly redis: RedisClient,
    private readonly logger: StructuredLogger
  ) {}

  async save(opportunity: ArbitrageOpportunity): Promise<void> {
    try {
      const key = `${this.OPPORTUNITIES_KEY}:${opportunity.id}`;
      const data = JSON.stringify({
        ...opportunity,
        timestamp: opportunity.timestamp.toISOString()
      });

      await this.redis.setex(key, this.EXPIRY_SECONDS, data);

      // Add to active opportunities set
      await this.redis.sadd(`${this.OPPORTUNITIES_KEY}:active`, opportunity.id);

      this.logger.info('opportunity_saved', {
        opportunityId: opportunity.id,
        pair: `${opportunity.pair.baseToken.symbol}/${opportunity.pair.quoteToken.symbol}`,
        profit: opportunity.profitPercentage,
        chain: opportunity.chain.name
      });
    } catch (error) {
      this.logger.error('opportunity_save_failed', {
        opportunityId: opportunity.id,
        error: error.message
      });
      throw new ArbitrageError(
        'REPOSITORY_SAVE_FAILED',
        `Failed to save arbitrage opportunity: ${error.message}`,
        { opportunityId: opportunity.id, error }
      );
    }
  }

  async findById(id: string): Promise<ArbitrageOpportunity | null> {
    try {
      const key = `${this.OPPORTUNITIES_KEY}:${id}`;
      const data = await this.redis.get(key);

      if (!data) return null;

      const parsed = JSON.parse(data);
      return {
        ...parsed,
        timestamp: new Date(parsed.timestamp)
      };
    } catch (error) {
      this.logger.error('opportunity_find_failed', {
        opportunityId: id,
        error: error.message
      });
      return null;
    }
  }

  async findActive(): Promise<ArbitrageOpportunity[]> {
    try {
      const activeIds = await this.redis.smembers(`${this.OPPORTUNITIES_KEY}:active`);
      const opportunities: ArbitrageOpportunity[] = [];

      for (const id of activeIds) {
        const opportunity = await this.findById(id);
        if (opportunity) {
          opportunities.push(opportunity);
        }
      }

      // Sort by profit percentage (highest first)
      opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

      return opportunities;
    } catch (error) {
      this.logger.error('active_opportunities_find_failed', {
        error: error.message
      });
      return [];
    }
  }

  async findByChain(chain: any): Promise<ArbitrageOpportunity[]> {
    try {
      const activeOpportunities = await this.findActive();
      return activeOpportunities.filter(opp => opp.chain.id === chain.id);
    } catch (error) {
      this.logger.error('chain_opportunities_find_failed', {
        chainId: chain.id,
        error: error.message
      });
      return [];
    }
  }

  async updateStatus(id: string, status: 'active' | 'executed' | 'expired'): Promise<void> {
    try {
      if (status !== 'active') {
        await this.redis.srem(`${this.OPPORTUNITIES_KEY}:active`, id);
      }

      // Add to appropriate set
      if (status === 'executed') {
        await this.redis.sadd(`${this.OPPORTUNITIES_KEY}:executed`, id);
      } else if (status === 'expired') {
        await this.redis.sadd(`${this.OPPORTUNITIES_KEY}:expired`, id);
      }

      this.logger.info('opportunity_status_updated', {
        opportunityId: id,
        status
      });
    } catch (error) {
      this.logger.error('opportunity_status_update_failed', {
        opportunityId: id,
        status,
        error: error.message
      });
    }
  }

  async deleteExpired(olderThan: Date): Promise<number> {
    try {
      const activeIds = await this.redis.smembers(`${this.OPPORTUNITIES_KEY}:active`);
      let deletedCount = 0;

      for (const id of activeIds) {
        const opportunity = await this.findById(id);
        if (opportunity && opportunity.timestamp < olderThan) {
          await this.redis.del(`${this.OPPORTUNITIES_KEY}:${id}`);
          await this.redis.srem(`${this.OPPORTUNITIES_KEY}:active`, id);
          await this.redis.sadd(`${this.OPPORTUNITIES_KEY}:expired`, id);
          deletedCount++;
        }
      }

      this.logger.info('expired_opportunities_cleaned', {
        deletedCount,
        olderThan: olderThan.toISOString()
      });

      return deletedCount;
    } catch (error) {
      this.logger.error('expired_opportunities_cleanup_failed', {
        olderThan: olderThan.toISOString(),
        error: error.message
      });
      return 0;
    }
  }
}

export class RedisExecutionRepository implements IExecutionRepository {
  private readonly EXECUTIONS_KEY = 'arbitrage:executions';
  private readonly RETENTION_DAYS = 30;

  constructor(
    private readonly redis: RedisClient,
    private readonly logger: StructuredLogger
  ) {}

  async save(result: ExecutionResult): Promise<void> {
    try {
      const key = `${this.EXECUTIONS_KEY}:${result.opportunityId}`;
      const data = JSON.stringify({
        ...result,
        executedAt: result.executedAt.toISOString()
      });

      // Store with expiration
      const expirySeconds = this.RETENTION_DAYS * 24 * 60 * 60;
      await this.redis.setex(key, expirySeconds, data);

      // Add to executions list for analytics
      const listKey = `${this.EXECUTIONS_KEY}:list`;
      await this.redis.lpush(listKey, result.opportunityId);
      await this.redis.ltrim(listKey, 0, 999); // Keep last 1000 executions

      this.logger.info('execution_result_saved', {
        opportunityId: result.opportunityId,
        success: result.success,
        profit: result.actualProfit,
        gasUsed: result.gasUsed
      });
    } catch (error) {
      this.logger.error('execution_save_failed', {
        opportunityId: result.opportunityId,
        error: error.message
      });
      throw new ArbitrageError(
        'EXECUTION_SAVE_FAILED',
        `Failed to save execution result: ${error.message}`,
        { opportunityId: result.opportunityId, error }
      );
    }
  }

  async getByOpportunityId(opportunityId: string): Promise<ExecutionResult | null> {
    try {
      const key = `${this.EXECUTIONS_KEY}:${opportunityId}`;
      const data = await this.redis.get(key);

      if (!data) return null;

      const parsed = JSON.parse(data);
      return {
        ...parsed,
        executedAt: new Date(parsed.executedAt)
      };
    } catch (error) {
      this.logger.error('execution_find_failed', {
        opportunityId,
        error: error.message
      });
      return null;
    }
  }

  async getRecentExecutions(limit: number = 50): Promise<ExecutionResult[]> {
    try {
      const listKey = `${this.EXECUTIONS_KEY}:list`;
      const opportunityIds = await this.redis.lrange(listKey, 0, limit - 1);
      const executions: ExecutionResult[] = [];

      for (const id of opportunityIds) {
        const execution = await this.getByOpportunityId(id);
        if (execution) {
          executions.push(execution);
        }
      }

      return executions;
    } catch (error) {
      this.logger.error('recent_executions_fetch_failed', {
        limit,
        error: error.message
      });
      return [];
    }
  }

  async getSuccessRate(timeRangeMs: number = 3600000): Promise<number> { // 1 hour default
    try {
      const recentExecutions = await this.getRecentExecutions(1000);
      const cutoffTime = Date.now() - timeRangeMs;

      const relevantExecutions = recentExecutions.filter(
        exec => exec.executedAt.getTime() > cutoffTime
      );

      if (relevantExecutions.length === 0) return 0;

      const successful = relevantExecutions.filter(exec => exec.success).length;
      return successful / relevantExecutions.length;
    } catch (error) {
      this.logger.error('success_rate_calculation_failed', {
        timeRangeMs,
        error: error.message
      });
      return 0;
    }
  }
}

// Factory functions for repository creation
export function createArbitrageRepository(redis: RedisClient, logger: StructuredLogger): IArbitrageRepository {
  return new RedisArbitrageRepository(redis, logger);
}

export function createExecutionRepository(redis: RedisClient, logger: StructuredLogger): IExecutionRepository {
  return new RedisExecutionRepository(redis, logger);
}
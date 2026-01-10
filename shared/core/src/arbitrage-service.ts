// Refactored Arbitrage Service - Clean Architecture Example
// Demonstrates proper separation of concerns and dependency injection

import { EventEmitter } from 'events';
import {
  ArbitrageOpportunity,
  ExecutionResult,
  MarketEvent,
  ArbitrageConfig,
  IArbitrageRepository,
  IExecutionRepository,
  IArbitrageDetector,
  IArbitrageExecutor,
  ArbitrageError,
  StructuredLogger
} from './domain-models';

export interface ArbitrageServiceConfig {
  maxConcurrentExecutions: number;
  executionTimeout: number;
  opportunityExpiry: number; // seconds
  cleanupInterval: number; // milliseconds
}

export class ArbitrageService extends EventEmitter {
  private readonly activeExecutions = new Set<string>();
  private readonly opportunityTimers = new Map<string, NodeJS.Timeout>();
  private cleanupTimer?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    private readonly config: ArbitrageServiceConfig,
    private readonly logger: StructuredLogger,
    private readonly opportunityRepo: IArbitrageRepository,
    private readonly executionRepo: IExecutionRepository,
    private readonly detectors: IArbitrageDetector[],
    private readonly executor: IArbitrageExecutor
  ) {
    super();
    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.logger.info('arbitrage_service_starting', {
      detectors: this.detectors.length,
      maxConcurrentExecutions: this.config.maxConcurrentExecutions
    });

    // Start all detectors
    await Promise.all(
      this.detectors.map(detector => detector.start())
    );

    // Start cleanup process
    this.startCleanupProcess();

    this.isRunning = true;
    this.emit('started');

    this.logger.info('arbitrage_service_started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('arbitrage_service_stopping');

    // Stop cleanup process
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Clear all opportunity timers
    for (const timer of this.opportunityTimers.values()) {
      clearTimeout(timer);
    }
    this.opportunityTimers.clear();

    // Wait for active executions to complete
    if (this.activeExecutions.size > 0) {
      this.logger.info('waiting_for_active_executions', {
        count: this.activeExecutions.size
      });

      // Wait up to 30 seconds for executions to complete
      const timeout = Date.now() + 30000;
      while (this.activeExecutions.size > 0 && Date.now() < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.activeExecutions.size > 0) {
        this.logger.warn('force_stopping_with_active_executions', {
          remaining: this.activeExecutions.size
        });
      }
    }

    // Stop all detectors
    await Promise.all(
      this.detectors.map(detector => detector.stop())
    );

    this.isRunning = false;
    this.emit('stopped');

    this.logger.info('arbitrage_service_stopped');
  }

  async processMarketEvent(event: MarketEvent): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Distribute event to all detectors
      await Promise.all(
        this.detectors.map(detector => detector.processEvent(event))
      );

      // Check for new opportunities
      await this.checkAndExecuteOpportunities();
    } catch (error) {
      this.logger.error('market_event_processing_failed', {
        eventType: event.type,
        eventId: event.id,
        error: error.message
      });
    }
  }

  private async checkAndExecuteOpportunities(): Promise<void> {
    if (this.activeExecutions.size >= this.config.maxConcurrentExecutions) {
      return; // At capacity
    }

    try {
      const opportunities = await this.opportunityRepo.findActive();

      // Sort by profit (highest first)
      opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

      for (const opportunity of opportunities) {
        if (this.activeExecutions.size >= this.config.maxConcurrentExecutions) {
          break; // Hit concurrency limit
        }

        if (this.activeExecutions.has(opportunity.id)) {
          continue; // Already executing
        }

        // Validate opportunity is still viable
        if (!(await this.isOpportunityViable(opportunity))) {
          await this.opportunityRepo.updateStatus(opportunity.id, 'expired');
          continue;
        }

        // Execute in background
        this.executeOpportunity(opportunity);
      }
    } catch (error) {
      this.logger.error('opportunity_check_failed', {
        error: error.message
      });
    }
  }

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const executionId = opportunity.id;

    if (this.activeExecutions.has(executionId)) {
      return; // Already executing
    }

    this.activeExecutions.add(executionId);

    try {
      this.logger.info('opportunity_execution_started', {
        opportunityId: executionId,
        profit: opportunity.profitPercentage,
        pair: `${opportunity.pair.baseToken.symbol}/${opportunity.pair.quoteToken.symbol}`
      });

      // Set execution timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new ArbitrageError(
            'EXECUTION_TIMEOUT',
            `Execution timed out after ${this.config.executionTimeout}ms`,
            { opportunityId: executionId },
            false
          ));
        }, this.config.executionTimeout);
      });

      // Execute with timeout
      const executionPromise = this.executor.execute(opportunity);
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Save execution result
      await this.executionRepo.save(result);

      // Update opportunity status
      await this.opportunityRepo.updateStatus(executionId, 'executed');

      // Emit success event
      this.emit('opportunityExecuted', result);

      this.logger.info('opportunity_execution_completed', {
        opportunityId: executionId,
        success: result.success,
        profit: result.actualProfit,
        gasUsed: result.gasUsed
      });

    } catch (error) {
      const executionError = error instanceof ArbitrageError ? error : new ArbitrageError(
        'EXECUTION_FAILED',
        `Unexpected execution error: ${error.message}`,
        { opportunityId: executionId, originalError: error },
        false
      );

      // Create failure result
      const failureResult: ExecutionResult = {
        opportunityId: executionId,
        success: false,
        executedAt: new Date(),
        gasUsed: 0,
        gasPrice: 0,
        actualProfit: '0',
        error: {
          type: 'execution',
          message: executionError.message,
          details: executionError.details,
          recoverable: executionError.recoverable
        },
        metadata: {
          executionTime: 0,
          retryCount: 0,
          flashLoanUsed: false,
          gasStrategy: 'normal'
        }
      };

      try {
        await this.executionRepo.save(failureResult);
        await this.opportunityRepo.updateStatus(executionId, 'expired');
      } catch (saveError) {
        this.logger.error('execution_result_save_failed', {
          opportunityId: executionId,
          saveError: saveError.message
        });
      }

      this.emit('opportunityFailed', failureResult);

      this.logger.error('opportunity_execution_failed', {
        opportunityId: executionId,
        error: executionError.message,
        recoverable: executionError.recoverable
      });

    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  private async isOpportunityViable(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      // Check if opportunity hasn't expired
      const age = Date.now() - opportunity.timestamp.getTime();
      if (age > this.config.opportunityExpiry * 1000) {
        return false;
      }

      // Validate with executor
      return await this.executor.validateExecution(opportunity);
    } catch (error) {
      this.logger.warn('opportunity_validation_failed', {
        opportunityId: opportunity.id,
        error: error.message
      });
      return false;
    }
  }

  private setupEventHandlers(): void {
    // Listen to detector events
    this.detectors.forEach((detector, index) => {
      detector.on('opportunityDetected', (opportunity: ArbitrageOpportunity) => {
        this.handleOpportunityDetected(opportunity, index);
      });
    });
  }

  private async handleOpportunityDetected(opportunity: ArbitrageOpportunity, detectorIndex: number): Promise<void> {
    try {
      // Save opportunity
      await this.opportunityRepo.save(opportunity);

      // Set expiry timer
      const timer = setTimeout(async () => {
        try {
          await this.opportunityRepo.updateStatus(opportunity.id, 'expired');
          this.opportunityTimers.delete(opportunity.id);
        } catch (error) {
          this.logger.error('opportunity_expiry_failed', {
            opportunityId: opportunity.id,
            error: error.message
          });
        }
      }, this.config.opportunityExpiry * 1000);

      this.opportunityTimers.set(opportunity.id, timer);

      this.emit('opportunityDetected', opportunity);

      this.logger.info('opportunity_detected_and_saved', {
        opportunityId: opportunity.id,
        detectorIndex,
        profit: opportunity.profitPercentage,
        pair: `${opportunity.pair.baseToken.symbol}/${opportunity.pair.quoteToken.symbol}`
      });

    } catch (error) {
      this.logger.error('opportunity_save_failed', {
        opportunityId: opportunity.id,
        detectorIndex,
        error: error.message
      });
    }
  }

  private startCleanupProcess(): void {
    this.cleanupTimer = setInterval(async () => {
      try {
        const cutoffDate = new Date(Date.now() - this.config.opportunityExpiry * 1000);
        const cleanedCount = await this.opportunityRepo.deleteExpired(cutoffDate);

        if (cleanedCount > 0) {
          this.logger.info('expired_opportunities_cleaned', {
            count: cleanedCount,
            cutoffDate: cutoffDate.toISOString()
          });
        }
      } catch (error) {
        this.logger.error('cleanup_process_failed', {
          error: error.message
        });
      }
    }, this.config.cleanupInterval);
  }

  // Public API methods
  async getActiveOpportunities(): Promise<ArbitrageOpportunity[]> {
    return this.opportunityRepo.findActive();
  }

  async getExecutionHistory(limit: number = 50): Promise<ExecutionResult[]> {
    return this.executionRepo.getRecentExecutions(limit);
  }

  async getSuccessRate(timeRangeMs: number = 3600000): Promise<number> {
    return this.executionRepo.getSuccessRate(timeRangeMs);
  }

  getActiveExecutionCount(): number {
    return this.activeExecutions.size;
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
import winston from 'winston';
import { format } from 'winston';
import * as fs from 'fs';
import * as path from 'path';

const { combine, timestamp, printf, colorize, errors } = format;

// P2-FIX: Export Logger type for consistent type usage across codebase
export type Logger = winston.Logger;

/**
 * P3 FIX #26: Minimal logger interface for dependency injection.
 * Use this instead of duplicating Logger interfaces in each file.
 * Compatible with winston.Logger and simple test mocks.
 */
export interface LoggerLike {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

// BigInt-safe JSON serializer
function safeStringify(obj: any): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

// Custom log format
const logFormat = printf(({ level, message, timestamp, service, ...meta }: any) => {
  const serviceName = service || 'unknown';
  const metaStr = Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : '';
  return `${timestamp} [${serviceName}] ${level}: ${message}${metaStr}`;
});

// Create logger instance
export function createLogger(serviceName: string) {
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
      timestamp(),
      errors({ stack: true }),
      process.env.NODE_ENV === 'development' ? colorize() : format.uncolorize(),
      logFormat
    ),
    defaultMeta: { service: serviceName },
    transports: [
      // Console transport for all logs
      // Note: handleExceptions/handleRejections disabled to prevent MaxListenersExceeded warnings
      // Exception handling is done at the service entry point level
      new winston.transports.Console(),

      // File transport for errors
      new winston.transports.File({
        filename: `logs/${serviceName}-error.log`,
        level: 'error'
      }),

      // File transport for all logs
      new winston.transports.File({
        filename: `logs/${serviceName}-combined.log`
      })
    ],
    exitOnError: false
  });

  // Ensure log directory exists
  const logDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return logger;
}

// Performance logging utilities
export class PerformanceLogger {
  private logger: winston.Logger;
  private metrics: Map<string, { start: number; count: number }> = new Map();

  constructor(serviceName: string) {
    this.logger = createLogger(serviceName);
  }

  startTimer(operation: string): void {
    this.metrics.set(operation, {
      start: Date.now(),
      count: (this.metrics.get(operation)?.count || 0) + 1
    });
  }

  endTimer(operation: string, metadata?: any): number {
    const metric = this.metrics.get(operation);
    if (!metric) {
      this.logger.warn(`Timer not started for operation: ${operation}`);
      return 0;
    }

    const duration = Date.now() - metric.start;
    this.logger.info(`Operation completed: ${operation}`, {
      duration,
      count: metric.count,
      ...metadata
    });

    // Clean up the metric
    this.metrics.delete(operation);

    return duration;
  }

  logEventLatency(operation: string, latency: number, metadata?: any): void {
    this.logger.debug(`Event processed: ${operation}`, {
      latency,
      ...metadata
    });
  }

  logArbitrageOpportunity(opportunity: any): void {
    this.logger.info('Arbitrage opportunity detected', {
      id: opportunity.id,
      type: opportunity.type,
      profit: opportunity.expectedProfit,
      confidence: opportunity.confidence,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex
    });
  }

  logExecutionResult(result: any): void {
    this.logger.info('Trade execution completed', {
      opportunityId: result.opportunityId,
      success: result.success,
      profit: result.actualProfit,
      gasUsed: result.gasUsed,
      transactionHash: result.transactionHash,
      error: result.error
    });
  }

  logError(error: Error, context?: any): void {
    this.logger.error('Error occurred', {
      error: error.message,
      stack: error.stack,
      ...context
    });
  }

  logHealthCheck(service: string, status: any): void {
    this.logger.info('Health check completed', {
      service,
      status: status.status,
      memoryUsage: status.memoryUsage,
      cpuUsage: status.cpuUsage,
      uptime: status.uptime
    });
  }

  logMetrics(metrics: any): void {
    this.logger.info('Performance metrics', metrics);
  }
}

// Map to store performance loggers by service name
const performanceLoggers: Map<string, PerformanceLogger> = new Map();

export function getPerformanceLogger(serviceName: string): PerformanceLogger {
  if (!performanceLoggers.has(serviceName)) {
    performanceLoggers.set(serviceName, new PerformanceLogger(serviceName));
  }
  return performanceLoggers.get(serviceName)!;
}
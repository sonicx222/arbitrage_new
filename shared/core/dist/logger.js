"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerformanceLogger = void 0;
exports.createLogger = createLogger;
exports.getPerformanceLogger = getPerformanceLogger;
const winston_1 = __importDefault(require("winston"));
const winston_2 = require("winston");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const { combine, timestamp, printf, colorize, errors } = winston_2.format;
// Custom log format
const logFormat = printf(({ level, message, timestamp, service, ...meta }) => {
    const serviceName = service || 'unknown';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${serviceName}] ${level}: ${message}${metaStr}`;
});
// Create logger instance
function createLogger(serviceName) {
    const logger = winston_1.default.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: combine(timestamp(), errors({ stack: true }), process.env.NODE_ENV === 'development' ? colorize() : winston_2.format.uncolorize(), logFormat),
        defaultMeta: { service: serviceName },
        transports: [
            // Console transport for all logs
            new winston_1.default.transports.Console({
                handleExceptions: true,
                handleRejections: true
            }),
            // File transport for errors
            new winston_1.default.transports.File({
                filename: `logs/${serviceName}-error.log`,
                level: 'error',
                handleExceptions: true,
                handleRejections: true
            }),
            // File transport for all logs
            new winston_1.default.transports.File({
                filename: `logs/${serviceName}-combined.log`,
                handleExceptions: true,
                handleRejections: true
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
class PerformanceLogger {
    constructor(serviceName) {
        this.metrics = new Map();
        this.logger = createLogger(serviceName);
    }
    startTimer(operation) {
        this.metrics.set(operation, {
            start: Date.now(),
            count: (this.metrics.get(operation)?.count || 0) + 1
        });
    }
    endTimer(operation, metadata) {
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
    logEventLatency(operation, latency, metadata) {
        this.logger.info(`Event processed: ${operation}`, {
            latency,
            ...metadata
        });
    }
    logArbitrageOpportunity(opportunity) {
        this.logger.info('Arbitrage opportunity detected', {
            id: opportunity.id,
            type: opportunity.type,
            profit: opportunity.expectedProfit,
            confidence: opportunity.confidence,
            buyDex: opportunity.buyDex,
            sellDex: opportunity.sellDex
        });
    }
    logExecutionResult(result) {
        this.logger.info('Trade execution completed', {
            opportunityId: result.opportunityId,
            success: result.success,
            profit: result.actualProfit,
            gasUsed: result.gasUsed,
            transactionHash: result.transactionHash,
            error: result.error
        });
    }
    logError(error, context) {
        this.logger.error('Error occurred', {
            error: error.message,
            stack: error.stack,
            ...context
        });
    }
    logHealthCheck(service, status) {
        this.logger.info('Health check completed', {
            service,
            status: status.status,
            memoryUsage: status.memoryUsage,
            cpuUsage: status.cpuUsage,
            uptime: status.uptime
        });
    }
    logMetrics(metrics) {
        this.logger.info('Performance metrics', metrics);
    }
}
exports.PerformanceLogger = PerformanceLogger;
// Map to store performance loggers by service name
const performanceLoggers = new Map();
function getPerformanceLogger(serviceName) {
    if (!performanceLoggers.has(serviceName)) {
        performanceLoggers.set(serviceName, new PerformanceLogger(serviceName));
    }
    return performanceLoggers.get(serviceName);
}
//# sourceMappingURL=logger.js.map
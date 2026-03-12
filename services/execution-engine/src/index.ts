/**
 * Execution Engine Service Entry Point
 *
 * Reads standby configuration from environment variables and initializes
 * the execution engine with proper failover settings (ADR-007).
 *
 * Environment Variables:
 * - IS_STANDBY: Whether this instance is a standby (default: false)
 * - QUEUE_PAUSED_ON_START: Whether queue starts paused (default: false)
 * - REGION_ID: Region identifier for this instance (default: 'us-east1')
 * - EXECUTION_SIMULATION_MODE: Whether simulation mode is enabled
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */

// P3-1 FIX: Set max listeners before imports to prevent MaxListenersExceededWarning.
// Pino transports add process.on('exit') per logger, exceeding the default 10 limit.
// The execution engine registers 11+ exit listeners across Redis clients,
// service-bootstrap signal handlers, and graceful shutdown handlers.
process.setMaxListeners(25);

import { IncomingMessage, ServerResponse, Server } from 'http';
import { ExecutionEngineService, SimulationConfig } from './engine';
import { getOrderflowPipelineConsumer } from '@arbitrage/core/analytics';
import { getCrossRegionHealthManager, resetCrossRegionHealthManager } from '@arbitrage/core/monitoring';
import { getErrorMessage } from '@arbitrage/core/resilience';
import {
  setupServiceShutdown,
  closeHealthServer,
  createSimpleHealthServer,
  runServiceMain,
} from '@arbitrage/core/service-lifecycle';
import { parseEnvInt } from '@arbitrage/core/utils';
import { createLogger, parseStandbyConfig } from '@arbitrage/core';
import { safeParseInt, safeParseFloat, getExecutionGroupFromEnv, EXECUTION_GROUP_STREAMS } from '@arbitrage/config';
import type { CrossRegionHealthConfig } from '@arbitrage/core/monitoring';
import {
  createCircuitBreakerApiHandler,
} from './api';
import { getMetricsText, updateHealthGauges, initializeGasPriceGauges, initializeBIHistograms, updateGasPrice } from './services/prometheus-metrics';
import { getRuntimeMonitor } from '@arbitrage/core/monitoring';
import { getSupportedExecutionChains } from '@arbitrage/config';
// P2 Fix DI-6: Import for stream lag monitoring
import { getRedisStreamsClient, RedisStreamsClient } from '@arbitrage/core/redis';
// RT-016 FIX: Import GasPriceCache for periodic metric updates
import { getGasPriceCache } from '@arbitrage/core/caching/gas-price-cache';

const logger = createLogger('execution-engine');

// Health check port (default: 3005)
// SA-060 FIX: Use safeParseInt to prevent NaN port causing server bind to random OS port
const HEALTH_CHECK_PORT = safeParseInt(process.env.HEALTH_CHECK_PORT || process.env.EXECUTION_ENGINE_PORT, 3005);

let healthServer: Server | null = null;

/**
 * Parse simulation configuration from environment variables.
 * Returns undefined if simulation is not enabled.
 *
 * Exported for unit testing -- not part of the public service API.
 */
export function getSimulationConfigFromEnv(): SimulationConfig | undefined {
  const enabled = process.env.EXECUTION_SIMULATION_MODE === 'true';

  if (!enabled) {
    return undefined;
  }

  // SA-FIX: Use safeParseFloat/safeParseInt with NaN guards instead of raw parseFloat/parseInt
  return {
    enabled: true,
    successRate: safeParseFloat(process.env.EXECUTION_SIMULATION_SUCCESS_RATE, 0.85),
    // RT-006 FIX: Reduced default from 500ms to 50ms. Real blockchain latency
    // is 2-30s, but 500ms sim delay with 5 concurrency yielded only 10 exec/sec
    // vs 250 msg/sec inflow, causing 749+ pending message lag. 50ms keeps
    // simulation realistic enough while matching pipeline throughput.
    executionLatencyMs: safeParseInt(process.env.EXECUTION_SIMULATION_LATENCY_MS, 50),
    gasUsed: safeParseInt(process.env.EXECUTION_SIMULATION_GAS_USED, 200000),
    gasCostMultiplier: safeParseFloat(process.env.EXECUTION_SIMULATION_GAS_COST_MULTIPLIER, 0.1),
    profitVariance: safeParseFloat(process.env.EXECUTION_SIMULATION_PROFIT_VARIANCE, 0.2),
    logSimulatedExecutions: process.env.EXECUTION_SIMULATION_LOG !== 'false'
  };
}

/**
 * Parse circuit breaker configuration from environment variables (Phase 1.3).
 *
 * Environment Variables:
 * - CIRCUIT_BREAKER_ENABLED: Whether circuit breaker is enabled (default: true)
 * - CIRCUIT_BREAKER_FAILURE_THRESHOLD: Consecutive failures before tripping (default: 5)
 * - CIRCUIT_BREAKER_COOLDOWN_MS: Cooldown period in ms (default: 300000 = 5 min)
 * - CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS: Max attempts in HALF_OPEN (default: 1)
 */
/**
 * Exported for unit testing -- not part of the public service API.
 */
export function getCircuitBreakerConfigFromEnv() {
  return {
    enabled: process.env.CIRCUIT_BREAKER_ENABLED !== 'false', // Default: true
    // SA-FIX: Use safeParseInt with NaN guards
    failureThreshold: safeParseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
    cooldownPeriodMs: safeParseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS, 300000),
    halfOpenMaxAttempts: safeParseInt(process.env.CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS, 1),
  };
}

/**
 * Phase 2 (ADR-038): Parse chain-group configuration from environment variables.
 *
 * Returns the Redis stream name for this EE instance's chain group, or undefined
 * when EXECUTION_CHAIN_GROUP is not set (legacy single-EE mode).
 *
 * Environment Variables:
 * - EXECUTION_CHAIN_GROUP: Chain group to consume (fast | l2 | premium | solana)
 *
 * Exported for unit testing -- not part of the public service API.
 */
export function getChainGroupConfigFromEnv(): { executionStreamName: string; chainGroup: string } | undefined {
  const group = getExecutionGroupFromEnv();
  if (!group) return undefined;
  return {
    chainGroup: group,
    executionStreamName: EXECUTION_GROUP_STREAMS[group],
  };
}

/**
 * Parse standby configuration from environment variables (ADR-007).
 *
 * Uses shared getCrossRegionEnvConfig for common cross-region fields (S-6).
 * Execution-engine-specific fields (queue pause, standby flag) are parsed here.
 */
/**
 * Exported for unit testing -- not part of the public service API.
 */
export function getStandbyConfigFromEnv() {
  const base = parseStandbyConfig('execution-engine');
  const queuePausedOnStart = process.env.QUEUE_PAUSED_ON_START === 'true';
  return { ...base, queuePausedOnStart };
}

/**
 * Create the execution engine health server using shared createSimpleHealthServer.
 *
 * Endpoints provided:
 * - GET /health — Health check with detailed status (via healthCheck callback)
 * - GET /ready — Readiness check (via readyCheck callback)
 * - GET /stats — Execution statistics (via additionalRoutes)
 * - GET / — Service info (auto-generated by createSimpleHealthServer)
 * - GET /circuit-breaker — Circuit breaker status (via additionalRoutes)
 * - POST /circuit-breaker/close — Force close circuit breaker
 * - POST /circuit-breaker/open — Force open circuit breaker
 */
// Cached Redis health status to avoid blocking health checks with ping on every request
let cachedRedisHealthy = true;
let redisHealthCheckInterval: NodeJS.Timeout | null = null;
// P1-6: Cached DLQ length for health monitoring
let cachedDlqLength = 0;
const DLQ_WARNING_THRESHOLD = 100;
// P1-5 FIX: Track consecutive DLQ threshold breaches for escalation
let dlqEscalationCount = 0;
const DLQ_ESCALATION_AFTER = 6; // Escalate to error after 6 consecutive breaches (~60s)
// P2-14: Consumer lag alerting thresholds
let cachedConsumerLag = { pendingCount: 0, minId: null as string | null, maxId: null as string | null };
const CONSUMER_LAG_WARNING_THRESHOLD = 50;

function startRedisHealthMonitor(
  engine: ExecutionEngineService,
  chainGroupConfig?: { executionStreamName: string; chainGroup: string },
): void {
  // Check Redis health every 10 seconds and cache the result
  redisHealthCheckInterval = setInterval(async () => {
    cachedRedisHealthy = await engine.isRedisHealthy();
    // P1-6: Monitor DLQ length — alert when failed messages accumulate
    cachedDlqLength = await engine.getDlqLength();
    if (cachedDlqLength > DLQ_WARNING_THRESHOLD) {
      dlqEscalationCount++;
      // P1-5 FIX: Escalate to error level after persistent threshold breach (~60s).
      // Warn-level logs are easily missed in high-volume output. Error-level
      // ensures operators notice persistent DLQ accumulation.
      if (dlqEscalationCount >= DLQ_ESCALATION_AFTER) {
        logger.error('DLQ persistently above threshold — auto-recovery may be insufficient', {
          dlqLength: cachedDlqLength,
          threshold: DLQ_WARNING_THRESHOLD,
          consecutiveBreaches: dlqEscalationCount,
          action: 'Manual investigation required: check stream:dead-letter-queue error types',
        });
      } else {
        logger.warn('DLQ stream has accumulated failed messages', {
          dlqLength: cachedDlqLength,
          threshold: DLQ_WARNING_THRESHOLD,
          consecutiveBreaches: dlqEscalationCount,
          action: 'Auto-recovery enabled; investigate if DLQ continues to grow',
        });
      }
    } else {
      dlqEscalationCount = 0;
    }
    // P2-14: Monitor consumer lag — alert when pending messages accumulate
    cachedConsumerLag = await engine.getConsumerLag();
    if (cachedConsumerLag.pendingCount > CONSUMER_LAG_WARNING_THRESHOLD) {
      logger.warn('Consumer lag is high — pending messages accumulating', {
        pendingCount: cachedConsumerLag.pendingCount,
        threshold: CONSUMER_LAG_WARNING_THRESHOLD,
        minId: cachedConsumerLag.minId,
        maxId: cachedConsumerLag.maxId,
        action: 'Check consumer health, increase concurrency, or investigate stalled processing',
      });
    }
    // P2 Fix DI-6: Monitor stream length vs MAXLEN to detect message loss risk
    try {
      const streamsClient = await getRedisStreamsClient();
      // Phase 2 (ADR-038): Monitor the actual stream this EE consumes, not always
      // the legacy stream. When EXECUTION_CHAIN_GROUP is set, the EE consumes from
      // a per-group stream (e.g., stream:exec-requests-fast) whose MAXLEN trimming
      // would otherwise go undetected.
      const executionStream = chainGroupConfig?.executionStreamName
        ?? RedisStreamsClient.STREAMS.EXECUTION_REQUESTS;
      const criticalStreams = [
        executionStream,
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
      ];
      for (const streamName of criticalStreams) {
        const lag = await streamsClient.checkStreamLag(streamName);
        if (lag.critical) {
          logger.warn('Stream length approaching MAXLEN — unread messages at risk of trimming', {
            streamName,
            length: lag.length,
            maxLen: lag.maxLen,
            lagRatio: lag.lagRatio,
          });
        }
      }
    } catch (error) {
      // OBS-01 FIX: Stream lag check is non-critical, but silent failure hides MAXLEN trimming risk
      logger.debug('Stream lag check failed', { error: getErrorMessage(error) });
    }
    // RT-016 FIX: Push GasPriceCache values to Prometheus gas_price_gwei metric.
    // In simulation mode, the gas-price-optimizer never runs (no real executions),
    // so gas metrics stay at 0. The GasPriceCache fetches real gas prices from RPC
    // every 60s — push those values to Prometheus for monitoring visibility.
    try {
      const cache = getGasPriceCache();
      const execChains = getSupportedExecutionChains();
      for (const chain of execChains) {
        const data = cache.getGasPrice(chain);
        if (data.gasPriceGwei > 0 && !data.isFallback) {
          updateGasPrice(chain, data.gasPriceGwei);
        }
      }
    } catch {
      // Non-critical — gas cache may not be started yet
    }
  }, 10_000);
  // Initial check
  engine.isRedisHealthy().then(healthy => { cachedRedisHealthy = healthy; }).catch(() => { cachedRedisHealthy = false; });
}

function createHealthServer(engine: ExecutionEngineService): Server {
  const circuitBreakerHandler = createCircuitBreakerApiHandler(engine);

  return createSimpleHealthServer({
    port: HEALTH_CHECK_PORT,
    serviceName: 'execution-engine',
    logger,
    description: 'Arbitrage Execution Engine Service',
    healthCheck: () => {
      const isRunning = engine.isRunning();
      const stats = engine.getStats();
      const healthyProviders = engine.getHealthyProvidersCount();
      const isSimulation = engine.getIsSimulationMode();

      const status = !isRunning ? 'unhealthy' :
                    (!cachedRedisHealthy) ? 'degraded' :
                    (healthyProviders === 0 && !isSimulation) ? 'degraded' : 'healthy';

      // P2 Fix O-9: Update Prometheus gauges from health endpoint values
      updateHealthGauges({
        queueDepth: engine.getQueueSize(),
        activeExecutions: engine.getActiveExecutionsCount(),
        dlqLength: cachedDlqLength,
        consumerLagPending: cachedConsumerLag.pendingCount,
      });

      // RT-015 FIX: Expose risk/drawdown state for monitoring observability.
      // Without this, operators cannot see HALT/CAUTION states, current drawdown,
      // or position sizing adjustments from the health endpoint.
      const drawdownStats = engine.getDrawdownStats();
      const tradingAllowed = engine.isTradingAllowed();

      return {
        status,
        simulationMode: isSimulation,
        redisConnected: cachedRedisHealthy,
        healthyProviders,
        queueSize: engine.getQueueSize(),
        activeExecutions: engine.getActiveExecutionsCount(),
        executionAttempts: stats.executionAttempts,
        successRate: stats.executionAttempts > 0
          ? (stats.successfulExecutions / stats.executionAttempts * 100).toFixed(2) + '%'
          : 'N/A',
        // P1-6: DLQ monitoring — surface accumulated failed messages
        dlqLength: cachedDlqLength,
        dlqAlert: cachedDlqLength > DLQ_WARNING_THRESHOLD,
        // P2-14: Consumer lag monitoring
        consumerLagPending: cachedConsumerLag.pendingCount,
        consumerLagAlert: cachedConsumerLag.pendingCount > CONSUMER_LAG_WARNING_THRESHOLD,
        // RT-015 FIX: Risk/drawdown state — the #1 profitability observability blind spot
        riskState: drawdownStats?.currentState ?? null,
        tradingAllowed: tradingAllowed?.allowed ?? null,
        positionSizeMultiplier: tradingAllowed?.sizeMultiplier ?? null,
        currentDrawdown: drawdownStats?.currentDrawdown ?? null,
        dailyPnLFraction: drawdownStats?.dailyPnLFraction ?? null,
        haltCooldownRemainingMs: tradingAllowed?.haltCooldownRemaining ?? null,
        // OBS-08 FIX: Surface trade logger disk health — silent write failures
        // mean lost audit trail while operators see "healthy" status.
        tradeLoggerHealth: engine.getTradeLoggerHealth(),
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      };
    },
    // P1-9: Ready check verifies engine is running AND essential subsystems are operational.
    // Previously only checked isRunning(), reporting "ready" when Redis was down or no providers healthy.
    // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-9
    readyCheck: () => {
      if (!engine.isRunning()) return false;
      if (!cachedRedisHealthy) return false;
      // In simulation mode, providers aren't required
      if (!engine.getIsSimulationMode() && engine.getHealthyProvidersCount() === 0) return false;
      return true;
    },
    additionalRoutes: {
      '/metrics': async (_req: IncomingMessage, res: ServerResponse) => {
        const text = await getMetricsText();
        const runtimeText = getRuntimeMonitor().getPrometheusMetrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(text + runtimeText);
      },
      '/stats': async (_req: IncomingMessage, res: ServerResponse) => {
        const stats = engine.getStats();
        // W2-18 FIX: Include consumer lag metric from XPENDING
        const consumerLag = await engine.getConsumerLag();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'execution-engine', stats, consumerLag }));
      },
      // P2-15: Bridge recovery metrics endpoint
      '/bridge-recovery': async (_req: IncomingMessage, res: ServerResponse) => {
        const metrics = engine.getBridgeRecoveryMetrics();
        const isRunning = engine.isBridgeRecoveryRunning();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'execution-engine', bridgeRecovery: { isRunning, metrics } }));
      },
      // P2-20: Probability tracker stats endpoint
      '/probability-tracker': async (_req: IncomingMessage, res: ServerResponse) => {
        const stats = engine.getProbabilityTrackerStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'execution-engine', probabilityTracker: stats }));
      },
      '/circuit-breaker': circuitBreakerHandler,
      '/circuit-breaker/close': circuitBreakerHandler,
      '/circuit-breaker/open': circuitBreakerHandler,
    },
  });
}

async function main() {
  try {
    const simulationConfig = getSimulationConfigFromEnv();
    const standbyConfig = getStandbyConfigFromEnv();
    const circuitBreakerConfig = getCircuitBreakerConfigFromEnv();
    // Phase 2 (ADR-038): chain-group routing — undefined = legacy single-EE mode
    const chainGroupConfig = getChainGroupConfigFromEnv();

    // RT-008 FIX: Initialize gas_price_gwei gauge to 0 for all configured chains
    // so the metric appears in /metrics output even before any gas fetches occur.
    const execChains = getSupportedExecutionChains();
    initializeGasPriceGauges(execChains);

    // RT-031 FIX: Seed v3.0 BI histograms so they appear in /metrics output
    // before any executions complete (monitoring 3AI checks for these names).
    initializeBIHistograms(execChains);

    logger.info('Starting Execution Engine Service', {
      port: HEALTH_CHECK_PORT,
      // Phase 2: log chain group for operational visibility
      chainGroup: chainGroupConfig?.chainGroup ?? 'legacy-single-ee',
      executionStream: chainGroupConfig?.executionStreamName ?? RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
    });
    logger.debug('Execution engine startup config', {
      simulationMode: simulationConfig?.enabled ?? false,
      isStandby: standbyConfig.isStandby,
      queuePausedOnStart: standbyConfig.queuePausedOnStart,
      regionId: standbyConfig.regionId,
      healthCheckPort: HEALTH_CHECK_PORT,
      circuitBreakerEnabled: circuitBreakerConfig.enabled,
      circuitBreakerThreshold: circuitBreakerConfig.failureThreshold,
      chainGroup: chainGroupConfig?.chainGroup,
    });

    // Generate unique instance ID
    const instanceId = `execution-engine-${standbyConfig.regionId}-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    const engine = new ExecutionEngineService({
      simulationConfig,
      standbyConfig: {
        isStandby: standbyConfig.isStandby,
        queuePausedOnStart: standbyConfig.queuePausedOnStart,
        activationDisablesSimulation: true, // Default behavior for standby activation
        regionId: standbyConfig.regionId
      },
      circuitBreakerConfig,
      // Phase 2 (ADR-038): set per-group stream when EXECUTION_CHAIN_GROUP is configured
      executionStreamName: chainGroupConfig?.executionStreamName,
      // Phase 3 (ADR-039): async pipeline split (SimulationWorker pre-validates opps)
      asyncPipelineSplit: process.env.ASYNC_PIPELINE_SPLIT === 'true',
    });

    // Initialize CrossRegionHealthManager for cross-region failover (ADR-007)
    // NOTE: Executor only initializes CrossRegionHealthManager when running as standby,
    // unlike Coordinator which always initializes it (coordinator participates in leader
    // election regardless of standby status). This design choice avoids unnecessary
    // overhead for primary executors while ensuring coordinators can always failover.
    let crossRegionManager: ReturnType<typeof getCrossRegionHealthManager> | null = null;
    if (standbyConfig.isStandby) {
      const crossRegionConfig: CrossRegionHealthConfig = {
        instanceId,
        regionId: standbyConfig.regionId,
        serviceName: standbyConfig.serviceName,
        healthCheckIntervalMs: standbyConfig.healthCheckIntervalMs,
        failoverThreshold: standbyConfig.failoverThreshold,
        failoverTimeoutMs: standbyConfig.failoverTimeoutMs,
        leaderHeartbeatIntervalMs: standbyConfig.leaderHeartbeatIntervalMs,
        leaderLockTtlMs: standbyConfig.leaderLockTtlMs,
        canBecomeLeader: true, // Standby executor can become leader on failover
        isStandby: standbyConfig.isStandby
      };

      crossRegionManager = getCrossRegionHealthManager(crossRegionConfig);

      // Wire up failover events
      // P2-4 FIX: Wrap async handler in try-catch to prevent unhandled rejection
      crossRegionManager.on('activateStandby', async (event: { failedRegion: string; timestamp: number }) => {
        try {
          logger.warn('Standby activation triggered by CrossRegionHealthManager', {
            failedRegion: event.failedRegion
          });
          const activated = await engine.activate();
          if (activated) {
            logger.info('Executor successfully activated');
          } else {
            logger.error('Failed to activate executor');
          }
        } catch (error) {
          logger.error('Error during standby activation', {
            error: getErrorMessage(error),
            failedRegion: event.failedRegion
          });
        }
      });

      crossRegionManager.on('failoverStarted', (event) => {
        logger.warn('Failover started', {
          sourceRegion: event.sourceRegion,
          targetRegion: event.targetRegion,
          services: event.services
        });
      });

      crossRegionManager.on('failoverCompleted', (event) => {
        logger.info('Failover completed', {
          sourceRegion: event.sourceRegion,
          targetRegion: event.targetRegion,
          durationMs: event.durationMs
        });
      });

      // Start cross-region health manager
      await crossRegionManager.start();
      logger.info('CrossRegionHealthManager started for standby executor');
    }

    // Start health server first
    healthServer = createHealthServer(engine);
    startRedisHealthMonitor(engine, chainGroupConfig);

    await engine.start();

    // Phase 1 Enhanced Monitoring: Start runtime monitor
    getRuntimeMonitor().start();

    // Start orderflow pipeline consumer (no-op if FEATURE_ORDERFLOW_PIPELINE != true)
    const orderflowConsumer = getOrderflowPipelineConsumer();
    await orderflowConsumer.start();

    // Graceful shutdown with shared bootstrap utility
    // P0 FIX: Bootstrap shutdownTimeoutMs must exceed engine drain timeout.
    // engine.stop() waits up to SHUTDOWN_DRAIN_TIMEOUT_MS (default 30s) for in-flight
    // executions, then runs post-drain cleanup (R2 upload, trade logger, consumers, Redis).
    // Without this, the 10s default force-kills the process before drain completes,
    // abandoning in-flight cross-chain trades.
    // SA-FIX: Use safeParseInt with NaN guard
    const drainTimeoutMs = safeParseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS, 30000);
    const POST_DRAIN_CLEANUP_BUFFER_MS = 15_000; // R2 upload, trade logger, consumers, Redis
    // SA-1R-005 FIX: Validate shutdown timeout hierarchy at startup
    const totalShutdownMs = drainTimeoutMs + POST_DRAIN_CLEANUP_BUFFER_MS;
    if (totalShutdownMs <= drainTimeoutMs) {
      logger.error('Invalid shutdown timeout hierarchy: total must exceed drain', {
        drainTimeoutMs, postDrainBufferMs: POST_DRAIN_CLEANUP_BUFFER_MS, totalShutdownMs,
      });
    }
    setupServiceShutdown({
      logger,
      serviceName: 'Execution Engine',
      shutdownTimeoutMs: drainTimeoutMs + POST_DRAIN_CLEANUP_BUFFER_MS,
      onShutdown: async () => {
        // Stop cross-region health manager if running
        // P1-2 FIX: Remove event listeners before destroying manager to prevent memory leak
        if (crossRegionManager) {
          crossRegionManager.removeAllListeners();
          await resetCrossRegionHealthManager();
        }

        if (redisHealthCheckInterval) {
          clearInterval(redisHealthCheckInterval);
          redisHealthCheckInterval = null;
        }
        await orderflowConsumer.stop();
        await engine.stop();
        await closeHealthServer(healthServer);
      },
    });

    logger.info('Execution Engine Service is running');

  } catch (error) {
    logger.error('Failed to start Execution Engine Service', { error });
    process.exit(1);
  }
}

runServiceMain({ main, serviceName: 'Execution Engine Service', logger });

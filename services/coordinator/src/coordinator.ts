/**
 * System Coordinator Service with Monitoring Dashboard
 *
 * Orchestrates all detector services and manages system health.
 * Uses Redis Streams for event consumption (ADR-002) and implements
 * leader election for failover (ADR-007).
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Layer 5: Coordination)
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 */
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  RedisClient,
  getRedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  ValidationMiddleware,
  RedisStreamsClient,
  getRedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
  createServiceState,
  ServiceState
} from '../../../shared/core/src';
import type { ServiceHealth, ArbitrageOpportunity } from '../../../shared/types/src';

// =============================================================================
// Types
// =============================================================================

interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  averageMemory: number;  // Added: previously memory was incorrectly assigned to latency
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
  whaleAlerts: number;
  pendingOpportunities: number;
}

interface LeaderElectionConfig {
  lockKey: string;
  lockTtlMs: number;
  heartbeatIntervalMs: number;
  instanceId: string;
}

interface CoordinatorConfig {
  port: number;
  leaderElection: LeaderElectionConfig;
  consumerGroup: string;
  consumerId: string;
}

// =============================================================================
// Coordinator Service
// =============================================================================

export class CoordinatorService {
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private logger = createLogger('coordinator');
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;
  private app: express.Application;
  private server: any = null;
  private isRunning = false;  // Kept for backwards compat, derived from stateManager
  private isLeader = false;
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
  private alertCooldowns: Map<string, number> = new Map();
  private opportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Intervals
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsUpdateInterval: NodeJS.Timeout | null = null;
  private leaderHeartbeatInterval: NodeJS.Timeout | null = null;
  private streamConsumerInterval: NodeJS.Timeout | null = null;

  // Configuration
  private readonly config: CoordinatorConfig;

  // Consumer group configs for streams
  private readonly consumerGroups: ConsumerGroupConfig[];

  constructor(config?: Partial<CoordinatorConfig>) {
    this.perfLogger = getPerformanceLogger('coordinator');
    this.app = express();
    this.systemMetrics = this.initializeMetrics();

    // Initialize state manager for lifecycle management (P0 fix: prevents race conditions)
    this.stateManager = createServiceState({
      serviceName: 'coordinator',
      transitionTimeoutMs: 30000
    });

    // Generate unique instance ID for leader election
    const instanceId = `coordinator-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    this.config = {
      port: config?.port || parseInt(process.env.PORT || '3000'),
      leaderElection: {
        lockKey: 'coordinator:leader:lock',
        lockTtlMs: 30000, // 30 seconds
        heartbeatIntervalMs: 10000, // 10 seconds (1/3 of TTL)
        instanceId,
        ...config?.leaderElection
      },
      consumerGroup: config?.consumerGroup || 'coordinator-group',
      consumerId: config?.consumerId || instanceId
    };

    // Define consumer groups for all streams we need to consume
    this.consumerGroups = [
      {
        streamName: RedisStreamsClient.STREAMS.HEALTH,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$' // Only new messages
      },
      {
        streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      },
      {
        streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      }
    ];

    this.setupMiddleware();
    this.setupRoutes();
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(port?: number): Promise<void> {
    const serverPort = port ?? this.config.port;

    // Use state manager to prevent concurrent starts (P0 fix)
    const result = await this.stateManager.executeStart(async () => {
      this.logger.info('Starting Coordinator Service', {
        instanceId: this.config.leaderElection.instanceId
      });

      // Initialize Redis client (for legacy operations)
      this.redis = await getRedisClient() as RedisClient;

      // Initialize Redis Streams client
      this.streamsClient = await getRedisStreamsClient();

      // Create consumer groups for all streams
      await this.createConsumerGroups();

      // Try to acquire leadership
      await this.tryAcquireLeadership();

      // Set isRunning BEFORE starting intervals (P0 fix: prevents early returns)
      this.isRunning = true;

      // Start stream consumers (run even as standby for monitoring)
      this.startStreamConsumers();

      // Start leader heartbeat
      this.startLeaderHeartbeat();

      // Start periodic health monitoring
      this.startHealthMonitoring();

      // Start HTTP server
      this.server = this.app.listen(serverPort, () => {
        this.logger.info(`Coordinator dashboard available at http://localhost:${serverPort}`, {
          isLeader: this.isLeader
        });
      });

      this.server.on('error', (error: any) => {
        this.logger.error('HTTP server error', { error });
      });

      this.logger.info('Coordinator Service started successfully', {
        isLeader: this.isLeader,
        instanceId: this.config.leaderElection.instanceId
      });
    });

    if (!result.success) {
      this.logger.error('Failed to start Coordinator Service', { error: result.error });
      throw result.error;
    }
  }

  async stop(): Promise<void> {
    // Use state manager to prevent concurrent stops (P0 fix)
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Coordinator Service');
      this.isRunning = false;

      // Release leadership if held
      if (this.isLeader) {
        await this.releaseLeadership();
      }

      // Stop all intervals
      this.clearAllIntervals();

      // Close HTTP server gracefully
      if (this.server) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.logger.warn('Force closing HTTP server after timeout');
            resolve();
          }, 5000);

          this.server.close(() => {
            clearTimeout(timeout);
            this.logger.info('HTTP server closed successfully');
            resolve();
          });
        });
        this.server = null;
      }

      // Disconnect Redis Streams client
      if (this.streamsClient) {
        await this.streamsClient.disconnect();
        this.streamsClient = null;
      }

      // Disconnect legacy Redis
      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }

      // Clear collections
      this.serviceHealth.clear();
      this.alertCooldowns.clear();
      this.opportunities.clear();

      this.logger.info('Coordinator Service stopped successfully');
    });

    if (!result.success) {
      this.logger.error('Error stopping Coordinator Service', { error: result.error });
    }
  }

  private clearAllIntervals(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
      this.metricsUpdateInterval = null;
    }
    if (this.leaderHeartbeatInterval) {
      clearInterval(this.leaderHeartbeatInterval);
      this.leaderHeartbeatInterval = null;
    }
    if (this.streamConsumerInterval) {
      clearInterval(this.streamConsumerInterval);
      this.streamConsumerInterval = null;
    }
  }

  // ===========================================================================
  // Leader Election (ADR-007)
  // ===========================================================================

  private async tryAcquireLeadership(): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const { lockKey, lockTtlMs, instanceId } = this.config.leaderElection;

      // Try to set the lock with NX (only if not exists)
      const acquired = await this.redis.setNx(lockKey, instanceId, Math.ceil(lockTtlMs / 1000));

      if (acquired) {
        this.isLeader = true;
        this.logger.info('Acquired leadership', { instanceId });
        return true;
      }

      // Check if we already hold the lock
      const currentLeader = await this.redis.get(lockKey);
      if (currentLeader === instanceId) {
        this.isLeader = true;
        return true;
      }

      this.logger.info('Another instance is leader', { currentLeader });
      return false;

    } catch (error) {
      this.logger.error('Failed to acquire leadership', { error });
      return false;
    }
  }

  private async releaseLeadership(): Promise<void> {
    if (!this.redis || !this.isLeader) return;

    try {
      const { lockKey, instanceId } = this.config.leaderElection;

      // Only release if we hold the lock
      const currentLeader = await this.redis.get(lockKey);
      if (currentLeader === instanceId) {
        await this.redis.del(lockKey);
        this.logger.info('Released leadership', { instanceId });
      }

      this.isLeader = false;

    } catch (error) {
      this.logger.error('Failed to release leadership', { error });
    }
  }

  private startLeaderHeartbeat(): void {
    const { heartbeatIntervalMs, lockKey, lockTtlMs, instanceId } = this.config.leaderElection;

    this.leaderHeartbeatInterval = setInterval(async () => {
      if (!this.isRunning || !this.redis) return;

      try {
        if (this.isLeader) {
          // Renew lock TTL
          const currentLeader = await this.redis.get(lockKey);
          if (currentLeader === instanceId) {
            await this.redis.expire(lockKey, Math.ceil(lockTtlMs / 1000));
          } else {
            // Lost leadership (another instance took over)
            this.isLeader = false;
            this.logger.warn('Lost leadership', { currentLeader });
          }
        } else {
          // Try to acquire leadership
          await this.tryAcquireLeadership();
        }

      } catch (error) {
        this.logger.error('Leader heartbeat failed', { error });
      }
    }, heartbeatIntervalMs);
  }

  // ===========================================================================
  // Redis Streams Consumer Groups (ADR-002)
  // ===========================================================================

  private async createConsumerGroups(): Promise<void> {
    if (!this.streamsClient) return;

    for (const config of this.consumerGroups) {
      try {
        await this.streamsClient.createConsumerGroup(config);
        this.logger.info('Consumer group ready', {
          stream: config.streamName,
          group: config.groupName
        });
      } catch (error) {
        this.logger.error('Failed to create consumer group', {
          error,
          stream: config.streamName
        });
      }
    }
  }

  private startStreamConsumers(): void {
    // Poll streams every 100ms (non-blocking)
    this.streamConsumerInterval = setInterval(async () => {
      if (!this.isRunning || !this.streamsClient) return;

      try {
        await Promise.all([
          this.consumeHealthStream(),
          this.consumeOpportunitiesStream(),
          this.consumeWhaleAlertsStream()
        ]);
      } catch (error) {
        this.logger.error('Stream consumer error', { error });
      }
    }, 100);
  }

  private async consumeHealthStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.HEALTH
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 10,
        block: 0, // Non-blocking
        startId: '>'
      });

      for (const message of messages) {
        await this.handleHealthMessage(message);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      // Ignore timeout errors from non-blocking read
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming health stream', { error });
      }
    }
  }

  private async consumeOpportunitiesStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.OPPORTUNITIES
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 10,
        block: 0,
        startId: '>'
      });

      for (const message of messages) {
        await this.handleOpportunityMessage(message);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming opportunities stream', { error });
      }
    }
  }

  private async consumeWhaleAlertsStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.WHALE_ALERTS
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 10,
        block: 0,
        startId: '>'
      });

      for (const message of messages) {
        await this.handleWhaleAlertMessage(message);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming whale alerts stream', { error });
      }
    }
  }

  // ===========================================================================
  // Stream Message Handlers
  // ===========================================================================

  private async handleHealthMessage(message: any): Promise<void> {
    try {
      const data = message.data;
      if (!data || !data.service) return;

      const health: ServiceHealth = {
        service: data.service,
        status: data.status || 'unknown',
        uptime: data.uptime || 0,
        memoryUsage: data.memoryUsage || 0,
        cpuUsage: data.cpuUsage || 0,
        lastHeartbeat: data.timestamp || Date.now()
      };

      this.serviceHealth.set(data.service, health);

      this.logger.debug('Health update received', {
        service: data.service,
        status: health.status
      });

    } catch (error) {
      this.logger.error('Failed to handle health message', { error, message });
    }
  }

  private async handleOpportunityMessage(message: any): Promise<void> {
    try {
      const data = message.data;
      if (!data || !data.id) return;

      // Track opportunity
      this.opportunities.set(data.id, data as ArbitrageOpportunity);
      this.systemMetrics.totalOpportunities++;
      this.systemMetrics.pendingOpportunities = this.opportunities.size;

      // Clean up expired opportunities
      const now = Date.now();
      for (const [id, opp] of this.opportunities) {
        if (opp.expiresAt && opp.expiresAt < now) {
          this.opportunities.delete(id);
        }
      }

      this.logger.info('Opportunity detected', {
        id: data.id,
        chain: data.chain,
        profitPercentage: data.profitPercentage,
        buyDex: data.buyDex,
        sellDex: data.sellDex
      });

      // Only leader should forward to execution engine
      if (this.isLeader && data.status === 'pending') {
        await this.forwardToExecutionEngine(data);
      }

    } catch (error) {
      this.logger.error('Failed to handle opportunity message', { error, message });
    }
  }

  private async handleWhaleAlertMessage(message: any): Promise<void> {
    try {
      const data = message.data;
      if (!data) return;

      this.systemMetrics.whaleAlerts++;

      this.logger.warn('Whale alert received', {
        address: data.address,
        usdValue: data.usdValue,
        direction: data.direction,
        chain: data.chain,
        dex: data.dex,
        impact: data.impact
      });

      // Send alert notification
      this.sendAlert({
        type: 'WHALE_TRANSACTION',
        message: `Whale ${data.direction} detected: $${data.usdValue?.toLocaleString()} on ${data.chain}`,
        severity: data.usdValue > 100000 ? 'critical' : 'high',
        data,
        timestamp: Date.now()
      });

    } catch (error) {
      this.logger.error('Failed to handle whale alert message', { error, message });
    }
  }

  private async forwardToExecutionEngine(opportunity: ArbitrageOpportunity): Promise<void> {
    // In production, this would forward to the execution engine via streams
    // For now, just log the intent
    this.logger.info('Forwarding opportunity to execution engine', {
      id: opportunity.id,
      chain: opportunity.chain
    });

    // TODO: Publish to execution-requests stream when execution engine is ready
  }

  // ===========================================================================
  // Metrics & Health
  // ===========================================================================

  private initializeMetrics(): SystemMetrics {
    return {
      totalOpportunities: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      totalProfit: 0,
      averageLatency: 0,
      averageMemory: 0,  // Added: tracked separately from latency
      systemHealth: 100,
      activeServices: 0,
      lastUpdate: Date.now(),
      whaleAlerts: 0,
      pendingOpportunities: 0
    };
  }

  private startHealthMonitoring(): void {
    // Update metrics periodically
    this.metricsUpdateInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        this.updateSystemMetrics();
        this.checkForAlerts();

        // Report own health to stream
        await this.reportHealth();

      } catch (error) {
        this.logger.error('Metrics update failed', { error });
      }
    }, 5000);

    // Legacy health polling (fallback for services not yet on streams)
    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning || !this.redis) return;

      try {
        const allHealth = await this.redis.getAllServiceHealth();
        for (const [serviceName, health] of Object.entries(allHealth)) {
          // Only update if we don't have recent stream data
          const existing = this.serviceHealth.get(serviceName);
          if (!existing || (Date.now() - existing.lastHeartbeat) > 30000) {
            this.serviceHealth.set(serviceName, health as ServiceHealth);
          }
        }
      } catch (error) {
        this.logger.error('Legacy health polling failed', { error });
      }
    }, 10000);
  }

  private async reportHealth(): Promise<void> {
    if (!this.streamsClient) return;

    try {
      const health = {
        service: 'coordinator',
        status: this.isRunning ? 'healthy' : 'unhealthy',
        isLeader: this.isLeader,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: 0,
        timestamp: Date.now(),
        metrics: {
          activeServices: this.systemMetrics.activeServices,
          totalOpportunities: this.systemMetrics.totalOpportunities,
          pendingOpportunities: this.systemMetrics.pendingOpportunities
        }
      };

      await this.streamsClient.xadd(RedisStreamsClient.STREAMS.HEALTH, health);

    } catch (error) {
      this.logger.error('Failed to report health', { error });
    }
  }

  private updateSystemMetrics(): void {
    const activeServices = Array.from(this.serviceHealth.values())
      .filter(health => health.status === 'healthy').length;

    const totalServices = Math.max(this.serviceHealth.size, 1);
    const systemHealth = (activeServices / totalServices) * 100;

    // Calculate average memory usage
    const avgMemory = Array.from(this.serviceHealth.values())
      .reduce((sum, health) => sum + (health.memoryUsage || 0), 0) / totalServices;

    // Calculate average latency from service health data (P1 fix: was incorrectly assigned memory)
    const avgLatency = Array.from(this.serviceHealth.values())
      .reduce((sum, health) => sum + (health.latency || health.lastHeartbeat ? Date.now() - health.lastHeartbeat : 0), 0) / totalServices;

    this.systemMetrics.activeServices = activeServices;
    this.systemMetrics.systemHealth = systemHealth;
    this.systemMetrics.averageLatency = avgLatency; // FIX: Use actual latency, not memory
    this.systemMetrics.averageMemory = avgMemory;   // Track memory separately
    this.systemMetrics.lastUpdate = Date.now();
    this.systemMetrics.pendingOpportunities = this.opportunities.size;
  }

  private checkForAlerts(): void {
    const alerts: any[] = [];

    // Check service health
    for (const [serviceName, health] of this.serviceHealth) {
      if (health.status !== 'healthy') {
        alerts.push({
          type: 'SERVICE_UNHEALTHY',
          service: serviceName,
          message: `${serviceName} is ${health.status}`,
          severity: 'high',
          timestamp: Date.now()
        });
      }
    }

    // Check system metrics
    if (this.systemMetrics.systemHealth < 80) {
      alerts.push({
        type: 'SYSTEM_HEALTH_LOW',
        message: `System health is ${this.systemMetrics.systemHealth.toFixed(1)}%`,
        severity: 'critical',
        timestamp: Date.now()
      });
    }

    // Send alerts (with cooldown)
    for (const alert of alerts) {
      this.sendAlert(alert);
    }
  }

  private sendAlert(alert: any): void {
    const alertKey = `${alert.type}_${alert.service || 'system'}`;
    const now = Date.now();
    const lastAlert = this.alertCooldowns.get(alertKey) || 0;

    // 5 minute cooldown for same alert type
    if (now - lastAlert > 300000) {
      this.logger.warn('Alert triggered', alert);
      this.alertCooldowns.set(alertKey, now);

      // TODO: Send to Discord/Telegram/email in production
    }
  }

  // ===========================================================================
  // Express Middleware & Routes
  // ===========================================================================

  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // CORS
    this.app.use((req, res, next) => {
      const allowedOrigins = process.env.ALLOWED_ORIGINS ?
        process.env.ALLOWED_ORIGINS.split(',') :
        ['http://localhost:3000', 'http://localhost:3001'];

      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }

      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      res.header('X-XSS-Protection', '1; mode=block');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }

      next();
    });

    // JSON parsing with limits
    this.app.use(express.json({ limit: '1mb', strict: true }));
    this.app.use(express.urlencoded({ extended: false, limit: '1mb' }));
    this.app.use(express.static('public'));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: { error: 'Too many requests', retryAfter: 900 },
      standardHeaders: true,
      legacyHeaders: false
    });
    this.app.use(limiter);

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logger.info('API Request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
          ip: clientIP
        });
      });

      next();
    });
  }

  private setupRoutes(): void {
    // Dashboard routes
    this.app.get('/', this.getDashboard.bind(this));
    this.app.get('/api/health', ValidationMiddleware.validateHealthCheck, this.getHealth.bind(this));
    this.app.get('/api/metrics', this.getMetrics.bind(this));
    this.app.get('/api/services', this.getServices.bind(this));
    this.app.get('/api/opportunities', this.getOpportunities.bind(this));
    this.app.get('/api/alerts', this.getAlerts.bind(this));
    this.app.get('/api/leader', this.getLeaderStatus.bind(this));

    // Control routes with strict rate limiting
    const strictLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: { error: 'Too many control actions', retryAfter: 900 }
    });

    this.app.post('/api/services/:service/restart',
      strictLimiter,
      this.validateServiceRestart.bind(this),
      this.restartService.bind(this)
    );
    this.app.post('/api/alerts/:alert/acknowledge',
      strictLimiter,
      this.validateAlertAcknowledge.bind(this),
      this.acknowledgeAlert.bind(this)
    );
  }

  // ===========================================================================
  // Route Handlers
  // ===========================================================================

  private getDashboard(req: any, res: any): void {
    const leaderBadge = this.isLeader
      ? '<span style="background:green;color:white;padding:2px 8px;border-radius:3px;">LEADER</span>'
      : '<span style="background:orange;color:white;padding:2px 8px;border-radius:3px;">STANDBY</span>';

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Arbitrage System Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
          .metric { background: #16213e; padding: 15px; margin: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
          .healthy { color: #00ff88; }
          .unhealthy { color: #ff4444; }
          .degraded { color: #ffaa00; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
          h1 { color: #00ff88; }
          h3 { color: #4da6ff; margin-bottom: 10px; }
          .leader-status { margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <h1>🏦 Professional Arbitrage System Dashboard</h1>
        <div class="leader-status">Status: ${leaderBadge}</div>

        <div class="grid">
          <div class="metric">
            <h3>System Health</h3>
            <div class="${this.systemMetrics.systemHealth > 80 ? 'healthy' : this.systemMetrics.systemHealth > 50 ? 'degraded' : 'unhealthy'}">
              ${this.systemMetrics.systemHealth.toFixed(1)}%
            </div>
            <small>${this.systemMetrics.activeServices} services active</small>
          </div>

          <div class="metric">
            <h3>Opportunities</h3>
            <div>Detected: ${this.systemMetrics.totalOpportunities}</div>
            <div>Pending: ${this.systemMetrics.pendingOpportunities}</div>
            <div>Whale Alerts: ${this.systemMetrics.whaleAlerts}</div>
          </div>

          <div class="metric">
            <h3>Trading Performance</h3>
            <div>Executions: ${this.systemMetrics.totalExecutions}</div>
            <div>Success Rate: ${this.systemMetrics.totalExecutions > 0 ?
              ((this.systemMetrics.successfulExecutions / this.systemMetrics.totalExecutions) * 100).toFixed(1) : 0}%</div>
            <div>Total Profit: $${this.systemMetrics.totalProfit.toFixed(2)}</div>
          </div>

          <div class="metric">
            <h3>Service Status</h3>
            ${Array.from(this.serviceHealth.entries()).map(([name, health]) =>
              `<div class="${health.status === 'healthy' ? 'healthy' : health.status === 'degraded' ? 'degraded' : 'unhealthy'}">
                ${name}: ${health.status}
              </div>`
            ).join('') || '<div>No services reporting</div>'}
          </div>
        </div>

        <div class="metric">
          <h3>System Information</h3>
          <div>Instance: ${this.config.leaderElection.instanceId}</div>
          <div>Last Update: ${new Date(this.systemMetrics.lastUpdate).toLocaleString()}</div>
          <div>Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m</div>
        </div>

        <script>
          // Auto-refresh every 10 seconds
          setTimeout(() => window.location.reload(), 10000);
        </script>
      </body>
      </html>
    `);
  }

  private getHealth(req: any, res: any): void {
    res.json({
      status: 'ok',
      isLeader: this.isLeader,
      instanceId: this.config.leaderElection.instanceId,
      systemHealth: this.systemMetrics.systemHealth,
      services: Object.fromEntries(this.serviceHealth),
      timestamp: Date.now()
    });
  }

  private getMetrics(req: any, res: any): void {
    res.json(this.systemMetrics);
  }

  private getServices(req: any, res: any): void {
    res.json(Object.fromEntries(this.serviceHealth));
  }

  private getOpportunities(req: any, res: any): void {
    const opportunities = Array.from(this.opportunities.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 100); // Return last 100
    res.json(opportunities);
  }

  private getAlerts(req: any, res: any): void {
    // Return recent alerts (in production, store in database)
    res.json([]);
  }

  private getLeaderStatus(req: any, res: any): void {
    res.json({
      isLeader: this.isLeader,
      instanceId: this.config.leaderElection.instanceId,
      lockKey: this.config.leaderElection.lockKey
    });
  }

  // ===========================================================================
  // Validation Methods
  // ===========================================================================

  private validateServiceRestart(req: any, res: any, next: any): void {
    const { service } = req.params;

    if (!service || typeof service !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(service)) {
      return res.status(400).json({ error: 'Invalid service name' });
    }

    const allowedServices = ['bsc-detector', 'ethereum-detector', 'arbitrum-detector',
      'polygon-detector', 'optimism-detector', 'base-detector', 'execution-engine'];

    if (!allowedServices.includes(service)) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Only leader can restart services
    if (!this.isLeader) {
      return res.status(403).json({ error: 'Only leader can restart services' });
    }

    next();
  }

  private validateAlertAcknowledge(req: any, res: any, next: any): void {
    const { alert } = req.params;

    if (!alert || typeof alert !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(alert)) {
      return res.status(400).json({ error: 'Invalid alert ID' });
    }

    next();
  }

  private async restartService(req: any, res: any): Promise<void> {
    const { service } = req.params;

    try {
      this.logger.info(`Restarting service: ${service}`);
      // In production, implement service restart logic via orchestration
      res.json({ success: true, message: `Restart requested for ${service}` });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  private acknowledgeAlert(req: any, res: any): void {
    const { alert } = req.params;
    this.alertCooldowns.delete(alert);
    res.json({ success: true });
  }

  // ===========================================================================
  // Public Getters for Testing
  // ===========================================================================

  getIsLeader(): boolean {
    return this.isLeader;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getServiceHealthMap(): Map<string, ServiceHealth> {
    return new Map(this.serviceHealth);
  }

  getSystemMetrics(): SystemMetrics {
    return { ...this.systemMetrics };
  }
}

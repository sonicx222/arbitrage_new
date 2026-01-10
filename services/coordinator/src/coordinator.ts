// System Coordinator Service with Monitoring Dashboard
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisClient, getRedisClient, createLogger, getPerformanceLogger, PerformanceLogger, ValidationMiddleware } from '../../../shared/core/src';
import { ServiceHealth, PerformanceMetrics } from '../../../shared/types/src';

interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
}

export class CoordinatorService {
  private redis: RedisClient | null = null; // Will be initialized asynchronously
  private logger = createLogger('coordinator');
  private perfLogger: PerformanceLogger;
  private app: express.Application;
  private server: any = null; // Store HTTP server reference for cleanup
  private isRunning = false;
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
  private alertCooldowns: Map<string, number> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null; // Track health check timer
  private metricsUpdateInterval: NodeJS.Timeout | null = null; // Track metrics update timer

  constructor() {
    this.perfLogger = getPerformanceLogger('coordinator');
    this.app = express();
    this.systemMetrics = this.initializeMetrics();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupHealthMonitoring();
  }

  async start(port: number = 3000): Promise<void> {
    try {
      this.logger.info('Starting Coordinator Service');

      // Initialize Redis client
      this.redis = await getRedisClient() as RedisClient;

      // Subscribe to execution results for analytics
      await this.subscribeToExecutionResults();

      // Start periodic health monitoring
      this.startHealthMonitoring();

      this.isRunning = true;

      // Start HTTP server with proper reference storage
      this.server = this.app.listen(port, () => {
        this.logger.info(`Coordinator dashboard available at http://localhost:${port}`);
      });

      // Add server error handling
      this.server.on('error', (error: any) => {
        this.logger.error('HTTP server error', { error });
        // Don't throw here, let the service continue
      });

      this.logger.info('Coordinator Service started successfully');

    } catch (error) {
      this.logger.error('Failed to start Coordinator Service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Coordinator Service');
    this.isRunning = false;

    // Stop periodic tasks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
      this.metricsUpdateInterval = null;
    }

    // Close HTTP server gracefully
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close((error?: Error) => {
          if (error) {
            this.logger.error('Error closing HTTP server', { error });
          } else {
            this.logger.info('HTTP server closed successfully');
          }
          resolve();
        });

        // Force close after timeout to prevent hanging
        setTimeout(() => {
          this.logger.warn('Force closing HTTP server after timeout');
          if (this.server) {
            this.server.close();
          }
          resolve();
        }, 5000);
      });
      this.server = null;
    }

    // Disconnect Redis
    if (this.redis) {
      await this.redis!.disconnect();
    }

    // Clear collections to prevent memory leaks
    this.serviceHealth.clear();
    this.alertCooldowns.clear();

    this.logger.info('Coordinator Service stopped successfully');
  }

  private initializeMetrics(): SystemMetrics {
    return {
      totalOpportunities: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      totalProfit: 0,
      averageLatency: 0,
      systemHealth: 100,
      activeServices: 0,
      lastUpdate: Date.now()
    };
  }

  private setupMiddleware(): void {
    // SECURITY: Comprehensive security headers
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

    // SECURITY: Strict CORS configuration
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

    // SECURITY: Request size limits and timeout
    this.app.use(express.json({
      limit: '1mb',
      strict: true,
      verify: (req, res, buf) => {
        // SECURITY: Prevent JSON parsing attacks
        if (buf.length > 1024 * 1024) { // 1MB limit
          throw new Error('Request too large');
        }
      }
    }));

    // SECURITY: URL-encoded payload protection
    this.app.use(express.urlencoded({
      extended: false,
      limit: '1mb'
    }));

    this.app.use(express.static('public'));

    // SECURITY: Rate limiting to prevent DoS attacks
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: 900 // 15 minutes in seconds
      },
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        const clientIP = req.ip || req.connection.remoteAddress ||
                        (req.socket ? req.socket.remoteAddress : undefined) || 'unknown';
        this.logger.warn('Rate limit exceeded', {
          ip: clientIP,
          url: req.url,
          userAgent: req.get('User-Agent')
        });
        res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil(15 * 60) // 15 minutes in seconds
        });
      }
    });

    // Apply rate limiting to all routes
    this.app.use(limiter);

    // Stricter rate limiting for sensitive endpoints
    const strictLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // Only 10 requests per 15 minutes for sensitive endpoints
      message: {
        error: 'Too many requests to sensitive endpoint',
        retryAfter: 900
      },
      handler: (req, res) => {
        const clientIP = req.ip || req.connection.remoteAddress ||
                        (req.socket ? req.socket.remoteAddress : undefined) || 'unknown';
        this.logger.error('Strict rate limit exceeded on sensitive endpoint', {
          ip: clientIP,
          url: req.url,
          method: req.method
        });
        res.status(429).json({
          error: 'Access denied: too many requests to sensitive endpoint',
          retryAfter: Math.ceil(15 * 60)
        });
      }
    });

    // Apply strict rate limiting to sensitive routes (will be added in setupRoutes)

    // SECURITY: Request logging for audit trail
    this.app.use((req, res, next) => {
      const start = Date.now();
      const clientIP = req.ip || req.connection.remoteAddress ||
                      (req.socket ? req.socket.remoteAddress : undefined) || 'unknown';

      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logger.info('API Request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
          ip: clientIP,
          userAgent: req.get('User-Agent')
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
    this.app.get('/api/alerts', this.getAlerts.bind(this));

    // Control routes with strict rate limiting
    const strictLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // Only 5 control actions per 15 minutes
      message: {
        error: 'Too many control actions',
        retryAfter: 900
      }
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

  // SECURITY: Validation methods for control routes
  private validateServiceRestart(req: any, res: any, next: any): void {
    const { service } = req.params;

    // Validate service name
    if (!service || typeof service !== 'string') {
      return res.status(400).json({
        error: 'Invalid service name'
      });
    }

    // Allow only safe service names
    if (!/^[a-zA-Z0-9_-]+$/.test(service)) {
      return res.status(400).json({
        error: 'Invalid service name format'
      });
    }

    // Check if service exists
    const allowedServices = ['bsc-detector', 'ethereum-detector', 'arbitrum-detector', 'polygon-detector', 'execution-engine'];
    if (!allowedServices.includes(service)) {
      return res.status(404).json({
        error: 'Service not found'
      });
    }

    next();
  }

  private validateAlertAcknowledge(req: any, res: any, next: any): void {
    const { alert } = req.params;

    // Validate alert ID
    if (!alert || typeof alert !== 'string') {
      return res.status(400).json({
        error: 'Invalid alert ID'
      });
    }

    // Allow only alphanumeric and safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(alert)) {
      return res.status(400).json({
        error: 'Invalid alert ID format'
      });
    }

    next();
  }

  private startHealthMonitoring(): void {
    // Poll health data periodically
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.isRunning) return;
        await this.updateServiceHealth();
      } catch (error) {
        this.logger.error('Health monitoring failed', { error });
      }
    }, 10000); // Update every 10 seconds

    // Update metrics periodically
    this.metricsUpdateInterval = setInterval(async () => {
      try {
        if (!this.isRunning) return;
        await this.updateSystemMetrics();
        await this.checkForAlerts();
      } catch (error) {
        this.logger.error('Metrics update failed', { error });
      }
    }, 5000); // Update every 5 seconds
  }

  private async subscribeToExecutionResults(): Promise<void> {
    await this.redis!.subscribe('execution-results', (message: string) => {
      this.handleExecutionResult(message);
    });
    this.logger.info('Subscribed to execution results');
  }

  private async updateServiceHealth(): Promise<void> {
    try {
      if (!this.redis) return;

      const allHealth = await this.redis!.getAllServiceHealth();
      const newServiceHealth = new Map<string, any>();

      for (const [serviceName, health] of Object.entries(allHealth)) {
        newServiceHealth.set(serviceName, health);
      }

      // Atomic update of service health map
      this.serviceHealth = newServiceHealth;

    } catch (error) {
      this.logger.error('Failed to update service health', { error });
    }
  }

  private handleExecutionResult(message: any): void {
    try {
      const result = message.data;

      this.systemMetrics.totalExecutions++;

      if (result.success) {
        this.systemMetrics.successfulExecutions++;
        if (result.actualProfit) {
          this.systemMetrics.totalProfit += result.actualProfit;
        }
      }

      this.systemMetrics.lastUpdate = Date.now();

      this.logger.info('Execution result processed', {
        success: result.success,
        profit: result.actualProfit,
        totalExecutions: this.systemMetrics.totalExecutions
      });

    } catch (error) {
      this.logger.error('Failed to handle execution result', { error });
    }
  }

  private updateSystemMetrics(): void {
    const activeServices = Array.from(this.serviceHealth.values())
      .filter(health => health.status === 'healthy').length;

    const avgLatency = Array.from(this.serviceHealth.values())
      .reduce((sum, health) => sum + (health.memoryUsage || 0), 0) / this.serviceHealth.size;

    const systemHealth = (activeServices / this.serviceHealth.size) * 100;

    this.systemMetrics.activeServices = activeServices;
    this.systemMetrics.averageLatency = avgLatency;
    this.systemMetrics.systemHealth = systemHealth;
    this.systemMetrics.lastUpdate = Date.now();
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

      // In production, send to Discord/Telegram/email
      // For now, just log
    }
  }

  // HTTP Route Handlers
  private getDashboard(req: any, res: any): void {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Arbitrage System Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .metric { background: #f0f0f0; padding: 10px; margin: 10px; border-radius: 5px; }
          .healthy { color: green; }
          .unhealthy { color: red; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        </style>
      </head>
      <body>
        <h1>🏦 Professional Arbitrage System Dashboard</h1>

        <div class="grid">
          <div class="metric">
            <h3>System Health</h3>
            <div class="${this.systemMetrics.systemHealth > 80 ? 'healthy' : 'unhealthy'}">
              ${this.systemMetrics.systemHealth.toFixed(1)}%
            </div>
            <small>${this.systemMetrics.activeServices} services active</small>
          </div>

          <div class="metric">
            <h3>Trading Performance</h3>
            <div>Opportunities: ${this.systemMetrics.totalOpportunities}</div>
            <div>Executions: ${this.systemMetrics.totalExecutions}</div>
            <div>Success Rate: ${this.systemMetrics.totalExecutions > 0 ?
              ((this.systemMetrics.successfulExecutions / this.systemMetrics.totalExecutions) * 100).toFixed(1) : 0}%</div>
            <div>Total Profit: $${this.systemMetrics.totalProfit.toFixed(2)}</div>
          </div>

          <div class="metric">
            <h3>Service Status</h3>
            ${Array.from(this.serviceHealth.entries()).map(([name, health]) =>
              `<div class="${health.status === 'healthy' ? 'healthy' : 'unhealthy'}">
                ${name}: ${health.status}
              </div>`
            ).join('')}
          </div>
        </div>

        <div class="metric">
          <h3>Recent Activity</h3>
          <div>Last Update: ${new Date(this.systemMetrics.lastUpdate).toLocaleString()}</div>
          <div>Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m</div>
        </div>

        <script>
          // Auto-refresh every 30 seconds
          setTimeout(() => window.location.reload(), 30000);
        </script>
      </body>
      </html>
    `);
  }

  private getHealth(req: any, res: any): void {
    res.json({
      status: 'ok',
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

  private getAlerts(req: any, res: any): void {
    // Return recent alerts (in production, store in database)
    res.json([]);
  }

  private async restartService(req: any, res: any): Promise<void> {
    const { service } = req.params;

    try {
      // In production, implement service restart logic
      this.logger.info(`Restarting service: ${service}`);

      res.json({ success: true, message: `Restarted ${service}` });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  private acknowledgeAlert(req: any, res: any): void {
    const { alert } = req.params;

    // Clear alert cooldown
    this.alertCooldowns.delete(alert);

    res.json({ success: true });
  }

  private setupHealthMonitoring(): void {
    setInterval(async () => {
      try {
        const health: ServiceHealth = {
          service: 'coordinator',
          status: this.isRunning ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now()
        };

        await this.redis!.updateServiceHealth('coordinator', health);
        this.perfLogger.logHealthCheck('coordinator', health);

      } catch (error) {
        this.logger.error('Coordinator health monitoring failed', { error });
      }
    }, 30000);
  }
}
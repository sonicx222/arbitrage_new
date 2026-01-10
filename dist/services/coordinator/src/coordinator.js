"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoordinatorService = void 0;
// System Coordinator Service with Monitoring Dashboard
const express_1 = __importDefault(require("express"));
const src_1 = require("../../../shared/core/src");
class CoordinatorService {
    constructor() {
        this.redis = null; // Will be initialized asynchronously
        this.logger = (0, src_1.createLogger)('coordinator');
        this.server = null; // Store HTTP server reference for cleanup
        this.isRunning = false;
        this.serviceHealth = new Map();
        this.alertCooldowns = new Map();
        this.healthCheckInterval = null; // Track health check timer
        this.metricsUpdateInterval = null; // Track metrics update timer
        this.perfLogger = (0, src_1.getPerformanceLogger)('coordinator');
        this.app = (0, express_1.default)();
        this.systemMetrics = this.initializeMetrics();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupHealthMonitoring();
    }
    async start(port = 3000) {
        try {
            this.logger.info('Starting Coordinator Service');
            // Initialize Redis client
            this.redis = await (0, src_1.getRedisClient)();
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
            this.server.on('error', (error) => {
                this.logger.error('HTTP server error', { error });
                // Don't throw here, let the service continue
            });
            this.logger.info('Coordinator Service started successfully');
        }
        catch (error) {
            this.logger.error('Failed to start Coordinator Service', { error });
            throw error;
        }
    }
    async stop() {
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
            await new Promise((resolve) => {
                this.server.close((error) => {
                    if (error) {
                        this.logger.error('Error closing HTTP server', { error });
                    }
                    else {
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
            await this.redis.disconnect();
        }
        // Clear collections to prevent memory leaks
        this.serviceHealth.clear();
        this.alertCooldowns.clear();
        this.logger.info('Coordinator Service stopped successfully');
    }
    initializeMetrics() {
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
    setupMiddleware() {
        this.app.use(express_1.default.json());
        this.app.use(express_1.default.static('public'));
        // CORS middleware
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
            res.header('Access-Control-Allow-Headers', 'Content-Type');
            next();
        });
    }
    setupRoutes() {
        // Dashboard routes
        this.app.get('/', this.getDashboard.bind(this));
        this.app.get('/api/health', this.getHealth.bind(this));
        this.app.get('/api/metrics', this.getMetrics.bind(this));
        this.app.get('/api/services', this.getServices.bind(this));
        this.app.get('/api/alerts', this.getAlerts.bind(this));
        // Control routes
        this.app.post('/api/services/:service/restart', this.restartService.bind(this));
        this.app.post('/api/alerts/:alert/acknowledge', this.acknowledgeAlert.bind(this));
    }
    startHealthMonitoring() {
        // Poll health data periodically
        this.healthCheckInterval = setInterval(async () => {
            try {
                if (!this.isRunning)
                    return;
                await this.updateServiceHealth();
            }
            catch (error) {
                this.logger.error('Health monitoring failed', { error });
            }
        }, 10000); // Update every 10 seconds
        // Update metrics periodically
        this.metricsUpdateInterval = setInterval(async () => {
            try {
                if (!this.isRunning)
                    return;
                await this.updateSystemMetrics();
                await this.checkForAlerts();
            }
            catch (error) {
                this.logger.error('Metrics update failed', { error });
            }
        }, 5000); // Update every 5 seconds
    }
    async subscribeToExecutionResults() {
        await this.redis.subscribe('execution-results', (message) => {
            this.handleExecutionResult(message);
        });
        this.logger.info('Subscribed to execution results');
    }
    async updateServiceHealth() {
        try {
            if (!this.redis)
                return;
            const allHealth = await this.redis.getAllServiceHealth();
            const newServiceHealth = new Map();
            for (const [serviceName, health] of Object.entries(allHealth)) {
                newServiceHealth.set(serviceName, health);
            }
            // Atomic update of service health map
            this.serviceHealth = newServiceHealth;
        }
        catch (error) {
            this.logger.error('Failed to update service health', { error });
        }
    }
    handleExecutionResult(message) {
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
        }
        catch (error) {
            this.logger.error('Failed to handle execution result', { error });
        }
    }
    updateSystemMetrics() {
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
    checkForAlerts() {
        const alerts = [];
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
    sendAlert(alert) {
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
    getDashboard(req, res) {
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
            ${Array.from(this.serviceHealth.entries()).map(([name, health]) => `<div class="${health.status === 'healthy' ? 'healthy' : 'unhealthy'}">
                ${name}: ${health.status}
              </div>`).join('')}
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
    getHealth(req, res) {
        res.json({
            status: 'ok',
            systemHealth: this.systemMetrics.systemHealth,
            services: Object.fromEntries(this.serviceHealth),
            timestamp: Date.now()
        });
    }
    getMetrics(req, res) {
        res.json(this.systemMetrics);
    }
    getServices(req, res) {
        res.json(Object.fromEntries(this.serviceHealth));
    }
    getAlerts(req, res) {
        // Return recent alerts (in production, store in database)
        res.json([]);
    }
    async restartService(req, res) {
        const { service } = req.params;
        try {
            // In production, implement service restart logic
            this.logger.info(`Restarting service: ${service}`);
            res.json({ success: true, message: `Restarted ${service}` });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
    acknowledgeAlert(req, res) {
        const { alert } = req.params;
        // Clear alert cooldown
        this.alertCooldowns.delete(alert);
        res.json({ success: true });
    }
    setupHealthMonitoring() {
        setInterval(async () => {
            try {
                const health = {
                    service: 'coordinator',
                    status: this.isRunning ? 'healthy' : 'unhealthy',
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage().heapUsed,
                    cpuUsage: 0,
                    lastHeartbeat: Date.now()
                };
                await this.redis.updateServiceHealth('coordinator', health);
                this.perfLogger.logHealthCheck('coordinator', health);
            }
            catch (error) {
                this.logger.error('Coordinator health monitoring failed', { error });
            }
        }, 30000);
    }
}
exports.CoordinatorService = CoordinatorService;
//# sourceMappingURL=coordinator.js.map